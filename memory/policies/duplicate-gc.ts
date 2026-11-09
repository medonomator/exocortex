/**
 * duplicate-gc policy.
 *
 * Finds pairs of highly similar items (cosine ≥ threshold) and merges the
 * weaker into the stronger:
 *   - add a lineage edge weaker → stronger ('merged')
 *   - transfer confidence via Conf.merge
 *   - archive the weaker item
 *   - delete its Qdrant point
 *
 * "Stronger" = higher confidence mean, ties broken by access count then age.
 *
 * This runs rarely (weekly). The novelty gate in IngestService is the first
 * line of defense; this exists to handle drift and post-hoc consolidation.
 */

import type { Policy, PolicyContext, PolicyOutcome } from '../core/contracts.js';
import { Conf } from '../core/confidence.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { QdrantStore } from '../stores/qdrant.js';
import type { Embedder } from '../stores/embedder.js';
import type { LifecycleStatus, MemoryItem } from '../core/types.js';

export interface DuplicateGcOpts {
  /** Cosine similarity at/above which two items are "duplicates". Default 0.95. */
  similarityThreshold?: number;
  /** How many candidate items to re-examine per run. Default 500. */
  batchSize?: number;
}

export class DuplicateGcPolicy implements Policy {
  readonly name = 'duplicate-gc';
  readonly version = '1.0.0';

  constructor(
    private readonly pg: PostgresStore,
    private readonly qd: QdrantStore,
    private readonly embedder: Embedder,
    private readonly opts: DuplicateGcOpts = {},
  ) {}

  async apply(ctx: PolicyContext): Promise<PolicyOutcome> {
    const cfg = { ...this.opts, ...(ctx.config ?? {}) } as DuplicateGcOpts;
    const threshold = cfg.similarityThreshold ?? 0.95;
    const batchSize = cfg.batchSize ?? 500;

    const transitions: Partial<Record<LifecycleStatus, number>> = {};
    let itemsScanned = 0;
    let itemsAffected = 0;
    const mergedIds = new Set<string>();

    const items = await this.pg.listItems({
      statuses: ['active', 'decayed'],
      limit: batchSize,
    });

    // Re-embed and look for near-neighbors. We don't trust stored embeddings
    // here - if the caller swapped models since ingest, the stored vectors
    // would be from a different space.
    for (const item of items) {
      itemsScanned += 1;
      if (mergedIds.has(item.id)) continue;

      const [vec] = await this.embedder.embed([item.raw.text]);
      if (!vec) continue;

      const hits = await this.qd.search(vec, {
        limit: 5,
        filter: { model: this.embedder.model, statuses: ['active', 'decayed'] },
      });

      for (const hit of hits) {
        if (hit.id === item.id) continue;
        if (hit.score < threshold) continue;
        if (mergedIds.has(hit.id)) continue;

        const other = await this.pg.getItem(hit.id);
        if (!other) continue;

        const [keep, drop] = pickWinner(item, other);
        const merged = Conf.merge(keep.conf, drop.conf);

        itemsAffected += 1;
        transitions.archived = (transitions.archived ?? 0) + 1;
        mergedIds.add(drop.id);

        if (ctx.dryRun) continue;
        await this.pg.patchItem(keep.id, {
          conf: merged,
          accessCount: keep.accessCount + drop.accessCount,
          importance: Math.max(keep.importance, drop.importance),
        });
        await this.pg.patchItem(drop.id, { status: 'archived' });
        await this.pg.addLineage(keep.id, drop.id, 'merged');
        await this.pg.logForgetting(
          drop.id,
          this.name,
          drop.status,
          'archived',
          `merged→${keep.id} sim=${hit.score.toFixed(3)}`,
        );
        await this.qd.delete([drop.id]);
        break; // one merge per item per run
      }
    }

    return { policy: this.name, itemsScanned, itemsAffected, transitions };
  }
}

function pickWinner(a: MemoryItem, b: MemoryItem): [MemoryItem, MemoryItem] {
  const aMean = Conf.mean(a.conf);
  const bMean = Conf.mean(b.conf);
  if (aMean !== bMean) return aMean > bMean ? [a, b] : [b, a];
  if (a.accessCount !== b.accessCount)
    return a.accessCount > b.accessCount ? [a, b] : [b, a];
  return a.createdAt.getTime() <= b.createdAt.getTime() ? [a, b] : [b, a];
}
