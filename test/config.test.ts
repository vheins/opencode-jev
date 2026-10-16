/**
 * Tests for configuration resolution.
 *
 * The load-bearing case is `JEV_BASE_URL`: it must have NO default host, so an
 * unset base URL disables Jev exactly like a missing key. These tests pin that
 * behavior, plus threshold parsing and the key precedence.
 *
 * @module
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { loadConfig, parseThreshold } from "../src/config.ts"

test("loadConfig: unset JEV_BASE_URL disables Jev with missing-base-url", () => {
  const { config, disabledReason } = loadConfig({ JEV_API_KEY: "secret" }, "secret")
  assert.equal(config.enabled, false)
  assert.equal(config.baseUrl, undefined)
  assert.equal(disabledReason, "missing-base-url")
})

test("loadConfig: blank JEV_BASE_URL is treated as unset (no default host)", () => {
  const { config, disabledReason } = loadConfig({ JEV_API_KEY: "k", JEV_BASE_URL: "   " }, "k")
  assert.equal(config.enabled, false)
  assert.equal(config.baseUrl, undefined)
  assert.equal(disabledReason, "missing-base-url")
})

test("loadConfig: missing key disables Jev with missing-key", () => {
  // Pass "" (not undefined) so the resolveApiKey() default parameter — which
  // would read the real ~/.config/opencode/.jev-key — is never triggered. This
  // keeps the test hermetic on a machine that has the key file present.
  const { config, disabledReason } = loadConfig({ JEV_BASE_URL: "https://router.example/v1/systemone" }, "")
  assert.equal(config.enabled, false)
  assert.equal(disabledReason, "missing-key")
})

test("loadConfig: both key and base URL present enables Jev", () => {
  const { config, disabledReason } = loadConfig(
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://router.example/v1/systemone" },
    "k",
  )
  assert.equal(config.enabled, true)
  assert.equal(disabledReason, undefined)
  assert.equal(config.baseUrl, "https://router.example/v1/systemone")
  assert.equal(config.model, "oc/jev-1.13-free")
})

test("loadConfig: no spasi/custom domain appears as a default", () => {
  // Pass "" (not undefined) so the resolveApiKey() default parameter is not
  // triggered and the test never reads a real key file from the host.
  const { config } = loadConfig({}, "")
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
    { JEV_API_KEY: "k", JEV_BASE_URL: "https://r.example/v1", JEV_BLOCK_THRESHOLD: "0.5" },
    "k",
  )
  assert.equal(config.blockThreshold, 0.5)
})
