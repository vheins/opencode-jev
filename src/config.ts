/**
 * Configuration resolution for the Jev plugin.
 *
 * Every value is read once at plugin load. Resolution precedence is:
 * opencode.json plugin options > environment variable > `~/.config/opencode/.jev-key`.
 *
 * `JEV_BASE_URL` (or the `baseUrl` option) is REQUIRED: the plugin ships no
 * default host, so an unset base URL disables Jev exactly like a missing key.
 * This keeps a custom router domain out of the source and prevents an
 * unconfigured install from silently calling a remote host.
 *
 * Option values are untrusted JSON from `opencode.json`: a wrong-typed value is
 * ignored (the environment value wins) and reported in `warnings`, never
 * thrown. An option-supplied API key is never included in a warning message.
 *
 * @module
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  booleanOption,
  countOption,
  parseBoolean,
  parseCount,
  parsePositiveInt,
  parseThreshold,
  positiveIntOption,
  stringOption,
  thresholdOption,
  type ConfigWarning,
  type PluginOptions,
} from "./config-options.ts"

// Re-export the parsing helpers so existing callers keep importing them from
// this module; the implementations now live in `config-options.ts`.
export {
  parseBoolean,
  parseCount,
  parsePositiveInt,
  parseThreshold,
  type ConfigWarning,
  type PluginOptions,
} from "./config-options.ts"

/** Fallback key file written by the router provider setup. */
export const DEFAULT_KEY_FILE = join(homedir(), ".config", "opencode", ".jev-key")

/**
 * Jev model id used when `JEV_MODEL` is unset.
 *
 * CONFIRMED against this deployment: POST /v1/systemone with an entitled key
 * returned HTTP 200 and `{"answers":{"is_urgent":{"type":"noul","noul":0.96}}}`.
 */
export const DEFAULT_MODEL = "oc/jev-1.13-free"

/** Default confidence above which a destructive verdict blocks the action. */
export const DEFAULT_BLOCK_THRESHOLD = 0.85

/** Default confidence above which a cascade-routing verdict surfaces a toast. */
export const DEFAULT_ROUTE_THRESHOLD = 0.8

/** Default confidence above which a non-transient session-error severity surfaces a toast. */
export const DEFAULT_SEVERITY_THRESHOLD = 0.8

/** Default confidence at or above which a compaction reminder is appended. */
export const DEFAULT_COMPACT_THRESHOLD = 0.75

/** Default probability above which a security-sensitive file edit surfaces a toast. */
export const DEFAULT_FILE_REVIEW_THRESHOLD = 0.8

/** Default decision-log path; an empty string or `"off"` disables logging. */
export const DEFAULT_DECISION_LOG_PATH = join(homedir(), ".config", "opencode", "jev-decisions.log")

/** Default decision-log size cap (bytes) before rotation. */
export const DEFAULT_DECISION_LOG_MAX_BYTES = 1_000_000

/** Default number of rotated decision-log copies to keep. */
export const DEFAULT_DECISION_LOG_BACKUPS = 3

/** Default for whether every decision also surfaces a toast. */
export const DEFAULT_TOAST_DECISIONS = false

/** Default trace-log path; empty string or `"off"` disables tracing. */
export const DEFAULT_TRACE_LOG_PATH = join(homedir(), ".local", "share", "opencode", "log", "jev.log")

/** Default trace-log size cap (bytes) before rotation. */
export const DEFAULT_TRACE_LOG_MAX_BYTES = 1_000_000

/** Default number of rotated trace-log copies to keep. */
export const DEFAULT_TRACE_LOG_BACKUPS = 3

/**
 * Default for whether the opt-in per-call trace log is enabled.
 *
 * OFF by default: enabling it writes one line per Jev call, so the default
 * install performs no trace file IO at all.
 */
export const DEFAULT_TRACE_LOG = false

/**
 * Default per-request timeout (ms) for a Jev call.
 *
 * Kept short so a hung router fails open fast and never stalls the main agent
 * loop; the blocking `tool.execute.before` hook additionally disables the retry
 * so its worst case is one timeout, not two.
 */
export const DEFAULT_TIMEOUT_MS = 3_000

/** How long a decision may be reused for identical input (ms). */
export const DEFAULT_CACHE_TTL_MS = 60_000
/** Maximum number of in-flight Jev requests; further calls fail fast as `busy`. */
export const MAX_CONCURRENT_REQUESTS = 4

