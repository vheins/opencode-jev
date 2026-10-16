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

/**
 * How a Jev call failed, mapped to a failure policy.
 *
 * `detail` carries a short, redacted, bounded diagnostic (e.g. a provider's
 * HTTP status and response-body snippet) so a failure is observable after the
 * fact without ever exposing the key or an unbounded payload.
 */
export type CallFailure =
  | { readonly kind: "timeout"; readonly detail?: string }
  | { readonly kind: "transport"; readonly detail?: string }
  | { readonly kind: "provider"; readonly status: number; readonly detail?: string }
  | { readonly kind: "busy"; readonly detail?: string }
  | { readonly kind: "circuit_open"; readonly detail?: string }

/** A successful or failed Jev call. */
export type CallResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly failure: CallFailure }

/**
 * Per-request budget overrides.
 *
 * A blocking hook (`tool.execute.before`) is awaited by opencode, so its worst
 * case sits in the main loop. Callers there pass `retry: false` so a hung
 * provider fails open after a single timeout instead of stalling for two.
 */
export type CallOptions = {
  /** Per-attempt timeout (ms); defaults to the client's configured timeout. */
  readonly timeoutMs?: number
  /** Whether a transient failure may be retried once; defaults to true. */
  readonly retry?: boolean
}

/** Maximum characters in a state string sent to the router. */
const MAX_STATE_CHARS = 4000

/** Backoff before the single transient retry (ms). */
const RETRY_BACKOFF_MS = 250

/** Maximum characters of a provider response body kept for diagnostics. */
export const MAX_BODY_SNIPPET_CHARS = 200

/** Consecutive provider failures that open the short-TTL circuit. */
export const FAILURE_THRESHOLD = 3

/**
 * Default how long (ms) the circuit stays open after a provider failure streak.
 *
 * Kept short so a transient outage recovers quickly while a down provider is
 * not hammered by every hook call in the meantime.
 */
export const DEFAULT_FAILURE_TTL_MS = 5_000

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

/**
 * Reduce a provider response body to a bounded, single-line, redacted snippet.
 *
 * The snippet is diagnostic only: it is clipped to
 * {@link MAX_BODY_SNIPPET_CHARS} characters, collapsed to one line, and has any
 * occurrence of the API key removed so a body echo can never leak the secret.
 *
 * @param text - The raw response body text.
 * @param secret - The API key to redact, when present.
 * @returns A bounded, redacted, single-line snippet.
 */
export function bodySnippet(text: string, secret?: string): string {
  const redacted = secret && secret.length > 0 ? text.split(secret).join("[redacted]") : text
  return redacted.slice(0, MAX_BODY_SNIPPET_CHARS).replace(/\s+/g, " ").trim()
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
function failureForStatus(status: number, detail?: string): CallFailure {
  return detail === undefined ? { kind: "provider", status } : { kind: "provider", status, detail }
}

/**
 * A bounded, cached System One client.
 *
 * The client caps concurrent requests, applies a per-attempt timeout, retries
 * a transient failure at most once, and caches only results whose inputs and
 * policy version are equivalent. A short-TTL circuit breaker trips after a
 * streak of provider failures so a down provider is not hit by every call.
 */
export class SystemOneClient {
  private readonly config: Config
  private readonly policyVersion: string
  private readonly semaphore: Semaphore
  private readonly cache = new Map<string, { readonly at: number; readonly body: unknown }>()
  private consecutiveFailures = 0
  private circuitOpenUntil = 0
  private lastFailureDetail: string | undefined

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
   * @param options - Optional per-request timeout and retry overrides.
   * @returns The parsed response body, or a classified failure.
   */
  async request(
    state: string,
    questions: Record<string, Question>,
    modelOverride?: string,
    options?: CallOptions,
  ): Promise<CallResult> {
    const baseUrl = this.baseUrl
    const apiKey = this.apiKey
    if (!baseUrl || !apiKey) return { ok: false, failure: { kind: "busy" } }

    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs
    const retry = options?.retry ?? true
    const boundedState = truncateState(state)
    const model = modelOverride?.trim() || this.config.model
    const key = this.cacheKey(boundedState, questions, model)

    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < this.config.cacheTtlMs) {
      return { ok: true, body: cached.body }
    }

    // Short-TTL circuit breaker: after a streak of provider failures, fail open
    // fast (no network) until the window elapses, so a down provider is not hit
    // by every hook call.
    const now = Date.now()
    if (now < this.circuitOpenUntil) {
      const detail =
        this.lastFailureDetail === undefined
          ? "circuit open after repeated provider failures"
          : `circuit open after repeated provider failures; last: ${this.lastFailureDetail}`
      return { ok: false, failure: { kind: "circuit_open", detail } }
    }

    if (!this.semaphore.tryAcquire()) {
      return { ok: false, failure: { kind: "busy" } }
    }
    try {
      const first = await this.attempt(baseUrl, apiKey, boundedState, questions, model, timeoutMs)
      if (first.ok) {
        this.recordSuccess()
        this.remember(key, first.body)
        return first
      }
      if (!retry || !isTransient(first.failure)) {
        this.recordFailure(first.failure)
        return first
      }
      await delay(RETRY_BACKOFF_MS)
      const second = await this.attempt(baseUrl, apiKey, boundedState, questions, model, timeoutMs)
      if (second.ok) {
        this.recordSuccess()
        this.remember(key, second.body)
      } else {
        this.recordFailure(second.failure)
      }
      return second
    } finally {
      this.semaphore.release()
    }
  }

  /** Reset the failure streak after a successful call. */
  private recordSuccess(): void {
    this.consecutiveFailures = 0
    this.circuitOpenUntil = 0
    this.lastFailureDetail = undefined
  }

  /**
   * Advance the failure streak and trip the circuit once it reaches the bound.
   *
   * Only provider/transport/timeout failures count: `busy` is a local
   * concurrency limit, not a provider-health signal.
   *
   * @param failure - The failure just observed.
   */
  private recordFailure(failure: CallFailure): void {
    if (failure.kind === "busy") return
    this.consecutiveFailures += 1
    this.lastFailureDetail = describeFailure(failure)
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + DEFAULT_FAILURE_TTL_MS
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
    timeoutMs: number,
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
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, failure: { kind: "timeout", detail: `no response within ${timeoutMs}ms` } }
      }
      return { ok: false, failure: { kind: "transport", detail: bodySnippet(errorMessage(error)) } }
    }
    if (!response.ok) {
      // Capture a bounded, redacted snippet of the provider's error body so a
      // failure is diagnosable from the decision log (status + why).
      const snippet = await response
        .text()
        .then((text) => bodySnippet(text, apiKey))
        .catch(() => "")
      const detail = snippet === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${snippet}`
      return { ok: false, failure: failureForStatus(response.status, detail) }
    }
    try {
      return { ok: true, body: await response.json() }
    } catch {
      return { ok: false, failure: { kind: "transport", detail: "response was not valid JSON" } }
    }
  }
}

/** Render a failure into a short, redacted, bounded diagnostic string. */
function describeFailure(failure: CallFailure): string {
  if (failure.kind === "provider") {
    return failure.detail ?? `HTTP ${failure.status}`
  }
  if (failure.kind === "busy") return "busy"
  if (failure.kind === "circuit_open") return failure.detail ?? "circuit open"
  return failure.detail ?? failure.kind
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
