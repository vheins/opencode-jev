/**
 * Shared domain types and fixed label domains for Jev-backed decisions.
 *
 * Every decision is either a `choice` (a label drawn from a fixed domain), a
 * `noul` (a yes/no probability), or a `score` (a rubric value). The label
 * domains live here so the classifier, the response validator, and the tests
 * read from a single source.
 *
 * @module
 */

/** Risk labels and their criteria for the tool-call guardrail. */
export const RISK_CRITERIA = {
  read_only: "The action only reads or inspects state and makes no changes.",
  mutating:
    "The action changes state, but the change is reversible or non-destructive.",
  destructive:
    "The action causes irreversible loss: delete, overwrite, force-push, drop, format, or similar.",
} as const

/** A risk level produced by the guardrail classifier. */
export type RiskLevel = keyof typeof RISK_CRITERIA

/** Every valid risk label, in a stable order. */
export const RISK_LABELS: readonly RiskLevel[] = ["read_only", "mutating", "destructive"]

/** Cascade-routing labels for user messages. */
export const ROUTE_CRITERIA = {
  code_only:
    "The request is fully answerable by direct code reading or editing with no external judgment.",
  needs_model:
    "The request needs reasoning or generation from a language model, but no human decision.",
  needs_human:
    "The request needs a human decision, approval, private context, or is ambiguous or high-stakes.",
} as const

/** A cascade-routing label for a user message. */
export type RouteLevel = keyof typeof ROUTE_CRITERIA

/** Every valid route label, in a stable order. */
export const ROUTE_LABELS: readonly RouteLevel[] = ["code_only", "needs_model", "needs_human"]

/** Severity labels for a session error. */
export const SEVERITY_CRITERIA = {
  transient: "A retryable or environmental failure that will likely clear on its own.",
  real_bug: "A genuine defect in the code or configuration that needs a fix.",
  fatal: "A failure that blocks all further progress and requires immediate human attention.",
} as const

/** A severity label for a session error. */
export type SeverityLevel = keyof typeof SEVERITY_CRITERIA

/** Every valid severity label, in a stable order. */
export const SEVERITY_LABELS: readonly SeverityLevel[] = [
  "transient",
  "real_bug",
  "fatal",
]

/**
 * Minimum confidence below which a well-formed verdict is treated as
 * uncertain. The per-category action thresholds (all at or above this floor)
 * decide whether an actionable verdict is acted on.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.5

/** A validated choice verdict with its confidence and label probabilities. */
export type ChoiceVerdict<T extends string> = {
  readonly choice: T
  readonly confidence: number
  readonly probabilities: Record<string, number>
}

/** A validated risk verdict. */
export type RiskVerdict = ChoiceVerdict<RiskLevel>

/** A validated route verdict. */
export type RouteVerdict = ChoiceVerdict<RouteLevel>

/** A validated severity verdict. */
export type SeverityVerdict = ChoiceVerdict<SeverityLevel>

/** Why a Jev decision could not be obtained at all. */
export type UnavailableReason =
  | "disabled"
  | "timeout"
  | "transport"
  | "provider"
  | "busy"

/** Why a returned Jev answer was rejected as unusable. */
export type InvalidReason =
  | "missing-answer"
  | "wrong-type"
  | "unknown-label"
  | "confidence-out-of-range"
  | "contradictory"

/**
 * The result of asking Jev for a decision.
 *
 * - `valid` - a well-formed, actionable answer.
 * - `abstain` - a well-formed but uncertain answer below the actionable floor.
 * - `invalid` - a response arrived but was rejected (malformed/contradictory).
 * - `unavailable` - no answer could be obtained (disabled/timeout/transport).
 */
export type Decision<T> =
  | { readonly kind: "valid"; readonly verdict: T }
  | { readonly kind: "abstain"; readonly verdict: T; readonly confidence: number }
  | { readonly kind: "invalid"; readonly reason: InvalidReason }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }

/** A validated System One answer envelope. */
export type ParsedResponse = {
  readonly model: string
  readonly answers: Record<string, unknown>
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
}

/** Log levels emitted to the opencode server. */
export type LogLevel = "debug" | "info" | "warn" | "error"

/** Emit a structured log entry; never throws. */
export type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

/** Show a TUI toast; never throws. */
export type Notifier = (
  message: string,
  variant: "info" | "success" | "warning" | "error",
  title?: string,
) => Promise<void>
