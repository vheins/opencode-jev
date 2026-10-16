/**
 * Tests for the judgement layer: per-type dispatch and the policy mapping.
 *
 * These pin two contracts. First, `judge` must validate every answer type
 * against its own criteria (a choice label in the criteria map, a noul
 * probability, a score in the rubric range) and reject a criteria shape that
 * contradicts the declared type. Second, `decidePolicy` must preserve the
 * fail-open binding: only a confident negative verdict escalates, while
 * timeout/unavailable/invalid/abstain/disabled never block the host loop.
 *
 * @module
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { decidePolicy, judge } from "../src/judgement.ts"
import { DEFAULT_BLOCK_THRESHOLD } from "../src/config.ts"
import type { JudgementRequest } from "../src/domain.ts"

/** A minimal choice request over a two-label criteria map. */
function choiceRequest(criteria: Record<string, string> = { yes: "affirmative", no: "negative" }): JudgementRequest {
  return { id: "j", type: "choice", instructions: "?", state: {}, criteria }
}

// --- judge: choice ---------------------------------------------------------

test("judge: a valid choice answer validates against the criteria labels", () => {
  const decision = judge(
    choiceRequest(),
    { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } },
  )
  assert.equal(decision.kind, "valid")
  if (decision.kind === "valid" && typeof decision.verdict === "object" && "choice" in decision.verdict) {
    assert.equal(decision.verdict.choice, "yes")
  }
})

test("judge: a low-confidence choice answer becomes abstain, not a verdict to act on", () => {
  const decision = judge(
    choiceRequest(),
    { type: "choice", choice: "yes", confidence: 0.2, probabilities: { yes: 0.2, no: 0.1 } },
  )
  assert.equal(decision.kind, "abstain")
})

test("judge: an unknown choice label is invalid", () => {
  const decision = judge(
    choiceRequest(),
    { type: "choice", choice: "maybe", confidence: 0.9, probabilities: { maybe: 0.9 } },
  )
  assert.equal(decision.kind, "invalid")
  if (decision.kind === "invalid") assert.equal(decision.reason, "unknown-label")
})

test("judge: a choice request whose criteria map has fewer than two labels is rejected as wrong-type", () => {
  const decision = judge(choiceRequest({ only: "the sole label" }), {
    type: "choice",
    choice: "only",
    confidence: 0.9,
    probabilities: { only: 0.9 },
  })
  assert.deepEqual(decision, { kind: "invalid", reason: "wrong-type" })
})

test("judge: a choice request with an array criteria shape is rejected as wrong-type", () => {
  const request: JudgementRequest = {
    id: "j",
    type: "choice",
    instructions: "?",
    state: {},
    criteria: ["a", "b"],
  }
  const decision = judge(request, { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9 } })
  assert.deepEqual(decision, { kind: "invalid", reason: "wrong-type" })
})

// --- judge: noul -----------------------------------------------------------

test("judge: a valid noul answer carries the yes-probability", () => {
  const request: JudgementRequest = { id: "j", type: "noul", instructions: "?", state: {}, criteria: {} }
  const decision = judge(request, { type: "noul", noul: 0.96 })
  assert.equal(decision.kind, "valid")
  if (decision.kind === "valid") assert.equal(decision.verdict, 0.96)
})

test("judge: a non-boolean noul answer is invalid", () => {
  const request: JudgementRequest = { id: "j", type: "noul", instructions: "?", state: {}, criteria: {} }
  assert.equal(judge(request, { type: "noul", noul: 1.5 }).kind, "invalid")
  assert.equal(judge(request, { type: "choice" }).kind, "invalid")
})

// --- judge: score ----------------------------------------------------------

test("judge: a valid score answer validates against the rubric length", () => {
  const request: JudgementRequest = {
    id: "j",
    type: "score",
    instructions: "?",
    state: {},
    criteria: ["poor", "ok", "great"],
  }
  const decision = judge(request, { type: "score", score: 2, confidence: 0.7 })
  assert.equal(decision.kind, "valid")
  if (decision.kind === "valid" && typeof decision.verdict === "object" && "score" in decision.verdict) {
    assert.equal(decision.verdict.score, 2)
  }
})

test("judge: an out-of-range score answer is invalid with score-out-of-range", () => {
  const request: JudgementRequest = {
    id: "j",
    type: "score",
    instructions: "?",
    state: {},
    criteria: ["poor", "ok", "great"],
  }
  const decision = judge(request, { type: "score", score: 5, confidence: 0.7 })
  assert.deepEqual(decision, { kind: "invalid", reason: "score-out-of-range" })
})

