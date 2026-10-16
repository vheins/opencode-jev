/**
 * Integration tests for the plugin hooks.
 *
 * These run the real plugin factory with a stubbed opencode client and a
 * stubbed `fetch`, so hook behavior is exercised end to end: the block path
 * under the real `tool.execute.before` contract, the read-only skip, the
 * no-op degradation when `JEV_BASE_URL` is unset, the observe-only
 * classification, and the compaction reminder. The plugin never registers a
 * `permission.ask` handler, and these tests assert that its exported hooks
 * contain no such key.
 *
 * @module
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

/** A score answer body for a given question id. */
function scoreBody(id: string, score: number): string {
  return JSON.stringify({
    model: "oc/jev-1.13-free",
    answers: {
      [id]: {
        type: "score",
        score,
        confidence: 0.8,
        legend: { "0": "low", "1": "high" },
        probabilities: { "0": 0.2, "1": 0.8 },
      },
    },
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

/** Route the stubbed fetch to a per-question body by inspecting the request. */
function routeFetch(handler: (body: { state: string; questions: Record<string, unknown> }) => Response): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, unknown> }
    return handler(body)
  }) as typeof fetch
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

beforeEach(() => {
  process.env = { ...originalEnv, JEV_API_KEY: "test-key", JEV_BASE_URL: "https://router.example/v1/systemone" }
  // Pin thresholds to the documented defaults so boundary tests are
  // independent of any JEV_* value inherited from the ambient shell.
  delete process.env.JEV_BLOCK_THRESHOLD
  delete process.env.JEV_ROUTE_THRESHOLD
  delete process.env.JEV_SEVERITY_THRESHOLD
  delete process.env.JEV_COMPACT_THRESHOLD
  delete process.env.JEV_FILE_REVIEW_THRESHOLD
  // Disable the decision log so these hook tests never write to the real
  // ~/.config/opencode/jev-decisions.log on the host.
  process.env.JEV_DECISION_LOG = "off"
  delete process.env.JEV_TOAST_DECISIONS
  // Tracing is opt-in and off by default; keep it off unless a test enables it.
  delete process.env.JEV_TRACE_LOG
  delete process.env.JEV_TRACE_LOG_PATH
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

test("hooks: never registers a permission.ask handler", async () => {
  const { input } = stubInput()
  const hooks = await plugin(input)
  assert.equal(Object.hasOwn(hooks, "permission.ask"), false)
})

test("tool.execute.before: blocks a destructive tool above the block threshold", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(choiceBody("risk", "destructive", 0.95), { status: 200 }))
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await assert.rejects(
    () => before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } }),
    /Blocked destructive tool/,
  )
})

test("tool.execute.before: does not block a destructive tool below the block threshold", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(choiceBody("risk", "destructive", 0.5), { status: 200 }))
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
})

test("tool.execute.before: read-only tools never call the provider", async () => {
  const { input } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("risk", "read_only", 0.9), { status: 200 })
  })
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: "/etc/hosts" } })
  assert.equal(called, false, "a known read-only tool must skip the network call")
})

test("tool.execute.before: a malformed verdict never blocks and never throws", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 }))
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi" } })
})

test("tool.execute.before: high-impact action during a provider failure warns but does not throw", async () => {
  const { input, logs } = stubInput()
  routeFetch(() => new Response("boom", { status: 500 }))
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /data" } })
  const warned = logs.some((entry) => entry.body.level === "warn")
  assert.equal(warned, true, "a high-impact action with no verdict must surface a warning")
})

test("tool.execute.before: unset JEV_BASE_URL degrades to a no-op and never calls the provider", async () => {
  process.env = { ...originalEnv, JEV_API_KEY: "test-key" }
  delete process.env.JEV_BASE_URL
  const { input, logs } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("risk", "destructive", 0.99), { status: 200 })
  })
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /" } })
  assert.equal(called, false, "no request may be made without a configured base URL")
  const warnedOnce = logs.filter((entry) => entry.body.level === "warn")
  assert.equal(warnedOnce.length >= 1, true)
})

