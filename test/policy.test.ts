/**
 * Tests for local action classification and the per-category failure policy.
 *
 * These are the cheap deterministic checks that run before any network call,
 * so they must be correct without Jev: known read-only tools skip the call,
 * destructive command patterns are recognized, and high-impact categories warn
 * (but never auto-allow) when Jev cannot produce a verdict.
 *
 * @module
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  categoryForRisk,
  classifyFileSensitivity,
  classifyLocally,
  failurePolicy,
  isHighImpact,
} from "../src/policy.ts"

test("classifyLocally: known read-only tools skip Jev", () => {
  for (const tool of ["read", "glob", "grep", "list"]) {
    const result = classifyLocally(tool, { filePath: "/etc/passwd" })
    assert.equal(result.kind, "read_only", `tool=${tool}`)
  }
})

test("classifyLocally: rm -rf is a destructive hint", () => {
  const result = classifyLocally("bash", { command: "rm -rf /tmp/x" })
  assert.equal(result.kind, "destructive_hint")
})

test("classifyLocally: git push --force is a destructive hint", () => {
  assert.equal(classifyLocally("bash", { command: "git push origin main --force" }).kind, "destructive_hint")
})

test("classifyLocally: DROP TABLE is a destructive hint", () => {
  assert.equal(classifyLocally("bash", { command: "psql -c 'DROP TABLE users'" }).kind, "destructive_hint")
})

test("classifyLocally: an ordinary mutating command is unknown, not destructive", () => {
  assert.equal(classifyLocally("bash", { command: "echo hello > file.txt" }).kind, "unknown")
})

test("classifyLocally: a string argument is searched too", () => {
  assert.equal(classifyLocally("bash", "rm -rf /").kind, "destructive_hint")
})

test("categoryForRisk: maps labels to categories", () => {
  assert.equal(categoryForRisk("read_only"), "read_only")
  assert.equal(categoryForRisk("mutating"), "reversible")
  assert.equal(categoryForRisk("destructive"), "destructive")
})

test("failurePolicy: high-impact warns, low-risk ignores", () => {
  assert.equal(failurePolicy("destructive"), "warn")
  assert.equal(failurePolicy("high_impact"), "warn")
  assert.equal(failurePolicy("reversible"), "ignore")
  assert.equal(failurePolicy("read_only"), "ignore")
})

test("isHighImpact: only destructive and high_impact are high-impact", () => {
  assert.equal(isHighImpact("destructive"), true)
  assert.equal(isHighImpact("high_impact"), true)
  assert.equal(isHighImpact("reversible"), false)
  assert.equal(isHighImpact("read_only"), false)
})

test("classifyFileSensitivity: sensitive paths score high, ordinary paths score 0", () => {
  assert.equal(classifyFileSensitivity(".env").score, 0.9)
  assert.equal(classifyFileSensitivity("config/id_rsa").score, 0.9)
  assert.equal(classifyFileSensitivity("src/index.ts").score, 0)
})

test("classifyFileSensitivity: malformed input never throws and scores 0", () => {
  for (const input of [undefined as any, 123 as any, null as any, {} as any, ""]) {
    const result = classifyFileSensitivity(input)
    assert.equal(result.score, 0, `input=${String(input)}`)
    assert.equal(typeof result.reason, "string")
  }
})
