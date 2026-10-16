/**
 * The judgement layer: one bounded decision per call, validated against its
 * own contract, then mapped to a pipeline action.
 *
 * `judge` turns an untrusted remote answer into a typed {@link JudgedDecision}
 * by dispatching on the request's declared type and reusing the per-type
 * validators. `decidePolicy` then maps a decision plus the action's category to
 * a {@link PipelineAction}, preserving the fail-open binding: only a confident
 * negative verdict on a high-impact action escalates, while invalid,
 * unavailable, abstain, and disabled outcomes never block the host loop.
 *
 * @module
 */

import { DEFAULT_BLOCK_THRESHOLD } from "./config.ts"
import {
  type ChoiceVerdict,
  type Decision,
  type JudgedDecision,
  type JudgedVerdict,
  type JudgementRequest,
  type PipelineAction,
  type ScoreVerdict,
} from "./domain.ts"
import { type ActionCategory, isHighImpact } from "./policy.ts"
import {
  classifyConfidence,
  invalid,
  validateChoice,
  validateNoul,
  validateScore,
} from "./validate.ts"

/** Per-call policy tuning; the block threshold defaults to the resolved default. */
export type PolicyOptions = {
  readonly blockThreshold?: number
}

/** Whether a verdict is a choice verdict. */
function isChoiceVerdict(verdict: JudgedVerdict): verdict is ChoiceVerdict<string> {
  return typeof verdict === "object" && verdict !== null && "choice" in verdict
}

/** Whether a verdict is a score verdict. */
function isScoreVerdict(verdict: JudgedVerdict): verdict is ScoreVerdict {
  return typeof verdict === "object" && verdict !== null && "score" in verdict
}

/**
 * Whether a verdict explicitly asks for a human decision.
 *
 * A `needs_human` choice is the routing signal; a `fatal` severity also needs
 * immediate human attention, so it maps to the same action.
 */
function needsHuman(verdict: JudgedVerdict): boolean {
  return isChoiceVerdict(verdict) && (verdict.choice === "needs_human" || verdict.choice === "fatal")
}

/** Whether a verdict is negative: a destructive choice label. */
function isNegative(verdict: JudgedVerdict): boolean {
  return isChoiceVerdict(verdict) && verdict.choice === "destructive"
}

/** The confidence the policy compares against the block threshold. */
function confidenceOf(verdict: JudgedVerdict): number {
  if (isChoiceVerdict(verdict)) return verdict.confidence
  if (isScoreVerdict(verdict)) return verdict.confidence
  return verdict
}

/**
 * Validate a raw answer against the request's declared type.
 *
 * Choice answers are validated against the criteria label set (rejecting a
 * criteria map with fewer than two labels); noul answers as a yes-probability;
 * score answers against the rubric length. A criteria shape that contradicts
 * the declared type is rejected as `wrong-type`.
 *
 * @param request - The judgement request that produced the answer.
 * @param rawAnswer - The untrusted answer read from the response envelope.
 * @returns A typed decision over the validated verdict.
 */
export function judge(request: JudgementRequest, rawAnswer: unknown): JudgedDecision {
  if (request.type === "choice") {
    if (Array.isArray(request.criteria)) return invalid("wrong-type")
    const labels = Object.keys(request.criteria)
    if (labels.length < 2) return invalid("wrong-type")
    const validated = validateChoice(rawAnswer, labels)
    if (!validated.ok) return invalid(validated.reason)
    return classifyConfidence(validated.verdict)
  }
  if (request.type === "noul") {
    const validated = validateNoul(rawAnswer)
    if (!validated.ok) return invalid(validated.reason)
    return { kind: "valid", verdict: validated.probability }
  }
  if (!Array.isArray(request.criteria) || request.criteria.length < 2) {
    return invalid("wrong-type")
  }
  const validated = validateScore(rawAnswer, request.criteria.length)
  if (!validated.ok) return invalid(validated.reason)
  return { kind: "valid", verdict: validated.verdict }
}

/**
 * Map a decision and action category to a pipeline action.
 *
 * A valid verdict that explicitly needs a human maps to `request-approval`. A
 * valid negative verdict (a `destructive` label) maps to `revise` above the
 * block threshold and to `verify` at or below it (mid-confidence). A valid
 * affirmative verdict maps to `proceed`. An abstain maps to `verify`. A
 * disabled decision is a no-op (`proceed`). Invalid and unavailable outcomes
 * (including timeout, transport, provider, busy, and circuit_open) fail open:
 * `verify` for a high-impact action (warn) and `proceed` otherwise. Only a
 * confident negative verdict can escalate.
 *
 * @param decision - The typed decision to map.
 * @param category - The action category the decision applies to.
 * @param options - Optional policy tuning (block threshold).
 * @returns The pipeline action to take.
 */
export function decidePolicy(
  decision: Decision<JudgedVerdict>,
  category: ActionCategory,
  options?: PolicyOptions,
): PipelineAction {
  const blockThreshold = options?.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD
  if (decision.kind === "valid") {
    const verdict = decision.verdict
    if (needsHuman(verdict)) return "request-approval"
    if (isNegative(verdict)) {
      return confidenceOf(verdict) > blockThreshold ? "revise" : "verify"
    }
    return "proceed"
  }
  if (decision.kind === "abstain") return "verify"
  if (decision.kind === "unavailable" && decision.reason === "disabled") return "proceed"
  return isHighImpact(category) ? "verify" : "proceed"
}
