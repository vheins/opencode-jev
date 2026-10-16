/**
 * Behaviour-proof integration tests for the Jev judgement pipeline.
 *
 * These close audit point 4 (MEM-031): the existing suite proved syntactically
 * valid responses, NOT that a verdict changes observable behaviour. Every test
 * here drives the real plugin factory with a stubbed `fetch` (a mocked System
 * One transport) and asserts an OBSERVABLE effect — whether the hook throws or
 * resolves, and which `action` the decision log recorded — never the response
 * shape. Each test is load-bearing: mutating the gate, the policy mapping, or
 * the per-type validation makes at least one of them fail.
 *
 * Coverage:
 * - Both postures: the automatic gate OFF (zero provider calls) and ON
 *   (destructive above threshold throws; read_only/mutating proceed).
 * - The full pipeline-action mapping, including mid-confidence `verify` and the
 *   `needs_human` -> `request-approval` deferral.
 * - Fail-open for every unavailable reason plus invalid/abstain: high-impact
 *   warns, low-risk defers, and NONE of them block.
 * - `jev_decide` per-type validation: an out-of-contract answer is rejected,
 *   never surfaced as valid.
 * - The selective trigger: a reused BLOCK still throws (additive) and a
 *   genuinely different logical decision is never suppressed.
 *
 * @module
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

import plugin from "../src/index.ts"
import { decidePolicy } from "../src/judgement.ts"

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

/** A score answer body for a given question id. */
function scoreBody(id: string, score: number): string {
  return JSON.stringify({
    model: "oc/jev-1.13-free",
    answers: { [id]: { type: "score", score, confidence: 0.8 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** A captured log entry. */
type LogEntry = { body: Record<string, unknown> }

/** Build a stub PluginInput capturing logs and toasts. */
function stubInput(): { input: PluginInput; logs: LogEntry[]; toasts: unknown[] } {
  const logs: LogEntry[] = []
  const toasts: unknown[] = []
  const client = {
    app: {
      log: async (entry: LogEntry) => {
        logs.push(entry)
        return {}
      },
    },
    tui: {
      showToast: async (entry: unknown) => {
        toasts.push(entry)
        return {}
      },
    },
  }
  const input = {
    client,
    project: {},
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: undefined,
  } as unknown as PluginInput
  return { input, logs, toasts }
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

/** Read the JSON decision-log entries a hook appended. */
async function readEntries(logPath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(logPath, "utf8")
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The message the plugin logs when a high-impact action has no verdict. */
const HIGH_IMPACT_WARN = "Jev could not produce an actionable verdict for a high-impact action"

/** Whether the captured logs contain the high-impact failure warning. */
function warnedHighImpact(logs: LogEntry[]): boolean {
  return logs.some((entry) => entry.body.message === HIGH_IMPACT_WARN)
}

/**
 * Four DISTINCT destructive patterns. Each matches a different DESTRUCTIVE_HINTS
 * entry, so each is a distinct logical action (never grouped by the trigger
 * gate) — used where a test needs several independent destructive judgements.
 */
const DISTINCT_DESTRUCTIVE: readonly string[] = [
  "rm -rf /a",
  "git push origin main --force",
  "git reset --hard",
  "dd if=/dev/zero of=/dev/sda",
]

/** A fifth distinct destructive pattern (matches the mkfs hint). */
const FIFTH_DESTRUCTIVE = "mkfs.ext4 /dev/sdb"

beforeEach(() => {
  process.env = { ...originalEnv, JEV_API_KEY: "test-key", JEV_BASE_URL: "https://router.example/v1/systemone" }
  // The enabled posture is the interesting one for behaviour proof; the OFF
  // posture tests delete this variable. Thresholds are pinned so boundary tests
  // are independent of any JEV_* value inherited from the ambient shell.
  process.env.JEV_TOOL_GATE = "1"
  delete process.env.JEV_BLOCK_THRESHOLD
  delete process.env.JEV_COOLDOWN_MS
  // Disable the decision log by default so no test touches the real
  // ~/.config/opencode/jev-decisions.log; the action-recording tests set a temp
  // path before loading the plugin.
  process.env.JEV_DECISION_LOG = "off"
  delete process.env.JEV_TOAST_DECISIONS
  delete process.env.JEV_TRACE_LOG
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

// --- posture (a): the automatic gate is OFF by default ---------------------

test("posture OFF: tool.execute.before makes ZERO provider calls and never blocks", async () => {
  delete process.env.JEV_TOOL_GATE
  const { input } = stubInput()
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response(choiceBody("risk", "destructive", 0.99), { status: 200 })
  }) as typeof fetch
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  // A destructive call that the enabled gate WOULD block must pass untouched.
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /" } })
  assert.equal(called, false, "the default posture must make no network call")
})

// --- posture (b): the enabled gate changes observable behaviour -------------

test("posture ON: a destructive verdict above the threshold THROWS and records action=block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-int-block-"))
  try {
    const logPath = join(dir, "d.log")
    process.env.JEV_DECISION_LOG = logPath
    const { input } = stubInput()
    globalThis.fetch = (async () =>
      new Response(choiceBody("risk", "destructive", 0.95), { status: 200 })) as typeof fetch
    const hooks = await plugin(input)
    const before = hooks["tool.execute.before"]
    assert.ok(before)
    await assert.rejects(
      () => before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } }),
      /Blocked destructive tool/,
    )
    const entries = await readEntries(logPath)
    assert.equal(entries[0]?.action, "block", "the block must be recorded as an observable action")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("posture ON: a read_only tool makes ZERO provider calls and never blocks", async () => {
  const { input } = stubInput()
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response(choiceBody("risk", "read_only", 0.9), { status: 200 })
  }) as typeof fetch
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: "/etc/hosts" } })
  assert.equal(called, false, "a known read-only tool must skip the network even when the gate is on")
})

