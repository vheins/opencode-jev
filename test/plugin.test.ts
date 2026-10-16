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

test("chat.message: observe-only classification raises a toast on confident needs_human", async () => {
  const { input, toasts } = stubInput()
  routeFetch(() => new Response(choiceBody("route", "needs_human", 0.9), { status: 200 }))
  const hooks = await plugin(input)
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "should I delete the prod database?" } as never] },
  )
  assert.equal(toasts.length, 1)
})

test("chat.message: no toast below the alert threshold", async () => {
  const { input, toasts } = stubInput()
  routeFetch(() => new Response(choiceBody("route", "needs_human", 0.4), { status: 200 }))
  const hooks = await plugin(input)
  const chat = hooks["chat.message"]
  assert.ok(chat)
  await chat(
    { sessionID: "s" },
    { message: {} as never, parts: [{ type: "text", text: "hi" } as never] },
  )
  assert.equal(toasts.length, 0)
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

test("event: file.edited on a security-sensitive file raises a warning toast", async () => {
  const { input, toasts } = stubInput()
  routeFetch(() => new Response(noulBody("security_sensitive", 0.9), { status: 200 }))
  const hooks = await plugin(input)
  const event = hooks.event
  assert.ok(event)
  await event({ event: { type: "file.edited", properties: { file: ".env" } } as never })
  assert.equal(toasts.length, 1)
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
  assert.match(String(result), /JEV_BASE_URL is not set/)
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
