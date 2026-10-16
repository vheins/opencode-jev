/**
 * Selective trigger gate and effectiveness metrics for the judgement layer.
 *
 * Judgement is a SELECTIVE decision layer, not a per-tool-call examiner: routine
 * activity must never reach the network, and consecutive calls that represent
 * ONE logical decision must collapse to a single judgement. This module sits in
 * front of `judge()`/`decidePolicy()` and adds two guards plus instrumentation,
 * without adding a hook:
 *
 * - Dedup: an identical judgement (same logical key AND fingerprint) within the
 *   cooldown window reuses the previous outcome instead of re-asking the model.
 * - Cooldown: a repeat judgement for the same logical key within the window is
 *   suppressed and the previous outcome is replayed.
 * - Metrics: System One call count, added latency, duplication rate, and
 *   decision-influence rate, derived in memory from outcomes the caller already
 *   computes (no new IO).
 *
 * Both guards are ADDITIVE and fail-open. A reused judgement REPLAYS a decision
 * that was already computed, so it can only re-apply the SAME outcome (including
 * a block) and can never invent an allow or relax opencode's native permission
 * flow. A logical key is only ever formed from a caller-supplied SAFE
 * equivalence scope: when a caller cannot prove two actions equivalent it passes
 * a unique key, so a genuinely different decision is never suppressed.
 *
 * @module
 */

import type { PipelineAction } from "./domain.ts"

/** Why a judgement was reused instead of re-asked. */
export type ReuseReason = "dedup" | "cooldown"

/** The gate's verdict for one judgement attempt. */
export type TriggerOutcome =
  | { readonly kind: "trigger" }
  | { readonly kind: "reuse"; readonly reason: ReuseReason }

/** The replay value a gate remembers for one logical action. */
export type GateReplay = { readonly blocked: boolean; readonly message?: string }

