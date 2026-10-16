/**
 * Tests for the opt-in per-call trace log.
 *
 * The load-bearing cases are: (1) when disabled, ZERO file IO happens — no
 * directory, no file, and not even a failing write is attempted; (2) when
 * enabled, one JSON object per line carries the documented call fields; (3) the
 * snippet and summary are bounded; (4) rotation caps the file size; (5) a
 * filesystem failure is reported once and never thrown.
 *
 * @module
 */

import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import { MAX_DETAIL_CHARS } from "../src/decision-log.ts"
import { appendTrace, type TraceLogEntry, type TraceLogOptions } from "../src/trace-log.ts"

/** A per-test temporary directory holding the log files. */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-trace-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Build trace options rooted in the test temp dir. */
function opts(overrides: Partial<TraceLogOptions> = {}): TraceLogOptions {
  return { enabled: true, path: join(dir, "trace.log"), maxBytes: 1_000_000, backups: 3, ...overrides }
}

/** A complete trace entry with the documented fields. */
function entry(overrides: Partial<TraceLogEntry> = {}): TraceLogEntry {
  return {
    hook: "tool.execute.before",
    summary: "bash",
    questionId: "risk",
    questionType: "choice",
    model: "oc/jev-1.13-free",
    durationMs: 12,
    cache: "miss",
    circuit: "closed",
    outcome: "valid",
    ...overrides,
  }
}

/** Read every line of a log file as parsed JSON objects. */
async function readLines(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8")
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("appendTrace: disabled performs ZERO file IO (no dir, no file, no write attempt)", async () => {
  // A nested, non-existent path: if any IO were attempted the parent would be
  // created. A path that is a directory would also fail loudly if opened.
  const nested = join(dir, "nope", "deeper", "trace.log")
  const failures: string[] = []
  await appendTrace(entry(), opts({ enabled: false, path: nested, onError: (r) => failures.push(r) }))
  // Even an unwritable path must not be touched when disabled.
  await appendTrace(entry(), opts({ enabled: false, path: dir, onError: (r) => failures.push(r) }))
  assert.equal(existsSync(join(dir, "nope")), false, "a disabled trace log must create no directory")
  assert.equal(failures.length, 0, "a disabled trace log must attempt no write at all")
  assert.deepEqual(await readdir(dir), [], "a disabled trace log must create no file")
})

test("appendTrace: enabled writes one JSON object per line with the documented fields", async () => {
  const path = join(dir, "trace.log")
  await appendTrace(entry(), opts({ path }))
  await appendTrace(entry({ outcome: "provider", snippet: "HTTP 502: down" }), opts({ path }))
  const lines = await readLines(path)
  assert.equal(lines.length, 2)
  assert.deepEqual(Object.keys(lines[0] ?? {}).sort(), [
    "cache",
    "circuit",
    "durationMs",
    "hook",
    "model",
    "outcome",
    "questionId",
    "questionType",
    "summary",
    "ts",
  ])
  assert.equal(lines[0]?.hook, "tool.execute.before")
  assert.equal(lines[0]?.questionId, "risk")
  assert.equal(lines[0]?.questionType, "choice")
  assert.equal(lines[0]?.cache, "miss")
  assert.equal(lines[0]?.circuit, "closed")
  assert.equal(lines[0]?.outcome, "valid")
  assert.equal(lines[0]?.durationMs, 12)
  assert.match(String(lines[0]?.ts), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(lines[1]?.outcome, "provider")
  assert.equal(lines[1]?.snippet, "HTTP 502: down")
})

test("appendTrace: the summary and snippet are bounded to the detail cap", async () => {
  const path = join(dir, "trace.log")
  const long = "x".repeat(MAX_DETAIL_CHARS + 500)
  await appendTrace(entry({ summary: long, snippet: long }), opts({ path }))
  const lines = await readLines(path)
  assert.equal((lines[0]?.summary as string).length, MAX_DETAIL_CHARS)
  assert.equal((lines[0]?.snippet as string).length, MAX_DETAIL_CHARS)
})

test("appendTrace: an empty or 'off' path disables writing even when enabled", async () => {
  await appendTrace(entry(), opts({ enabled: true, path: "" }))
  await appendTrace(entry(), opts({ enabled: true, path: "off" }))
  assert.deepEqual(await readdir(dir), [])
})

test("appendTrace: rotates to .1 and keeps at most `backups` copies", async () => {
  const path = join(dir, "trace.log")
  const options = opts({ path, maxBytes: 1, backups: 2 })
  for (let index = 0; index < 5; index++) {
    await appendTrace(entry({ summary: `h${index}` }), options)
  }
  const names = (await readdir(dir)).sort()
  assert.deepEqual(names, ["trace.log.1", "trace.log.2"])
  const newest = await readLines(`${path}.1`)
  assert.equal(newest[0]?.summary, "h4")
  const older = await readLines(`${path}.2`)
  assert.equal(older[0]?.summary, "h3")
})

test("appendTrace: creates missing parent directories", async () => {
  const path = join(dir, "nested", "deeper", "trace.log")
  await appendTrace(entry(), opts({ path }))
  const lines = await readLines(path)
  assert.equal(lines.length, 1)
})

test("appendTrace: a filesystem failure is reported once and never thrown", async () => {
  // Using the directory itself as the log path makes appendFile fail
  // deterministically (EISDIR) without depending on permissions.
  const failures: string[] = []
  await appendTrace(entry(), opts({ path: dir, onError: (reason) => failures.push(reason) }))
  assert.equal(failures.length, 1)
  assert.ok(failures[0] && failures[0].length > 0)
})
