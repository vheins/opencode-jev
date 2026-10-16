/**
 * opencode-Jev integration plugin.
 *
 * Bridges TypeSafe Jev (System One) structured judgments into opencode's
 * built-in plugin hooks. Jev is not a model replacement: it returns typed
 * answers (Choice / Score / Noul) that this plugin branches on.
 *
 * All Jev calls go through the configured router provider, whose pass-through
 * route (`POST` at `JEV_BASE_URL`) forwards the body untouched and returns the
 * native System One JSON, authenticated with the same bearer key used for chat
 * models. `JEV_BASE_URL` is REQUIRED: the plugin ships no default host.
 *
 * Hooks provided:
 * - `tool.execute.before`: classifies a tool call and blocks a destructive
 *   action whose confidence exceeds the block threshold. It can only ever
 *   add a block; it never auto-allows, so opencode's native permission flow
 *   remains the sole gate for execution.
 * - `tool.jev_decide`: exposes Choice / Score / Noul judgments over arbitrary
 *   state as a callable tool.
 * - `chat.message`: classifies each user message (code_only | needs_model |
 *   needs_human) and raises a toast on a confident needs_human. This hook is
 *   observe-only: it cannot reroute the message, so it is reported as a
 *   classification, never as routing.
 * - `experimental.session.compacting`: asks whether the session holds
 *   unrecoverable state and appends a preservation reminder to the summary
 *   context. Never replaces the compaction prompt.
 * - `event`: handles `session.error` (severity: transient | real_bug | fatal)
 *   and `file.edited` (security-sensitive review check).
 *
 * When the key or base URL is missing, the plugin degrades to a no-op that
 * warns once, so opencode startup never crashes. Every hook is throw-safe: a
 * Jev failure or missing config degrades to the safe path and never breaks
 * opencode's flow.
 *
 * @module
 */

