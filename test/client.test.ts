/**
 * Tests for the bounded System One transport.
 *
 * The client is exercised against a stubbed global `fetch` so the retry,
 * timeout, cache, and concurrency bounds are deterministic. The load-bearing
 * assertions are: a transient failure is retried at most once, a deterministic
 * (4xx) failure is never retried, identical input is served from cache, and no
 * request header ever leaks the key into a log line.
 *
 * @module
 */

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { SystemOneClient } from "../src/client.ts"
import type { Config } from "../src/config.ts"

const originalFetch = globalThis.fetch

/** Build a config with sane bounds for tests. */
function config(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    apiKey: "test-key",
    baseUrl: "https://router.example/v1/systemone",
    model: "oc/jev-1.13-free",
    blockThreshold: 0.85,
    routeThreshold: 0.8,
    severityThreshold: 0.8,
    compactThreshold: 0.75,
    fileReviewThreshold: 0.8,
    decisionLogPath: "off",
    decisionLogMaxBytes: 1_000_000,
    decisionLogBackups: 3,
    toastDecisions: false,
    timeoutMs: 50,
    cacheTtlMs: 60_000,
    maxConcurrent: 4,
    ...overrides,
  }
}

const QUESTIONS = { risk: { type: "noul" as const } }

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("request: returns the parsed body on success", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, true)
})

test("request: classifies a 4xx as a provider failure and never retries", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response("nope", { status: 400 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.failure.kind, "provider")
    if (result.failure.kind === "provider") assert.equal(result.failure.status, 400)
  }
  assert.equal(calls, 1, "a deterministic 4xx must not be retried")
})

test("request: retries a 500 at most once, then gives up", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response("boom", { status: 500 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  assert.equal(calls, 2, "transient failure is retried exactly once")
})

test("request: retry:false disables the retry (blocking-path budget)", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response("boom", { status: 500 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS, undefined, { retry: false })
  assert.equal(result.ok, false)
  assert.equal(calls, 1, "the blocking path must not retry a transient failure")
})

test("request: retry:false does not retry a timeout either", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    const error = new Error("aborted")
    error.name = "AbortError"
    throw error
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS, undefined, { retry: false })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.failure.kind, "timeout")
  assert.equal(calls, 1, "a timeout on the blocking path must not be retried")
})

test("request: recovers when the single retry succeeds", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) return new Response("boom", { status: 503 })
    return new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
})

test("request: classifies a timeout via AbortSignal", async () => {
  globalThis.fetch = (async () => {
    const error = new Error("aborted")
    error.name = "AbortError"
    throw error
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.failure.kind, "timeout")
})

test("request: classifies a network error as transport", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed")
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.failure.kind, "transport")
})

test("request: serves identical unchanged input from cache (one network call)", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  await client.request("same-state", QUESTIONS)
  await client.request("same-state", QUESTIONS)
  assert.equal(calls, 1, "duplicate unchanged input must not re-call the provider")
})

test("request: a different policy version misses the cache", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })
  }) as typeof fetch
  const a = new SystemOneClient(config(), "v1")
  const b = new SystemOneClient(config(), "v2")
  await a.request("same-state", QUESTIONS)
  await b.request("same-state", QUESTIONS)
  assert.equal(calls, 2, "a policy-version change must invalidate the cache")
})

test("request: fails fast as busy when the concurrency bound is exhausted", async () => {
  let release: (() => void) | undefined
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })
  }) as typeof fetch
  const client = new SystemOneClient(config({ maxConcurrent: 1 }), "v")
  const first = client.request("state-a", QUESTIONS)
  const second = await client.request("state-b", QUESTIONS)
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.failure.kind, "busy")
  release?.()
  await first
})

test("request: returns busy when the client is not configured", async () => {
  const client = new SystemOneClient(config({ baseUrl: undefined, apiKey: undefined }), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.failure.kind, "busy")
})

test("request: retries a 429 exactly once and succeeds on the second attempt", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) return new Response("slow down", { status: 429 })
    return new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, true)
  assert.equal(calls, 2, "429 is transient and must be retried exactly once")
})

