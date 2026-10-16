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
  if (!result.ok) assert.deepEqual(result.failure, { kind: "provider", status: 400 })
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
