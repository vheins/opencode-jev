/**
 * Tests for response validation and decision evaluation.
 *
 * The validator is the trust boundary between an untrusted remote answer and a
 * typed decision, so these tests exercise every rejection path: missing
 * answers, wrong types, unknown labels, non-finite or out-of-range
 * confidences, contradictory probability maps, and the abstain floor.
 *
 * @module
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyConfidence,
  parseResponse,
  validateChoice,
  validateNoul,
} from "../src/validate.ts"
import { MIN_ACTIONABLE_CONFIDENCE } from "../src/domain.ts"

const LABELS = ["read_only", "mutating", "destructive"] as const

test("parseResponse: accepts a well-formed envelope", () => {
  const parsed = parseResponse({
    model: "oc/jev-1.13-free",
    answers: { risk: { type: "choice" } },
    usage: { input_tokens: 3, output_tokens: 1 },
  })
  assert.ok(parsed)
  assert.equal(parsed.model, "oc/jev-1.13-free")
  assert.deepEqual(parsed.usage, { inputTokens: 3, outputTokens: 1 })
})

test("parseResponse: rejects non-object, missing answers, missing model", () => {
  assert.equal(parseResponse(null), undefined)
  assert.equal(parseResponse("nope"), undefined)
  assert.equal(parseResponse([]), undefined)
  assert.equal(parseResponse({ model: "m" }), undefined)
  assert.equal(parseResponse({ answers: {} }), undefined)
  assert.equal(parseResponse({ model: "m", answers: [] }), undefined)
})

test("parseResponse: normalizes absent usage to zeros", () => {
  const parsed = parseResponse({ model: "m", answers: {} })
  assert.ok(parsed)
  assert.deepEqual(parsed.usage, { inputTokens: 0, outputTokens: 0 })
})

test("validateChoice: accepts a valid label with confidence", () => {
  const result = validateChoice(
    { type: "choice", choice: "destructive", confidence: 0.9, probabilities: { destructive: 0.9, mutating: 0.1 } },
    LABELS,
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.verdict.choice, "destructive")
})

test("validateChoice: rejects a missing answer", () => {
  assert.deepEqual(validateChoice(undefined, LABELS), { ok: false, reason: "missing-answer" })
  assert.deepEqual(validateChoice(null, LABELS), { ok: false, reason: "missing-answer" })
})

test("validateChoice: rejects a wrong type", () => {
  assert.deepEqual(validateChoice({ type: "noul", noul: 0.5 }, LABELS), { ok: false, reason: "wrong-type" })
  assert.deepEqual(validateChoice("destructive", LABELS), { ok: false, reason: "wrong-type" })
})

test("validateChoice: rejects an unknown label", () => {
  const result = validateChoice(
    { type: "choice", choice: "delete_everything", confidence: 0.9, probabilities: { delete_everything: 0.9 } },
    LABELS,
  )
  assert.deepEqual(result, { ok: false, reason: "unknown-label" })
})

test("validateChoice: rejects a non-finite or out-of-range confidence", () => {
  for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1, "0.9"]) {
    const result = validateChoice(
      { type: "choice", choice: "mutating", confidence, probabilities: { mutating: 0.9 } },
      LABELS,
    )
    assert.deepEqual(result, { ok: false, reason: "confidence-out-of-range" }, `confidence=${String(confidence)}`)
  }
})

test("validateChoice: rejects a non-unit-interval probability map", () => {
  const result = validateChoice(
    { type: "choice", choice: "mutating", confidence: 0.9, probabilities: { mutating: 2 } },
    LABELS,
  )
  assert.deepEqual(result, { ok: false, reason: "confidence-out-of-range" })
})

test("validateChoice: rejects a contradictory answer (label below another label's probability)", () => {
  const result = validateChoice(
    { type: "choice", choice: "mutating", confidence: 0.9, probabilities: { mutating: 0.2, destructive: 0.8 } },
    LABELS,
  )
  assert.deepEqual(result, { ok: false, reason: "contradictory" })
})

test("validateNoul: accepts a unit-interval probability", () => {
  assert.deepEqual(validateNoul({ type: "noul", noul: 0.96 }), { ok: true, probability: 0.96 })
})

test("validateNoul: rejects missing, wrong type, and out-of-range", () => {
  assert.deepEqual(validateNoul(undefined), { ok: false, reason: "missing-answer" })
  assert.deepEqual(validateNoul({ type: "choice" }), { ok: false, reason: "wrong-type" })
  assert.deepEqual(validateNoul({ type: "noul", noul: 1.5 }), { ok: false, reason: "confidence-out-of-range" })
  assert.deepEqual(validateNoul({ type: "noul", noul: Number.NaN }), { ok: false, reason: "confidence-out-of-range" })
})

test("classifyConfidence: above the floor is valid, below is abstain", () => {
  const high = classifyConfidence({ choice: "destructive" as const, confidence: 0.9, probabilities: {} })
  assert.equal(high.kind, "valid")

  const low = classifyConfidence({
    choice: "destructive" as const,
    confidence: MIN_ACTIONABLE_CONFIDENCE - 0.01,
    probabilities: {},
  })
  assert.equal(low.kind, "abstain")
  if (low.kind === "abstain") assert.equal(low.confidence, MIN_ACTIONABLE_CONFIDENCE - 0.01)
})

test("classifyConfidence: exactly at the floor is valid", () => {
  const atFloor = classifyConfidence({
    choice: "mutating" as const,
    confidence: MIN_ACTIONABLE_CONFIDENCE,
    probabilities: {},
  })
  assert.equal(atFloor.kind, "valid")
})
