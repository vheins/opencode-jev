/**
 * opencode-Jev integration plugin (9router-spasi routed).
 *
 * Bridges TypeSafe Jev (System One) structured judgments into opencode's
 * built-in plugin hooks. Jev is not a model replacement: it returns typed
 * answers (Choice / Score / Noul) that this plugin branches on.
 *
 * All Jev calls go through the existing `9router-spasi` provider, which
 * exposes a pass-through route at `POST https://model.spasi.biz.id/v1/systemone`
 * (alias `/systemone`). The router forwards the body untouched and returns the
 * native System One JSON, authenticated with the same bearer key used for chat
 * models.
 *
 * Hooks provided:
 * - `tool.execute.before`: classifies every tool call and blocks destructive
 *   actions whose confidence exceeds the block threshold.
 * - `permission.ask`: arbitrates permission prompts from Jev confidence,
 *   auto-allowing confident read-only actions and denying confident
 *   destructive ones; everything else escalates to the human unchanged.
 * - `tool.jev_decide`: exposes Choice / Score / Noul judgments over arbitrary
 *   state as a callable tool.
 * - `chat.message`: cascade-routes each user message (code_only | needs_model |
 *   needs_human) and raises a toast on a confident needs_human. Never alters
 *   the message flow.
 * - `experimental.session.compacting`: scores whether the session holds
 *   unrecoverable decisions and appends a reminder line to the summary context.
 *   Never replaces the compaction prompt.
 * - `event`: handles `session.error` (severity: transient | real_bug | fatal)
 *   and `file.edited` (security-sensitive review check).
 *
 * When no spasi key is available the plugin degrades to a no-op that warns
 * once, so opencode startup never crashes. Every hook is throw-safe: a Jev
 * failure or missing key degrades to a no-op + warn and never breaks opencode's
 * flow.
 *
 * @module
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Event } from "@opencode-ai/sdk"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { choice, noul, score, type Question } from "@typesafe-ai/sdk"

/** Log service name stamped on every entry this plugin emits. */
const SERVICE = "opencode-jev"

/** Router pass-through route for System One judgments. */
const DEFAULT_BASE_URL = "https://model.spasi.biz.id/v1/systemone"

/** Fallback key file written by the 9router-spasi provider setup. */
const DEFAULT_KEY_FILE = join(homedir(), ".config", "opencode", ".spasi-key")

/**
 * Jev model id used when `JEV_MODEL` is unset.
 *
 * CONFIRMED against this deployment: POST /v1/systemone with an entitled key
 * returned HTTP 200 and `{"answers":{"is_urgent":{"type":"noul","noul":0.96}}}`.
 */
const DEFAULT_MODEL = "oc/jev-1.13-free"

/** Default confidence above which a destructive verdict blocks the action. */
const DEFAULT_BLOCK_THRESHOLD = 0.85

/** Default confidence at or above which a read-only verdict is auto-allowed. */
const DEFAULT_ALLOW_THRESHOLD = 0.7

/** Default confidence above which a cascade-routing or severity verdict surfaces a toast. */
const DEFAULT_ALERT_THRESHOLD = 0.8

/** Default confidence at or above which a compaction reminder is appended. */
const DEFAULT_COMPACT_THRESHOLD = 0.75

/** Per-request timeout (ms) for a Jev call, so a hung router never stalls a hook. */
const REQUEST_TIMEOUT_MS = 10_000

/** Risk labels and their criteria for the tool-call guardrail. */
const RISK_CRITERIA = {
  read_only: "The action only reads or inspects state and makes no changes.",
  mutating:
    "The action changes state, but the change is reversible or non-destructive.",
  destructive:
    "The action causes irreversible loss: delete, overwrite, force-push, drop, format, or similar.",
} as const

/** Cascade-routing labels for user messages. */
const ROUTE_CRITERIA = {
  code_only:
    "The request is fully answerable by direct code reading or editing with no external judgment.",
  needs_model:
    "The request needs reasoning or generation from a language model, but no human decision.",
  needs_human:
    "The request needs a human decision, approval, private context, or is ambiguous or high-stakes.",
} as const

/** Severity labels for a session error. */
const SEVERITY_CRITERIA = {
  transient: "A retryable or environmental failure that will likely clear on its own.",
  real_bug: "A genuine defect in the code or configuration that needs a fix.",
  fatal: "A failure that blocks all further progress and requires immediate human attention.",
} as const

