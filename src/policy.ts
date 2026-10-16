/**
 * Action classification and per-category failure policy.
 *
 * Two jobs live here. First, a cheap deterministic pass classifies an action
 * before any network call, so obvious read-only tools skip Jev entirely and
 * obvious destructive signals are recognized even when Jev is unavailable.
 * Second, each action category maps a failed or uncertain Jev decision to a
 * safe response.
 *
 * The plugin can only ever ADD a block: `tool.execute.before` either throws
 * (deny) or returns (defer). It never auto-allows, so opencode's native
 * permission flow remains the sole gate for execution. "Fail safe" therefore
 * means: never treat an unavailable, invalid, or uncertain verdict as a reason
 * to relax that gate, and never claim the plugin arbitrates permissions.
 *
 * @module
 */

import type { RiskLevel } from "./domain.ts"

/** How much an action can cost if it runs. */
export type ActionCategory = "read_only" | "reversible" | "destructive" | "high_impact"

/** The result of the cheap local pre-classification. */
export type LocalClassification =
  | { readonly kind: "read_only"; readonly reason: string }
  | { readonly kind: "destructive_hint"; readonly reason: string }
  | { readonly kind: "unknown" }

/** What the plugin should do when Jev cannot produce an actionable verdict. */
export type FailurePolicy = "ignore" | "warn"

/**
 * Tool ids that only read or inspect state, plus low-risk meta tools.
 *
 * These are skipped without a Jev call: the deterministic answer is already
 * known, and a network round trip would only add latency. `todowrite` and
 * `task-read` are local bookkeeping/read tools that cannot cause irreversible
 * loss; the dispatch tool `task` and every mutating tool (`edit`, `write`,
 * `bash`, `execute`, `memory-write`) stay on the network path.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "todoread",
  "todowrite",
  "task-read",
  "webfetch",
])

/**
 * Command substrings that signal an irreversible operation.
 *
 * This is a hint, not an enforcement decision: it raises the local category so
 * a failed Jev call is never treated as an allow, and it is surfaced to Jev as
 * context. The plugin still defers to opencode's native permission flow.
 */
const DESTRUCTIVE_HINTS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bgit\s+push\b[^\n]*\s-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b[^\n]*-[a-z]*[df]/i,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+[^\n]*of=/i,
  />\s*\/dev\/sd/i,
  /\bchmod\s+-R\s+777\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bkill\s+-9\b/i,
]

/** Join a tool's arguments into a single lowercase searchable string. */
function argsToSearchText(args: unknown): string {
  if (typeof args === "string") return args.toLowerCase()
  if (typeof args !== "object" || args === null) return ""
  const parts: string[] = []
  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value === "string") parts.push(value)
    else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value))
  }
  return parts.join(" ").toLowerCase()
}

/**
 * Classify an action locally, before any network call.
 *
 * @param tool - The tool id being invoked.
 * @param args - The tool arguments.
 * @returns The local classification and, when applicable, the signal reason.
 */
export function classifyLocally(tool: string, args: unknown): LocalClassification {
  if (READ_ONLY_TOOLS.has(tool)) {
    return { kind: "read_only", reason: `tool "${tool}" is a known read-only tool` }
  }
  const text = argsToSearchText(args)
  if (text) {
    for (const pattern of DESTRUCTIVE_HINTS) {
      if (pattern.test(text)) {
        return { kind: "destructive_hint", reason: `arguments match ${pattern.source}` }
      }
    }
  }
  return { kind: "unknown" }
}

/**
 * Derive a safety-preserving cache scope for a tool action.
 *
 * The scope is the deterministic local classification of the action, never the
 * full argument blob. A destructive hint is keyed by the exact pattern it
 * matched, so a destructive call can never reuse a cached non-destructive
 * verdict and two distinct destructive patterns never collide. The tool id is
 * part of the scope so two tools with the same classification can never share a
 * verdict.
 *
 * The `unknown` class is deliberately NOT a safe equivalence class: two unknown
 * actions of the same tool (e.g. `echo one > a.txt` and `rm file.txt`, which
 * matches no {@link DESTRUCTIVE_HINTS} entry) can still be verdict `mutating`
 * and `destructive` respectively, so sharing one key could serve a cached
 * non-destructive verdict to a destructive call. A caller must therefore pass a
 * scope ONLY for `read_only`/`destructive_hint`, and OMIT it for `unknown` so
 * the client falls back to the full-state key.
 *
 * @param tool - The tool id being invoked.
 * @param args - The tool arguments.
 * @returns A deterministic scope string (`<tool>\0read_only`,
 *   `<tool>\0unknown`, or `<tool>\0destructive:<matched-pattern>`).
 */
