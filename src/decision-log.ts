/**
 * Newline-delimited JSON decision log with size-based rotation.
 *
 * Every Jev decision the plugin makes can be appended here so the opencode<->
 * Jev interaction is observable after the fact. The log is a plain file of
 * one-JSON-object-per-line entries; when the file reaches `maxBytes` it is
 * rotated to `<path>.1`, shifting older copies up and dropping those beyond
 * `backups`.
 *
 * The writer is throw-safe by construction: a filesystem failure (missing
 * permission, full disk, racing rotation) is reported through the optional
 * `onError` callback and then swallowed, so it can never break a hook. Callers
 * are responsible for what goes into `detail`: this module only truncates it
 * and never inspects or redacts, so secrets must not be passed in the first
 * place.
 *
 * @module
 */

import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises"
import { dirname } from "node:path"

/** The outcome class of a logged decision. */
export type DecisionKind = "valid" | "abstain" | "invalid" | "unavailable"

/** What the plugin did in response to a decision. */
export type DecisionAction =
  | "block"
  | "allow"
  | "toast"
  | "log"
  | "context"
  | "return"
  | "none"

/** One decision to append to the log, before the timestamp is added. */
export type DecisionLogEntry = {
  /** The hook or tool that produced the decision (e.g. `tool.execute.before`). */
  readonly hook: string
  /** The outcome class. */
  readonly kind: DecisionKind
  /** The chosen label when the decision is actionable, else `null`. */
  readonly decision: string | null
  /** The verdict confidence when applicable, else `null`. */
  readonly confidence: number | null
  /** What the plugin did in response. */
  readonly action: DecisionAction
  /** A short, non-secret note (truncated; never pass a key or full payload). */
  readonly detail?: string
}

/** Resolved rotation options for the decision log. */
export type DecisionLogOptions = {
  /** Target file path; an empty string or `"off"` disables logging. */
  readonly path: string
  /** Rotate once the file reaches this many bytes. */
  readonly maxBytes: number
  /** Number of rotated copies to keep (`<path>.1` .. `<path>.N`). */
  readonly backups: number
  /** Called once per filesystem failure; the write is then swallowed. */
  readonly onError?: (reason: string) => void
}

/** Maximum length of a persisted `detail` string. */
export const MAX_DETAIL_CHARS = 200

/** A value that disables logging when used as the configured path. */
const DISABLED_PATH = "off"

/**
 * Truncate a detail string to the persisted cap.
 *
 * @param detail - The raw detail.
 * @returns The detail, clipped to {@link MAX_DETAIL_CHARS}.
 */
function truncateDetail(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS ? detail.slice(0, MAX_DETAIL_CHARS) : detail
}

/** Render an unknown thrown value as a short message, without a stack. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Rotate the log once it reaches the size cap.
 *
 * `<path>` becomes `<path>.1`, `.1` becomes `.2`, and so on; the copy at
 * `<path>.<backups>` is dropped. A missing source is ignored so a concurrent
 * rotation is harmless.
 *
 * @param path - The active log file.
 * @param backups - Number of rotated copies to keep.
 */
export async function rotate(path: string, backups: number): Promise<void> {
  if (backups <= 0) {
    await unlink(path).catch(() => {})
    return
  }
  await unlink(`${path}.${backups}`).catch(() => {})
  for (let index = backups - 1; index >= 1; index--) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => {})
  }
  await rename(path, `${path}.1`)
}

/**
 * Append one decision as a single JSON line, rotating when the file is full.
 *
 * Never throws: any filesystem error is reported via `opts.onError` (when
 * provided) and swallowed so a logging failure cannot break a hook.
 *
 * @param entry - The decision to record.
 * @param opts - Resolved log path and rotation options.
 */
export async function appendDecision(
  entry: DecisionLogEntry,
  opts: DecisionLogOptions,
): Promise<void> {
  const path = opts.path.trim()
  if (path === "" || path === DISABLED_PATH) return

  const payload = {
    ts: new Date().toISOString(),
    hook: entry.hook,
    kind: entry.kind,
    decision: entry.decision,
    confidence: entry.confidence,
    action: entry.action,
    ...(entry.detail !== undefined ? { detail: truncateDetail(entry.detail) } : {}),
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