/** A risk level produced by the guardrail classifier. */
type RiskLevel = keyof typeof RISK_CRITERIA

/** A cascade-routing label for a user message. */
type RouteLevel = keyof typeof ROUTE_CRITERIA

/** A severity label for a session error. */
type SeverityLevel = keyof typeof SEVERITY_CRITERIA

/** A classified Choice verdict with its confidence and full distribution. */
type ChoiceVerdict<T extends string> = {
  choice: T
  confidence: number
  probabilities: Record<string, number>
}

/** A classified risk verdict. */
type RiskVerdict = ChoiceVerdict<RiskLevel>

/**
 * Error thrown to block a destructive tool call.
 *
 * It is re-thrown past the hook's outer guard so an intentional block still
 * propagates to opencode, while any unexpected error degrades to a no-op.
 */
class JevBlockError extends Error {}

/** A yes/no answer as returned by the router. */
type NoulAnswer = { type: "noul"; noul: number }

/** A selected-label answer as returned by the router. */
type ChoiceAnswer = {
  type: "choice"
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

/** A scored answer as returned by the router. */
type ScoreAnswer = {
  type: "score"
  score: number
  confidence: number
  legend: Record<string, unknown>
  probabilities: Record<string, number>
}

/** Any System One answer. */
type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** The native System One response envelope. */
type SystemOneResponse = {
  model: string
  answers: Record<string, Answer>
  usage: { input_tokens: number; output_tokens: number }
}

/**
 * Parse a numeric threshold from an environment value.
 *
 * @param raw - Raw environment string, or `undefined` when unset.
 * @param fallback - Value returned when the input is missing or not finite.
 * @returns The parsed threshold, or `fallback`.
 */
function parseThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Validate a remote verdict before it is trusted for an allow/deny decision.
 *
 * Rejects unknown labels (when an allowlist is given) and non-finite or
 * out-of-range confidence values, so a malformed remote answer degrades to the
 * no-op path instead of driving a block/allow or a `toFixed` throw.
 *
 * @param choice - The remote label; checked against `allowed` when provided.
 * @param confidence - The remote confidence/probability.
 * @param allowed - Optional set of labels the question may legitimately return.
 * @returns True when the verdict is well-formed.
 */
function isValidVerdict(
  choice: unknown,
  confidence: unknown,
  allowed?: readonly string[],
): boolean {
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return false
  }
  if (allowed !== undefined && (typeof choice !== "string" || !allowed.includes(choice))) {
    return false
  }
  return true
}

/**
 * Serialize an arbitrary value to JSON without throwing on cycles or bigints.
 *
 * @param value - Value to serialize.
 * @returns A JSON string, or a stringified fallback when serialization fails.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner) =>
      typeof inner === "bigint" ? inner.toString() : inner,
    )
  } catch {
    return String(value)
  }
}

/**
 * Reduce an unknown thrown value to a readable message.
 *
 * @param error - The caught value.
 * @returns A human-readable message.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Cap a serialized state string so no Jev request body grows unbounded.
 *
 * Values at or under the cap pass through byte-identical.
 *
 * @param value - The serialized state string.
 * @param max - Maximum character count; defaults to 4000.
 * @returns The original string when within the cap, otherwise a truncated slice.
 */
function truncateState(value: string, max = 4000): string {
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Extract the concatenated text of a message's parts, bounded in length.
 *
 * @param parts - Message parts; only text parts contribute.
 * @returns The joined text, trimmed to a bounded length.
 */
function extractText(parts: ReadonlyArray<{ type?: string; text?: string }>): string {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
  return text.length > 4000 ? text.slice(0, 4000) : text
}

/**
 * Resolve the spasi API key from the environment, then the provider key file.
 *
 * @returns The trimmed key, or `undefined` when neither source yields one.
 */
function resolveApiKey(): string | undefined {
  const fromEnv = process.env.SPASI_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const fromFile = readFileSync(DEFAULT_KEY_FILE, "utf8").trim()
    return fromFile || undefined
  } catch {
    return undefined
  }
}

