/**
 * decay-ebbinghaus policy.
 *
 * Scans active items whose *effective* confidence (lazily decayed by
 * Ebbinghaus) has dropped below `decayedAt` strength, and transitions them
 * to status='decayed'. Decayed items remain indexed and retrievable (warm
 * mode); they just get down-weighted in hot-path ranking.
 *
 * Further below `archivedAt`, items go status='archived' - excluded from
 * hot-path recall entirely but still kept.
 *
 * This policy is *non-destructive*: it never writes to confidence, only to
 * lifecycle status. The decay itself is computed on read via decay.ts.
 */

import type { Policy, PolicyContext, PolicyOutcome } from '../core/contracts.js';
import { effectiveConfidence, daysSince } from '../core/decay.js';
import { Conf } from '../core/confidence.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { LifecycleStatus } from '../core/types.js';

export interface DecayEbbinghausOpts {
  /** Effective strength (alpha+beta-2) below which items decay. Default 0.5. */
  decayedAtStrength?: number;
  /** Effective strength below which items archive. Default 0.1. */
  archivedAtStrength?: number;
  /** Minimum days since lastAccessedAt before we touch the item. Default 30. */
  minIdleDays?: number;
  /** Batch size for scanning. */
  batchSize?: number;
}

export class DecayEbbinghausPolicy implements Policy {
  readonly name = 'decay-ebbinghaus';
  readonly version = '1.0.0';

  constructor(private readonly pg: PostgresStore, private readonly opts: DecayEbbinghausOpts = {}) {}

  async apply(ctx: PolicyContext): Promise<PolicyOutcome> {
    const now = ctx.now;
    const cfg = { ...this.opts, ...(ctx.config ?? {}) } as DecayEbbinghausOpts;
    const decayedAt = cfg.decayedAtStrength ?? 0.5;
    const archivedAt = cfg.archivedAtStrength ?? 0.1;
    const minIdleDays = cfg.minIdleDays ?? 30;
    const batchSize = cfg.batchSize ?? 1000;

    const transitions: Partial<Record<LifecycleStatus, number>> = {};
    let itemsScanned = 0;
    let itemsAffected = 0;

    // Scan hot-path statuses that can still transition down.
    const items = await this.pg.listItems({
      statuses: ['active', 'decayed'],
      limit: batchSize,
    });

    for (const item of items) {
      itemsScanned += 1;
      if (daysSince(item.lastAccessedAt, now) < minIdleDays) continue;

      const effConf = effectiveConfidence(item, now);
      const effStrength = Conf.strength(effConf);
      let nextStatus: LifecycleStatus | null = null;

      if (effStrength < archivedAt) nextStatus = 'archived';
      else if (effStrength < decayedAt && item.status === 'active') nextStatus = 'decayed';

      if (!nextStatus || nextStatus === item.status) continue;

      itemsAffected += 1;
      transitions[nextStatus] = (transitions[nextStatus] ?? 0) + 1;

      if (ctx.dryRun) continue;
      await this.pg.patchItem(item.id, { status: nextStatus });
      await this.pg.logForgetting(
        item.id,
        this.name,
        item.status,
        nextStatus,
        `effStrength=${effStrength.toFixed(3)} idle=${daysSince(item.lastAccessedAt, now).toFixed(1)}d`,
        { effStrength, stability: item.stability },
      );
    }

    return { policy: this.name, itemsScanned, itemsAffected, transitions };
  }
}