import type { Event } from "@opencode-ai/sdk"
import type { Hooks, Plugin, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { choice, noul, score, type Question } from "@typesafe-ai/sdk"

import { errorMessage, safeStringify, SystemOneClient } from "./client.ts"
import { loadConfig, type DisabledReason } from "./config.ts"
import {
  appendDecision,
  type DecisionAction,
  type DecisionKind,
  type DecisionLogOptions,
} from "./decision-log.ts"
import {
  classifyNoul,
  classifyRisk,
  classifyRoute,
  classifySeverity,
} from "./decisions.ts"
import type { ChoiceVerdict, Decision, LogLevel, RiskLevel } from "./domain.ts"
import {
  classifyLocally,
  failurePolicy,
  type ActionCategory,
} from "./policy.ts"
import { parseResponse } from "./validate.ts"

/** Log service name stamped on every entry this plugin emits. */
const SERVICE = "opencode-jev"

/**
 * Decision-policy version.
 *
 * Bump this whenever decision semantics, thresholds, or question wording
 * change so a cached decision cannot outlive the policy that produced it.
 */
const POLICY_VERSION = "2"

/** Question id used for the security-sensitive file review. */
const FILE_REVIEW_QUESTION_ID = "security_sensitive"

/** Instructions for the security-sensitive file review. */
const FILE_REVIEW_INSTRUCTIONS =
  "Is this file path security-sensitive or does it need a security review before changes are accepted?"

/** Question id used for the compaction preservation check. */
const COMPACT_QUESTION_ID = "unrecoverable"

/** Instructions for the compaction preservation check. */
const COMPACT_INSTRUCTIONS =
  "Does this session hold unrecoverable decisions, findings, or context that must be preserved in the summary to avoid losing work?"

/** The preservation reminder appended to the compaction context. */
const COMPACT_REMINDER =
  "[jev] This session likely holds unrecoverable state. Preserve explicitly: decisions, constraints, unresolved issues, file references, test status, and next actions."

/**
 * Error thrown to block a destructive tool call.
 *
 * It is re-thrown past the hook's outer guard so an intentional block still
 * propagates to opencode, while any unexpected error degrades to a no-op.
 */
class JevBlockError extends Error {}

/** Human-readable description of why Jev is disabled. */
function disabledMessage(reason: DisabledReason): string {
  if (reason === "missing-key") {
    return "No JEV key found (apiKey option, JEV_API_KEY, or .jev-key); Jev guardrails are a no-op."
  }
  return "No base URL set (baseUrl option or JEV_BASE_URL); Jev guardrails are a no-op (no default host is used)."
}

/** Extract the concatenated text of a message's parts, bounded in length. */
function extractText(parts: ReadonlyArray<{ type?: string; text?: string }>): string {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
  return text.length > 4000 ? text.slice(0, 4000) : text
}

/** A bounded set of warning keys already emitted, to avoid log spam. */
class WarnOnce {
  private readonly seen = new Set<string>()

  /**
   * @param key - The warning key.
   * @returns True the first time a key is seen, false afterwards.
   */
  claim(key: string): boolean {
    if (this.seen.has(key)) return false
    if (this.seen.size >= 128) this.seen.clear()
    this.seen.add(key)
    return true
  }
}

/** A validated tool-risk decision outcome. */
type RiskDecision = Decision<ChoiceVerdict<RiskLevel>>

/** Describe a non-actionable decision for logging. */
function describeDecision(decision: RiskDecision): string {
  switch (decision.kind) {
    case "invalid":
      return `invalid:${decision.reason}`
    case "unavailable":
      return `unavailable:${decision.reason}`
    case "abstain":
      return `abstain:${decision.confidence.toFixed(2)}`
    case "valid":
      return `valid:${decision.verdict.choice}:${decision.verdict.confidence.toFixed(2)}`
  }
}

/** The log-relevant fields distilled from any decision. */
type DecisionSummary = {
  readonly kind: DecisionKind
  readonly decision: string | null
  readonly confidence: number | null
}

/** Distill a choice decision into the fields the decision log records. */
function summarizeChoice<T extends string>(decision: Decision<ChoiceVerdict<T>>): DecisionSummary {
  switch (decision.kind) {
    case "valid":
      return {
        kind: "valid",
        decision: decision.verdict.choice,
        confidence: decision.verdict.confidence,
      }
    case "abstain":
      return {
        kind: "abstain",
        decision: decision.verdict.choice,
        confidence: decision.confidence,
      }
    case "invalid":
      return { kind: "invalid", decision: null, confidence: null }
    case "unavailable":
      return { kind: "unavailable", decision: null, confidence: null }
  }
}

/** Distill a noul (probability) decision into the fields the decision log records. */
function summarizeNoul(decision: Decision<number>): DecisionSummary {
  switch (decision.kind) {
    case "valid":
      return { kind: "valid", decision: null, confidence: decision.verdict }
    case "abstain":
      return { kind: "abstain", decision: null, confidence: decision.confidence }
    case "invalid":
      return { kind: "invalid", decision: null, confidence: null }
    case "unavailable":
      return { kind: "unavailable", decision: null, confidence: null }
  }
}

/** Reduce a base URL to its host for display, never echoing the full URL. */
function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "unset"
  try {
    return new URL(baseUrl).host
  } catch {
    return "invalid-url"
  }
}

