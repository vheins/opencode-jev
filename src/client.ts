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
import { appendTrace, type TraceLogOptions, type TraceOutcome } from "./trace-log.ts"

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
  /**
   * Trace context for this call: the hook that made it and a bounded,
   * non-secret summary of the state under judgment. Only used when the trace
   * log is enabled; never written otherwise.
   */
  readonly trace?: { readonly hook: string; readonly summary: string }
  /**
   * Optional stable, safety-preserving cache scope for the call.
   *
   * When present, the cache key uses this scope in place of the serialized
   * `state`, so calls that differ only in detail the caller has proven
   * irrelevant (e.g. per-call tool arguments in the same safety class) share a
   * cache entry. The caller derives it from the local safety classification,
   * never from the raw argument blob, so two calls that could yield different
   * risk verdicts never share it. When absent, the full `state` remains part of
   * the key, which is the safe default for every other hook.
   */
  readonly cacheScope?: string
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
  private readonly trace: TraceLogOptions
  private readonly cache = new Map<string, { readonly at: number; readonly body: unknown }>()
  private consecutiveFailures = 0
  private circuitOpenUntil = 0
  private lastFailureDetail: string | undefined

  /**
   * @param config - Resolved configuration (base URL, key, model, bounds).
   * @param policyVersion - A version string that changes when decision logic
   * changes, so a cached decision cannot outlive the policy that produced it.
   * @param trace - Optional opt-in trace-log options; when omitted, tracing is
   * disabled and no call performs any trace file IO.
   */
  constructor(config: Config, policyVersion: string, trace?: TraceLogOptions) {
    this.config = config
    this.policyVersion = policyVersion
    this.semaphore = new Semaphore(config.maxConcurrent)
    this.trace = trace ?? { enabled: false, path: "", maxBytes: 0, backups: 0 }
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
  private cacheKey(scope: string, questions: Record<string, Question>, model: string): string {
    return `${this.policyVersion}\u0000${model}\u0000${scope}\u0000${safeStringify(questions)}`
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
    const startedAt = Date.now()
    const baseUrl = this.baseUrl
    const apiKey = this.apiKey
    if (!baseUrl || !apiKey) {
      await this.emitTrace(options, this.config.model, questions, startedAt, "miss", "closed", "busy")
      return { ok: false, failure: { kind: "busy" } }
    }

    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs
    const retry = options?.retry ?? true
    const boundedState = truncateState(state)
    const model = modelOverride?.trim() || this.config.model
    // A caller-supplied scope (derived from the local safety classification)
    // replaces the full state in the key, so equivalent calls hit while calls
    // that could yield a different risk verdict never share an entry. Absent a
    // scope, the full state stays in the key (the safe default).
    const key = this.cacheKey(options?.cacheScope ?? boundedState, questions, model)

    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < this.config.cacheTtlMs) {
      await this.emitTrace(options, model, questions, startedAt, "hit", "closed", "cache_hit")
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
      await this.emitTrace(
        options,
        model,
        questions,
        startedAt,
        "miss",
        "open",
        "circuit_open",
        detail,
      )
      return { ok: false, failure: { kind: "circuit_open", detail } }
    }

    if (!this.semaphore.tryAcquire()) {
      await this.emitTrace(options, model, questions, startedAt, "miss", "closed", "busy")
      return { ok: false, failure: { kind: "busy" } }
    }
    try {
      const first = await this.attempt(baseUrl, apiKey, boundedState, questions, model, timeoutMs)
      if (first.ok) {
        this.recordSuccess()
        this.remember(key, first.body)
        await this.emitTrace(
          options,
          model,
          questions,
          startedAt,
          "miss",
          "closed",
          "valid",
          bodySnippet(safeStringify(first.body), apiKey),
        )
        return first
      }
      if (!retry || !isTransient(first.failure)) {
        this.recordFailure(first.failure)
        await this.emitFailureTrace(options, model, questions, startedAt, first.failure)
        return first
      }
      await delay(RETRY_BACKOFF_MS)
      const second = await this.attempt(baseUrl, apiKey, boundedState, questions, model, timeoutMs)
      if (second.ok) {
        this.recordSuccess()
        this.remember(key, second.body)
        await this.emitTrace(
          options,
          model,
          questions,
          startedAt,
          "miss",
          "closed",
          "valid",
          bodySnippet(safeStringify(second.body), apiKey),
        )
      } else {
        this.recordFailure(second.failure)
        await this.emitFailureTrace(options, model, questions, startedAt, second.failure)
      }
      return second
    } finally {
      this.semaphore.release()
    }
  }

  /**
   * Append one trace entry for a call, when tracing is enabled.
   *
   * Building the entry is skipped entirely when tracing is off, so the default
   * install performs no trace work at all.
   *
   * @param options - The call options carrying optional trace context.
   * @param model - The model used for the call.
   * @param questions - The questions sent, used to derive the id and type.
   * @param startedAt - Epoch ms when the call began.
   * @param cache - Whether the result was a cache hit or miss.
   * @param circuit - Whether the circuit was open at call time.
   * @param outcome - The outcome class.
   * @param snippet - Optional bounded, redacted response/error snippet.
   */
  private async emitTrace(
    options: CallOptions | undefined,
    model: string,
    questions: Record<string, Question>,
    startedAt: number,
    cache: "hit" | "miss",
    circuit: "open" | "closed",
    outcome: TraceOutcome,
    snippet?: string,
  ): Promise<void> {
    if (!this.trace.enabled) return
    const first = Object.keys(questions)[0]
    const question = first !== undefined ? questions[first] : undefined
    await appendTrace(
      {
        hook: options?.trace?.hook ?? "unknown",
        summary: options?.trace?.summary ?? "",
        questionId: first ?? "",
        questionType: question?.type ?? "unknown",
        model,
        durationMs: Date.now() - startedAt,
        cache,
        circuit,
        outcome,
        ...(snippet !== undefined ? { snippet } : {}),
      },
      this.trace,
    )
  }

  /** Append a trace entry for a classified failure, deriving its outcome. */
  private async emitFailureTrace(
    options: CallOptions | undefined,
    model: string,
    questions: Record<string, Question>,
    startedAt: number,
    failure: CallFailure,
  ): Promise<void> {
    await this.emitTrace(
      options,
      model,
      questions,
      startedAt,
      "miss",
      "closed",
      failure.kind,
      failure.detail,
    )
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
