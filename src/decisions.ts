/**
 * Jev-backed decision functions.
 *
 * Each function builds one named question, asks the client, and validates the
 * answer into a typed {@link Decision}. The caller never sees a bare
 * `undefined`: an absent, malformed, contradictory, timed-out, or disabled
 * answer is reported as `invalid` or `unavailable` so the per-action failure
 * policy can choose a safe response.
 *
 * @module
 */

import { choice, noul, type Question } from "@typesafe-ai/sdk"

import type { SystemOneClient } from "./client.ts"
import { safeStringify } from "./client.ts"
import {
  RISK_CRITERIA,
  RISK_LABELS,
  ROUTE_CRITERIA,
  ROUTE_LABELS,
  SEVERITY_CRITERIA,
  SEVERITY_LABELS,
  type ChoiceVerdict,
  type Decision,
  type RiskVerdict,
  type RouteVerdict,
  type SeverityVerdict,
} from "./domain.ts"
import {
  classifyConfidence,
  invalid,
  parseResponse,
  unavailable,
  validateChoice,
  validateNoul,
  type ParsedResponseShape,
} from "./validate.ts"

/** A client that can answer named questions, or report why it could not. */
export type Requester = Pick<SystemOneClient, "request">

/** The question id used for the tool-risk and permission verdicts. */
export const RISK_QUESTION_ID = "risk"

/** The question id used for the chat-message cascade route. */
export const ROUTE_QUESTION_ID = "route"

/** The question id used for the session-error severity. */
export const SEVERITY_QUESTION_ID = "severity"

/** Instructions for the tool-risk question. */
export const RISK_INSTRUCTIONS =
  "Classify the risk of the following agent action. Choose read_only if it only inspects state, mutating if it changes state reversibly, destructive if it causes irreversible loss such as delete, overwrite, force-push, drop, or format."

/** Instructions for the cascade-route question. */
export const ROUTE_INSTRUCTIONS =
  "Cascade-route this user message. Choose code_only if it is fully answerable by reading or editing code with no external judgment, needs_model if it needs language-model reasoning but no human decision, or needs_human if it needs a human decision, approval, private context, or is ambiguous or high-stakes."

/** Instructions for the session-error severity question. */
export const SEVERITY_INSTRUCTIONS =
  "Classify the severity of this opencode session error. Choose transient if it is retryable or environmental, real_bug if it is a genuine defect needing a fix, or fatal if it blocks all further progress and needs immediate human attention."

/**
 * Ask a choice question and validate the answer against its label domain.
 *
 * @param requester - The client to ask.
 * @param id - Question id used to read the answer.
 * @param instructions - The question text.
 * @param criteria - Map of label to description.
 * @param allowed - The labels the question may legitimately return.
 * @param state - The state to classify (serialized when not a string).
 * @returns A typed decision over the validated verdict.
 */
async function askChoice<T extends string>(
  requester: Requester,
  id: string,
  instructions: string,
  criteria: Record<string, string>,
  allowed: readonly T[],
  state: unknown,
): Promise<Decision<ChoiceVerdict<T>>> {
  const questions: Record<string, Question> = { [id]: choice(instructions, criteria) }
  const result = await requester.request(safeStringify(state), questions)
  if (!result.ok) return unavailable<ChoiceVerdict<T>>(result.failure.kind)
  const parsed = parseResponse(result.body)
  if (!parsed) return invalid<ChoiceVerdict<T>>("wrong-type")
  const validated = validateChoice(parsed.answers[id], allowed)
  if (!validated.ok) return invalid<ChoiceVerdict<T>>(validated.reason)
  return classifyConfidence(validated.verdict)
}

/**
 * Classify the risk of a tool action.
 *
 * @param requester - The client to ask.
 * @param state - The action description or structured state to classify.
 * @returns A typed decision over the risk verdict.
 */
export function classifyRisk(requester: Requester, state: unknown): Promise<Decision<RiskVerdict>> {
  return askChoice(
    requester,
    RISK_QUESTION_ID,
    RISK_INSTRUCTIONS,
    RISK_CRITERIA,
    RISK_LABELS,
    state,
  )
}

/**
 * Classify the cascade route of a user message.
 *
 * @param requester - The client to ask.
 * @param state - The message state to classify.
 * @returns A typed decision over the route verdict.
 */
export function classifyRoute(
  requester: Requester,
  state: unknown,
): Promise<Decision<RouteVerdict>> {
  return askChoice(
    requester,
    ROUTE_QUESTION_ID,
    ROUTE_INSTRUCTIONS,
    ROUTE_CRITERIA,
    ROUTE_LABELS,
    state,
  )
}

/**
 * Classify the severity of a session error.
 *
 * @param requester - The client to ask.
 * @param state - The error state to classify.
 * @returns A typed decision over the severity verdict.
 */
export function classifySeverity(
  requester: Requester,
  state: unknown,
): Promise<Decision<SeverityVerdict>> {
  return askChoice(
    requester,
    SEVERITY_QUESTION_ID,
    SEVERITY_INSTRUCTIONS,
    SEVERITY_CRITERIA,
    SEVERITY_LABELS,
    state,
  )
}

/**
 * Ask a noul (yes/no) question and validate the yes-probability.
 *
 * @param requester - The client to ask.
 * @param id - Question id used to read the answer.
 * @param instructions - The question text.
 * @param state - The state to evaluate (serialized when not a string).
 * @returns A decision carrying the yes-probability, or an invalid/unavailable result.
 */
export async function classifyNoul(
  requester: Requester,
  id: string,
  instructions: string,
  state: unknown,
): Promise<Decision<number>> {
  const questions: Record<string, Question> = { [id]: noul(instructions) }
  const result = await requester.request(safeStringify(state), questions)
  if (!result.ok) return unavailable<number>(result.failure.kind)
  const parsed = parseResponse(result.body)
  if (!parsed) return invalid<number>("wrong-type")
  const validated = validateNoul(parsed.answers[id])
  if (!validated.ok) return invalid<number>(validated.reason)
  return { kind: "valid", verdict: validated.probability }
}

/** Re-export the parsed response type for callers that need the raw envelope. */
export type { ParsedResponseShape }