/** Resolved plugin configuration. */
export type Config = {
  /** Whether Jev can be called at all (key + base URL present). */
  readonly enabled: boolean
  /** Bearer key for the router provider, when configured. */
  readonly apiKey: string | undefined
  /** Router pass-through route for System One judgments, when configured. */
  readonly baseUrl: string | undefined
  /** Jev model id. */
  readonly model: string
  /** Block a destructive action above this confidence. */
  readonly blockThreshold: number
  /** Toast a cascade-route verdict at or above this confidence. */
  readonly routeThreshold: number
  /** Toast a non-transient severity verdict at or above this confidence. */
  readonly severityThreshold: number
  /** Append a compaction reminder at or above this probability. */
  readonly compactThreshold: number
  /** Toast a security-sensitive file edit at or above this probability. */
  readonly fileReviewThreshold: number
  /** Decision-log file path; empty or `"off"` disables logging. */
  readonly decisionLogPath: string
  /** Rotate the decision log once it reaches this many bytes. */
  readonly decisionLogMaxBytes: number
  /** Number of rotated decision-log copies to keep. */
  readonly decisionLogBackups: number
  /** Whether the opt-in per-call trace log is enabled. */
  readonly traceLog: boolean
  /** Trace-log file path; empty or `"off"` disables tracing. */
  readonly traceLogPath: string
  /** Rotate the trace log once it reaches this many bytes. */
  readonly traceLogMaxBytes: number
  /** Number of rotated trace-log copies to keep. */
  readonly traceLogBackups: number
  /** Whether every decision also surfaces a TUI toast. */
  readonly toastDecisions: boolean
  /** Per-request timeout (ms). */
  readonly timeoutMs: number
  /** Decision cache TTL (ms). */
  readonly cacheTtlMs: number
  /** Maximum concurrent Jev requests. */
  readonly maxConcurrent: number
}

/** The reason Jev is disabled, when it is. */
export type DisabledReason = "missing-key" | "missing-base-url"

/**
 * Read the JEV API key from the provider key file only.
 *
 * @returns The trimmed key, or `undefined` when the file is absent or empty.
 */
