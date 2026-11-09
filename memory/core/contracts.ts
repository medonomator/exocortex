/**
 * Contracts for the three plugin kinds: Signals, Policies, Pipeline stages.
 *
 * Implementations live in signals/ policies/ pipeline/ and are registered
 * into the three PluginRegistry instances at bootstrap.
 */

import type {
  MemoryItem,
  Query,
  MemoryEvent,
  TimeRange,
  LifecycleStatus,
} from './types.js';
import type { Plugin } from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Signal (ranking)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A signal produces per-candidate scores for a given query.
 * Scores are returned in the order of the provided candidates array,
 * as "raw" values to be normalized later by the ranker.
 *
 * Implementations must be pure and stateless with respect to the query
 * (though they may cache read-only state across calls).
 */
export interface Signal extends Plugin {
  /** Compute raw scores (higher is better) for each candidate. */
  score(ctx: SignalContext): Promise<Float32Array>;
}

export interface SignalContext {
  query: Query;
  candidates: MemoryItem[];
  /** Time to use as "now" for recency / decay calculations. */
  now: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy (lifecycle mutation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A policy mutates items based on rules (decay, archive, promote, ...).
 * Policies are applied in batches, typically by a cron-driven ForgetService.
 */
export interface Policy extends Plugin {
  /**
   * Apply this policy. Returns stats on what was affected.
   * Implementations MUST be idempotent: running twice with the same input
   * should not double-apply the effect.
   */
  apply(ctx: PolicyContext): Promise<PolicyOutcome>;
}

export interface PolicyContext {
  now: Date;
  /** Optional scoping window for this run. */
  window?: TimeRange;
  /** Optional dry-run flag: compute outcomes but don't persist. */
  dryRun?: boolean;
  /** Policy-specific config overrides. */
  config?: Record<string, unknown>;
}

export interface PolicyOutcome {
  policy: string;
  itemsScanned: number;
  itemsAffected: number;
  /** Counts of status transitions this policy performed. */
  transitions: Partial<Record<LifecycleStatus, number>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline stage (consolidate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pipeline stage transforms events/items into more refined items.
 * Stages are composed into a linear pipeline in ConsolidateService.
 *
 * Each stage gets the current accumulator of "in-flight" items plus raw
 * events, and returns the updated accumulator.
 */
export interface PipelineStage extends Plugin {
  run(ctx: StageContext): Promise<StageOutcome>;
}

export interface StageContext {
  events: MemoryEvent[];
  /** Items produced or updated so far in this consolidate run. */
  items: MemoryItem[];
  now: Date;
  /** Stage-specific config. */
  config?: Record<string, unknown>;
}

export interface StageOutcome {
  stage: string;
  items: MemoryItem[];
  /** Optional stats for observability. */
  stats?: Record<string, number>;
}
