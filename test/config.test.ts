/**
 * Tests for configuration resolution.
 *
 * The load-bearing cases are: (1) the base URL has NO default host, so an unset
 * base URL disables Jev exactly like a missing key; (2) plugin options from the
 * opencode.json tuple form take precedence over the environment, which takes
 * precedence over the key file; (3) a wrong-typed option is ignored (never
 * throws) and never echoes its value.
 *
 * @module
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { loadConfig, parseBoolean, parseCount, parsePositiveInt, parseThreshold } from "../src/config.ts"

test("loadConfig: unset JEV_BASE_URL disables Jev with missing-base-url", () => {
  const { config, disabledReason } = loadConfig({}, { JEV_API_KEY: "secret" }, "secret")
  assert.equal(config.enabled, false)
  assert.equal(config.baseUrl, undefined)
  assert.equal(disabledReason, "missing-base-url")
})

test("loadConfig: blank JEV_BASE_URL is treated as unset (no default host)", () => {
  const { config, disabledReason } = loadConfig({}, { JEV_API_KEY: "k", JEV_BASE_URL: "   " }, "k")
  assert.equal(config.enabled, false)
  assert.equal(config.baseUrl, undefined)
  assert.equal(disabledReason, "missing-base-url")
})

test("loadConfig: missing key disables Jev with missing-key", () => {
  // Pass "" (not undefined) so the resolveApiKey() default parameter — which
  // would read the real ~/.config/opencode/.jev-key — is never triggered. This
  // keeps the test hermetic on a machine that has the key file present.
  const { config, disabledReason } = loadConfig(
    {},
    { JEV_BASE_URL: "https://router.example/v1/systemone" },
    "",
  )
  assert.equal(config.enabled, false)
  assert.equal(disabledReason, "missing-key")
})

test("loadConfig: both key and base URL present enables Jev", () => {
  const { config, disabledReason } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://router.example/v1/systemone" },
    "k",
  )
  assert.equal(config.enabled, true)
  assert.equal(disabledReason, undefined)
  assert.equal(config.baseUrl, "https://router.example/v1/systemone")
  assert.equal(config.model, "oc/jev-1.13-free")
})

test("loadConfig: no custom domain appears as a default", () => {
  // Pass "" (not undefined) so the resolveApiKey() default parameter is not
  // triggered and the test never reads a real key file from the host.
  const { config } = loadConfig({}, {}, "")
  assert.equal(config.baseUrl, undefined)
  assert.equal(config.apiKey, "")
  assert.equal(config.enabled, false)
})

test("parseThreshold: valid value in range is used", () => {
  assert.equal(parseThreshold("0.5", 0.8), 0.5)
})

test("parseThreshold: missing, blank, non-finite, or out-of-range falls back", () => {
  assert.equal(parseThreshold(undefined, 0.8), 0.8)
  assert.equal(parseThreshold("", 0.8), 0.8)
  assert.equal(parseThreshold("abc", 0.8), 0.8)
  assert.equal(parseThreshold("1.5", 0.8), 0.8)
  assert.equal(parseThreshold("-0.1", 0.8), 0.8)
})

test("loadConfig: threshold env overrides are honored", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://r.example/v1", JEV_BLOCK_THRESHOLD: "0.5" },
    "k",
  )
  assert.equal(config.blockThreshold, 0.5)
})

test("loadConfig: options supply baseUrl, model, and apiKey", () => {
  const { config, disabledReason } = loadConfig(
    { baseUrl: "https://opt.example/v1/systemone", model: "opt-model", apiKey: "opt-key" },
    {},
    undefined,
  )
  assert.equal(config.enabled, true)
  assert.equal(disabledReason, undefined)
  assert.equal(config.baseUrl, "https://opt.example/v1/systemone")
  assert.equal(config.model, "opt-model")
  assert.equal(config.apiKey, "opt-key")
})

test("loadConfig: options override the environment (options > env)", () => {
  const { config } = loadConfig(
    { baseUrl: "https://opt.example/v1", model: "opt-model" },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_MODEL: "env-model" },
    "k",
  )
  assert.equal(config.baseUrl, "https://opt.example/v1")
  assert.equal(config.model, "opt-model")
})

test("loadConfig: environment overrides the key-file fallback (env > key)", () => {
  const { config } = loadConfig({}, { JEV_API_KEY: "env-key", JEV_BASE_URL: "https://env.example/v1" }, "file-key")
  assert.equal(config.apiKey, "env-key")
})

test("loadConfig: key file is used when no option or env key is present", () => {
  const { config } = loadConfig({}, { JEV_BASE_URL: "https://env.example/v1" }, "file-key")
  assert.equal(config.apiKey, "file-key")
})

test("loadConfig: options.baseUrl satisfies the required base URL path", () => {
  const { config, disabledReason } = loadConfig({ baseUrl: "https://opt.example/v1", apiKey: "k" }, {}, undefined)
  assert.equal(config.enabled, true)
  assert.equal(disabledReason, undefined)
  assert.equal(config.baseUrl, "https://opt.example/v1")
})

test("loadConfig: a wrong-typed option is ignored, falls back to env, and warns", () => {
  const { config, warnings } = loadConfig(
    { baseUrl: 123, blockThreshold: "0.5" },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_BLOCK_THRESHOLD: "0.4" },
    "k",
  )
  assert.equal(config.baseUrl, "https://env.example/v1", "wrong-typed baseUrl must fall back to env")
  assert.equal(config.blockThreshold, 0.4, "wrong-typed threshold must fall back to env")
  assert.equal(warnings.length, 2)
  assert.deepEqual(
    warnings.map((w) => w.field).sort(),
    ["baseUrl", "blockThreshold"],
  )
})

test("loadConfig: an out-of-range numeric option is ignored and warns", () => {
  const { config, warnings } = loadConfig(
    { blockThreshold: 1.5, routeThreshold: Number.NaN },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(config.blockThreshold, 0.85)
  assert.equal(config.routeThreshold, 0.8)
  assert.equal(warnings.length, 2)
})

test("loadConfig: a valid option threshold overrides the env threshold", () => {
  const { config } = loadConfig(
    { blockThreshold: 0.5 },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_BLOCK_THRESHOLD: "0.9" },
    "k",
  )
  assert.equal(config.blockThreshold, 0.5)
})

test("loadConfig: a wrong-typed apiKey option is ignored and never echoed in a warning", () => {
  const { config, warnings } = loadConfig(
    { apiKey: 42 },
    { JEV_API_KEY: "env-secret", JEV_BASE_URL: "https://env.example/v1" },
    "env-secret",
  )
  assert.equal(config.apiKey, "env-secret")
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.field, "apiKey")
  // The warning names the field only; it must never carry a value.
  assert.equal(warnings[0]?.reason.includes("42"), false)
  assert.equal(JSON.stringify(warnings).includes("42"), false)
})

test("loadConfig: an option-provided apiKey never appears in any warning", () => {
  const secret = "sk-option-secret-value"
  const { warnings } = loadConfig(
    { apiKey: secret, blockThreshold: "nope" },
    { JEV_BASE_URL: "https://env.example/v1" },
    undefined,
  )
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.field, "blockThreshold")
  assert.equal(JSON.stringify(warnings).includes(secret), false)
})

test("loadConfig: an unknown option key is ignored without a warning", () => {
  const { warnings } = loadConfig(
    { notAJevField: "x" },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(warnings.length, 0)
})

test("parseCount: non-negative integers pass; missing/invalid fall back", () => {
  assert.equal(parseCount("5", 3), 5)
  assert.equal(parseCount("0", 3), 0)
  assert.equal(parseCount(undefined, 3), 3)
  assert.equal(parseCount("", 3), 3)
  assert.equal(parseCount("-1", 3), 3)
  assert.equal(parseCount("1.5", 3), 3)
  assert.equal(parseCount("abc", 3), 3)
})

test("parseBoolean: truthy/falsy strings parse; missing/unrecognized fall back", () => {
  assert.equal(parseBoolean("true", false), true)
  assert.equal(parseBoolean("1", false), true)
  assert.equal(parseBoolean("YES", false), true)
  assert.equal(parseBoolean("on", false), true)
  assert.equal(parseBoolean("false", true), false)
  assert.equal(parseBoolean("0", true), false)
  assert.equal(parseBoolean("off", true), false)
  assert.equal(parseBoolean(undefined, true), true)
  assert.equal(parseBoolean("maybe", true), true)
})

test("loadConfig: decision-log fields default when nothing is set", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.match(config.decisionLogPath, /jev-decisions\.log$/)
  assert.equal(config.decisionLogMaxBytes, 1_000_000)
  assert.equal(config.decisionLogBackups, 3)
  assert.equal(config.toastDecisions, false)
})

test("loadConfig: decision-log env overrides are honored", () => {
  const { config } = loadConfig(
    {},
    {
      JEV_API_KEY: "k",
      JEV_BASE_URL: "https://env.example/v1",
      JEV_DECISION_LOG: "/tmp/jev-env.log",
      JEV_DECISION_LOG_MAX_BYTES: "2048",
      JEV_DECISION_LOG_BACKUPS: "5",
      JEV_TOAST_DECISIONS: "true",
    },
    "k",
  )
  assert.equal(config.decisionLogPath, "/tmp/jev-env.log")
  assert.equal(config.decisionLogMaxBytes, 2048)
  assert.equal(config.decisionLogBackups, 5)
  assert.equal(config.toastDecisions, true)
})

test("loadConfig: options override the decision-log env (options > env)", () => {
  const { config } = loadConfig(
    {
      decisionLogPath: "/tmp/jev-opt.log",
      decisionLogMaxBytes: 4096,
      decisionLogBackups: 1,
      toastDecisions: true,
    },
    {
      JEV_API_KEY: "k",
      JEV_BASE_URL: "https://env.example/v1",
      JEV_DECISION_LOG: "/tmp/jev-env.log",
      JEV_DECISION_LOG_MAX_BYTES: "2048",
      JEV_DECISION_LOG_BACKUPS: "5",
      JEV_TOAST_DECISIONS: "false",
    },
    "k",
  )
  assert.equal(config.decisionLogPath, "/tmp/jev-opt.log")
  assert.equal(config.decisionLogMaxBytes, 4096)
  assert.equal(config.decisionLogBackups, 1)
  assert.equal(config.toastDecisions, true)
})

test("loadConfig: an empty decisionLogPath option disables logging (not ignored)", () => {
  const { config, warnings } = loadConfig(
    { decisionLogPath: "" },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(config.decisionLogPath, "")
  assert.equal(warnings.length, 0, "an empty path is a valid 'disable' value, not a warning")
})

test("loadConfig: trace-log is OFF by default and points at the share dir", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(config.traceLog, false, "trace logging must be opt-in")
  assert.match(config.traceLogPath, /\.local[/\\]share[/\\]opencode[/\\]log[/\\]jev\.log$/)
  assert.equal(config.traceLogMaxBytes, 1_000_000)
  assert.equal(config.traceLogBackups, 3)
})

test("loadConfig: trace-log env enables and overrides the path", () => {
  const { config } = loadConfig(
    {},
    {
      JEV_API_KEY: "k",
      JEV_BASE_URL: "https://env.example/v1",
      JEV_TRACE_LOG: "1",
      JEV_TRACE_LOG_PATH: "/tmp/jev-trace.log",
      JEV_TRACE_LOG_MAX_BYTES: "4096",
      JEV_TRACE_LOG_BACKUPS: "2",
    },
    "k",
  )
  assert.equal(config.traceLog, true)
  assert.equal(config.traceLogPath, "/tmp/jev-trace.log")
  assert.equal(config.traceLogMaxBytes, 4096)
  assert.equal(config.traceLogBackups, 2)
})

test("loadConfig: trace-log options override the env (options > env)", () => {
  const { config } = loadConfig(
    { traceLog: true, traceLogPath: "/tmp/jev-opt-trace.log", traceLogMaxBytes: 8192, traceLogBackups: 1 },
    {
      JEV_API_KEY: "k",
      JEV_BASE_URL: "https://env.example/v1",
      JEV_TRACE_LOG: "0",
      JEV_TRACE_LOG_PATH: "/tmp/jev-env-trace.log",
      JEV_TRACE_LOG_MAX_BYTES: "4096",
      JEV_TRACE_LOG_BACKUPS: "2",
    },
    "k",
  )
  assert.equal(config.traceLog, true)
  assert.equal(config.traceLogPath, "/tmp/jev-opt-trace.log")
  assert.equal(config.traceLogMaxBytes, 8192)
  assert.equal(config.traceLogBackups, 1)
})

test("loadConfig: wrong-typed trace-log options are ignored and warn", () => {
  const { config, warnings } = loadConfig(
    { traceLog: "yes", traceLogPath: 123, traceLogMaxBytes: -1, traceLogBackups: 1.5 },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(config.traceLog, false, "a non-boolean must not flip tracing on")
  assert.match(config.traceLogPath, /jev\.log$/)
  assert.equal(config.traceLogMaxBytes, 1_000_000)
  assert.equal(config.traceLogBackups, 3)
  const fields = warnings.map((warning) => warning.field).sort()
  assert.deepEqual(fields, ["traceLog", "traceLogBackups", "traceLogMaxBytes", "traceLogPath"])
})

test("loadConfig: wrong-typed decision-log options are ignored and warn", () => {
  const { config, warnings } = loadConfig(
    { decisionLogMaxBytes: "big", decisionLogBackups: -1, toastDecisions: "yes" },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(config.decisionLogMaxBytes, 1_000_000)
  assert.equal(config.decisionLogBackups, 3)
  assert.equal(config.toastDecisions, false)
  assert.deepEqual(
    warnings.map((w) => w.field).sort(),
    ["decisionLogBackups", "decisionLogMaxBytes", "toastDecisions"],
  )
})

test("loadConfig: timeoutMs defaults to 3000 when nothing is set", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(config.timeoutMs, 3_000)
})

test("loadConfig: JEV_TIMEOUT_MS env overrides the default timeout", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_TIMEOUT_MS: "1500" },
    "k",
  )
  assert.equal(config.timeoutMs, 1_500)
})

test("loadConfig: a timeoutMs option overrides the env (options > env)", () => {
  const { config } = loadConfig(
    { timeoutMs: 750 },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_TIMEOUT_MS: "1500" },
    "k",
  )
  assert.equal(config.timeoutMs, 750)
})

test("loadConfig: an invalid timeout falls back to the default and warns", () => {
  const { config, warnings } = loadConfig(
    { timeoutMs: -1 },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_TIMEOUT_MS: "0" },
    "k",
  )
  assert.equal(config.timeoutMs, 3_000, "a non-positive timeout must fall back to the default")
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.field, "timeoutMs")
})

test("parsePositiveInt: positive integers pass; missing/zero/negative/non-integer fall back", () => {
  assert.equal(parsePositiveInt("2000", 3000), 2000)
  assert.equal(parsePositiveInt(undefined, 3000), 3000)
  assert.equal(parsePositiveInt("", 3000), 3000)
  assert.equal(parsePositiveInt("0", 3000), 3000)
  assert.equal(parsePositiveInt("-5", 3000), 3000)
  assert.equal(parsePositiveInt("1.5", 3000), 3000)
  assert.equal(parsePositiveInt("abc", 3000), 3000)
})

test("loadConfig: cacheTtlMs defaults to 60000 when nothing is set", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1" },
    "k",
  )
  assert.equal(config.cacheTtlMs, 60_000)
})

test("loadConfig: JEV_CACHE_TTL_MS env overrides the default TTL", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_CACHE_TTL_MS: "120000" },
    "k",
  )
  assert.equal(config.cacheTtlMs, 120_000)
})

test("loadConfig: a cacheTtlMs option overrides the env (options > env)", () => {
  const { config } = loadConfig(
    { cacheTtlMs: 5_000 },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_CACHE_TTL_MS: "120000" },
    "k",
  )
  assert.equal(config.cacheTtlMs, 5_000)
})

test("loadConfig: an invalid cacheTtlMs option is ignored, falls back to env, and warns", () => {
  const { config, warnings } = loadConfig(
    { cacheTtlMs: -1 },
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_CACHE_TTL_MS: "120000" },
    "k",
  )
  assert.equal(config.cacheTtlMs, 120_000, "a non-positive option must fall back to the env")
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.field, "cacheTtlMs")
})

test("loadConfig: an invalid JEV_CACHE_TTL_MS falls back to the default", () => {
  const { config } = loadConfig(
    {},
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://env.example/v1", JEV_CACHE_TTL_MS: "0" },
    "k",
  )
  assert.equal(config.cacheTtlMs, 60_000, "a non-positive env TTL must fall back to the default")
})