test("posture ON: a mutating verdict PROCEEDS and records action=allow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-int-allow-"))
  try {
    const logPath = join(dir, "d.log")
    process.env.JEV_DECISION_LOG = logPath
    const { input } = stubInput()
    globalThis.fetch = (async () =>
      new Response(choiceBody("risk", "mutating", 0.9), { status: 200 })) as typeof fetch
    const hooks = await plugin(input)
    const before = hooks["tool.execute.before"]
    assert.ok(before)
    await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi > x.txt" } })
    const entries = await readEntries(logPath)
    assert.equal(entries[0]?.action, "allow", "a non-destructive verdict must proceed and be recorded as allow")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("posture ON: a mid-confidence destructive verdict VERIFIES (no throw, counted as influence)", async () => {
  const { input } = stubInput()
  globalThis.fetch = (async () =>
    // Destructive at exactly the block threshold (0.85) is NOT above it, so the
    // strict `>` block condition is false: verify, never revise/throw.
    new Response(choiceBody("risk", "destructive", 0.85), { status: 200 })) as typeof fetch
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  const metrics = hooks.tool?.jev_metrics
  assert.ok(before)
  assert.ok(metrics)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  const snap = JSON.parse(String(await metrics.execute({}, toolContext()))) as Record<string, unknown>
  // `verify` is not `proceed`, so the judgement changed the decision. If the
  // policy mapped a mid-confidence destructive verdict to `proceed`, this is 0.
  assert.equal(snap.decisionInfluence, 1, "a mid-confidence destructive verdict must map to verify, not proceed")
})

test("policy: a needs_human verdict maps to request-approval (defer, never block)", () => {
  const decision = {
    kind: "valid" as const,
    verdict: { choice: "needs_human", confidence: 0.9, probabilities: { needs_human: 0.9 } },
  }
  assert.equal(decidePolicy(decision, "reversible"), "request-approval")
})

test("posture ON: a needs_human answer to the risk question fails open (unknown-label), never blocks", async () => {
  const { input, logs } = stubInput()
  // The risk label domain has no `needs_human`; such an answer is rejected by
  // `judge` as unknown-label, so it degrades to a warn, never a false block.
  globalThis.fetch = (async () =>
    new Response(choiceBody("risk", "needs_human", 0.99), { status: 200 })) as typeof fetch
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  assert.equal(warnedHighImpact(logs), true, "an out-of-domain verdict on a high-impact action must warn, not block")
})

// --- fail-open: NO unavailable/invalid/abstain outcome ever blocks ----------

test("fail-open: timeout on a destructive hint warns (high-impact) but never blocks", async () => {
  let calls = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    })
  }) as typeof fetch
  const { input, logs } = stubInput()
  const hooks = await plugin(input, { timeoutMs: 100 })
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  assert.equal(calls, 1, "the blocking path must not retry after a timeout")
  assert.equal(warnedHighImpact(logs), true, "a high-impact timeout must warn")
})

test("fail-open: a transport error on a destructive hint never blocks", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed")
  }) as typeof fetch
  const { input, logs } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  assert.equal(warnedHighImpact(logs), true, "a transport failure on a high-impact action must warn")
})

test("fail-open: a provider error on a destructive hint never blocks", async () => {
  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch
  const { input, logs } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  assert.equal(warnedHighImpact(logs), true, "a provider failure on a high-impact action must warn")
})

test("fail-open: a busy client (no free concurrency permit) never blocks", async () => {
  let calls = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    })
  }) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input, { timeoutMs: 100 })
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  // Four concurrent distinct destructive calls hold every permit (maxConcurrent
  // is 4); the fifth fails fast as `busy` without reaching the provider.
  const inflight = DISTINCT_DESTRUCTIVE.map((command) =>
    before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } }),
  )
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: FIFTH_DESTRUCTIVE } })
  await Promise.allSettled(inflight)
  assert.equal(calls, 4, "the busy call must not reach the provider")
})

