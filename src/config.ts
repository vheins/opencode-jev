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

/** Per-request timeout (ms) for a Jev call, so a hung router never stalls a hook. */
export const REQUEST_TIMEOUT_MS = 10_000

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
 * Parse a numeric threshold from an environment value.
 *
 * A value outside `[0, 1]` is treated as absent so a typo cannot widen a
 * guardrail silently.
 *
 * @param raw - Raw environment string, or `undefined` when unset.
 * @param fallback - Value returned when the input is missing or not finite.
 * @returns The parsed threshold, or `fallback`.
 */
export function parseThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback
  return parsed
}

/** Untrusted plugin options delivered by the opencode.json tuple form. */
export type PluginOptions = Record<string, unknown>

/** A single ignored-option warning; it names the field, never its value. */
export type ConfigWarning = { readonly field: string; readonly reason: string }

/**
 * Read a string plugin option.
 *
 * A wrong-typed or blank value is ignored (the environment value then wins)
 * and reported as a warning. The value itself is never echoed, so an
 * option-supplied secret cannot leak through a warning.
 *
 * @param options - The raw plugin options.
 * @param field - The option key to read.
 * @param warnings - Collector for ignored-option warnings.
 * @returns The trimmed value, or `undefined` when absent or invalid.
 */
function stringOption(
  options: PluginOptions,
  field: string,
  warnings: ConfigWarning[],
): string | undefined {
  if (!(field in options)) return undefined
  const raw = options[field]
  if (typeof raw !== "string") {
    warnings.push({ field, reason: "expected a string" })
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed === "") {
    warnings.push({ field, reason: "empty string" })
    return undefined
  }
  return trimmed
}

/**
 * Read a numeric threshold plugin option.
 *
 * A non-finite or out-of-range value is ignored and reported, so a typo cannot
 * widen a guardrail silently.
 *
 * @param options - The raw plugin options.
 * @param field - The option key to read.
 * @param fallback - Value used when the option is absent or invalid.
 * @param warnings - Collector for ignored-option warnings.
 * @returns The validated threshold, or `fallback`.
 */
function thresholdOption(
  options: PluginOptions,
  field: string,
  fallback: number,
  warnings: ConfigWarning[],
): number {
  if (!(field in options)) return fallback
  const raw = options[field]
  if (typeof raw !== "number") {
    warnings.push({ field, reason: "expected a number" })
    return fallback
  }
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
    warnings.push({ field, reason: "expected a number in [0, 1]" })
    return fallback
  }
  return raw
}

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
      timeoutMs: REQUEST_TIMEOUT_MS,
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      maxConcurrent: MAX_CONCURRENT_REQUESTS,
    },
    ...(disabledReason ? { disabledReason } : {}),
    warnings,
  }
}
