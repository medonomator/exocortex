/**
 * contradiction-archive policy.
 *
 * When evidence against an item significantly outweighs evidence for it
 * (β >> α beyond a ratio), and the net strength is non-trivial, archive it.
 * This is the "stop surfacing what the user has rejected" policy.
 *
 * Never tombstones automatically - we keep the record so future contradictions
 * can still be traced. Tombstoning is user-driven (explicit-tombstone).
 */

import type { Policy, PolicyContext, PolicyOutcome } from '../core/contracts.js';
import { Conf } from '../core/confidence.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { LifecycleStatus } from '../core/types.js';

export interface ContradictionArchiveOpts {
  /** beta/alpha must exceed this to trigger archive. Default 3. */
  minBetaAlphaRatio?: number;
  /** Minimum strength (α+β-2) for the signal to be credible. Default 3. */
  minStrength?: number;
  /** Batch size. */
  batchSize?: number;
}

export class ContradictionArchivePolicy implements Policy {
  readonly name = 'contradiction-archive';
  readonly version = '1.0.0';

  constructor(
    private readonly pg: PostgresStore,
    private readonly opts: ContradictionArchiveOpts = {},
  ) {}

  async apply(ctx: PolicyContext): Promise<PolicyOutcome> {
    const cfg = { ...this.opts, ...(ctx.config ?? {}) } as ContradictionArchiveOpts;
    const minRatio = cfg.minBetaAlphaRatio ?? 3;
    const minStrength = cfg.minStrength ?? 3;
    const batchSize = cfg.batchSize ?? 1000;

    const transitions: Partial<Record<LifecycleStatus, number>> = {};
    let itemsScanned = 0;
    let itemsAffected = 0;

    const candidates = await this.pg.listItems({
      statuses: ['active', 'decayed'],
      limit: batchSize,
    });

    for (const item of candidates) {
      itemsScanned += 1;
      const strength = Conf.strength(item.conf);
      if (strength < minStrength) continue;
      const ratio = item.conf.beta / Math.max(1e-9, item.conf.alpha);
      if (ratio < minRatio) continue;

      itemsAffected += 1;
      transitions.archived = (transitions.archived ?? 0) + 1;

      if (ctx.dryRun) continue;
      await this.pg.patchItem(item.id, { status: 'archived' });
      await this.pg.logForgetting(
        item.id,
        this.name,
        item.status,
        'archived',
        `β/α=${ratio.toFixed(2)} strength=${strength.toFixed(2)}`,
        { alpha: item.conf.alpha, beta: item.conf.beta },
      );
    }

    return { policy: this.name, itemsScanned, itemsAffected, transitions };
  }
}
