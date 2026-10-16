/**
 * Option and environment parsing helpers for Jev configuration.
 *
 * These are the pure, side-effect-free readers used by {@link loadConfig}:
 * environment parsers that fall back on a malformed value, and plugin-option
 * readers that ignore a wrong-typed value and record a {@link ConfigWarning}
 * instead of throwing. They live here so the resolution module stays focused
 * and within the file-size bound. A warning names the field, never its value,
 * so an option-supplied secret cannot leak through a warning.
 *
 * @module
 */

/** Untrusted plugin options delivered by the opencode.json tuple form. */
export type PluginOptions = Record<string, unknown>

/** A single ignored-option warning; it names the field, never its value. */
export type ConfigWarning = { readonly field: string; readonly reason: string }

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

/**
 * Parse a non-negative integer from an environment value.
 *
 * @param raw - Raw environment string, or `undefined` when unset.
 * @param fallback - Value returned when the input is missing or invalid.
 * @returns The parsed integer, or `fallback`.
 */
export function parseCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return parsed
}

/**
 * Parse a boolean from an environment value.
 *
 * Accepts `1`/`true`/`yes`/`on` (case-insensitive) as true and
 * `0`/`false`/`no`/`off` as false; anything else falls back.
 *
 * @param raw - Raw environment string, or `undefined` when unset.
 * @param fallback - Value returned when the input is missing or unrecognized.
 * @returns The parsed boolean, or `fallback`.
 */
export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  const value = raw.trim().toLowerCase()
  if (value === "") return fallback
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  return fallback
}

/**
 * Parse a positive integer from an environment value.
 *
 * @param raw - Raw environment string, or `undefined` when unset.
 * @param fallback - Value returned when the input is missing or invalid.
 * @returns The parsed integer, or `fallback`.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

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
export function stringOption(
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
export function thresholdOption(
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
 * Read a non-negative integer plugin option.
 *
 * A non-integer or negative value is ignored and reported, so a malformed
 * rotation setting cannot disable the cap silently.
 *
 * @param options - The raw plugin options.
 * @param field - The option key to read.
 * @param fallback - Value used when the option is absent or invalid.
 * @param warnings - Collector for ignored-option warnings.
 * @returns The validated integer, or `fallback`.
 */
export function countOption(
  options: PluginOptions,
  field: string,
  fallback: number,
  warnings: ConfigWarning[],
): number {
  if (!(field in options)) return fallback
  const raw = options[field]
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    warnings.push({ field, reason: "expected a non-negative integer" })
    return fallback
  }
  return raw
}

/**
 * Read a boolean plugin option.
 *
 * A non-boolean value is ignored and reported, so a string like `"false"`
 * cannot silently flip a flag on.
 *
 * @param options - The raw plugin options.
 * @param field - The option key to read.
 * @param fallback - Value used when the option is absent or invalid.
 * @param warnings - Collector for ignored-option warnings.
 * @returns The validated boolean, or `fallback`.
 */
export function booleanOption(
  options: PluginOptions,
  field: string,
  fallback: boolean,
  warnings: ConfigWarning[],
): boolean {
  if (!(field in options)) return fallback
  const raw = options[field]
  if (typeof raw !== "boolean") {
    warnings.push({ field, reason: "expected a boolean" })
    return fallback
  }
  return raw
}

/**
 * Read a positive-integer plugin option.
 *
 * A non-integer or non-positive value is ignored and reported, so a malformed
 * timeout cannot disable the bound silently.
 *
 * @param options - The raw plugin options.
 * @param field - The option key to read.
 * @param fallback - Value used when the option is absent or invalid.
 * @param warnings - Collector for ignored-option warnings.
 * @returns The validated integer, or `fallback`.
 */
export function positiveIntOption(
  options: PluginOptions,
  field: string,
  fallback: number,
  warnings: ConfigWarning[],
): number {
  if (!(field in options)) return fallback
  const raw = options[field]
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    warnings.push({ field, reason: "expected a positive integer" })
    return fallback
  }
  return raw
}
