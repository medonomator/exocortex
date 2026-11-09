/**
 * ConsolidateService - runs the pipeline: events → items → clusters → abstractions.
 *
 * Sequential pipeline over a time window:
 *   1. Load events in window (for provenance / observability; actual items
 *      are already in mem_items via ingest).
 *   2. Load candidate items to abstract (level=sourceLevel, active, in window).
 *   3. Run each PipelineStage in order, threading the `items` accumulator.
 *   4. Persist any *new* items (id not already in mem_items) via upsertItem.
 *   5. Write embeddings for new items to Qdrant.
 *
 * The stages themselves come from a PluginRegistry<PipelineStage> so callers
 * can slot in alternative clusterers, extractors, or dedupers without
 * touching this service.
 */

import type { PipelineStage, StageOutcome } from '../core/contracts.js';
import { PluginRegistry } from '../core/registry.js';
import type {
  MemoryItem,
  ConsolidateResult,
  TimeRange,
  AbstractionLevel,
} from '../core/types.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { QdrantStore, QdrantPayload } from '../stores/qdrant.js';
import type { Embedder } from '../stores/embedder.js';
import { Conf } from '../core/confidence.js';

export interface ConsolidateServiceOpts {
  postgres: PostgresStore;
  qdrant: QdrantStore;
  embedder: Embedder;
  stages: PluginRegistry<PipelineStage>;
}

export interface ConsolidateRunOpts {
  /** Window of item lastAccessedAt to consider. */
  window?: TimeRange;
  /** Which level to source from. Default 0 (episodes). */
  sourceLevel?: AbstractionLevel;
  /** Stage names in execution order. Default: ['cluster', 'abstract']. */
  stages?: string[];
  /** Stage-specific configs by stage name. */
  configs?: Record<string, Record<string, unknown>>;
  /** Max candidate items to load. Default 500. */
  maxItems?: number;
  /** Override now (tests / backfills). */
  now?: Date;
}

export class ConsolidateService {
  private readonly pg: PostgresStore;
  private readonly qd: QdrantStore;
  private readonly embedder: Embedder;
  private readonly stages: PluginRegistry<PipelineStage>;

  constructor(opts: ConsolidateServiceOpts) {
    this.pg = opts.postgres;
    this.qd = opts.qdrant;
    this.embedder = opts.embedder;
    this.stages = opts.stages;
  }

  async run(opts: ConsolidateRunOpts = {}): Promise<ConsolidateResult> {
    const started = Date.now();
    const now = opts.now ?? new Date();
    const sourceLevel: AbstractionLevel = opts.sourceLevel ?? 0;
    const stageNames = opts.stages ?? ['cluster', 'abstract'];

    const events = opts.window ? await this.pg.listEvents(opts.window) : [];

    const candidates = await this.pg.listItems({
      levels: [sourceLevel],
      statuses: ['active'],
      since: opts.window?.from,
      until: opts.window?.to,
      limit: opts.maxItems ?? 500,
    });

    const existingIds = new Set(candidates.map((c) => c.id));
    let items: MemoryItem[] = [...candidates];
    const outcomes: StageOutcome[] = [];

    for (const name of stageNames) {
      const stage = this.stages.get(name);
      const outcome = await stage.run({
        events,
        items,
        now,
        config: opts.configs?.[name],
      });
      items = outcome.items;
      outcomes.push(outcome);
    }

    // Persist new items (those not in existingIds).
    const toPersist = items.filter((it) => !existingIds.has(it.id));
    let abstractionsPromoted = 0;
    for (const item of toPersist) {
      await this.pg.upsertItem(item);
      if (item.type === 'abstraction') abstractionsPromoted += 1;
      // Lineage edges
      for (const parentId of item.provenance.derivedFrom ?? []) {
        await this.pg.addLineage(parentId, item.id, 'abstraction');
      }
    }

    // Embed + upsert into Qdrant.
    if (toPersist.length > 0) {
      await this.qd.ensure();
      const vectors = await this.embedder.embed(toPersist.map((it) => it.raw.text));
      const points = toPersist.map((item, i) => {
        const payload: QdrantPayload = {
          type: item.type,
          status: item.status,
          level: item.level,
          project: (item.payload as { project?: string } | null)?.project,
          model: this.embedder.model,
          lastAccessedAt: item.lastAccessedAt.toISOString(),
          importance: item.importance,
          confidence: Conf.mean(item.conf),
        };
        return { id: item.id, vector: vectors[i]!, payload };
      });
      await this.qd.upsert(points);
    }

    return {
      processedEvents: events.length,
      itemsCreated: toPersist.length,
      itemsReinforced: 0,
      itemsArchived: 0,
      abstractionsPromoted,
      elapsedMs: Date.now() - started,
    };
  }
}
