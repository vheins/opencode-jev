/**
 * Integration tests for the selective trigger gate at the real hook boundary.
 *
 * These drive the actual plugin factory with a stubbed `fetch` to prove the gate
 * behavior end to end: consecutive calls of ONE logical decision collapse to a
 * single provider call, a genuinely different logical decision is never
 * suppressed, a reused BLOCK still blocks (the ADDITIVE invariant), the
 * `unknown` class is judged per call, `jev_decide` dedups an identical question,
 * and `jev_metrics` reports the counters. They live in their own file so the
 * large `plugin.test.ts` stays focused.
 *
 * @module
 */

import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"

import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

import plugin from "../src/index.ts"

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

/** A choice answer body for a given question id. */
function choiceBody(id: string, choice: string, confidence: number): string {
  return JSON.stringify({
    model: "oc/jev-1.13-free",
    answers: { [id]: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } },
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** A noul answer body for a given question id. */
function noulBody(id: string, noul: number): string {
  return JSON.stringify({
    model: "oc/jev-1.13-free",
    answers: { [id]: { type: "noul", noul } },
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** A stub PluginInput with a no-op log/toast sink. */
function stubInput(): PluginInput {
  const client = {
    app: { log: async () => ({}) },
    tui: { showToast: async () => ({}) },
  }
  return {
    client,
    project: {},
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: undefined,
  } as unknown as PluginInput
}

/** Build a minimal ToolContext for calling `jev_decide.execute`. */
function toolContext(): ToolContext {
  return {
    sessionID: "s",
    messageID: "m",
    agent: "a",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

/** Route the stubbed fetch and count the calls. */
function countingFetch(body: () => string): () => number {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(body(), { status: 200 })
  }) as typeof fetch
  return () => calls
}

beforeEach(() => {
  process.env = { ...originalEnv, JEV_API_KEY: "test-key", JEV_BASE_URL: "https://router.example/v1/systemone" }
  process.env.JEV_TOOL_GATE = "1"
  process.env.JEV_DECISION_LOG = "off"
  delete process.env.JEV_COOLDOWN_MS
  delete process.env.JEV_TOAST_DECISIONS
  delete process.env.JEV_TRACE_LOG
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

test("tool.execute.before: two calls of one destructive pattern collapse to ONE provider call", async () => {
  const calls = countingFetch(() => choiceBody("risk", "mutating", 0.9))
  const hooks = await plugin(stubInput())
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  // Same destructive pattern, different path: one logical decision.
  await before({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "rm -rf /tmp/one" } })
  await before({ tool: "bash", sessionID: "s", callID: "c2" }, { args: { command: "rm -rf /var/two" } })
  assert.equal(calls(), 1, "the same logical decision must collapse to a single provider call")
})

test("tool.execute.before: a genuinely different logical decision is NOT suppressed", async () => {
  const calls = countingFetch(() => choiceBody("risk", "mutating", 0.9))
  const hooks = await plugin(stubInput())
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  // Two DISTINCT destructive patterns are two logical decisions.
  await before({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "rm -rf /tmp/one" } })
  await before(
    { tool: "bash", sessionID: "s", callID: "c2" },
    { args: { command: "git push origin main --force" } },
  )
  assert.equal(calls(), 2, "distinct logical decisions must each reach the provider")
})

test("tool.execute.before: a reused BLOCK still blocks (additive, no second provider call)", async () => {
  const calls = countingFetch(() => choiceBody("risk", "destructive", 0.99))
  const hooks = await plugin(stubInput())
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await assert.rejects(
    () => before({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "rm -rf /tmp/one" } }),
    /Blocked destructive tool/,
  )
  // The second call of the same logical decision reuses the block: it must still
  // throw, and must not reach the provider again.
  await assert.rejects(
    () => before({ tool: "bash", sessionID: "s", callID: "c2" }, { args: { command: "rm -rf /var/two" } }),
    /Blocked by a reused judgement|Blocked destructive tool/,
  )
  assert.equal(calls(), 1, "the reused block must not make a second provider call")
})

test("tool.execute.before: an unknown-class action is judged per call (never grouped)", async () => {
  const calls = countingFetch(() => choiceBody("risk", "mutating", 0.9))
  const hooks = await plugin(stubInput())
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  const metrics = hooks.tool?.jev_metrics
  assert.ok(metrics)
  // Two different `unknown` actions must not collapse (they are not a safe
  // equivalence class). The provider cache also misses, so both reach it.
  await before({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "echo one > a.txt" } })
  await before({ tool: "bash", sessionID: "s", callID: "c2" }, { args: { command: "echo two > b.txt" } })
  assert.equal(calls(), 2, "unknown-class actions are not a safe equivalence and must each reach the provider")
  // Each ungrouped action is still counted as a triggered judgement.
  const snap = JSON.parse(String(await metrics.execute({}, toolContext()))) as Record<string, unknown>
  assert.equal(snap.triggered, 2)
  assert.equal(snap.systemOneCalls, 2)
})

test("tool.jev_decide: an identical repeated call reuses the result (one provider call)", async () => {
  const calls = countingFetch(() => noulBody("judgment", 0.8))
  const hooks = await plugin(stubInput())
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const args = { state: "{}", type: "noul" as const, instructions: "same question" }
  const first = await decide.execute(args, toolContext())
  const second = await decide.execute(args, toolContext())
  assert.match(String(first), /"valid":true/)
  assert.equal(String(second), String(first), "an identical call must replay the same result")
  assert.equal(calls(), 1, "an identical repeated judgement must not re-ask the provider")
})

test("tool.jev_decide: a distinct question is NOT suppressed", async () => {
  const calls = countingFetch(() => noulBody("judgment", 0.8))
  const hooks = await plugin(stubInput())
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  await decide.execute({ state: "{}", type: "noul", instructions: "question A" }, toolContext())
  await decide.execute({ state: "{}", type: "noul", instructions: "question B" }, toolContext())
  assert.equal(calls(), 2, "a distinct explicit question must each reach the provider")
})

test("tool.jev_metrics: reports zeroed counters before any judgement (no IO)", async () => {
  const hooks = await plugin(stubInput())
  const metrics = hooks.tool?.jev_metrics
  assert.ok(metrics)
  const snap = JSON.parse(String(await metrics.execute({}, toolContext()))) as Record<string, unknown>
  assert.equal(snap.judgements, 0)
  assert.equal(snap.systemOneCalls, 0)
  assert.equal(snap.duplicationRate, 0)
  assert.equal(snap.influenceRate, 0)
})

test("tool.jev_metrics: counts a triggered judgement and its decision influence", async () => {
  countingFetch(() => choiceBody("risk", "destructive", 0.5))
  const hooks = await plugin(stubInput())
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  const metrics = hooks.tool?.jev_metrics
  assert.ok(metrics)
  // A destructive verdict at the threshold maps to `verify` (not `proceed`), so
  // the judgement changed the decision.
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  const snap = JSON.parse(String(await metrics.execute({}, toolContext()))) as Record<string, unknown>
  assert.equal(snap.judgements, 1)
  assert.equal(snap.systemOneCalls, 1)
  assert.equal(snap.decisionInfluence, 1)
  assert.equal(snap.influenceRate, 1)
})
