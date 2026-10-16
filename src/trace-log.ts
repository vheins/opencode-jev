/**
 * Opt-in per-call trace log with size-based rotation.
 *
 * Unlike the decision log, which records the OUTCOME of each decision, this log
 * records ONE entry per JEV remote call: the hook, a bounded tool/state summary,
 * the question id/type/model, duration, cache hit/miss, circuit state, the
 * outcome kind, and a bounded, secret-redacted response snippet. It exists to
 * trace WHY a call behaved as it did (e.g. a `provider` failure) after the fact.
 *
 * It is OFF by default: {@link appendTrace} returns before any file IO unless
 * the caller resolved `traceLog: true`. When enabled it reuses the decision
 * log's size-based {@link rotate}, so it cannot grow without bound. The writer
 * is throw-safe by construction: a filesystem failure is reported through the
 * optional `onError` callback and then swallowed, so it can never break a hook.
 *
 * @module
 */

import { appendFile, mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"

import { MAX_DETAIL_CHARS, reasonOf, rotate } from "./decision-log.ts"

/** The outcome class of a traced JEV call. */
export type TraceOutcome =
  | "valid"
  | "abstain"
  | "invalid"
  | "unavailable"
  | "timeout"
  | "transport"
  | "provider"
  | "busy"
  | "circuit_open"
  | "cache_hit"

/** Resolved rotation options for the trace log. */
export type TraceLogOptions = {
  /** Whether tracing is enabled; when false, no file IO is performed. */
  readonly enabled: boolean
  /** Target file path; an empty string or `"off"` disables writing. */
  readonly path: string
  /** Rotate once the file reaches this many bytes. */
  readonly maxBytes: number
  /** Number of rotated copies to keep (`<path>.1` .. `<path>.N`). */
  readonly backups: number
  /** Called once per filesystem failure; the write is then swallowed. */
  readonly onError?: (reason: string) => void
}

/** One JEV call to append to the trace log, before the timestamp is added. */
export type TraceLogEntry = {
  /** The hook or tool that made the call (e.g. `tool.execute.before`). */
  readonly hook: string
  /** A short, bounded summary of the tool/state under judgment (never a secret). */
  readonly summary: string
  /** The question id sent to the router. */
  readonly questionId: string
  /** The question type (`choice` / `score` / `noul`). */
  readonly questionType: string
  /** The model used for the call. */
  readonly model: string
  /** Wall-clock duration of the call in milliseconds. */
  readonly durationMs: number
  /** Whether the result was served from cache. */
  readonly cache: "hit" | "miss"
  /** Whether the circuit breaker was open at call time. */
  readonly circuit: "open" | "closed"
  /** The outcome class of the call. */
  readonly outcome: TraceOutcome
  /** A bounded, redacted response/error snippet (never a key or full body). */
  readonly snippet?: string
}

/** A value that disables writing when used as the configured path. */
const DISABLED_PATH = "off"

/** Truncate a string to the persisted detail cap. */
function truncate(value: string): string {
  return value.length > MAX_DETAIL_CHARS ? value.slice(0, MAX_DETAIL_CHARS) : value
}

/**
 * Append one JEV call as a single JSON line, rotating when the file is full.
 *
 * When `opts.enabled` is false this returns immediately, before any `mkdir`,
 * `appendFile`, or `stat`, so the default install performs ZERO trace file IO.
 * Never throws: any filesystem error is reported via `opts.onError` (when
 * provided) and swallowed so a logging failure cannot break a hook.
 *
 * @param entry - The call to record.
 * @param opts - Resolved trace path, enable flag, and rotation options.
 */
export async function appendTrace(entry: TraceLogEntry, opts: TraceLogOptions): Promise<void> {
  if (!opts.enabled) return
  const path = opts.path.trim()
  if (path === "" || path === DISABLED_PATH) return

  const payload = {
    ts: new Date().toISOString(),
    hook: entry.hook,
    summary: truncate(entry.summary),
    questionId: entry.questionId,
    questionType: entry.questionType,
    model: entry.model,
    durationMs: entry.durationMs,
    cache: entry.cache,
    circuit: entry.circuit,
    outcome: entry.outcome,
    ...(entry.snippet !== undefined ? { snippet: truncate(entry.snippet) } : {}),
  }

  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(payload)}\n`, "utf8")
    const info = await stat(path)
    if (info.size >= opts.maxBytes) await rotate(path, opts.backups)
  } catch (error) {
    opts.onError?.(reasonOf(error))
  }
}
