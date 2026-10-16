/**
 * Measured JEV-call attribution for one representative write/edit action.
 *
 * FEAT-7's first deliverable is a MEASURED (not estimated) before/after count of
 * remote JEV calls per hook. This test drives the three hooks a single
 * write-then-edit flow triggers — `tool.execute.before` (risk), `event`
 * `file.edited` (security review), and `chat.message` (route) — and counts each
 * `fetch` by the question id in its body, so every call is attributed to its
 * hook.
 *
 * The assertions pin the POST-FEAT-7 target: only the risk call remains for a
 * non-sensitive file; the file-review and route calls are gone. Running this
 * against the pre-FEAT-7 source prints the BEFORE summary and fails, which is
 * the recorded baseline.
 *
 * @module
 */

import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"

import type { PluginInput } from "@opencode-ai/plugin"

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

/** The question ids that identify each decision site in a request body. */
const RISK = "risk"
const FILE_REVIEW = "security_sensitive"
const ROUTE = "route"

/**
 * Drive one representative write/edit/message action and return the per-hook
 * call counts, attributed by the question id present in each request body.
 */
async function measure(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const id = Object.keys(body.questions)[0] ?? "unknown"
    counts[id] = (counts[id] ?? 0) + 1
    const answer =
      id === RISK ? choiceBody(id, "mutating", 0.9) : noulBody(id, 0.9)
    return new Response(answer, { status: 200 })
  }) as typeof fetch

  const hooks = await plugin(stubInput())

  // 1. A write action via a non-read-only tool.
  await hooks["tool.execute.before"]?.(
    { tool: "bash", sessionID: "s", callID: "c" },
    { args: { command: "echo hi > notes.txt" } },
  )
  // 2. The resulting file edit (non-sensitive path).
  await hooks.event?.({ event: { type: "file.edited", properties: { file: "notes.txt" } } as never })
  // 3. A user message.
  await hooks["chat.message"]?.(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "add a test for the parser" } as never] },
  )
  return counts
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    JEV_API_KEY: "test-key",
    JEV_BASE_URL: "https://router.example/v1/systemone",
    JEV_DECISION_LOG: "off",
    // The automatic tool gate is OFF by default (MEM-037); this measurement
    // drives the automatic path, so it opts in explicitly.
    JEV_TOOL_GATE: "1",
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

test("measurement: one write/edit/message action makes exactly ONE JEV call (risk only)", async () => {
  const counts = await measure()
  // Emitted as evidence for the before/after table.
  console.log(`MEASUREMENT ${JSON.stringify(counts)}`)
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  assert.equal(total, 1, `expected exactly one JEV call, got ${JSON.stringify(counts)}`)
  assert.equal(counts[RISK], 1, "the risk guard is the one remaining call")
  assert.equal(counts[FILE_REVIEW] ?? 0, 0, "file.edited must make zero remote calls")
  assert.equal(counts[ROUTE] ?? 0, 0, "chat.message must make zero remote calls")
})