export function riskCacheScope(tool: string, args: unknown): string {
  const local = classifyLocally(tool, args)
  const signal = local.kind === "destructive_hint" ? `destructive:${local.reason}` : local.kind
  return `${tool}\u0000${signal}`
}

/**
 * Derive the LOGICAL-ACTION key the selective trigger gate groups on.
 *
 * Two calls share a logical action only when they are a proven SAFE equivalence
 * class, so grouping them can never collapse a genuinely different decision:
 *
 * - A locally-recognized destructive hint is keyed by the exact pattern it
 *   matched (the same safe equivalence {@link riskCacheScope} already uses), so
 *   repeated calls of one destructive pattern collapse to a single judgement
 *   while two distinct destructive patterns stay separate.
 * - Every other action returns `undefined`: the `unknown` class is deliberately
 *   NOT a safe equivalence class (see {@link riskCacheScope}), so the caller
 *   must not group it and each such action is judged on its own.
 *
 * `read_only` never reaches the gate (the caller skips it locally), so it also
 * returns `undefined` here.
 *
 * @param tool - The tool id being invoked.
 * @param args - The tool arguments.
 * @returns The logical-action key, or `undefined` when the action must not be
 *   grouped.
 */
export function riskLogicalKey(tool: string, args: unknown): string | undefined {
  const local = classifyLocally(tool, args)
  if (local.kind !== "destructive_hint") return undefined
  return `${tool}\u0000${local.kind}:${local.reason}`
}

/**
 * Path/extension/keyword patterns that mark a file as security-sensitive, with
 * a deterministic weight in `[0, 1]`.
 *
 * This replaces the per-edit remote Jev call with a deterministic check: an
 * edit to a matching path still raises the same advisory, but at zero network
 * cost and with no model round trip. The list targets secrets, credentials,
 * private keys, and security-gating configuration. Strong signals (secret
 * files, key material, CI auth) score 0.9; weaker hints (a generic `secret`
 * directory) score 0.5, so the caller's `fileReviewThreshold` stays meaningful.
 */
const SENSITIVE_FILE_SIGNALS: ReadonlyArray<{ readonly weight: number; readonly pattern: RegExp }> = [
  { weight: 0.9, pattern: /(^|[./\\-])\.env(\.|$)/i },
  { weight: 0.9, pattern: /(^|[./\\-])(\.npmrc|\.netrc|\.git-credentials|\.pgpass|\.htpasswd)(\.|$)/i },
  { weight: 0.9, pattern: /(^|[./\\-])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?(\.|$)/i },
  { weight: 0.9, pattern: /\.(pem|key|crt|cer|p12|pfx|jks|keystore)(\.|$)/i },
  { weight: 0.9, pattern: /(^|[./\\-])\.(ssh|aws|gnupg)([./\\-]|$)/i },
  { weight: 0.9, pattern: /(^|[./\\-])(password|passwd|private[_-]?key|access[_-]?key)([./\\-]|$)/i },
  { weight: 0.9, pattern: /(^|[./\\-])(\.github[./\\-]workflows|\.gitlab-ci\.ya?ml|Jenkinsfile)([./\\-]|$)/i },
  { weight: 0.5, pattern: /(^|[./\\-])(credentials?|secrets?)(\.|$)/i },
]

/** The result of the deterministic file-sensitivity check. */
export type FileSensitivity = { readonly score: number; readonly reason: string }

/**
 * Classify whether an edited file path is security-sensitive, locally.
 *
 * Deterministic and network-free, so the `file.edited` handler can keep its
 * user-visible advisory without paying for a Jev call on every edit. The
 * returned score is gated by the caller's `fileReviewThreshold`.
 *
 * @param file - The edited file path; malformed (non-string) input is tolerated.
 * @returns The graded score in `[0, 1]` and the matching reason.
 */