test("chat.message: a high-stakes message raises a toast with zero provider calls", async () => {
  const { input, toasts } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("route", "needs_human", 0.9), { status: 200 })
  })
  const hooks = await plugin(input)
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "should I delete the prod database?" } as never] },
  )
  assert.equal(toasts.length, 1)
  assert.equal(called, false, "the deterministic check must not call the provider")
})

test("chat.message: a low-stakes message makes no provider call and no toast", async () => {
  const { input, toasts } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("route", "needs_human", 0.4), { status: 200 })
  })
  const hooks = await plugin(input)
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "hi" } as never] },
  )
  assert.equal(toasts.length, 0)
  assert.equal(called, false, "a low-stakes message must not call the provider")
})

test("experimental.session.compacting: appends the preservation reminder on a confident yes", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(noulBody("unrecoverable", 0.9), { status: 200 }))
  const hooks = await plugin(input)
  const compact = hooks["experimental.session.compacting"]
  assert.ok(compact)
  const output: { context: string[] } = { context: [] }
  await compact({ sessionID: "s" }, output)
  assert.equal(output.context.length, 1)
  assert.match(output.context[0] ?? "", /unrecoverable state/)
})

test("experimental.session.compacting: no reminder on a confident no", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(noulBody("unrecoverable", 0.1), { status: 200 }))
  const hooks = await plugin(input)
  const compact = hooks["experimental.session.compacting"]
  assert.ok(compact)
  const output: { context: string[] } = { context: [] }
  await compact({ sessionID: "s" }, output)
  assert.equal(output.context.length, 0)
})

test("event: session.error with a fatal verdict raises an error toast", async () => {
  const { input, toasts } = stubInput()
  routeFetch(() => new Response(choiceBody("severity", "fatal", 0.95), { status: 200 }))
  const hooks = await plugin(input)
  const event = hooks.event
  assert.ok(event)
  await event({
    event: {
      type: "session.error",
      properties: { sessionID: "s", error: { name: "UnknownError", data: { message: "boom" } } },
    } as never,
  })
  assert.equal(toasts.length, 1)
})

test("event: a MessageAbortedError is ignored without a provider call", async () => {
  const { input } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("severity", "transient", 0.9), { status: 200 })
  })
  const hooks = await plugin(input)
  const event = hooks.event
  assert.ok(event)
  await event({
    event: {
      type: "session.error",
      properties: { sessionID: "s", error: { name: "MessageAbortedError", data: {} } },
    } as never,
  })
  assert.equal(called, false)
})

test("event: file.edited on a security-sensitive file raises a warning toast with zero provider calls", async () => {
  const { input, toasts } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(noulBody("security_sensitive", 0.9), { status: 200 })
  })
  const hooks = await plugin(input)
  const event = hooks.event
  assert.ok(event)
  await event({ event: { type: "file.edited", properties: { file: ".env" } } as never })
  assert.equal(toasts.length, 1)
  assert.equal(called, false, "the deterministic file check must not call the provider")
})

test("hooks: every hook is throw-safe when the provider is unreachable", async () => {
  const { input } = stubInput()
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed")
  }) as typeof fetch
  const hooks = await plugin(input)
  await hooks["tool.execute.before"]?.(
    { tool: "bash", sessionID: "s", callID: "c" },
    { args: { command: "echo hi" } },
  )
  await hooks["chat.message"]?.(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "hi" } as never] },
  )
  await hooks.event?.({ event: { type: "file.edited", properties: { file: "x.ts" } } as never })
  const compact = hooks["experimental.session.compacting"]
  assert.ok(compact)
  const output: { context: string[] } = { context: [] }
  await compact({ sessionID: "s" }, output)
  assert.equal(output.context.length, 0)
})

test("tool.jev_decide: returns a disabled message when Jev is not configured", async () => {
  process.env = { ...originalEnv, JEV_API_KEY: "test-key" }
  delete process.env.JEV_BASE_URL
  const { input } = stubInput()
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const result = await decide.execute(
    { state: "{}", type: "noul", instructions: "?" },
    toolContext(),
  )
  assert.match(String(result), /No base URL set/)
})

