/**
 * Transport for System One judgments through the configured router provider.
 *
 * This module owns the wire contract and the failure taxonomy. A request is
 * POSTed to the configured `JEV_BASE_URL` with a per-attempt timeout and a
 * bounded, single retry for transient failures only. It never retries a
 * deterministic (4xx) failure, and it never logs the API key or the request
 * body.
 *
 * @module
 */

import type { Question } from "@typesafe-ai/sdk"

import type { Config } from "./config.ts"

/** How a Jev call failed, mapped to a failure policy. */
export type CallFailure =
  | { readonly kind: "timeout" }
  | { readonly kind: "transport" }
  | { readonly kind: "provider"; readonly status: number }
  | { readonly kind: "busy" }

/** A successful or failed Jev call. */
export type CallResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly failure: CallFailure }

/** Maximum characters in a state string sent to the router. */
const MAX_STATE_CHARS = 4000

/** Backoff before the single transient retry (ms). */
const RETRY_BACKOFF_MS = 250

/**
 * A counting semaphore bounding in-flight Jev requests.
 *
 * Acquisition never blocks: a caller that finds no free permit fails fast as
 * `busy`, so a hook can never be stalled waiting on the concurrency limit. The
 * per-action failure policy then decides whether `busy` is safe to ignore.
 */
class Semaphore {
  private available: number

  constructor(permits: number) {
    this.available = permits
  }

  /** Acquire a permit, or return `false` when none is free. */
  tryAcquire(): boolean {
    if (this.available > 0) {
      this.available -= 1
      return true
    }
    return false
  }

  /** Release a permit. */
  release(): void {
    this.available += 1
  }
}

/** JSON-serialize a value without throwing on cycles or bigints. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner) =>
      typeof inner === "bigint" ? inner.toString() : inner,
    )
  } catch {
    return String(value)
  }
}

/** Reduce an unknown thrown value to a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Cap a serialized state string so no request body grows unbounded. */
export function truncateState(value: string, max = MAX_STATE_CHARS): string {
  return value.length > max ? value.slice(0, max) : value
}

/** Narrow a fetch rejection to a timeout. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  )
}

/** Classify an HTTP status into a call failure. */
function failureForStatus(status: number): CallFailure {
  return { kind: "provider", status }
}

/**
 * A bounded, cached System One client.
 *
 * The client caps concurrent requests, applies a per-attempt timeout, retries
 * a transient failure at most once, and caches only results whose inputs and
 * policy version are equivalent.
 */
export class SystemOneClient {
  private readonly config: Config
  private readonly policyVersion: string
  private readonly semaphore: Semaphore
  private readonly cache = new Map<string, { readonly at: number; readonly body: unknown }>()

  /**
   * @param config - Resolved configuration (base URL, key, model, bounds).
   * @param policyVersion - A version string that changes when decision logic
   * changes, so a cached decision cannot outlive the policy that produced it.
   */
  constructor(config: Config, policyVersion: string) {
    this.config = config
    this.policyVersion = policyVersion
    this.semaphore = new Semaphore(config.maxConcurrent)
  }

  /** The configured base URL, when present. */
  private get baseUrl(): string | undefined {
    return this.config.baseUrl
  }

  /** The configured API key, when present. */
  private get apiKey(): string | undefined {
    return this.config.apiKey
  }

  /** Build a stable cache key from the request inputs and policy version. */
  private cacheKey(state: string, questions: Record<string, Question>, model: string): string {
    return `${this.policyVersion}\u0000${model}\u0000${state}\u0000${safeStringify(questions)}`
  }

  /**
   * POST one System One request with a bounded retry.
   *
   * @param state - Serialized state to evaluate.
   * @param questions - Named questions keyed by the ids used to read answers.
   * @param modelOverride - Optional model override for this call.
   * @returns The parsed response body, or a classified failure.
   */
  async request(
    state: string,
    questions: Record<string, Question>,
    modelOverride?: string,
  ): Promise<CallResult> {
    const baseUrl = this.baseUrl
    const apiKey = this.apiKey
    if (!baseUrl || !apiKey) return { ok: false, failure: { kind: "busy" } }

    const boundedState = truncateState(state)
    const model = modelOverride?.trim() || this.config.model
    const key = this.cacheKey(boundedState, questions, model)

    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < this.config.cacheTtlMs) {
      return { ok: true, body: cached.body }
    }

    if (!this.semaphore.tryAcquire()) {
      return { ok: false, failure: { kind: "busy" } }
    }
    try {
      const first = await this.attempt(baseUrl, apiKey, boundedState, questions, model)
      if (first.ok) {
        this.remember(key, first.body)
        return first
      }
      if (!isTransient(first.failure)) return first
      await delay(RETRY_BACKOFF_MS)
      const second = await this.attempt(baseUrl, apiKey, boundedState, questions, model)
      if (second.ok) this.remember(key, second.body)
      return second
    } finally {
      this.semaphore.release()
    }
  }

  /** Store a successful response body in the cache, bounding cache size. */
  private remember(key: string, body: unknown): void {
    if (this.cache.size >= 256) this.cache.clear()
    this.cache.set(key, { at: Date.now(), body })
  }

  /** Perform one HTTP attempt with a timeout. */
  private async attempt(
    baseUrl: string,
    apiKey: string,
    state: string,
    questions: Record<string, Question>,
    model: string,
  ): Promise<CallResult> {
    let response: Response
    try {
      response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error) {
      if (isAbortError(error)) return { ok: false, failure: { kind: "timeout" } }
      return { ok: false, failure: { kind: "transport" } }
    }
    if (!response.ok) return { ok: false, failure: failureForStatus(response.status) }
    try {
      return { ok: true, body: await response.json() }
    } catch {
      return { ok: false, failure: { kind: "transport" } }
    }
  }
}

/** Whether a failure is worth a single retry. */
function isTransient(failure: CallFailure): boolean {
  if (failure.kind === "timeout" || failure.kind === "transport") return true
  if (failure.kind === "provider") return failure.status === 429 || failure.status >= 500
  return false
}

/** Wait for a bounded delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
