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
  riskCacheScope,
} from "../src/policy.ts"

test("classifyLocally: known read-only tools skip Jev", () => {
  for (const tool of ["read", "glob", "grep", "list"]) {
    const result = classifyLocally(tool, { filePath: "/etc/passwd" })
    assert.equal(result.kind, "read_only", `tool=${tool}`)
  }
})

test("classifyLocally: low-risk meta tools (todowrite, task-read) skip Jev", () => {
  for (const tool of ["todowrite", "todoread", "task-read"]) {
    assert.equal(classifyLocally(tool, {}).kind, "read_only", `tool=${tool}`)
  }
})

test("classifyLocally: mutating and dispatch tools stay on the network path", () => {
  for (const tool of ["edit", "write", "bash", "execute", "task", "memory-write"]) {
    assert.equal(classifyLocally(tool, { command: "echo hi" }).kind, "unknown", `tool=${tool}`)
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

/**
 * Cache-scope tests.
 *
 * The scope is the safety discriminator the client cache key uses. It must
 * separate any two calls that could yield a different risk verdict: destructive
 * hints are keyed by their matched pattern, and the tool id is always prefixed.
 * The `unknown` class is intentionally coarse and is NOT a safe equivalence key
 * (two unknown actions can still be verdict differently), so `tool.execute.before`
 * omits the scope for `unknown` and falls back to the full-state key — proven at
 * the hook boundary in `plugin.test.ts`.
 */

test("riskCacheScope: the unknown class is coarse and unsafe as an equivalence key", () => {
  const a = riskCacheScope("bash", { command: "echo one > a.txt" })
  const b = riskCacheScope("bash", { command: "rm file.txt" })
  // Neither arg matches a DESTRUCTIVE_HINT, so both collapse to the same coarse
  // label. This is exactly why the hook omits the scope for unknown actions.
  assert.equal(a, b, "the unknown class does not separate these two actions")
  assert.equal(a, "bash\u0000unknown")
})

test("riskCacheScope: a read-only tool and a destructive call never share a scope", () => {
  const readOnly = riskCacheScope("bash", { command: "ls -la" })
  const destructive = riskCacheScope("bash", { command: "rm -rf /tmp/x" })
  assert.notEqual(readOnly, destructive, "a destructive call must not reuse a non-destructive key")
})

test("riskCacheScope: two distinct destructive patterns do not collide", () => {
  const rm = riskCacheScope("bash", { command: "rm -rf /tmp/x" })
  const forcePush = riskCacheScope("bash", { command: "git push origin main --force" })
  assert.notEqual(rm, forcePush, "distinct destructive signals must be distinct scopes")
})

test("riskCacheScope: the same destructive pattern is stable across calls", () => {
  const a = riskCacheScope("bash", { command: "rm -rf /tmp/one" })
  const b = riskCacheScope("bash", { command: "rm -rf /var/two" })
  assert.equal(a, b, "the same destructive pattern must yield a stable scope")
})

test("riskCacheScope: the tool id is always part of the scope", () => {
  const edit = riskCacheScope("edit", { filePath: "src/a.ts" })
  const write = riskCacheScope("write", { filePath: "src/a.ts" })
  assert.notEqual(edit, write, "two tools must never share a scope")
  assert.equal(edit.startsWith("edit\u0000"), true)
})

test("riskCacheScope: is deterministic for identical input", () => {
  const args = { command: "psql -c 'DROP TABLE users'" }
  assert.equal(riskCacheScope("bash", args), riskCacheScope("bash", args))
})
