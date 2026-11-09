/**
 * core-promotion policy.
 *
 * Identity-level items (persistent preferences, strong principles) should
 * never decay. This policy identifies items that have accumulated strong
 * evidence AND have been reactivated repeatedly, and promotes them:
 *
 *   - level: raised toward L3 if appropriate
 *   - status: reset to 'active'
 *   - stability: floor-bumped so they resist future decay
 *
 * Runs weekly; idempotent.
 */

import type { Policy, PolicyContext, PolicyOutcome } from '../core/contracts.js';
import { Conf } from '../core/confidence.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { AbstractionLevel, LifecycleStatus } from '../core/types.js';

export interface CorePromotionOpts {
  /** Minimum strength (α+β-2) to be considered "core". Default 20. */
  minStrength?: number;
  /** Minimum access count to be considered "core". Default 10. */
  minAccessCount?: number;
  /** Minimum mean confidence. Default 0.8. */
  minMean?: number;
  /** Floor for stability days on promotion. Default 180. */
  stabilityFloorDays?: number;
  /** Max level to promote to. Default 3. */
  maxLevel?: AbstractionLevel;
  batchSize?: number;
}

export class CorePromotionPolicy implements Policy {
  readonly name = 'core-promotion';
  readonly version = '1.0.0';

  constructor(
    private readonly pg: PostgresStore,
    private readonly opts: CorePromotionOpts = {},
  ) {}

  async apply(ctx: PolicyContext): Promise<PolicyOutcome> {
    const cfg = { ...this.opts, ...(ctx.config ?? {}) } as CorePromotionOpts;
    const minStrength = cfg.minStrength ?? 20;
    const minAccess = cfg.minAccessCount ?? 10;
    const minMean = cfg.minMean ?? 0.8;
    const stabilityFloor = cfg.stabilityFloorDays ?? 180;
    const maxLevel: AbstractionLevel = cfg.maxLevel ?? 3;
    const batchSize = cfg.batchSize ?? 500;

    const transitions: Partial<Record<LifecycleStatus, number>> = {};
    let itemsScanned = 0;
    let itemsAffected = 0;

    const candidates = await this.pg.listItems({
      statuses: ['active', 'decayed'],
      limit: batchSize,
      minImportance: 0.3,
    });

    for (const item of candidates) {
      itemsScanned += 1;
      if (Conf.strength(item.conf) < minStrength) continue;
      if (item.accessCount < minAccess) continue;
      if (Conf.mean(item.conf) < minMean) continue;

      const bumpedStability = Math.max(item.stability, stabilityFloor);
      const targetLevel: AbstractionLevel =
        item.level < maxLevel ? ((item.level + 1) as AbstractionLevel) : item.level;

      const changed =
        item.status !== 'active' ||
        bumpedStability !== item.stability ||
        targetLevel !== item.level;
      if (!changed) continue;

      itemsAffected += 1;
      if (item.status !== 'active') transitions.active = (transitions.active ?? 0) + 1;

      if (ctx.dryRun) continue;
      await this.pg.patchItem(item.id, {
        status: 'active',
        stability: bumpedStability,
        level: targetLevel,
      });
      if (item.status !== 'active') {
        await this.pg.logForgetting(
          item.id,
          this.name,
          item.status,
          'active',
          `promoted (strength=${Conf.strength(item.conf).toFixed(1)} access=${item.accessCount})`,
          { stability: bumpedStability, level: targetLevel },
        );
      }
    }

    return { policy: this.name, itemsScanned, itemsAffected, transitions };
  }
}
