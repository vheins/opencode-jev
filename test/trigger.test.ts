/**
 * Tests for the selective trigger gate and the effectiveness metrics.
 *
 * These pin three contracts. First, the gate collapses consecutive calls of ONE
 * logical decision: an identical fingerprint is `dedup`, a different fingerprint
 * under the same key is `cooldown` (when enabled), and a genuinely different
 * logical key is never suppressed. Second, the gate is purely ADDITIVE: it only
 * ever replays an already-computed value, never invents one. Third, the metrics
 * derive call count, latency, duplication rate, and decision-influence rate from
 * those outcomes. Two mutation proofs pin the cooldown window and the dedup key.
 *
 * @module
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { gateJudgement, TriggerGate, TriggerMetrics } from "../src/trigger.ts"

/** A controllable clock for deterministic window tests. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms: number) => (current += ms) }
}

// --- dedup -----------------------------------------------------------------

test("gate: an identical judgement within the window is deduped", () => {
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  const first = gate.decide("bash\u0000destructive:x", "fp-1")
  const second = gate.decide("bash\u0000destructive:x", "fp-1")
  assert.equal(first.kind, "trigger")
  assert.deepEqual(second, { kind: "reuse", reason: "dedup" })
})

test("gate: a different fingerprint under the same key is cooldown-suppressed by default", () => {
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  assert.equal(gate.decide("k", "fp-1").kind, "trigger")
  assert.deepEqual(gate.decide("k", "fp-2"), { kind: "reuse", reason: "cooldown" })
})

test("gate: cooldown can be disabled so only an exact dedup is reused", () => {
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  assert.equal(gate.decide("k", "fp-1", { cooldown: false }).kind, "trigger")
  // A different question is a distinct logical decision and must trigger again.
  assert.equal(gate.decide("k", "fp-2", { cooldown: false }).kind, "trigger")
  // An identical question is still deduped.
  assert.deepEqual(gate.decide("k", "fp-2", { cooldown: false }), { kind: "reuse", reason: "dedup" })
})

// --- negative: a different logical decision is not suppressed ---------------

test("gate: a genuinely different logical key is never suppressed", () => {
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  assert.equal(gate.decide("bash\u0000destructive:rm", "fp-1").kind, "trigger")
  // A distinct destructive pattern is a distinct logical action.
  assert.equal(gate.decide("bash\u0000destructive:force-push", "fp-2").kind, "trigger")
})

// --- window boundary --------------------------------------------------------

test("gate: a repeat at the window edge still reuses; past it triggers again", () => {
  const c = clock()
  const gate = new TriggerGate({ cooldownMs: 1_000, now: c.now })
  assert.equal(gate.decide("k", "fp-1").kind, "trigger")
  c.advance(999)
  assert.deepEqual(gate.decide("k", "fp-1"), { kind: "reuse", reason: "dedup" })
  c.advance(1) // now 1000 elapsed; the window is exclusive at the boundary
  assert.equal(gate.decide("k", "fp-1").kind, "trigger")
})

test("gate: the window is measured from the last trigger, not the last reuse", () => {
  const c = clock()
  const gate = new TriggerGate({ cooldownMs: 1_000, now: c.now })
  assert.equal(gate.decide("k", "fp-1").kind, "trigger")
  c.advance(900)
  assert.equal(gate.decide("k", "fp-1").kind, "reuse")
  c.advance(900) // 1800 since the trigger, but only 900 since the reuse
  assert.equal(gate.decide("k", "fp-1").kind, "trigger", "the reuse must not extend the window")
})

// --- replay is additive -----------------------------------------------------

test("gate: remember/replay returns the stored value only after a trigger", () => {
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  assert.equal(gate.replay("k"), undefined, "nothing is replayable before a trigger")
  gate.decide("k", "fp-1")
  gate.remember("k", { blocked: true, message: "boom" })
  assert.deepEqual(gate.replay("k"), { blocked: true, message: "boom" })
})

test("gate: remember on an unknown key is a no-op (never invents a value)", () => {
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  gate.remember("never-triggered", { blocked: false })
  assert.equal(gate.replay("never-triggered"), undefined)
})

// --- gateJudgement couples the decision to the metrics ----------------------

test("gateJudgement: records trigger vs reuse on the metrics", () => {
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  const metrics = new TriggerMetrics()
  assert.equal(gateJudgement(gate, metrics, "k", "fp").kind, "trigger")
  assert.equal(gateJudgement(gate, metrics, "k", "fp").kind, "reuse")
  const snap = metrics.snapshot()
  assert.equal(snap.triggered, 1)
  assert.equal(snap.reused, 1)
  assert.equal(snap.deduped, 1)
  assert.equal(snap.judgements, 2)
  assert.equal(snap.duplicationRate, 0.5)
})

// --- metrics ----------------------------------------------------------------

test("metrics: call count and latency accumulate", () => {
  const metrics = new TriggerMetrics()
  metrics.recordSystemOneCall(120)
  metrics.recordSystemOneCall(80)
  const snap = metrics.snapshot()
  assert.equal(snap.systemOneCalls, 2)
  assert.equal(snap.addedLatencyMs, 200)
})

test("metrics: a non-positive latency is counted as a call but adds no latency", () => {
  const metrics = new TriggerMetrics()
  metrics.recordSystemOneCall(0)
  metrics.recordSystemOneCall(-5)
  const snap = metrics.snapshot()
  assert.equal(snap.systemOneCalls, 2)
  assert.equal(snap.addedLatencyMs, 0)
})

test("metrics: decision influence counts every non-proceed action", () => {
  const metrics = new TriggerMetrics()
  metrics.recordTrigger()
  metrics.recordTrigger()
  metrics.recordTrigger()
  metrics.recordDecision("proceed")
  metrics.recordDecision("verify")
  metrics.recordDecision("revise")
  const snap = metrics.snapshot()
  assert.equal(snap.decisionInfluence, 2)
  assert.equal(snap.influenceRate, 2 / 3)
})

test("metrics: empty counters produce zero rates, never NaN", () => {
  const snap = new TriggerMetrics().snapshot()
  assert.equal(snap.duplicationRate, 0)
  assert.equal(snap.influenceRate, 0)
  assert.equal(snap.judgements, 0)
})

test("metrics: cooldown suppressions are counted separately from dedups", () => {
  const metrics = new TriggerMetrics()
  metrics.recordReuse("dedup")
  metrics.recordReuse("cooldown")
  metrics.recordReuse("cooldown")
  const snap = metrics.snapshot()
  assert.equal(snap.deduped, 1)
  assert.equal(snap.cooldownSuppressed, 2)
  assert.equal(snap.reused, 3)
})

// --- mutation proofs --------------------------------------------------------

test("mutation proof: the cooldown window depends on the configured duration", () => {
  // With a 1000ms window, a repeat after 500ms is suppressed. If the window
  // comparison were removed (or the window treated as always-open), the second
  // call would trigger and this assertion would fail.
  const c = clock()
  const gate = new TriggerGate({ cooldownMs: 1_000, now: c.now })
  assert.equal(gate.decide("k", "fp").kind, "trigger")
  c.advance(500)
  assert.deepEqual(gate.decide("k", "fp"), { kind: "reuse", reason: "dedup" })

  // A zero window disables reuse entirely: every call triggers.
  const open = new TriggerGate({ cooldownMs: 0, now: c.now })
  assert.equal(open.decide("k", "fp").kind, "trigger")
  assert.equal(open.decide("k", "fp").kind, "trigger")
})

test("mutation proof: the dedup key is the fingerprint, so a different question re-triggers", () => {
  // If the gate keyed only on the logical key (ignoring the fingerprint), the
  // second, different question would be reported as a `dedup` reuse instead of
  // a `cooldown` reuse — the two reasons are the discriminator.
  const gate = new TriggerGate({ cooldownMs: 1_000, now: () => 0 })
  assert.equal(gate.decide("k", "question-A").kind, "trigger")
  const different = gate.decide("k", "question-B")
  assert.equal(different.kind, "reuse")
  assert.equal(different.kind === "reuse" && different.reason, "cooldown")

  // The exact same question is a true dedup, not a cooldown.
  const same = gate.decide("k", "question-A")
  assert.equal(same.kind === "reuse" && same.reason, "dedup")
})
