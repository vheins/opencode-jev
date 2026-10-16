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
 * - `tool.jev_decide`: exposes Choice / Score / Noul judgments over arbitrary
 *   state as a callable tool, validated per type. This is the primary,
 *   on-demand judgement path.
 * - `tool.execute.before`: the OPTIONAL automatic risk gate. OFF by default
 *   (enable with the `enableToolGate` option or `JEV_TOOL_GATE`); when enabled
 *   it classifies a tool call and blocks a destructive action whose confidence
 *   exceeds the block threshold. It can only ever add a block; it never
 *   auto-allows, so opencode's native permission flow remains the sole gate.
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
  classifySeverity,
  RISK_INSTRUCTIONS,
  RISK_QUESTION_ID,
} from "./decisions.ts"
import {
  RISK_CRITERIA,
  type ChoiceVerdict,
  type Decision,
  type JudgedDecision,
  type JudgedVerdict,
  type JudgementRequest,
  type LogLevel,
} from "./domain.ts"
import { decidePolicy, isChoiceVerdict, judge } from "./judgement.ts"
import {
  classifyFileSensitivity,
  classifyLocally,
  classifyMessage,
  failurePolicy,
  riskCacheScope,
  riskLogicalKey,
  type ActionCategory,
  type LocalClassification,
} from "./policy.ts"
import type { TraceLogOptions } from "./trace-log.ts"
import { gateJudgement, TriggerGate, TriggerMetrics } from "./trigger.ts"
import { parseResponse, unavailable } from "./validate.ts"
/** Log service name stamped on every entry this plugin emits. */
const SERVICE = "opencode-jev"

/**
 * Decision-policy version.
 *
 * Bump this whenever decision semantics, thresholds, or question wording
 * change so a cached decision cannot outlive the policy that produced it.
 */
const POLICY_VERSION = "2"

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

/** Describe a judged (choice | noul | score) verdict for logging. */
function describeJudged(decision: JudgedDecision): string {
  switch (decision.kind) {
    case "invalid":
      return `invalid:${decision.reason}`
    case "unavailable":
      return decision.detail === undefined
        ? `unavailable:${decision.reason}`
        : `unavailable:${decision.reason} (${decision.detail})`
    case "abstain":
      return `abstain:${decision.confidence.toFixed(2)}`
    case "valid":
      if (isChoiceVerdict(decision.verdict)) {
        return `valid:${decision.verdict.choice}:${decision.verdict.confidence.toFixed(2)}`
      }
      if (typeof decision.verdict === "number") {
        return `valid:${decision.verdict.toFixed(2)}`
      }
      return `valid:score:${decision.verdict.score}`
  }
}

/** Distill a judged (choice | noul | score) decision for the decision log. */
function summarizeJudged(decision: JudgedDecision): DecisionSummary {
  if (decision.kind === "valid") {
    if (isChoiceVerdict(decision.verdict)) {
      return {
        kind: "valid",
        decision: decision.verdict.choice,
        confidence: decision.verdict.confidence,
      }
    }
    if (typeof decision.verdict === "number") {
      return { kind: "valid", decision: null, confidence: decision.verdict }
    }
    return { kind: "valid", decision: `score:${decision.verdict.score}`, confidence: decision.verdict.confidence }
  }
  if (decision.kind === "abstain") {
    return isChoiceVerdict(decision.verdict)
      ? { kind: "abstain", decision: decision.verdict.choice, confidence: decision.confidence }
      : { kind: "abstain", decision: null, confidence: decision.confidence }
  }
  return { kind: decision.kind, decision: null, confidence: null }
}

/** The action category implied by the local pre-classification. */
function localCategory(local: LocalClassification): ActionCategory {
  if (local.kind === "read_only") return "read_only"
  if (local.kind === "destructive_hint") return "destructive"
  return "reversible"
}

/**
 * Build the risk judgement request for the tool gate.
 *
 * The criteria is the fixed {@link RISK_CRITERIA} label domain, so the request
 * validates against the same labels the classifier returns.
 *
 * @param tool - The tool id being invoked.
 * @param args - The tool arguments.
 * @returns A choice judgement request over the risk label domain.
 */
function riskRequest(tool: string, args: unknown): JudgementRequest {
  return {
    id: RISK_QUESTION_ID,
    type: "choice",
    instructions: RISK_INSTRUCTIONS,
    state: { tool, args },
    criteria: RISK_CRITERIA,
  }
}