test("request: a 200 with invalid JSON maps to transport failure", async () => {
  globalThis.fetch = (async () => new Response("not-json{", { status: 200 })) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.failure.kind, "transport")
})

test("request: a >4000-char state is truncated in the wire body and the cache key", async () => {
  const bodies: Array<{ state: string }> = []
  let calls = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1
    const parsed = JSON.parse(String(init?.body)) as { state: string }
    bodies.push({ state: parsed.state })
    return new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")

  // Two states that share their first 4000 characters must truncate to the
  // same bounded string, so the second request is served from cache.
  const longA = "x".repeat(5000)
  const longB = "x".repeat(4000) + "y".repeat(1000)
  await client.request(longA, QUESTIONS)
  await client.request(longB, QUESTIONS)

  assert.equal(bodies.length, 1, "the truncated state must be the cache key")
  assert.ok((bodies[0]?.state.length ?? 0) <= 4000, "wire body state must be bounded to <=4000 chars")
  assert.equal(bodies[0]?.state, "x".repeat(4000))
})

test("request: a provider failure carries the HTTP status and a bounded body snippet", async () => {
  globalThis.fetch = (async () =>
    new Response("upstream exploded: quota exceeded", { status: 502 })) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.failure.kind, "provider")
    if (result.failure.kind === "provider") {
      assert.equal(result.failure.status, 502)
      assert.match(String(result.failure.detail), /HTTP 502/)
      assert.match(String(result.failure.detail), /quota exceeded/)
    }
  }
})

test("request: the provider body snippet never leaks the API key and is bounded", async () => {
  const secret = "sk-super-secret-key"
  globalThis.fetch = (async () =>
    new Response(`denied for ${secret} ${"z".repeat(1000)}`, { status: 401 })) as typeof fetch
  const client = new SystemOneClient(config({ apiKey: secret }), "v")
  const result = await client.request("state", QUESTIONS)
  assert.equal(result.ok, false)
  if (!result.ok) {
    const detail = String(result.failure.detail)
    assert.equal(detail.includes(secret), false, "the key must be redacted from the snippet")
    assert.ok(detail.length <= 200 + "HTTP 401: ".length, "the snippet must be bounded")
  }
})

test("request: trips a short-TTL circuit after a provider failure streak (bounded, fail-open)", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response("down", { status: 503 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  // Each request with retry:false makes exactly one provider call.
  for (let i = 0; i < 3; i++) {
    await client.request(`state-${i}`, QUESTIONS, undefined, { retry: false })
  }
  const callsBeforeOpen = calls
  // The next distinct request must fail open from the circuit, not the network.
  const open = await client.request("state-after-open", QUESTIONS, undefined, { retry: false })
  assert.equal(open.ok, false)
  if (!open.ok) assert.equal(open.failure.kind, "circuit_open")
  assert.equal(calls, callsBeforeOpen, "an open circuit must make no network call")
})

test("request: a success resets the failure streak", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    // Calls 1,2 fail; call 3 succeeds (resets); calls 4,5 fail again.
    if (calls === 3) {
      return new Response(JSON.stringify({ model: "m", answers: {}, usage: {} }), { status: 200 })
    }
    return new Response("down", { status: 503 })
  }) as typeof fetch
  const client = new SystemOneClient(config(), "v")
  await client.request("s1", QUESTIONS, undefined, { retry: false })
  await client.request("s2", QUESTIONS, undefined, { retry: false })
  await client.request("s3", QUESTIONS, undefined, { retry: false }) // succeeds, resets
  // Two more failures must not trip the circuit yet (streak restarted).
  const a = await client.request("s4", QUESTIONS, undefined, { retry: false })
  const b = await client.request("s5", QUESTIONS, undefined, { retry: false })
  assert.equal(a.ok, false)
  assert.equal(b.ok, false)
  if (!b.ok) assert.notEqual(b.failure.kind, "circuit_open", "the streak must have reset on success")
})
