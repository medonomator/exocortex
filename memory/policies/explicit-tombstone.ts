/**
 * explicit-tombstone policy.
 *
 * Transitions items the user has explicitly flagged via metadata.tombstone=true
 * (or any deletion marker) to status='tombstoned'. User-driven - never runs
 * automatically on any heuristic. The tombstoned row is retained as audit; the
 * Qdrant entry should be deleted by the caller (ForgetService).
 */

import type { Policy, PolicyContext, PolicyOutcome } from '../core/contracts.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { LifecycleStatus } from '../core/types.js';

export interface ExplicitTombstoneOpts {
  /** Metadata key that marks an item for tombstoning. Default 'tombstone'. */
  markerKey?: string;
}

export class ExplicitTombstonePolicy implements Policy {
  readonly name = 'explicit-tombstone';
  readonly version = '1.0.0';

  constructor(
    private readonly pg: PostgresStore,
    private readonly opts: ExplicitTombstoneOpts = {},
  ) {}

  async apply(ctx: PolicyContext): Promise<PolicyOutcome> {
    const cfg = { ...this.opts, ...(ctx.config ?? {}) } as ExplicitTombstoneOpts;
    const key = cfg.markerKey ?? 'tombstone';

    const transitions: Partial<Record<LifecycleStatus, number>> = {};
    let itemsAffected = 0;

    const sql = `
      SELECT id, status
      FROM mem_items
      WHERE metadata ? $1
        AND (metadata->>$1)::boolean = true
        AND status <> 'tombstoned'
    `;
    const rows = await this.pg.withClient(async (c) => {
      const r = await c.query<{ id: string; status: LifecycleStatus }>(sql, [key]);
      return r.rows;
    });

    for (const row of rows) {
      itemsAffected += 1;
      transitions.tombstoned = (transitions.tombstoned ?? 0) + 1;
      if (ctx.dryRun) continue;
      await this.pg.patchItem(row.id, { status: 'tombstoned' });
      await this.pg.logForgetting(
        row.id,
        this.name,
        row.status,
        'tombstoned',
        'user-marked',
      );
    }

    return {
      policy: this.name,
      itemsScanned: rows.length,
      itemsAffected,
      transitions,
    };
  }
}