/** The arguments accepted by the `jev_decide` tool. */
type JeveDecideArgs = {
  readonly type: "choice" | "score" | "noul"
  readonly instructions: string
  readonly state: string
  readonly choiceCriteria?: Record<string, string>
  readonly scoreCriteria?: readonly string[]
  readonly noulCriteria?: { readonly true?: string; readonly false?: string }
  readonly model?: string
}

/**
 * Build the judgement request for a `jev_decide` call.
 *
 * The declared `type` selects the criteria shape: a choice label map, an
 * ordered score rubric, or an (unused) empty criteria for noul. `judge` then
 * validates the answer against that same shape, so an answer whose shape
 * contradicts the request is rejected.
 *
 * @param args - The validated `jev_decide` arguments.
 * @returns The judgement request matching the declared type.
 */
function judgementRequest(args: JeveDecideArgs): JudgementRequest {
  const base = { id: "judgment", instructions: args.instructions, state: args.state }
  if (args.type === "choice") {
    return { ...base, type: "choice", criteria: args.choiceCriteria ?? {} }
  }
  if (args.type === "score") {
    return { ...base, type: "score", criteria: args.scoreCriteria ?? [] }
  }
  return { ...base, type: "noul", criteria: {} }
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

  /**
   * Append a trace-log write failure at most once.
   *
   * @param reason - A short filesystem error message (never a secret).
   */
  const onTraceError = (reason: string): void => {
    if (warnOnce.claim(`trace-log:${reason}`)) {
      void log("warn", "Jev trace log write failed", { reason })
    }
  }

  const traceLog: TraceLogOptions = {
    enabled: config.traceLog,
    path: config.traceLogPath,
    maxBytes: config.traceLogMaxBytes,
    backups: config.traceLogBackups,
    onError: onTraceError,
  }

  const systemOne = new SystemOneClient(config, POLICY_VERSION, traceLog)

  // The selective trigger gate collapses consecutive calls of ONE logical
  // decision into a single judgement; the metrics collector records the effect
  // in memory (no IO of its own). Both are ADDITIVE: a reuse replays an
  // already-computed outcome, so it can never invent an allow or relax the
  // native permission flow.
  const triggerGate = new TriggerGate({ cooldownMs: config.cooldownMs })
  const metrics = new TriggerMetrics()

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
   * @param detail - A short, non-secret description of the decision.
   */
  const reportUnavailable = async (
    label: string,
    category: ActionCategory,
    detail: string,
  ): Promise<void> => {
    const policy = failurePolicy(category)
    if (policy === "warn" && warnOnce.claim(`${label}:${detail}`)) {
      await log("warn", "Jev could not produce an actionable verdict for a high-impact action", {
        label,
        category,
        detail,
      })
    }
  }

  /**
   * Effectiveness metrics for the judgement layer, exposed as an on-demand read.
   *
   * The counters are maintained in memory as judgements happen and are derived
   * from the same signals the decision log (`action`) and trace log
   * (`durationMs`) persist, so reading them adds NO IO — nothing is read or
   * written, in particular when tracing is off. `decisionInfluence` counts
   * judgements whose action was not a silent proceed; `duplicationRate` counts
   * judgements the trigger gate served from a dedup/cooldown reuse.
   */
  const jevMetrics = tool({
    description:
      "Report effectiveness metrics for the Jev judgement layer: System One call count, added latency (ms), duplication rate, and decision-influence rate. Derived in memory from the same signals the decision/trace logs persist; reading it performs no IO.",
    args: {},
    async execute() {
      return safeStringify(metrics.snapshot())
    },
  })

  const jevDecide = tool({
    description:
      "Ask TypeSafe Jev (System One) a structured judgment about arbitrary state, routed through the router provider. Supports choice, score, and noul question types and returns the typed answer as JSON.\n\n" +
      "When to use: consult jev_decide for CONSEQUENTIAL, hard-to-reverse decisions with >=2 viable options (for example: a destructive migration, an irreversible data change, choosing between competing architectures with long-lived cost). Do NOT use it for routine actions (read, search, a small edit, a lint fix) — those do not need a judgement call.\n\n" +
      "jev_decide only informs; it never replaces the user approval gate (ASK_MECHANISM) or native OpenCode permission. If the protocol requires user approval, that gate stands regardless of any Jev verdict.",
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

      // On-demand judgement: dedup an IDENTICAL question (same tool + scope +
      // questions) so a repeated identical call reuses the result instead of
      // re-asking. Cooldown is disabled here — a distinct explicit question is a
      // distinct logical decision and must never be collapsed into another.
      //
      // A reuse is only reported when a replayable answer actually exists: this
      // handler must RETURN that answer, so an earlier identical judgement that
      // produced no valid answer (invalid/unavailable, nothing remembered) cannot
      // be served. Without the `servable` guard the gate would report a reuse the
      // handler then ignores, ask the model anyway, and count the judgement as
      // BOTH reused and a model call — breaking `systemOneCalls == triggered`.
      const fingerprint = safeStringify({
        type: args.type,
        instructions: args.instructions,
        state: args.state,
        choiceCriteria: args.choiceCriteria ?? null,
        scoreCriteria: args.scoreCriteria ?? null,
        noulCriteria: args.noulCriteria ?? null,
        model: args.model ?? null,
      })
      const gate = gateJudgement(triggerGate, metrics, "tool.jev_decide", fingerprint, {
        cooldown: false,
        servable: () => typeof triggerGate.replay("tool.jev_decide") === "string",
      })
      if (gate.kind === "reuse") {
        await log("info", "jev_decide reused an identical judgement", { type: args.type })
        const replayed = triggerGate.replay("tool.jev_decide")
        if (typeof replayed === "string") return replayed
      }

      const startedAt = Date.now()
      const result = await systemOne.request(args.state, questions, args.model, {
        trace: { hook: "tool.jev_decide", summary: args.type },
      })
      metrics.recordSystemOneCall(Date.now() - startedAt)
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
      // Validate the answer against its own type contract before it is used:
      // an out-of-contract answer (unknown choice label, non-boolean noul,
      // out-of-range score) is reported as its ACTUAL outcome, never as valid.
      const request = judgementRequest(args)
      const decision = judge(request, parsed.answers.judgment)
      await log("info", "jev_decide completed", {
        type: args.type,
        model: parsed.model,
        outcome: decision.kind,
      })
      await record("tool.jev_decide", summarizeJudged(decision), "return", describeJudged(decision))
      if (decision.kind !== "valid") {
        // Fail-open: a rejected or unavailable answer is never surfaced as a
        // verdict. The envelope-only fields are still returned for diagnosis.
        return safeStringify({
          model: parsed.model,
          valid: false,
          outcome: decision.kind,
          detail: describeJudged(decision),
          usage: parsed.usage,
        })
      }
      const answer = safeStringify({
        model: parsed.model,
        valid: true,
        answer: decision.verdict,
        usage: parsed.usage,
      })
      triggerGate.remember("tool.jev_decide", answer)
      return answer
    },
  })

  return {
    tool: {
      jev_decide: jevDecide,
      jev_metrics: jevMetrics,
    },
    "tool.execute.before": async (hookInput, output) => {
      // OPTIONAL automatic gate, OFF by default (MEM-037): judgement is
      // on-demand via `jev_decide`, and opencode's native permission flow is
      // the sole gate for tool calls. Disabled -> return before any network
      // call or local classification, so the default install adds no latency.
      if (!config.enableToolGate) return
      if (!config.enabled) return
      const local = classifyLocally(hookInput.tool, output.args)
      if (local.kind === "read_only") return
      const category = localCategory(local)
      // The selective trigger gate: a proven-safe logical key groups consecutive
      // calls of ONE logical decision, so a repeat within the cooldown window
      // replays the previous outcome instead of re-asking the model. An
      // unproven action (`undefined`) is never grouped and is judged on its own.
      const logicalKey = riskLogicalKey(hookInput.tool, output.args)
      try {
        if (logicalKey !== undefined) {
          const fingerprint = `${logicalKey}\u0000${safeStringify(output.args)}`
          const outcome = gateJudgement(triggerGate, metrics, logicalKey, fingerprint)
          if (outcome.kind === "reuse") {
            // Replay the already-computed outcome: a remembered block still
            // blocks (additive), and a remembered allow defers to the native
            // flow exactly as the original judgement did. No network call.
            const replay = triggerGate.replay(logicalKey) as
              | { readonly blocked: boolean; readonly message?: string }
              | undefined
            await log("info", "Jev tool gate reused a judgement", {
              tool: hookInput.tool,
              reason: outcome.reason,
            })
            if (replay?.blocked) throw new JevBlockError(replay.message ?? "[jev] Blocked by a reused judgement.")
            return
          }
        } else {
          // No proven-safe logical key (the `unknown` class): the action is
          // judged on its own, but it is still a judgement the metrics count.
          metrics.recordTrigger()
        }
        const startedAt = Date.now()
        // Ask Jev for the risk verdict, then validate the answer against the
        // risk label domain via `judge`. A transport failure becomes an
        // `unavailable` decision, so the same fail-open policy applies.
        const result = await systemOne.request(
          safeStringify({
            tool: hookInput.tool,
            args: output.args,
            localSignal: local.kind === "destructive_hint" ? local.reason : undefined,
          }),
          { [RISK_QUESTION_ID]: choice(RISK_INSTRUCTIONS, RISK_CRITERIA) },
          undefined,
          // Blocking hook: no retry, so worst-case blocking latency is one
          // timeout (~3s), not two. Fail-open on timeout is preserved.
          {
            retry: false,
            trace: { hook: "tool.execute.before", summary: hookInput.tool },
            // A cache scope is passed ONLY for a locally-recognized destructive
            // hint, keyed by the exact pattern it matched. Every other action
            // (the `unknown` class) omits the scope, so the client keys on the
            // full state: two distinct unknown actions can never share a cache
            // entry, and a cached non-destructive verdict can never be served to
            // a call the model could verdict destructive. read_only never
            // reaches here (it early-returns above).
            ...(local.kind === "destructive_hint"
              ? { cacheScope: riskCacheScope(hookInput.tool, output.args) }
              : {}),
          },
        )
        metrics.recordSystemOneCall(Date.now() - startedAt)
        const decision: JudgedDecision = result.ok
          ? judge(
              riskRequest(hookInput.tool, output.args),
              parseResponse(result.body)?.answers[RISK_QUESTION_ID],
            )
          : unavailable<JudgedVerdict>(result.failure.kind, result.failure.detail)
        const action = decidePolicy(decision, category, { blockThreshold: config.blockThreshold })
        metrics.recordDecision(action)
        if (decision.kind === "valid" && isChoiceVerdict(decision.verdict)) {
          const verdict = decision.verdict
          await log("info", "Jev tool risk verdict", {
            tool: hookInput.tool,
            choice: verdict.choice,
            confidence: verdict.confidence,
          })
          // `revise` is exactly destructive + confidence > blockThreshold; the
          // throw below is the byte-identical destructive gate.
          const blocks = verdict.choice === "destructive" && verdict.confidence > config.blockThreshold
          const message = `[jev] Blocked destructive tool "${hookInput.tool}" (confidence ${verdict.confidence.toFixed(3)} > ${config.blockThreshold}).`
          if (logicalKey !== undefined) {
            triggerGate.remember(logicalKey, blocks ? { blocked: true, message } : { blocked: false })
          }
          await record(
            "tool.execute.before",
            summarizeChoice({ kind: "valid", verdict }),
            blocks ? "block" : "allow",
            hookInput.tool,
          )
          if (blocks) {
            throw new JevBlockError(message)
          }
          return
        }
        // Non-actionable: never relax the native gate. `verify` (the fail-open
        // mapping for invalid/unavailable/abstain) warns only for the category
        // the failure policy marks high-impact; low-risk stays silent.
        await record(
          "tool.execute.before",
          summarizeJudged(decision),
          "log",
          describeJudged(decision),
        )
        if (action === "verify") {
          await reportUnavailable(hookInput.tool, category, describeJudged(decision))
        }
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
        // Observe-only: hooks return Promise<void> and cannot reroute a
        // message, so a per-message Jev call would produce a verdict with no
        // action. A deterministic local check keeps the advisory at zero cost.
        const classification = classifyMessage(text)
        const needsHuman = classification.score >= config.routeThreshold
        const summary: DecisionSummary = {
          kind: "valid",
          decision: needsHuman ? "needs_human" : "code_only",
          confidence: classification.score,
        }
        if (needsHuman) {
          await log("info", "Message flagged high-stakes (deterministic)", {
            score: classification.score,
            reason: classification.reason,
          })
        }
        await record("chat.message", summary, needsHuman ? "toast" : "log", classification.reason)
        if (needsHuman) {
          await toast(
            `Message looks high-stakes (score ${classification.score.toFixed(2)}).`,
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
          { trace: { hook: "experimental.session.compacting", summary: COMPACT_QUESTION_ID } },
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
            const severity = await classifySeverity(
              systemOne,
              {
                error,
                sessionID: event.properties.sessionID,
              },
              { trace: { hook: "event:session.error", summary: error.name ?? "error" } },
            )
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
            // Demoted from a per-edit Jev call to a deterministic path check:
            // the advisory is unchanged, but there is no network round trip.
            const sensitivity = classifyFileSensitivity(file)
            const sensitive = sensitivity.score >= config.fileReviewThreshold
            const summary: DecisionSummary = {
              kind: "valid",
              decision: sensitive ? "security_sensitive" : "ordinary",
              confidence: sensitivity.score,
            }
            if (sensitive) {
              await log("info", "Security-sensitive file edited (deterministic)", {
                file,
                reason: sensitivity.reason,
              })
            }
            await record("event:file.edited", summary, sensitive ? "toast" : "log", file)
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