test("tool.jev_decide: returns the typed answer when configured", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(noulBody("judgment", 0.8), { status: 200 }))
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const result = await decide.execute(
    { state: "{}", type: "noul", instructions: "?" },
    toolContext(),
  )
  assert.match(String(result), /"noul":0.8/)
})

test("tool.jev_decide: choice without two criteria is rejected locally", async () => {
  const { input } = stubInput()
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const result = await decide.execute(
    { state: "{}", type: "choice", instructions: "?", choiceCriteria: { only: "one" } },
    toolContext(),
  )
  assert.match(String(result), /at least two criteria/)
})

test("tool.jev_decide: score request returns the score answer through the provider", async () => {
  const { input } = stubInput()
  let seenType: unknown
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type?: unknown }> }
    seenType = body.questions.judgment?.type
    return new Response(scoreBody("judgment", 0.75), { status: 200 })
  }) as typeof fetch
  const hooks = await plugin(input)
  const decide = hooks.tool?.jev_decide
  assert.ok(decide)
  const result = await decide.execute(
    {
      state: "{}",
      type: "score",
      instructions: "Rate the risk",
      scoreCriteria: ["low", "high"],
    },
    toolContext(),
  )
  assert.equal(seenType, "score", "the request must carry a score question")
  assert.match(String(result), /"type":"score"/)
  assert.match(String(result), /"score":0.75/)
})

test("plugin: options.baseUrl configures Jev without any JEV_BASE_URL env", async () => {
  process.env = { ...originalEnv, JEV_API_KEY: "env-key" }
  delete process.env.JEV_BASE_URL
  const { input, logs } = stubInput()
  let calledUrl: string | undefined
  globalThis.fetch = (async (url: string) => {
    calledUrl = url
    return new Response(noulBody("risk", 0.9), { status: 200 })
  }) as typeof fetch
  const hooks = await plugin(input, { baseUrl: "https://opt.example/v1/systemone" })
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi" } })
  assert.equal(calledUrl, "https://opt.example/v1/systemone", "the option base URL must be used")
  const configured = logs.some(
    (entry) =>
      typeof entry.body.message === "string" && entry.body.message.startsWith("Jev enabled:"),
  )
  assert.equal(configured, true)
})

test("plugin: options.apiKey is sent as the bearer token and never logged", async () => {
  process.env = { ...originalEnv }
  delete process.env.JEV_API_KEY
  delete process.env.JEV_BASE_URL
  const { input, logs } = stubInput()
  const secret = "sk-option-only-secret"
  let auth: string | undefined
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined
    auth = headers?.Authorization
    return new Response(noulBody("risk", 0.9), { status: 200 })
  }) as typeof fetch
  const hooks = await plugin(input, { baseUrl: "https://opt.example/v1", apiKey: secret })
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi" } })
  assert.equal(auth, `Bearer ${secret}`)
  assert.equal(JSON.stringify(logs).includes(secret), false, "the option key must never be logged")
})

test("plugin: an invalid option is ignored with a warning and Jev still runs on env", async () => {
  process.env = { ...originalEnv, JEV_API_KEY: "env-key", JEV_BASE_URL: "https://env.example/v1" }
  const { input, logs } = stubInput()
  globalThis.fetch = (async () => new Response(noulBody("risk", 0.9), { status: 200 })) as typeof fetch
  const hooks = await plugin(input, { baseUrl: 123 })
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi" } })
  const warned = logs.some(
    (entry) => entry.body.message === "Ignored invalid JEV plugin option" && entry.body.extra !== undefined,
  )
  assert.equal(warned, true, "an invalid option must produce a warning")
})

test("plugin: with no base URL from options or env, Jev degrades to a no-op", async () => {
  process.env = { ...originalEnv, JEV_API_KEY: "env-key" }
  delete process.env.JEV_BASE_URL
  const { input, logs } = stubInput()
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response(noulBody("risk", 0.9), { status: 200 })
  }) as typeof fetch
  const hooks = await plugin(input, {})
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /" } })
  assert.equal(called, false)
  assert.equal(logs.some((entry) => entry.body.level === "warn"), true)
})

