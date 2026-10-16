/**
 * Response validation and decision evaluation for Jev-backed decisions.
 *
 * A remote answer is untrusted: it may be the wrong type, carry an unknown
 * label, hold a non-finite or out-of-range confidence, or contradict itself
 * (a label whose own probability is below another label's). This module turns
 * a raw answer into a typed {@link Decision} so every caller branches on an
 * explicit `valid` / `abstain` / `invalid` / `unavailable` outcome instead of
 * on a bare `undefined`.
 *
 * Missing confidence or malformed output is NEVER treated as permission to
 * proceed: an `invalid` or `unavailable` result carries no verdict at all.
 *
 * @module
 */

import {
  MIN_ACTIONABLE_CONFIDENCE,
  type ChoiceVerdict,
  type Decision,
  type InvalidReason,
  type UnavailableReason,
} from "./domain.ts"

/** The normalized System One response envelope. */
export type ParsedResponseShape = {
  readonly model: string
  readonly answers: Record<string, unknown>
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
}

/** A confidence/probability that is a finite number within `[0, 1]`. */
function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

/** A record of label to probability where every value is a unit-interval number. */
function isProbabilityMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isUnitInterval)
}

/**
 * Parse a System One response envelope into a bounded shape.
 *
 * Rejects a body that is not an object, has no `answers` record, or carries a
 * `model` that is not a string. Usage is optional and normalized to numbers.
 *
 * @param body - The parsed JSON body of a System One response.
 * @returns The normalized envelope, or `undefined` when the shape is unusable.
 */
export function parseResponse(body: unknown): ParsedResponseShape | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const answers = record.answers
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return undefined
  }
  if (typeof record.model !== "string") return undefined
  const usage = record.usage
  const usageRecord =
    typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : undefined
  const inputTokens =
    typeof usageRecord?.input_tokens === "number" ? usageRecord.input_tokens : 0
  const outputTokens =
    typeof usageRecord?.output_tokens === "number" ? usageRecord.output_tokens : 0
  return {
    model: record.model,
    answers: answers as Record<string, unknown>,
    usage: { inputTokens, outputTokens },
  }
}

/** A raw choice answer before validation. */
type RawChoice = {
  readonly choice: unknown
  readonly confidence: unknown
  readonly probabilities: unknown
}

/** Narrow a raw answer to a raw choice answer. */
function asRawChoice(answer: unknown): RawChoice | undefined {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined
  const record = answer as Record<string, unknown>
  if (record.type !== "choice") return undefined
  return {
    choice: record.choice,
    confidence: record.confidence,
    probabilities: record.probabilities,
  }
}

/**
 * Validate a raw choice answer against a fixed label domain.
 *
 * A valid answer has a label drawn from `allowed`, a finite confidence in
 * `[0, 1]`, and a probability map whose values are all unit-interval numbers.
 * A contradictory answer - one whose own label probability is lower than
 * another label's - is rejected, since a confident pick must not be
 * contradicted by its own distribution.
 *
 * @param answer - The raw answer read from the response envelope.
 * @param allowed - The labels the question may legitimately return.
 * @returns The validated verdict, or a rejected decision reason.
 */
export function validateChoice<T extends string>(
  answer: unknown,
  allowed: readonly T[],
):
  | { readonly ok: true; readonly verdict: ChoiceVerdict<T> }
  | { readonly ok: false; readonly reason: InvalidReason } {
  if (answer === undefined || answer === null) {
    return { ok: false, reason: "missing-answer" }
  }
  const raw = asRawChoice(answer)
  if (!raw) return { ok: false, reason: "wrong-type" }
  if (typeof raw.choice !== "string" || !allowed.includes(raw.choice as T)) {
    return { ok: false, reason: "unknown-label" }
  }
  if (!isUnitInterval(raw.confidence)) {
    return { ok: false, reason: "confidence-out-of-range" }
  }
  if (!isProbabilityMap(raw.probabilities)) {
    return { ok: false, reason: "confidence-out-of-range" }
  }
  const label = raw.choice as T
  const probabilities = raw.probabilities as Record<string, number>
  const selected = probabilities[label]
  if (selected !== undefined) {
    const max = Math.max(...Object.values(probabilities))
    if (selected < max) return { ok: false, reason: "contradictory" }
  }
  return {
    ok: true,
    verdict: { choice: label, confidence: raw.confidence, probabilities },
  }
}

/**
 * Validate a raw noul answer as a yes-probability in `[0, 1]`.
 *
 * @param answer - The raw answer read from the response envelope.
 * @returns The validated probability, or a rejected decision reason.
 */
export function validateNoul(
  answer: unknown,
):
  | { readonly ok: true; readonly probability: number }
  | { readonly ok: false; readonly reason: InvalidReason } {
  if (answer === undefined || answer === null) {
    return { ok: false, reason: "missing-answer" }
  }
  if (typeof answer !== "object" || Array.isArray(answer)) {
    return { ok: false, reason: "wrong-type" }
  }
  const record = answer as Record<string, unknown>
  if (record.type !== "noul") return { ok: false, reason: "wrong-type" }
  if (!isUnitInterval(record.noul)) return { ok: false, reason: "confidence-out-of-range" }
  return { ok: true, probability: record.noul }
}

/**
 * Wrap a validated choice verdict as an actionable decision.
 *
 * A verdict at or above the actionable-confidence floor is `valid`; below it
 * the verdict is `abstain` and carries no action. Callers must never act on an
 * abstain.
 *
 * @param verdict - A validated verdict.
 * @returns A valid or abstain decision.
 */
export function classifyConfidence<T extends string>(
  verdict: ChoiceVerdict<T>,
): Decision<ChoiceVerdict<T>> {
  if (verdict.confidence >= MIN_ACTIONABLE_CONFIDENCE) {
    return { kind: "valid", verdict }
  }
  return { kind: "abstain", verdict, confidence: verdict.confidence }
}

/**
 * Build an unavailable decision from a reason.
 *
 * @param reason - Why no answer could be obtained.
 * @returns An unavailable decision.
 */
export function unavailable<T>(reason: UnavailableReason): Decision<T> {
  return { kind: "unavailable", reason }
}

/**
 * Build an invalid decision from a reason.
 *
 * @param reason - Why the returned answer was rejected.
 * @returns An invalid decision.
 */
export function invalid<T>(reason: InvalidReason): Decision<T> {
  return { kind: "invalid", reason }
}
