/**
 * ForgetService - orchestrates lifecycle policies.
 *
 * Loaded with a PluginRegistry<Policy>; cron jobs ask for specific policy
 * names, and this service runs them sequentially with the same `now` so that
 * all transitions within a run share a consistent clock.
 *
 * Rationale for sequential (not parallel): transitions may depend on prior
 * transitions in the same run (e.g. a duplicate-gc archive could precede a
 * decay-ebbinghaus scan). Ordering matters; we document it explicitly.
 */

import type { Policy, PolicyContext, PolicyOutcome } from '../core/contracts.js';
import { PluginRegistry } from '../core/registry.js';
import { PluginNotFoundError } from '../core/errors.js';

export interface ForgetServiceOpts {
  registry: PluginRegistry<Policy>;
}

export interface ForgetRunOpts {
  /** Policy names to run, in order. If omitted, runs a sensible default order. */
  policies?: string[];
  dryRun?: boolean;
  /** Override `now` (for testing / backfills). */
  now?: Date;
  /** Pass-through per-policy config by policy name. */
  configs?: Record<string, Record<string, unknown>>;
}

export interface ForgetRunResult {
  startedAt: Date;
  finishedAt: Date;
  outcomes: PolicyOutcome[];
  dryRun: boolean;
}

/** Default execution order when caller doesn't specify. */
export const DEFAULT_FORGET_ORDER = [
  'explicit-tombstone', // user-driven removal first
  'duplicate-gc', // collapse near-duplicates before decay measures them
  'contradiction-archive', // then drop items strongly refuted
  'decay-ebbinghaus', // then time-based demotion
  'core-promotion', // finally lift anything that survived and is load-bearing
];

export class ForgetService {
  private readonly registry: PluginRegistry<Policy>;

  constructor(opts: ForgetServiceOpts) {
    this.registry = opts.registry;
  }

  /** Register a policy at runtime. Useful for swapping implementations in tests. */
  register(policy: Policy): void {
    this.registry.register(policy);
  }

  async run(opts: ForgetRunOpts = {}): Promise<ForgetRunResult> {
    const startedAt = new Date();
    const now = opts.now ?? startedAt;
    const names = opts.policies ?? DEFAULT_FORGET_ORDER;
    const outcomes: PolicyOutcome[] = [];

    for (const name of names) {
      const policy = this.registry.tryGet(name);
      if (!policy) {
        // Skip silently for missing-but-optional (e.g. no embedder → no duplicate-gc)
        // but surface via an empty outcome for observability.
        outcomes.push({
          policy: name,
          itemsScanned: 0,
          itemsAffected: 0,
          transitions: {},
        });
        continue;
      }
      const ctx = {
        now,
        dryRun: opts.dryRun ?? false,
        config: opts.configs?.[name],
      };
      outcomes.push(await policy.apply(ctx));
    }

    return { startedAt, finishedAt: new Date(), outcomes, dryRun: opts.dryRun ?? false };
  }

  /** Strict variant - throws if any requested policy is missing. */
  async runStrict(opts: ForgetRunOpts = {}): Promise<ForgetRunResult> {
    const names = opts.policies ?? DEFAULT_FORGET_ORDER;
    for (const name of names) {
      if (!this.registry.has(name)) {
        throw new PluginNotFoundError('policy', name);
      }
    }
    return this.run(opts);
  }
}