/** Options for {@link TriggerGate}. */
export type TriggerOptions = {
  /** Suppress or reuse a repeat judgement within this many milliseconds. */
  readonly cooldownMs: number
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Per-call tuning for {@link TriggerGate.decide}. */
export type TriggerDecideOptions = {
  /**
   * Whether a repeat for the same key with a DIFFERENT fingerprint may be
   * suppressed. Defaults to true. Set false for an explicit on-demand question
   * (e.g. `jev_decide`), where a distinct question is a distinct logical
   * decision and must never be collapsed into another.
   */
  readonly cooldown?: boolean
  /**
   * Whether the caller can actually serve a reuse for this key.
   *
   * A reuse is only a reuse if the caller can honor it. A caller whose reuse is
   * a void deferral (the automatic tool gate) is always servable and omits this.
   * A caller that must RETURN a remembered value (e.g. `jev_decide`) passes a
   * predicate that reports whether a replayable value exists: when it does not,
   * the gate must NOT report a reuse, because the caller would fall through and
   * ask the model after all. Reporting a reuse there would count the judgement
   * as reused AND as a model call, breaking `systemOneCalls == triggered`.
   *
   * Defaults to always-servable.
   */
  readonly servable?: () => boolean
}

/** One remembered logical action: its fingerprint, timestamp, and replay value. */
type GateEntry = {
  readonly fingerprint: string
  readonly at: number
  value?: unknown
}

/**
 * A bounded gate that collapses repeated judgements for one logical action.
 *
 * The window is measured from the last TRIGGER, not the last reuse, so a burst
 * of equivalent calls collapses to one judgement without extending the window
 * indefinitely under continuous load.
 */
export class TriggerGate {
  private readonly cooldownMs: number
  private readonly now: () => number
  private readonly entries = new Map<string, GateEntry>()

  /**
   * @param options - The cooldown window and an optional clock for tests.
   */
  constructor(options: TriggerOptions) {
    this.cooldownMs = options.cooldownMs
    this.now = options.now ?? Date.now
  }

  /**
   * Decide whether a judgement for `key` must call the model.
   *
   * A previous entry within the window is reused when its fingerprint matches
   * (dedup) or, when cooldown is enabled, for any fingerprint under the same key
   * (cooldown), and only when the caller can actually serve the reuse (see
   * {@link TriggerDecideOptions.servable}). Otherwise the key is stamped and the
   * caller must trigger.
   *
   * @param key - The logical-action key (tool + safe equivalence scope).
   * @param fingerprint - The exact judgement identity (tool + scope + questions).
   * @param options - Optional per-call tuning (cooldown on/off, servability).
   * @returns `trigger` when the model must be asked, else the reuse reason.
   */
  decide(key: string, fingerprint: string, options?: TriggerDecideOptions): TriggerOutcome {
    const cooldown = options?.cooldown ?? true
    const servable = options?.servable
    const previous = this.entries.get(key)
    if (previous !== undefined && this.now() - previous.at < this.cooldownMs) {
      const canServe = servable === undefined || servable()
      if (canServe) {
        if (previous.fingerprint === fingerprint) return { kind: "reuse", reason: "dedup" }
        if (cooldown) return { kind: "reuse", reason: "cooldown" }
      }
    }
    this.entries.set(key, { fingerprint, at: this.now() })
    return { kind: "trigger" }
  }

  /**
   * Store the outcome of a triggered judgement so a later reuse can replay it.
   *
   * A no-op when the key was never triggered, so a reuse can never replay a
   * value that no judgement produced.
   *
   * @param key - The logical-action key.
   * @param value - The replay value (the caller's own shape).
   */
  remember(key: string, value: unknown): void {
    const previous = this.entries.get(key)
    if (previous !== undefined) this.entries.set(key, { ...previous, value })
  }

  /**
   * The remembered replay value for `key`, when one exists.
   *
   * @param key - The logical-action key.
   * @returns The remembered value, or `undefined` when nothing was remembered.
   */
  replay(key: string): unknown {
    return this.entries.get(key)?.value
  }

  /** Drop all gate state. */
  clear(): void {
    this.entries.clear()
  }
}

/** An in-memory effectiveness snapshot for the judgement layer. */
export type TriggerMetricsSnapshot = {
  /** Judgements the gate evaluated (triggered + reused). */
  readonly judgements: number
  /** Judgements that reached the model path. */
  readonly triggered: number
  /** Judgements served from the gate (deduped + cooldown-suppressed). */
  readonly reused: number
  /** Reuses whose fingerprint matched exactly. */
  readonly deduped: number
  /** Reuses suppressed by the cooldown window. */
  readonly cooldownSuppressed: number
  /** Model calls the caller actually invoked. */
  readonly systemOneCalls: number
  /** Accumulated wall-clock latency of the model calls (ms). */
  readonly addedLatencyMs: number
  /** `reused / judgements`, in `[0, 1]`. */
  readonly duplicationRate: number
  /** Judgements whose pipeline action was not `proceed`. */
  readonly decisionInfluence: number
  /** `decisionInfluence / triggered`, in `[0, 1]`. */
  readonly influenceRate: number
}

/** A pure in-memory metrics collector; it performs no IO of its own. */
export class TriggerMetrics {
  private judgements = 0
  private triggered = 0
  private deduped = 0
  private cooldownSuppressed = 0
  private systemOneCalls = 0
  private addedLatencyMs = 0
  private decisionInfluence = 0

  /** Count one judgement that reached the model path. */
  recordTrigger(): void {
    this.judgements += 1
    this.triggered += 1
  }

  /**
   * Count one judgement served from the gate.
   *
   * @param reason - Whether it was an exact dedup or a cooldown suppression.
   */
  recordReuse(reason: ReuseReason): void {
    this.judgements += 1
    if (reason === "dedup") this.deduped += 1
    else this.cooldownSuppressed += 1
  }

  /**
   * Count one model call and its latency.
   *
   * @param latencyMs - Wall-clock duration of the call; non-positive values are
   *   counted as a call but contribute no latency.
   */
  recordSystemOneCall(latencyMs: number): void {
    this.systemOneCalls += 1
    if (Number.isFinite(latencyMs) && latencyMs > 0) this.addedLatencyMs += latencyMs
  }

  /**
   * Record the pipeline action a judgement produced.
   *
   * A `proceed` action is a no-op verdict; every other action (verify, revise,
   * request-approval) means the judgement changed the decision.
   *
   * @param action - The pipeline action mapped from the judgement.
   */
  recordDecision(action: PipelineAction): void {
    if (action !== "proceed") this.decisionInfluence += 1
  }

  /**
   * Take a consistent snapshot of the collected metrics.
   *
   * @returns The current counters and derived rates.
   */
  snapshot(): TriggerMetricsSnapshot {
    const reused = this.deduped + this.cooldownSuppressed
    return {
      judgements: this.judgements,
      triggered: this.triggered,
      reused,
      deduped: this.deduped,
      cooldownSuppressed: this.cooldownSuppressed,
      systemOneCalls: this.systemOneCalls,
      addedLatencyMs: this.addedLatencyMs,
      duplicationRate: this.judgements === 0 ? 0 : reused / this.judgements,
      decisionInfluence: this.decisionInfluence,
      influenceRate: this.triggered === 0 ? 0 : this.decisionInfluence / this.triggered,
    }
  }
}

/**
 * Apply the trigger gate for one logical action and record the metrics.
 *
 * This is the single call site that couples the gate decision to the metrics so
 * a caller cannot trigger without accounting for it (or account twice).
 *
 * @param gate - The gate holding the per-key window state.
 * @param metrics - The metrics collector to update.
 * @param key - The logical-action key.
 * @param fingerprint - The exact judgement identity.
 * @param options - Optional per-call tuning (cooldown on/off).
 * @returns The gate outcome the caller must honor.
 */
export function gateJudgement(
  gate: TriggerGate,
  metrics: TriggerMetrics,
  key: string,
  fingerprint: string,
  options?: TriggerDecideOptions,
): TriggerOutcome {
  const outcome = gate.decide(key, fingerprint, options)
  if (outcome.kind === "reuse") metrics.recordReuse(outcome.reason)
  else metrics.recordTrigger()
  return outcome
}