export default (async (input) => {
  const { client } = input

  /**
   * Emit a structured log entry to the opencode server, never throwing.
   *
   * @param level - Log level.
   * @param message - Log message.
   * @param extra - Optional structured metadata.
   */
  const log = async (
    level: "debug" | "info" | "warn" | "error",
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
      await client.tui.showToast({
        body: { message, variant, title, duration: 5000 },
      })
    } catch {
      // A toast failure must never break a hook.
    }
  }

  const apiKey = resolveApiKey()
  const baseUrl = process.env.JEV_BASE_URL?.trim() || DEFAULT_BASE_URL
  const model = process.env.JEV_MODEL?.trim() || DEFAULT_MODEL
  const blockThreshold = parseThreshold(
    process.env.JEV_BLOCK_THRESHOLD,
    DEFAULT_BLOCK_THRESHOLD,
  )
  const allowThreshold = parseThreshold(
    process.env.JEV_ALLOW_THRESHOLD,
    DEFAULT_ALLOW_THRESHOLD,
  )
  const alertThreshold = parseThreshold(
    process.env.JEV_ROUTE_THRESHOLD,
    DEFAULT_ALERT_THRESHOLD,
  )
  const severityThreshold = parseThreshold(
    process.env.JEV_SEVERITY_THRESHOLD,
    DEFAULT_ALERT_THRESHOLD,
  )
  const compactThreshold = parseThreshold(
    process.env.JEV_COMPACT_THRESHOLD,
    DEFAULT_COMPACT_THRESHOLD,
  )

  if (apiKey) {
    await log("info", "Jev router configured", { baseUrl, model })
  } else {
    await log(
      "warn",
      "No spasi key found (SPASI_API_KEY or .spasi-key); Jev guardrails are a no-op.",
    )
  }

  /**
   * POST a System One request through the 9router-spasi pass-through route.
   *
   * The router forwards the body untouched and returns native System One JSON,
   * so a raw fetch is used instead of the SDK client to keep the wire contract
   * exact for a custom base URL.
   *
   * @param state - State to evaluate (serialized when not a string).
   * @param questions - Named questions keyed by the ids used to read answers.
   * @param override - Optional model override for this call.
   * @returns The native System One response.
   * @throws {Error} When no key is configured, the transport fails, or the
   * router returns a non-2xx status.
   */
  const systemOne = async (
    state: string,
    questions: Record<string, Question>,
    override?: string,
  ): Promise<SystemOneResponse> => {
    if (!apiKey) {
      throw new Error("No spasi key configured")
    }
    const boundedState = truncateState(state)
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: override?.trim() || model,
        state: boundedState,
        questions,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(
        `systemone HTTP ${response.status}: ${detail.slice(0, 500)}`,
      )
    }
    return (await response.json()) as SystemOneResponse
  }

  /**
   * Classify the risk of an action using a Jev Choice question.
   *
   * @param state - The action description or structured state to classify.
   * @returns The verdict, or `undefined` when Jev is disabled or fails.
   */
  const classifyRisk = async (state: unknown): Promise<RiskVerdict | undefined> => {
    if (!apiKey) return undefined
    try {
      const { answers } = await systemOne(safeStringify(state), {
        risk: choice(
          "Classify the risk of the following agent action. Choose read_only if it only inspects state, mutating if it changes state reversibly, destructive if it causes irreversible loss such as delete, overwrite, force-push, drop, or format.",
          RISK_CRITERIA,
        ),
      })
      const answer = answers.risk
      if (!answer || answer.type !== "choice") return undefined
      if (!isValidVerdict(answer.choice, answer.confidence, Object.keys(RISK_CRITERIA))) {
        await log("warn", "Jev risk verdict malformed; ignoring", {
          choice: answer.choice,
          confidence: answer.confidence,
        })
        return undefined
      }
      return {
        choice: answer.choice as RiskLevel,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      }
    } catch (error) {
      await log("warn", "Jev risk classification failed", {
        error: errorMessage(error),
      })
      return undefined
    }
  }

  /**
   * Classify arbitrary state into one of a set of named labels using a Jev
   * Choice question.
   *
   * @param label - Question id used to read the answer.
   * @param instructions - The question text.
   * @param criteria - Map of label to description (at least two entries).
   * @param state - The state to classify (serialized when not a string).
   * @returns The verdict, or `undefined` when Jev is disabled or fails.
   */
  const classifyChoice = async (
    label: string,
    instructions: string,
    criteria: Record<string, string>,
    state: unknown,
  ): Promise<ChoiceVerdict<string> | undefined> => {
    if (!apiKey) return undefined
    try {
      const { answers } = await systemOne(safeStringify(state), {
        [label]: choice(instructions, criteria),
      })
      const answer = answers[label]
      if (!answer || answer.type !== "choice") return undefined
      if (!isValidVerdict(answer.choice, answer.confidence, Object.keys(criteria))) {
        await log("warn", "Jev verdict malformed; ignoring", {
          label,
          choice: answer.choice,
          confidence: answer.confidence,
        })
        return undefined
      }
      return {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      }
    } catch (error) {
      await log("warn", "Jev classification failed", {
        label,
        error: errorMessage(error),
      })
      return undefined
    }
  }

  /**
   * Ask a single Jev Noul (yes/no) question about state.
   *
   * @param label - Question id used to read the answer.
   * @param instructions - The question text.
   * @param state - The state to evaluate (serialized when not a string).
   * @returns The probability of "yes" (0..1), or `undefined` when Jev is
   * disabled or fails.
   */
  const classifyNoul = async (
    label: string,
    instructions: string,
    state: unknown,
  ): Promise<number | undefined> => {
    if (!apiKey) return undefined
    try {
      const { answers } = await systemOne(safeStringify(state), {
        [label]: noul(instructions),
      })
      const answer = answers[label]
      if (!answer || answer.type !== "noul") return undefined
      if (!isValidVerdict(undefined, answer.noul)) {
        await log("warn", "Jev noul verdict malformed; ignoring", {
          label,
          noul: answer.noul,
        })
        return undefined
      }
      return answer.noul
    } catch (error) {
      await log("warn", "Jev noul judgment failed", {
        label,
        error: errorMessage(error),
      })
      return undefined
    }
  }

  const jevDecide = tool({
    description:
      "Ask TypeSafe Jev (System One) a structured judgment about arbitrary state, routed through the 9router-spasi provider. Supports choice, score, and noul question types and returns the typed answer as JSON.",
    args: {
      state: tool.schema
        .string()
        .describe("The text or JSON state to evaluate."),
      type: tool.schema
        .enum(["choice", "score", "noul"])
        .describe("Question type to ask."),
      instructions: tool.schema
        .string()
        .describe("The question asked about the state."),
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
      if (!apiKey) {
        return "Jev is disabled: no spasi key found (SPASI_API_KEY or .spasi-key). Set it and restart opencode to enable jev_decide."
      }
      try {
        const questions = (() => {
          if (args.type === "choice") {
            if (!args.choiceCriteria || Object.keys(args.choiceCriteria).length < 2) {
              return undefined
            }
            return { judgment: choice(args.instructions, args.choiceCriteria) }
          }
          if (args.type === "score") {
            if (!args.scoreCriteria || args.scoreCriteria.length < 2) {
              return undefined
            }
            return {
              judgment: score(
                args.instructions,
                args.scoreCriteria as [string, string, ...string[]],
              ),
            }
          }
          return {
            judgment: noul(args.instructions, args.noulCriteria ?? undefined),
          }
        })()

        if (!questions) {
          return `type=${args.type} requires at least two criteria entries.`
        }

        const result = await systemOne(args.state, questions, args.model)
        await log("info", "jev_decide completed", {
          type: args.type,
          model: result.model,
        })
        return safeStringify({
          model: result.model,
          answer: result.answers.judgment,
          usage: result.usage,
        })
      } catch (error) {
        const message = errorMessage(error)
        await log("error", "jev_decide failed", { error: message })
        return `jev_decide failed: ${message}`
      }
    },
  })

  return {
    tool: {
      jev_decide: jevDecide,
    },
    "tool.execute.before": async (hookInput, output) => {
      if (!apiKey) return
      try {
        const verdict = await classifyRisk({
          tool: hookInput.tool,
          args: output.args,
        })
        if (!verdict) return
        await log("info", "Jev tool risk verdict", {
          tool: hookInput.tool,
          choice: verdict.choice,
          confidence: verdict.confidence,
        })
        if (verdict.choice === "destructive" && verdict.confidence > blockThreshold) {
          throw new JevBlockError(
            `[jev] Blocked destructive tool "${hookInput.tool}" (confidence ${verdict.confidence.toFixed(3)} > ${blockThreshold}).`,
          )
        }
      } catch (error) {
        // An intentional block must still propagate; anything else degrades to a no-op.
        if (error instanceof JevBlockError) throw error
        await log("warn", "Jev tool guard failed", { error: errorMessage(error) })
      }
    },
    "permission.ask": async (permission, output) => {
      if (!apiKey) return
      try {
        const verdict = await classifyRisk({
          permission: permission.type,
          pattern: permission.pattern,
          title: permission.title,
        })
        if (!verdict) return
        await log("info", "Jev permission verdict", {
          permission: permission.type,
          choice: verdict.choice,
          confidence: verdict.confidence,
        })
        if (verdict.choice === "read_only" && verdict.confidence >= allowThreshold) {
          output.status = "allow"
        } else if (
          verdict.choice === "destructive" &&
          verdict.confidence > blockThreshold
        ) {
          output.status = "deny"
        }
        // Otherwise leave the status untouched: opencode escalates to the human.
      } catch (error) {
        await log("warn", "Jev permission arbitration failed", {
          error: errorMessage(error),
        })
      }
    },
    "chat.message": async (_hookInput, output) => {
      if (!apiKey) return
      try {
        const text = extractText(output.parts)
        if (!text) return
        const verdict = await classifyChoice(
          "route",
          "Cascade-route this user message. Choose code_only if it is fully answerable by reading or editing code with no external judgment, needs_model if it needs language-model reasoning but no human decision, or needs_human if it needs a human decision, approval, private context, or is ambiguous or high-stakes.",
          ROUTE_CRITERIA,
          { message: text },
        )
        if (!verdict) return
        await log("info", "Jev cascade routing verdict", {
          route: verdict.choice,
          confidence: verdict.confidence,
        })
        if (verdict.choice === "needs_human" && verdict.confidence >= alertThreshold) {
          await toast(
            `Message routed to needs_human (confidence ${verdict.confidence.toFixed(2)}).`,
            "warning",
            "Jev cascade routing",
          )
        }
      } catch (error) {
        await log("warn", "Jev cascade routing failed", {
          error: errorMessage(error),
        })
      }
    },
    "experimental.session.compacting": async (_hookInput, output) => {
      if (!apiKey) return
      try {
        const probability = await classifyNoul(
          "unrecoverable",
          "Does this session hold unrecoverable decisions, findings, or context that must be preserved in the summary to avoid losing work?",
          { context: output.context },
        )
        if (probability === undefined) return
        await log("info", "Jev compaction judgment", { probability })
        if (probability >= compactThreshold) {
          output.context.push(
            "[jev] This session likely holds unrecoverable decisions; preserve decisions, findings, and next steps explicitly.",
          )
        }
      } catch (error) {
        await log("warn", "Jev compaction judgment failed", {
          error: errorMessage(error),
        })
      }
    },
    event: async (hookInput) => {
      if (!apiKey) return
      try {
        const event = hookInput.event as Event
        switch (event.type) {
          case "session.error": {
            const severity = await classifyChoice(
              "severity",
              "Classify the severity of this opencode session error. Choose transient if it is retryable or environmental, real_bug if it is a genuine defect needing a fix, or fatal if it blocks all further progress and needs immediate human attention.",
              SEVERITY_CRITERIA,
              { error: event.properties.error, sessionID: event.properties.sessionID },
            )
            if (!severity) return
            await log("warn", "Jev session error severity", {
              severity: severity.choice,
              confidence: severity.confidence,
            })
            if (
              severity.choice !== "transient" &&
              severity.confidence >= severityThreshold
            ) {
              await toast(
                `Session error classified ${severity.choice} (confidence ${severity.confidence.toFixed(2)}).`,
                severity.choice === "fatal" ? "error" : "warning",
                "Jev error triage",
              )
            }
            return
          }
          case "file.edited": {
            const file = event.properties.file
            const probability = await classifyNoul(
              "security_sensitive",
              "Is this file path security-sensitive or does it need a security review before changes are accepted?",
              { file },
            )
            if (probability === undefined) return
            await log("info", "Jev file edit review judgment", {
              file,
              probability,
            })
            if (probability >= alertThreshold) {
              await toast(
                `Security-sensitive file edited: ${file}`,
                "warning",
                "Jev file review",
              )
            }
            return
          }
          default:
            return
        }
      } catch (error) {
        await log("warn", "Jev event handler failed", {
          error: errorMessage(error),
        })
      }
    },
  } satisfies Hooks
}) satisfies Plugin