export function readKeyFile(): string | undefined {
  try {
    const fromFile = readFileSync(DEFAULT_KEY_FILE, "utf8").trim()
    return fromFile || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the JEV API key from the environment, then the provider key file.
 *
 * @returns The trimmed key, or `undefined` when neither source yields one.
 */
export function resolveApiKey(): string | undefined {
  const fromEnv = process.env.JEV_API_KEY?.trim()
  if (fromEnv) return fromEnv
  return readKeyFile()
}

/**
 * Build the resolved configuration from plugin options, environment, and key file.
 *
 * Precedence: `options` > `env` > `key`. A wrong-typed option is ignored and
 * reported in `warnings` rather than thrown, so a malformed `opencode.json`
 * cannot disable the plugin's safety behavior. The base URL has no default: an
 * unset `baseUrl` option and an unset `JEV_BASE_URL` disable Jev rather than
 * falling back to any host.
 *
 * @param options - Untrusted plugin options from the opencode.json tuple form.
 * @param env - Environment source; defaults to `process.env`.
 * @param keyFile - Key-file fallback; defaults to {@link readKeyFile}.
 * @returns The resolved configuration, disabled reason, and ignored-option warnings.
 */
export function loadConfig(
  options: PluginOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  keyFile: string | undefined = readKeyFile(),
): {
  readonly config: Config
  readonly disabledReason?: DisabledReason
  readonly warnings: readonly ConfigWarning[]
} {
  const warnings: ConfigWarning[] = []

  const baseUrl =
    stringOption(options, "baseUrl", warnings) ?? (env.JEV_BASE_URL?.trim() || undefined)
  const model =
    stringOption(options, "model", warnings) ?? (env.JEV_MODEL?.trim() || DEFAULT_MODEL)
  const envKey = env.JEV_API_KEY?.trim() || undefined
  const apiKey = stringOption(options, "apiKey", warnings) ?? envKey ?? keyFile

  // A blank `decisionLogPath` option is meaningful: it disables logging. So it
  // is read directly rather than through `stringOption`, which rejects blanks.
  let decisionLogPath: string
  if ("decisionLogPath" in options) {
    const raw = options.decisionLogPath
    if (typeof raw === "string") {
      decisionLogPath = raw.trim()
    } else {
      warnings.push({ field: "decisionLogPath", reason: "expected a string" })
      decisionLogPath = env.JEV_DECISION_LOG?.trim() || DEFAULT_DECISION_LOG_PATH
    }
  } else {
    decisionLogPath = env.JEV_DECISION_LOG?.trim() || DEFAULT_DECISION_LOG_PATH
  }

  // A blank `traceLogPath` option is meaningful: it disables tracing. Read it
  // directly rather than through `stringOption`, which rejects blanks.
  let traceLogPath: string
  if ("traceLogPath" in options) {
    const raw = options.traceLogPath
    if (typeof raw === "string") {
      traceLogPath = raw.trim()
    } else {
      warnings.push({ field: "traceLogPath", reason: "expected a string" })
      traceLogPath = env.JEV_TRACE_LOG_PATH?.trim() || DEFAULT_TRACE_LOG_PATH
    }
  } else {
    traceLogPath = env.JEV_TRACE_LOG_PATH?.trim() || DEFAULT_TRACE_LOG_PATH
  }

  let disabledReason: DisabledReason | undefined
  if (!apiKey) disabledReason = "missing-key"
  else if (!baseUrl) disabledReason = "missing-base-url"
  return {
    config: {
      enabled: disabledReason === undefined,
      apiKey,
      baseUrl,
      model,
      blockThreshold: thresholdOption(
        options,
        "blockThreshold",
        parseThreshold(env.JEV_BLOCK_THRESHOLD, DEFAULT_BLOCK_THRESHOLD),
        warnings,
      ),
      routeThreshold: thresholdOption(
        options,
        "routeThreshold",
        parseThreshold(env.JEV_ROUTE_THRESHOLD, DEFAULT_ROUTE_THRESHOLD),
        warnings,
      ),
      severityThreshold: thresholdOption(
        options,
        "severityThreshold",
        parseThreshold(env.JEV_SEVERITY_THRESHOLD, DEFAULT_SEVERITY_THRESHOLD),
        warnings,
      ),
      compactThreshold: thresholdOption(
        options,
        "compactThreshold",
        parseThreshold(env.JEV_COMPACT_THRESHOLD, DEFAULT_COMPACT_THRESHOLD),
        warnings,
      ),
      fileReviewThreshold: thresholdOption(
        options,
        "fileReviewThreshold",
        parseThreshold(env.JEV_FILE_REVIEW_THRESHOLD, DEFAULT_FILE_REVIEW_THRESHOLD),
        warnings,
      ),
      decisionLogPath,
      decisionLogMaxBytes: countOption(
        options,
        "decisionLogMaxBytes",
        parseCount(env.JEV_DECISION_LOG_MAX_BYTES, DEFAULT_DECISION_LOG_MAX_BYTES),
        warnings,
      ),
      decisionLogBackups: countOption(
        options,
        "decisionLogBackups",
        parseCount(env.JEV_DECISION_LOG_BACKUPS, DEFAULT_DECISION_LOG_BACKUPS),
        warnings,
      ),
      traceLog: booleanOption(
        options,
        "traceLog",
        parseBoolean(env.JEV_TRACE_LOG, DEFAULT_TRACE_LOG),
        warnings,
      ),
      traceLogPath,
      traceLogMaxBytes: countOption(
        options,
        "traceLogMaxBytes",
        parseCount(env.JEV_TRACE_LOG_MAX_BYTES, DEFAULT_TRACE_LOG_MAX_BYTES),
        warnings,
      ),
      traceLogBackups: countOption(
        options,
        "traceLogBackups",
        parseCount(env.JEV_TRACE_LOG_BACKUPS, DEFAULT_TRACE_LOG_BACKUPS),
        warnings,
      ),
      toastDecisions: booleanOption(
        options,
        "toastDecisions",
        parseBoolean(env.JEV_TOAST_DECISIONS, DEFAULT_TOAST_DECISIONS),
        warnings,
      ),
      timeoutMs: positiveIntOption(
        options,
        "timeoutMs",
        parsePositiveInt(env.JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        warnings,
      ),
      cacheTtlMs: positiveIntOption(
        options,
        "cacheTtlMs",
        parsePositiveInt(env.JEV_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
        warnings,
      ),
      maxConcurrent: MAX_CONCURRENT_REQUESTS,
    },
    ...(disabledReason ? { disabledReason } : {}),
    warnings,
  }
}
