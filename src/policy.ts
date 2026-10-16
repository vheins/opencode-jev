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
 * Tool ids that only read or inspect state.
 *
 * These are skipped without a Jev call: the deterministic answer is already
 * known, and a network round trip would only add latency.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "todoread",
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