/**
 * Threshold-boundary tests.
 *
 * These pin the exact comparison operator per category. `tool.execute.before`
 * blocks on a strict `>` (a verdict exactly at `blockThreshold` must NOT
 * block); `chat.message`, compaction, `session.error`, and `file.edited` act on
 * an inclusive `>=` (a verdict exactly at the threshold MUST act). Flipping any
 * operator in `src/index.ts` makes at least one of these fail.
 */

/** Default thresholds (mirrors src/config.ts) that these boundary tests pin. */
const BLOCK_THRESHOLD = 0.85
const COMPACT_THRESHOLD = 0.75
const SEVERITY_THRESHOLD = 0.8

/** The destructive command used to trigger the risk guard. */
const DESTRUCTIVE_ARGS = { command: "rm -rf /tmp/x" }

test("boundary: destructive at exactly blockThreshold does NOT block (strict >)", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(choiceBody("risk", "destructive", BLOCK_THRESHOLD), { status: 200 }))
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: DESTRUCTIVE_ARGS })
})

test("boundary: destructive just above blockThreshold blocks (strict >)", async () => {
  const { input } = stubInput()
  routeFetch(() =>
    new Response(choiceBody("risk", "destructive", BLOCK_THRESHOLD + 1e-6), { status: 200 }),
  )
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await assert.rejects(
    () => before({ tool: "bash", sessionID: "s", callID: "c" }, { args: DESTRUCTIVE_ARGS }),
    /Blocked destructive tool/,
  )
})

test("boundary: high-stakes score at exactly routeThreshold toasts (inclusive >=)", async () => {
  const { input, toasts } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("route", "needs_human", 0.9), { status: 200 })
  })
  // A message that matches exactly one 0.5-weight signal scores exactly 0.5;
  // gating with routeThreshold=0.5 pins the inclusive `>=`.
  const hooks = await plugin(input, { routeThreshold: 0.5 })
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "please review the production config" } as never] },
  )
  assert.equal(toasts.length, 1)
  assert.equal(called, false)
})

test("boundary: high-stakes score just below routeThreshold does NOT toast", async () => {
  const { input, toasts } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("route", "needs_human", 0.4), { status: 200 })
  })
  const hooks = await plugin(input, { routeThreshold: 0.5 + 1e-6 })
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "please review the production config" } as never] },
  )
  assert.equal(toasts.length, 0)
  assert.equal(called, false)
})

test("boundary: compaction at exactly compactThreshold appends (inclusive >=)", async () => {
  const { input } = stubInput()
  routeFetch(() => new Response(noulBody("unrecoverable", COMPACT_THRESHOLD), { status: 200 }))
  const hooks = await plugin(input)
  const compact = hooks["experimental.session.compacting"]
  assert.ok(compact)
  const output: { context: string[] } = { context: [] }
  await compact({ sessionID: "s" }, output)
  assert.equal(output.context.length, 1)
})

test("boundary: compaction just below compactThreshold does NOT append", async () => {
  const { input } = stubInput()
  routeFetch(() =>
    new Response(noulBody("unrecoverable", COMPACT_THRESHOLD - 1e-6), { status: 200 }),
  )
  const hooks = await plugin(input)
  const compact = hooks["experimental.session.compacting"]
  assert.ok(compact)
  const output: { context: string[] } = { context: [] }
  await compact({ sessionID: "s" }, output)
  assert.equal(output.context.length, 0)
})

test("boundary: severity at exactly severityThreshold toasts (inclusive >=)", async () => {
  const { input, toasts } = stubInput()
  routeFetch(() => new Response(choiceBody("severity", "fatal", SEVERITY_THRESHOLD), { status: 200 }))
  const hooks = await plugin(input)
  const event = hooks.event
  assert.ok(event)
  await event({
    event: {
      type: "session.error",
      properties: { sessionID: "s", error: { name: "UnknownError", data: { message: "boom" } } },
    } as never,
  })
  assert.equal(toasts.length, 1)
})