export default (async (input, options?: PluginOptions) => {
  const { client } = input

  /**
   * Emit a structured log entry to the opencode server, never throwing.
   *
   * @param level - Log level.
   * @param message - Log message.
   * @param extra - Optional structured metadata (never secrets).
   */
  const log = async (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await client.app.log({ body: { service: SERVICE, level, message, extra } })
    } catch {
      // Logging must never break a hook.
    }
  }

  /**
   * Show a TUI toast, never throwing.
   *
   * @param message - Toast body text.
   * @param variant - Toast variant.
   * @param title - Optional toast title.
   */
  const toast = async (
    message: string,
    variant: "info" | "success" | "warning" | "error",
    title?: string,
  ): Promise<void> => {
    try {
      await client.tui.showToast({ body: { message, variant, title, duration: 5000 } })
    } catch {
      // A toast failure must never break a hook.
    }
  }

  const { config, disabledReason, warnings } = loadConfig(options ?? {})
  const warnOnce = new WarnOnce()
  const systemOne = new SystemOneClient(config, POLICY_VERSION)

  /**
   * Append a decision to the JSON log, reporting a write failure at most once.
   *
   * @param reason - A short filesystem error message (never a secret).
   */
  const onLogError = (reason: string): void => {
    if (warnOnce.claim(`decision-log:${reason}`)) {
      void log("warn", "Jev decision log write failed", { reason })
    }
  }

  const decisionLog: DecisionLogOptions = {
    path: config.decisionLogPath,
    maxBytes: config.decisionLogMaxBytes,
    backups: config.decisionLogBackups,
    onError: onLogError,
  }

  /**
   * Record one decision: append it to the JSON log and, when enabled, toast a
   * compact one-line summary. Never throws.
   *
   * @param hook - The hook or tool that produced the decision.
   * @param summary - The distilled decision fields.
   * @param action - What the plugin did in response.
   * @param detail - Optional short, non-secret note.
   */
  const record = async (
    hook: string,
    summary: DecisionSummary,
    action: DecisionAction,
    detail?: string,
  ): Promise<void> => {
    await appendDecision(
      {
        hook,
        kind: summary.kind,
        decision: summary.decision,
        confidence: summary.confidence,
        action,
        ...(detail !== undefined ? { detail } : {}),
      },
      decisionLog,
    )
    if (!config.toastDecisions) return
    const label =
      summary.decision ??
      (summary.confidence !== null ? summary.confidence.toFixed(2) : summary.kind)
    const variant = summary.kind === "valid" ? "info" : "warning"
    await toast(`Jev ${hook}: ${summary.kind} ${label} (${action})`, variant, "Jev decision")
  }

  for (const warning of warnings) {
    await log("warn", "Ignored invalid JEV plugin option", {
      field: warning.field,
      reason: warning.reason,
    })
  }

  if (disabledReason) {
    await log("warn", disabledMessage(disabledReason))
  } else {
    const baseUrlHost = hostOf(config.baseUrl)
    const startupProof = `Jev enabled: model=${config.model}, baseUrl=${baseUrlHost}, key=${config.apiKey ? "set" : "missing"}`
    await log("info", startupProof, {
      model: config.model,
      baseUrl: baseUrlHost,
      key: config.apiKey ? "set" : "missing",
    })
    // The startup toast is part of the opt-in "toast every decision" mode: with
    // it off, the default install keeps exactly the three decision toasts and
    // proves liveness through the server log line instead.
    if (config.toastDecisions) await toast(startupProof, "info", "Jev enabled")
  }

  /**
   * Report an unavailable/invalid verdict for a high-impact action.
   *
   * The plugin never auto-allows, so this is a warning only: opencode's native
   * permission flow still gates the action.
   *
   * @param label - A short label naming the action.
   * @param category - The action category.
   * @param decision - The non-actionable decision.
   */
  const reportUnavailable = async (
    label: string,
    category: ActionCategory,
    decision: RiskDecision,
  ): Promise<void> => {
    const policy = failurePolicy(category)
    const detail = describeDecision(decision)
    if (policy === "warn" && warnOnce.claim(`${label}:${detail}`)) {
      await log("warn", "Jev could not produce an actionable verdict for a high-impact action", {
        label,
        category,
        detail,
      })
    }
  }

  const jevDecide = tool({
    description:
      "Ask TypeSafe Jev (System One) a structured judgment about arbitrary state, routed through the router provider. Supports choice, score, and noul question types and returns the typed answer as JSON.",
    args: {
      state: tool.schema.string().describe("The text or JSON state to evaluate."),
      type: tool.schema.enum(["choice", "score", "noul"]).describe("Question type to ask."),
      instructions: tool.schema.string().describe("The question asked about the state."),
      choiceCriteria: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .optional()
        .describe("For type=choice: map of label to description (min 2 labels)."),
      scoreCriteria: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("For type=score: ordered rubric indexed from 0 (min 2 entries)."),
      noulCriteria: tool.schema
        .object({
          true: tool.schema.string().optional(),
          false: tool.schema.string().optional(),
        })
        .optional()
        .describe("For type=noul: optional yes/no outcome descriptions."),
      model: tool.schema
        .string()
        .optional()
        .describe("Optional Jev model override (defaults to JEV_MODEL)."),
    },
    async execute(args) {
      if (!config.enabled) {
        return disabledMessage(disabledReason ?? "missing-base-url")
      }
      const questions: Record<string, Question> | undefined = (() => {
        if (args.type === "choice") {
          if (!args.choiceCriteria || Object.keys(args.choiceCriteria).length < 2) return undefined
          return { judgment: choice(args.instructions, args.choiceCriteria) }
        }
        if (args.type === "score") {
          if (!args.scoreCriteria || args.scoreCriteria.length < 2) return undefined
          return {
            judgment: score(args.instructions, args.scoreCriteria as [string, string, ...string[]]),
          }
        }
        return { judgment: noul(args.instructions, args.noulCriteria ?? undefined) }
      })()
      if (!questions) return `type=${args.type} requires at least two criteria entries.`

      const result = await systemOne.request(args.state, questions, args.model)
      if (!result.ok) {
        await log("error", "jev_decide failed", { type: args.type, failure: result.failure.kind })
        await record("tool.jev_decide", { kind: "unavailable", decision: null, confidence: null }, "return", args.type)
        return `jev_decide failed: ${result.failure.kind}`
      }
      const parsed = parseResponse(result.body)
      if (!parsed) {
        await log("error", "jev_decide failed", { type: args.type, failure: "malformed" })
        await record("tool.jev_decide", { kind: "invalid", decision: null, confidence: null }, "return", args.type)
        return "jev_decide failed: malformed response"
      }
      await log("info", "jev_decide completed", { type: args.type, model: parsed.model })
      await record("tool.jev_decide", { kind: "valid", decision: args.type, confidence: null }, "return")
      return safeStringify({
        model: parsed.model,
        answer: parsed.answers.judgment,
        usage: parsed.usage,
      })
    },
  })

  return {
    tool: {
      jev_decide: jevDecide,
    },
    "tool.execute.before": async (hookInput, output) => {
      if (!config.enabled) return
      const local = classifyLocally(hookInput.tool, output.args)
      if (local.kind === "read_only") return
      try {
        const decision = await classifyRisk(systemOne, {
          tool: hookInput.tool,
          args: output.args,
          localSignal: local.kind === "destructive_hint" ? local.reason : undefined,
        })
        if (decision.kind === "valid") {
          await log("info", "Jev tool risk verdict", {
            tool: hookInput.tool,
            choice: decision.verdict.choice,
            confidence: decision.verdict.confidence,
          })
          const blocks =
            decision.verdict.choice === "destructive" &&
            decision.verdict.confidence > config.blockThreshold
          await record(
            "tool.execute.before",
            summarizeChoice(decision),
            blocks ? "block" : "allow",
            hookInput.tool,
          )
          if (blocks) {
            throw new JevBlockError(
              `[jev] Blocked destructive tool "${hookInput.tool}" (confidence ${decision.verdict.confidence.toFixed(3)} > ${config.blockThreshold}).`,
            )
          }
          return
        }
        // Non-actionable: never relax the native gate. Warn only for the
        // category the local pre-classification (or Jev's own history) marks
        // high-impact, and only for invalid/unavailable or a destructive hint.
        await record(
          "tool.execute.before",
          summarizeChoice(decision),
          "log",
          describeDecision(decision),
        )
        const category: ActionCategory =
          local.kind === "destructive_hint" ? "destructive" : "reversible"
        const warnWorthy =
          decision.kind === "invalid" ||
          decision.kind === "unavailable" ||
          (decision.kind === "abstain" && local.kind === "destructive_hint")
        if (warnWorthy) await reportUnavailable(hookInput.tool, category, decision)
      } catch (error) {
        if (error instanceof JevBlockError) throw error
        await log("warn", "Jev tool guard failed", { error: errorMessage(error) })
      }
    },
    "chat.message": async (_hookInput, output) => {
      if (!config.enabled) return
      try {
        const text = extractText(output.parts)
        if (!text) return
        const decision = await classifyRoute(systemOne, { message: text })
        if (decision.kind !== "valid") {
          await record("chat.message", summarizeChoice(decision), "log")
          return
        }
        await log("info", "Jev cascade classification (observe-only)", {
          route: decision.verdict.choice,
          confidence: decision.verdict.confidence,
        })
        const toastsNeedsHuman =
          decision.verdict.choice === "needs_human" &&
          decision.verdict.confidence >= config.routeThreshold
        await record("chat.message", summarizeChoice(decision), toastsNeedsHuman ? "toast" : "log")
        if (toastsNeedsHuman) {
          await toast(
            `Message classified needs_human (confidence ${decision.verdict.confidence.toFixed(2)}).`,
            "warning",
            "Jev cascade classification",
          )
        }
      } catch (error) {
        await log("warn", "Jev cascade classification failed", { error: errorMessage(error) })
      }
    },
    "experimental.session.compacting": async (_hookInput, output) => {
      if (!config.enabled) return
      try {
        const decision = await classifyNoul(
          systemOne,
          COMPACT_QUESTION_ID,
          COMPACT_INSTRUCTIONS,
          { context: output.context },
        )
        if (decision.kind !== "valid") {
          await record("experimental.session.compacting", summarizeNoul(decision), "log")
          return
        }
        await log("info", "Jev compaction judgment", { probability: decision.verdict })
        const preserve = decision.verdict >= config.compactThreshold
        await record(
          "experimental.session.compacting",
          summarizeNoul(decision),
          preserve ? "context" : "log",
        )
        if (preserve) {
          output.context.push(COMPACT_REMINDER)
        }
      } catch (error) {
        await log("warn", "Jev compaction judgment failed", { error: errorMessage(error) })
      }
    },
    event: async (hookInput) => {
      if (!config.enabled) return
      try {
        const event = hookInput.event as Event
        switch (event.type) {
          case "session.error": {
            const error = event.properties.error
            if (!error || error.name === "MessageAbortedError") return
            const severity = await classifySeverity(systemOne, {
              error,
              sessionID: event.properties.sessionID,
            })
            if (severity.kind !== "valid") {
              await record("event:session.error", summarizeChoice(severity), "log")
              return
            }
            await log("warn", "Jev session error severity", {
              severity: severity.verdict.choice,
              confidence: severity.verdict.confidence,
            })
            const toastsSeverity =
              severity.verdict.choice !== "transient" &&
              severity.verdict.confidence >= config.severityThreshold
            await record(
              "event:session.error",
              summarizeChoice(severity),
              toastsSeverity ? "toast" : "log",
            )
            if (toastsSeverity) {
              await toast(
                `Session error classified ${severity.verdict.choice} (confidence ${severity.verdict.confidence.toFixed(2)}).`,
                severity.verdict.choice === "fatal" ? "error" : "warning",
                "Jev error triage",
              )
            }
            return
          }
          case "file.edited": {
            const file = event.properties.file
            const decision = await classifyNoul(
              systemOne,
              FILE_REVIEW_QUESTION_ID,
              FILE_REVIEW_INSTRUCTIONS,
              { file },
            )
            if (decision.kind !== "valid") {
              await record("event:file.edited", summarizeNoul(decision), "log")
              return
            }
            await log("info", "Jev file edit review judgment", {
              file,
              probability: decision.verdict,
            })
            const sensitive = decision.verdict >= config.fileReviewThreshold
            await record("event:file.edited", summarizeNoul(decision), sensitive ? "toast" : "log")
            if (sensitive) {
              await toast(`Security-sensitive file edited: ${file}`, "warning", "Jev file review")
            }
            return
          }
          default:
            return
        }
      } catch (error) {
        await log("warn", "Jev event handler failed", { error: errorMessage(error) })
      }
    },
  } satisfies Hooks
}) satisfies Plugin