export function classifyFileSensitivity(file: unknown): FileSensitivity {
  if (typeof file !== "string") return { score: 0, reason: "invalid path" }
  const normalized = file.trim()
  if (normalized === "") return { score: 0, reason: "empty path" }
  let score = 0
  let reason = "no security-sensitive pattern matched"
  for (const signal of SENSITIVE_FILE_SIGNALS) {
    if (signal.pattern.test(normalized)) {
      score = Math.max(score, signal.weight)
      if (reason === "no security-sensitive pattern matched") {
        reason = `path matches ${signal.pattern.source}`
      }
    }
  }
  return { score, reason }
}

/** The result of the deterministic message-needs-human check. */
export type MessageClassification = { readonly score: number; readonly reason: string }

/**
 * High-stakes message signals and their deterministic weights.
 *
 * `chat.message` is observe-only (hooks return `Promise<void>` and cannot
 * inject or reroute a message), so the per-message Jev round trip produced a
 * verdict with no action. This deterministic check keeps the user-visible
 * advisory at zero network cost: a graded score in `[0, 1]` that the caller
 * gates with `routeThreshold`.
 */
const MESSAGE_SIGNALS: ReadonlyArray<{ readonly weight: number; readonly pattern: RegExp }> = [
  { weight: 0.9, pattern: /\b(delete|drop|truncate)\b[^\n]*\b(prod|production|database|table|data)\b/i },
  { weight: 0.9, pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i },
  { weight: 0.9, pattern: /\bforce[-\s]?push\b/i },
  { weight: 0.9, pattern: /\b(deploy|release|ship|rollback)\b[^\n]*\b(prod|production|live)\b/i },
  { weight: 0.9, pattern: /\b(rotate|revoke)\b[^\n]*\b(secret|key|credential|token|access)s?\b/i },
  { weight: 0.5, pattern: /\bprod(uction)?\b/i },
  { weight: 0.5, pattern: /\b(secret|password|credential|api[_-]?key|private[_-]?key)\b/i },
  { weight: 0.5, pattern: /\b(should i|is it safe|do you recommend|which is better|your call)\b/i },
  { weight: 0.5, pattern: /\b(approve|approval|sign[-\s]?off|permission)\b/i },
  { weight: 0.5, pattern: /\bmigrat(e|ion)\b/i },
  { weight: 0.5, pattern: /\b(breaking change|backward[-\s]?incompat)/i },
]

/**
 * Score whether a user message needs a human decision, locally and network-free.
 *
 * @param text - The message text.
 * @returns The graded score in `[0, 1]` and the matching reason.
 */
export function classifyMessage(text: string): MessageClassification {
  let score = 0
  let reason = "no high-stakes signal matched"
  for (const signal of MESSAGE_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += signal.weight
      if (reason === "no high-stakes signal matched") reason = `text matches ${signal.pattern.source}`
    }
  }
  return { score: Math.min(1, score), reason }
}

/**
 * Map a Jev risk label to an action category.
 *
 * @param risk - The validated risk verdict label.
 * @returns The corresponding action category.
 */
export function categoryForRisk(risk: RiskLevel): ActionCategory {
  if (risk === "read_only") return "read_only"
  if (risk === "destructive") return "destructive"
  return "reversible"
}

/**
 * Decide how to respond when Jev cannot produce an actionable verdict.
 *
 * Low-risk categories defer silently to the native flow. High-impact
 * categories surface a warning so an operator knows the guardrail was
 * unavailable; neither case relaxes the native gate.
 *
 * @param category - The action category.
 * @returns `ignore` for low-risk actions, `warn` for high-impact ones.
 */
export function failurePolicy(category: ActionCategory): FailurePolicy {
  return category === "destructive" || category === "high_impact" ? "warn" : "ignore"
}

/**
 * Whether a category is high-impact and must never be auto-relaxed.
 *
 * @param category - The action category.
 * @returns True for destructive and high-impact categories.
 */
export function isHighImpact(category: ActionCategory): boolean {
  return category === "destructive" || category === "high_impact"
}