test("boundary: severity just below severityThreshold does NOT toast", async () => {
  const { input, toasts } = stubInput()
  routeFetch(() =>
    new Response(choiceBody("severity", "fatal", SEVERITY_THRESHOLD - 1e-6), { status: 200 }),
  )
  const hooks = await plugin(input)
  const event = hooks.event
  assert.ok(event)
  await event({
    event: {
      type: "session.error",
      properties: { sessionID: "s", error: { name: "UnknownError", data: { message: "boom" } } },
    } as never,
  })
  assert.equal(toasts.length, 0)
})

test("boundary: fileReview score at exactly fileReviewThreshold toasts (inclusive >=)", async () => {
  const { input, toasts } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(noulBody("security_sensitive", 0.9), { status: 200 })
  })
  // `.env` scores exactly 0.9 in the deterministic classifier; gating with
  // fileReviewThreshold=0.9 pins the inclusive `>=`.
  const hooks = await plugin(input, { fileReviewThreshold: 0.9 })
  const event = hooks.event
  assert.ok(event)
  await event({ event: { type: "file.edited", properties: { file: ".env" } } as never })
  assert.equal(toasts.length, 1)
  assert.equal(called, false)
})

test("boundary: fileReview score just below fileReviewThreshold does NOT toast", async () => {
  const { input, toasts } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(noulBody("security_sensitive", 0.9), { status: 200 })
  })
  const hooks = await plugin(input, { fileReviewThreshold: 0.9 + 1e-6 })
  const event = hooks.event
  assert.ok(event)
  await event({ event: { type: "file.edited", properties: { file: ".env" } } as never })
  assert.equal(toasts.length, 0)
  assert.equal(called, false)
})

/**
 * Decision-observability tests: the JSON decision log and the opt-in
 * "toast every decision" mode. These use a temp log path so they never touch
 * the real `~/.config/opencode/jev-decisions.log`.
 */

test("plugin: startup proof line names model, host, and key presence but never the key", async () => {
  const secret = "sk-startup-secret-value"
  process.env = { ...originalEnv, JEV_API_KEY: secret, JEV_BASE_URL: "https://router.example/v1/systemone" }
  const { input, logs } = stubInput()
  const hooks = await plugin(input)
  const proof = logs.find(
    (entry) =>
      typeof entry.body.message === "string" && entry.body.message.startsWith("Jev enabled:"),
  )
  assert.ok(proof, "an enabled plugin must emit a startup proof line")
  const message = String(proof.body.message)
  assert.match(message, /model=oc\/jev-1\.13-free/)
  assert.match(message, /baseUrl=router\.example/)
  assert.match(message, /key=set/)
  assert.equal(message.includes(secret), false, "the key value must never appear")
  assert.equal(JSON.stringify(logs).includes(secret), false)
  assert.equal(Object.hasOwn(hooks, "permission.ask"), false)
})

test("plugin: writes a decision-log line for a valid tool verdict and never leaks the key", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "jev-plugin-log-"))
  try {
    const logPath = join(logDir, "decisions.log")
    const secret = "sk-decision-log-secret"
    process.env = {
      ...originalEnv,
      JEV_API_KEY: secret,
      JEV_BASE_URL: "https://router.example/v1/systemone",
      JEV_DECISION_LOG: logPath,
    }
    const { input, logs } = stubInput()
    routeFetch(() => new Response(choiceBody("risk", "destructive", 0.95), { status: 200 }))
    const hooks = await plugin(input)
    const before = hooks["tool.execute.before"]
    assert.ok(before)
    await assert.rejects(
      () => before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } }),
      /Blocked destructive tool/,
    )
    const raw = await readFile(logPath, "utf8")
    const entry = JSON.parse(raw.split("\n").filter(Boolean)[0] ?? "{}") as Record<string, unknown>
    assert.equal(entry.hook, "tool.execute.before")
    assert.equal(entry.kind, "valid")
    assert.equal(entry.decision, "destructive")
    assert.equal(entry.action, "block")
    assert.equal(raw.includes(secret), false, "the decision log must never contain the api key")
    assert.equal(JSON.stringify(logs).includes(secret), false, "server logs must never contain the api key")
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
})