test("fail-open: an open circuit breaker fails fast (no network) and never blocks", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response("down", { status: 500 })
  }) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  // Three provider failures trip the short-TTL circuit; the fourth distinct
  // destructive call is refused locally as circuit_open with no network call.
  for (const command of DISTINCT_DESTRUCTIVE.slice(0, 3)) {
    await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } })
  }
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: FIFTH_DESTRUCTIVE } })
  assert.equal(calls, 3, "once the circuit is open the call must fail fast without touching the provider")
})

test("fail-open: a malformed/empty verdict never blocks", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })) as typeof fetch
  const { input, logs } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  assert.equal(warnedHighImpact(logs), true, "an invalid verdict on a high-impact action must warn, not block")
})

test("fail-open: a low-confidence (abstain) destructive verdict never blocks", async () => {
  globalThis.fetch = (async () =>
    // Below MIN_ACTIONABLE_CONFIDENCE (0.5) -> abstain, which maps to verify.
    new Response(choiceBody("risk", "destructive", 0.3), { status: 200 })) as typeof fetch
  const { input, logs } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  assert.equal(warnedHighImpact(logs), true, "an abstain on a high-impact action must warn, not block")
})

test("fail-open: a low-risk action with no verdict defers silently (no high-impact warn)", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new TypeError("fetch failed")
  }) as typeof fetch
  const { input, logs } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  // An `unknown`-class action (no destructive hint) is category `reversible`, so
  // its failure policy is `ignore`: the hook still tried, but stays silent.
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi > x.txt" } })
  assert.equal(calls, 1, "the fail-open path must still attempt the judgement")
  assert.equal(warnedHighImpact(logs), false, "a low-risk failure must defer silently")
})

// --- jev_decide: per-type validation rejects an out-of-contract answer ------

test("tool.jev_decide: an unknown choice label is rejected, not surfaced as valid", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: "oc/jev-1.13-free",
        answers: { judgment: { type: "choice", choice: "maybe", confidence: 0.9, probabilities: { maybe: 0.9 } } },
        usage: {},
      }),
      { status: 200 },
    )) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const result = await decide.execute(
    { state: "{}", type: "choice", instructions: "?", choiceCriteria: { yes: "y", no: "n" } },
    toolContext(),
  )
  assert.match(String(result), /"valid":false/)
  assert.match(String(result), /unknown-label/)
})

test("tool.jev_decide: an out-of-range score is rejected, not surfaced as valid", async () => {
  globalThis.fetch = (async () => new Response(scoreBody("judgment", 5), { status: 200 })) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const result = await decide.execute(
    { state: "{}", type: "score", instructions: "?", scoreCriteria: ["low", "high"] },
    toolContext(),
  )
  assert.match(String(result), /"valid":false/)
  assert.match(String(result), /score-out-of-range/)
})

test("tool.jev_decide: an answer whose shape contradicts the request is rejected (wrong-type)", async () => {
  globalThis.fetch = (async () => new Response(noulBody("judgment", 0.9), { status: 200 })) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  // A noul answer to a choice request: the declared type is choice, so a noul
  // body is out of contract and must not be surfaced as a valid answer.
  const result = await decide.execute(
    { state: "{}", type: "choice", instructions: "?", choiceCriteria: { yes: "y", no: "n" } },
    toolContext(),
  )
  assert.match(String(result), /"valid":false/)
  assert.match(String(result), /wrong-type/)
})

test("tool.jev_decide: a valid in-contract answer IS surfaced as valid (control)", async () => {
  globalThis.fetch = (async () => new Response(noulBody("judgment", 0.8), { status: 200 })) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const result = await decide.execute({ state: "{}", type: "noul", instructions: "?" }, toolContext())
  assert.match(String(result), /"valid":true/)
})

// --- selective trigger: additive, and never over-suppressing ----------------

test("trigger: a reused BLOCK still throws (additive) with no second provider call", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(choiceBody("risk", "destructive", 0.99), { status: 200 })
  }) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await assert.rejects(
    () => before({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "rm -rf /tmp/one" } }),
    /Blocked destructive tool/,
  )
  // The second call of the SAME logical decision reuses the remembered block.
  await assert.rejects(
    () => before({ tool: "bash", sessionID: "s", callID: "c2" }, { args: { command: "rm -rf /var/two" } }),
    /Blocked by a reused judgement|Blocked destructive tool/,
  )
  assert.equal(calls, 1, "a reused block must not make a second provider call")
})

test("trigger: a genuinely different logical decision is NOT suppressed", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(choiceBody("risk", "mutating", 0.9), { status: 200 })
  }) as typeof fetch
  const { input } = stubInput()
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  // Two DISTINCT destructive patterns are two logical decisions.
  await before({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "rm -rf /tmp/one" } })
  await before(
    { tool: "bash", sessionID: "s", callID: "c2" },
    { args: { command: "git push origin main --force" } },
  )
  assert.equal(calls, 2, "distinct logical decisions must each reach the provider")
})