test("judge: a score request with a sub-two rubric is rejected as wrong-type", () => {
  const request: JudgementRequest = {
    id: "j",
    type: "score",
    instructions: "?",
    state: {},
    criteria: ["only"],
  }
  assert.deepEqual(judge(request, { type: "score", score: 0 }), { kind: "invalid", reason: "wrong-type" })
})

// --- decidePolicy: valid mapping ------------------------------------------

const VALID_DESTRUCTIVE = {
  kind: "valid" as const,
  verdict: { choice: "destructive", confidence: 0.9, probabilities: { destructive: 0.9 } },
}

test("decidePolicy: a valid affirmative verdict proceeds", () => {
  const decision = {
    kind: "valid" as const,
    verdict: { choice: "read_only", confidence: 0.9, probabilities: { read_only: 0.9 } },
  }
  assert.equal(decidePolicy(decision, "reversible"), "proceed")
})

test("decidePolicy: a valid needs_human verdict requests approval", () => {
  const decision = {
    kind: "valid" as const,
    verdict: { choice: "needs_human", confidence: 0.9, probabilities: { needs_human: 0.9 } },
  }
  assert.equal(decidePolicy(decision, "reversible"), "request-approval")
})

test("decidePolicy: a confident destructive verdict revises", () => {
  assert.equal(decidePolicy(VALID_DESTRUCTIVE, "destructive"), "revise")
})

test("decidePolicy: a mid-confidence destructive verdict verifies (at or below the threshold)", () => {
  const mid = {
    kind: "valid" as const,
    verdict: {
      choice: "destructive",
      confidence: DEFAULT_BLOCK_THRESHOLD,
      probabilities: { destructive: 0.86 },
    },
  }
  assert.equal(decidePolicy(mid, "destructive"), "verify")
})

test("decidePolicy: a non-destructive verdict on a high-impact action proceeds", () => {
  const mutating = {
    kind: "valid" as const,
    verdict: { choice: "mutating", confidence: 0.9, probabilities: { mutating: 0.9 } },
  }
  assert.equal(decidePolicy(mutating, "destructive"), "proceed")
})

test("decidePolicy: an abstain verifies, never blocks", () => {
  const decision = {
    kind: "abstain" as const,
    verdict: { choice: "destructive", confidence: 0.2, probabilities: { destructive: 0.2 } },
    confidence: 0.2,
  }
  assert.equal(decidePolicy(decision, "destructive"), "verify")
})

// --- decidePolicy: fail-open (mutation-proof) -----------------------------

test("decidePolicy: every unavailable reason fails open, never a block", () => {
  const reasons = ["timeout", "transport", "provider", "busy", "circuit_open"] as const
  for (const reason of reasons) {
    // Low-risk -> proceed; high-impact -> verify. Neither is revise/block.
    assert.equal(decidePolicy({ kind: "unavailable", reason }, "reversible"), "proceed", reason)
    assert.equal(decidePolicy({ kind: "unavailable", reason }, "destructive"), "verify", reason)
  }
})

test("decidePolicy: an invalid decision fails open, never a block", () => {
  assert.equal(decidePolicy({ kind: "invalid", reason: "wrong-type" }, "reversible"), "proceed")
  assert.equal(decidePolicy({ kind: "invalid", reason: "score-out-of-range" }, "destructive"), "verify")
})

test("decidePolicy: a disabled decision is a no-op (proceed), even for a high-impact action", () => {
  assert.equal(decidePolicy({ kind: "unavailable", reason: "disabled" }, "destructive"), "proceed")
})

test("mutation proof: relaxing the score range bound would let an out-of-range score validate", () => {
  const request: JudgementRequest = {
    id: "j",
    type: "score",
    instructions: "?",
    state: {},
    criteria: ["poor", "ok", "great"],
  }
  // score=3 is exactly one past the last valid index (2); if the `score > max`
  // guard were removed this would validate and the assertion below would fail.
  const decision = judge(request, { type: "score", score: 3, confidence: 0.7 })
  assert.equal(decision.kind, "invalid")
  if (decision.kind === "invalid") assert.equal(decision.reason, "score-out-of-range")
})

test("mutation proof: fail-open depends on the destructive branch, not on any default", () => {
  // If decidePolicy mapped every unavailable outcome to 'revise', this fails.
  const low = decidePolicy({ kind: "unavailable", reason: "timeout" }, "reversible")
  const high = decidePolicy({ kind: "unavailable", reason: "timeout" }, "high_impact")
  assert.notEqual(low, "revise")
  assert.notEqual(high, "revise")
  assert.equal(low, "proceed")
  assert.equal(high, "verify")
})