test("plugin: toastDecisions=false adds no toast beyond the default decision toasts", async () => {
  process.env = { ...originalEnv, JEV_API_KEY: "test-key", JEV_BASE_URL: "https://router.example/v1/systemone" }
  const { input, toasts } = stubInput()
  routeFetch(() => new Response(choiceBody("route", "code_only", 0.9), { status: 200 }))
  const hooks = await plugin(input)
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "read the file" } as never] },
  )
  assert.equal(toasts.length, 0, "a non-default decision must not toast when the mode is off")
})

test("plugin: toastDecisions=true toasts a decision that would otherwise be silent", async () => {
  process.env = { ...originalEnv, JEV_API_KEY: "test-key", JEV_BASE_URL: "https://router.example/v1/systemone" }
  const { input, toasts } = stubInput()
  routeFetch(() => new Response(choiceBody("route", "code_only", 0.9), { status: 200 }))
  const hooks = await plugin(input, { toastDecisions: true })
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "read the file" } as never] },
  )
  // One startup toast + one decision toast.
  assert.equal(toasts.length, 2)
})

/**
 * Fail-open latency tests for the blocking hook.
 *
 * `tool.execute.before` is awaited by opencode, so its worst case sits in the
 * main agent loop. A hung provider must fail open after a single timeout: the
 * hook proceeds, never throws (even on a destructive hint), and never retries.
 */

test("fail-open: blocking hook proceeds within the timeout bound and does not retry", async () => {
  let calls = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1
    // Hang until the client's AbortSignal fires, mimicking a stalled provider.
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
  const started = Date.now()
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi > x.txt" } })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `blocking hook must fail open within the bound, took ${elapsed}ms`)
  assert.equal(calls, 1, "the blocking path must not retry after a timeout")
})

test("fail-open: a destructive hint that times out does NOT throw", async () => {
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
  // `rm -rf` is a destructive hint; an unavailable decision must still fail open.
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } })
  assert.equal(calls, 1)
})

/**
 * Cache-scope integration tests.
 *
 * These prove the two halves of the cache optimization at the real hook
 * boundary: equivalent actions now hit the cache, and a destructive action can
 * never reuse a cached non-destructive verdict. A mutation that keys the cache
 * on the raw args blob fails the hit test; a mutation that drops the safety
 * discriminator fails the block test.
 */

test("tool.execute.before: equivalent bash calls hit the cache (one network call)", async () => {
  const { input } = stubInput()
  let calls = 0
  routeFetch(() => {
    calls += 1
    return new Response(choiceBody("risk", "mutating", 0.9), { status: 200 })
  })
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo one > a.txt" } })
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo two > b.txt" } })
  assert.equal(calls, 1, "equivalent same-safety-class calls must share a cache entry")
})

test("tool.execute.before: a destructive call does NOT reuse a cached non-destructive verdict", async () => {
  const { input } = stubInput()
  let calls = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1
    const body = JSON.parse(String(init?.body)) as { state: string }
    // A benign call is read_only; the destructive call is destructive. If the
    // destructive call reused the cached read_only verdict it would not block.
    const destructive = body.state.includes("rm -rf")
    return new Response(choiceBody("risk", destructive ? "destructive" : "read_only", 0.95), {
      status: 200,
    })
  }) as typeof fetch
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi" } })
  await assert.rejects(
    () => before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } }),
    /Blocked destructive tool/,
    "a destructive call must never reuse a cached read_only verdict",
  )
  assert.equal(calls, 2, "the destructive call must miss the cache and reach the provider")
})

test("tool.execute.before: low-risk meta tools (todowrite, task-read) never call the provider", async () => {
  const { input } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("risk", "mutating", 0.9), { status: 200 })
  })
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  for (const tool of ["todowrite", "task-read"]) {
    await before({ tool, sessionID: "s", callID: "c" }, { args: {} })
  }
  assert.equal(called, false, "low-risk meta tools must skip the network call")
})

