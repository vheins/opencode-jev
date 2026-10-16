/**
 * Tests for the rotated newline-delimited JSON decision log.
 *
 * The load-bearing cases are: (1) each decision is one JSON object per line
 * with the documented fields; (2) the file rotates once it reaches `maxBytes`
 * and never keeps more than `backups` rotated copies; (3) a `detail` is
 * truncated and a `""`/`"off"` path disables writing; (4) a filesystem failure
 * is reported once and never thrown.
 *
 * @module
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import { appendDecision, MAX_DETAIL_CHARS, type DecisionLogOptions } from "../src/decision-log.ts"

/** A per-test temporary directory holding the log files. */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-decisions-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Build log options rooted in the test temp dir. */
function opts(overrides: Partial<DecisionLogOptions> = {}): DecisionLogOptions {
  return { path: join(dir, "decisions.log"), maxBytes: 1_000_000, backups: 3, ...overrides }
}

/** Read every line of a log file as parsed JSON objects. */
async function readLines(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8")
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("appendDecision: writes one JSON object per line with the documented fields", async () => {
  const path = join(dir, "decisions.log")
  await appendDecision(
    { hook: "tool.execute.before", kind: "valid", decision: "destructive", confidence: 0.97, action: "block" },
    opts({ path }),
  )
  await appendDecision(
    { hook: "chat.message", kind: "invalid", decision: null, confidence: null, action: "log" },
    opts({ path }),
  )
  const lines = await readLines(path)
  assert.equal(lines.length, 2)
  assert.deepEqual(Object.keys(lines[0] ?? {}).sort(), [
    "action",
    "confidence",
    "decision",
    "hook",
    "kind",
    "ts",
  ])
  assert.equal(lines[0]?.hook, "tool.execute.before")
  assert.equal(lines[0]?.kind, "valid")
  assert.equal(lines[0]?.decision, "destructive")
  assert.equal(lines[0]?.confidence, 0.97)
  assert.equal(lines[0]?.action, "block")
  assert.match(String(lines[0]?.ts), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(lines[1]?.decision, null)
  assert.equal(lines[1]?.confidence, null)
})

test("appendDecision: detail is present only when supplied and is truncated to the cap", async () => {
  const path = join(dir, "decisions.log")
  const long = "x".repeat(MAX_DETAIL_CHARS + 50)
  await appendDecision(
    { hook: "h", kind: "unavailable", decision: null, confidence: null, action: "log", detail: long },
    opts({ path }),
  )
  await appendDecision(
    { hook: "h2", kind: "valid", decision: "ok", confidence: 0.9, action: "allow" },
    opts({ path }),
  )
  const lines = await readLines(path)
  assert.equal((lines[0]?.detail as string).length, MAX_DETAIL_CHARS)
  assert.equal("detail" in (lines[1] ?? {}), false)
})

test("appendDecision: rotates to .1 and keeps at most `backups` copies", async () => {
  const path = join(dir, "decisions.log")
  // maxBytes tiny so a single line triggers rotation each write.
  const options = opts({ path, maxBytes: 1, backups: 2 })
  for (let index = 0; index < 5; index++) {
    await appendDecision(
      { hook: `h${index}`, kind: "valid", decision: "ok", confidence: 0.9, action: "allow" },
      options,
    )
  }
  const names = (await readdir(dir)).sort()
  // After each write the active file is rotated away, so only the kept copies
  // remain; the older-than-`backups` copy (h2) has been dropped.
  assert.deepEqual(names, ["decisions.log.1", "decisions.log.2"])
  const newest = await readLines(`${path}.1`)
  assert.equal(newest[0]?.hook, "h4")
  const older = await readLines(`${path}.2`)
  assert.equal(older[0]?.hook, "h3")
})

test("appendDecision: does not rotate while under maxBytes", async () => {
  const path = join(dir, "decisions.log")
  await appendDecision(
    { hook: "h", kind: "valid", decision: "ok", confidence: 0.9, action: "allow" },
    opts({ path, maxBytes: 1_000_000, backups: 3 }),
  )
  const names = await readdir(dir)
  assert.deepEqual(names, ["decisions.log"])
})

test("appendDecision: an empty or 'off' path disables writing", async () => {
  await appendDecision(
    { hook: "h", kind: "valid", decision: "ok", confidence: 0.9, action: "allow" },
    opts({ path: "" }),
  )
  await appendDecision(
    { hook: "h", kind: "valid", decision: "ok", confidence: 0.9, action: "allow" },
    opts({ path: "off" }),
  )
  assert.deepEqual(await readdir(dir), [])
})

test("appendDecision: creates missing parent directories", async () => {
  const path = join(dir, "nested", "deeper", "decisions.log")
  await appendDecision(
    { hook: "h", kind: "valid", decision: "ok", confidence: 0.9, action: "allow" },
    opts({ path }),
  )
  const lines = await readLines(path)
  assert.equal(lines.length, 1)
})

test("appendDecision: a filesystem failure is reported once and never thrown", async () => {
  // Using the directory itself as the log path makes appendFile fail
  // deterministically (EISDIR) without depending on permissions.
  const failures: string[] = []
  const options = opts({ path: dir, onError: (reason) => failures.push(reason) })
  await appendDecision(
    { hook: "h", kind: "valid", decision: "ok", confidence: 0.9, action: "allow" },
    options,
  )
  assert.equal(failures.length, 1)
  assert.ok(failures[0] && failures[0].length > 0)
})