test("tool.execute.before: the dispatch `task` tool stays on the network path", async () => {
  const { input } = stubInput()
  let called = false
  routeFetch(() => {
    called = true
    return new Response(choiceBody("risk", "mutating", 0.9), { status: 200 })
  })
  const hooks = await plugin(input)
  const before = hooks["tool.execute.before"]
  assert.ok(before)
  await before({ tool: "task", sessionID: "s", callID: "c" }, { args: { description: "do work" } })
  assert.equal(called, true, "the dispatch tool can mutate and must be classified remotely")
})

test("plugin: a provider failure is logged with its HTTP status and no secret", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "jev-plugin-fail-"))
  try {
    const logPath = join(logDir, "decisions.log")
    const secret = "sk-provider-fail-secret"
    process.env = {
      ...originalEnv,
      JEV_API_KEY: secret,
      JEV_BASE_URL: "https://router.example/v1/systemone",
      JEV_DECISION_LOG: logPath,
    }
    const { input } = stubInput()
    globalThis.fetch = (async () =>
      new Response(`upstream down for ${secret}`, { status: 503 })) as typeof fetch
    const hooks = await plugin(input)
    const before = hooks["tool.execute.before"]
    assert.ok(before)
    await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi" } })
    const raw = await readFile(logPath, "utf8")
    const entry = JSON.parse(raw.split("\n").filter(Boolean)[0] ?? "{}") as Record<string, unknown>
    assert.equal(entry.kind, "unavailable")
    assert.match(String(entry.detail), /HTTP 503/)
    assert.equal(raw.includes(secret), false, "the decision log must never contain the api key")
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
})

test("plugin: traceLog OFF (default) writes no trace file for a hook call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-plugin-trace-off-"))
  try {
    process.env = {
      ...originalEnv,
      JEV_API_KEY: "test-key",
      JEV_BASE_URL: "https://router.example/v1/systemone",
      JEV_DECISION_LOG: "off",
      JEV_TRACE_LOG_PATH: join(dir, "trace.log"),
    }
    delete process.env.JEV_TRACE_LOG
    const { input } = stubInput()
    routeFetch(() => new Response(choiceBody("risk", "mutating", 0.9), { status: 200 }))
    const hooks = await plugin(input)
    const before = hooks["tool.execute.before"]
    assert.ok(before)
    await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi > x.txt" } })
    assert.deepEqual(await readdir(dir), [], "trace logging is off by default and must write nothing")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("plugin: traceLog ON writes one entry per JEV call with hook, model, and outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-plugin-trace-on-"))
  try {
    const tracePath = join(dir, "trace.log")
    process.env = {
      ...originalEnv,
      JEV_API_KEY: "test-key",
      JEV_BASE_URL: "https://router.example/v1/systemone",
      JEV_DECISION_LOG: "off",
      JEV_TRACE_LOG: "1",
      JEV_TRACE_LOG_PATH: tracePath,
    }
    const { input } = stubInput()
    routeFetch(() => new Response(choiceBody("risk", "mutating", 0.9), { status: 200 }))
    const hooks = await plugin(input)
    const before = hooks["tool.execute.before"]
    assert.ok(before)
    await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi > x.txt" } })
    const raw = await readFile(tracePath, "utf8")
    const lines = raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.equal(lines.length, 1, "one JEV call must produce exactly one trace entry")
    assert.equal(lines[0]?.hook, "tool.execute.before")
    assert.equal(lines[0]?.summary, "bash")
    assert.equal(lines[0]?.questionId, "risk")
    assert.equal(lines[0]?.questionType, "choice")
    assert.equal(lines[0]?.model, "oc/jev-1.13-free")
    assert.equal(lines[0]?.cache, "miss")
    assert.equal(lines[0]?.circuit, "closed")
    assert.equal(lines[0]?.outcome, "valid")
    assert.equal(typeof lines[0]?.durationMs, "number")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
