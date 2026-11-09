/**
 * IngestService - realize Memory.ingest().
 *
 * Flow:
 *   1. Persist the raw MemoryEvent (audit trail, even if nothing else happens).
 *   2. Compute an embedding for the event content.
 *   3. Novelty gate: find the nearest existing item.
 *        • If novelty < threshold → reinforce that item instead of creating a duplicate.
 *        • Otherwise → create a new MemoryItem of the requested type.
 *   4. Upsert to Postgres and Qdrant.
 *   5. Link back to the originating event (resulting_item_id).
 */

import { randomUUID } from 'node:crypto';
import type {
  MemoryEvent,
  MemoryItem,
  IngestResult,
  ItemType,
  RawContent,
  Provenance,
} from '../core/types.js';
import { Conf } from '../core/confidence.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { QdrantStore, QdrantPayload } from '../stores/qdrant.js';
import type { Embedder } from '../stores/embedder.js';

export interface IngestServiceOpts {
  postgres: PostgresStore;
  qdrant: QdrantStore;
  embedder: Embedder;

  /** Below this similarity (0..1) we treat the event as novel. */
  noveltyThreshold?: number;

  /** Initial stability in days for new items. Defaults to 7. */
  initialStabilityDays?: number;

  /** Default item type inference when caller doesn't specify. */
  defaultType?: ItemType;
}

/** Hint from caller: what kind of item should this event become? */
export interface IngestHint {
  type?: ItemType;
  payload?: Record<string, unknown>;
  importance?: number;
  project?: string;
}

export class IngestService {
  private readonly pg: PostgresStore;
  private readonly qd: QdrantStore;
  private readonly embedder: Embedder;
  private readonly noveltyThreshold: number;
  private readonly initialStability: number;
  private readonly defaultType: ItemType;

  constructor(opts: IngestServiceOpts) {
    this.pg = opts.postgres;
    this.qd = opts.qdrant;
    this.embedder = opts.embedder;
    this.noveltyThreshold = opts.noveltyThreshold ?? 0.15;
    this.initialStability = opts.initialStabilityDays ?? 7;
    this.defaultType = opts.defaultType ?? 'episode';
  }

  async ingest(event: MemoryEvent, hint: IngestHint = {}): Promise<IngestResult> {
    // 1. Persist the raw event first - we always want the audit trail.
    await this.pg.insertEvent(event);

    const text = event.content.text.trim();
    if (!text) {
      await this.pg.insertEvent(event, undefined, 'skipped');
      return { itemId: null, action: 'skipped' };
    }

    // 2. Embed.
    const [vec] = await this.embedder.embed([text]);
    if (!vec) throw new Error('Embedder returned no vector');

    // 3. Novelty gate - nearest existing item.
    await this.qd.ensure();
    const near = await this.qd.search(vec, {
      limit: 1,
      filter: { model: this.embedder.model, statuses: ['active', 'decayed'] },
    });
    const top = near[0];
    const novelty = top ? 1 - top.score : 1;

    // 4a. Reinforce existing item.
    if (top && novelty < this.noveltyThreshold) {
      const existing = await this.pg.getItem(top.id);
      if (existing) {
        const newConf = Conf.reinforce(existing.conf, 1);
        await this.pg.patchItem(existing.id, {
          conf: newConf,
          lastAccessedAt: event.timestamp,
          accessCount: existing.accessCount + 1,
        });
        // Note: no mem_lineage row here. mem_lineage.child_id FKs to
        // mem_items, while `event.id` lives in mem_events. The reinforcement
        // link is captured by insertEvent below (resulting_item_id +
        // resulting_action='reinforced'). Lineage is reserved for item→item
        // relations (e.g. abstraction via consolidate).
        await this.pg.insertEvent(event, existing.id, 'reinforced');
        return {
          itemId: existing.id,
          action: 'reinforced',
          noveltyScore: novelty,
        };
      }
    }

    // 4b. Create a new item.
    const item = buildItem({
      id: randomUUID(),
      type: hint.type ?? this.defaultType,
      payload: hint.payload ?? defaultPayloadFor(hint.type ?? this.defaultType, event, hint),
      raw: event.content,
      provenance: event.provenance,
      timestamp: event.timestamp,
      importance: hint.importance ?? 0.5,
      initialStabilityDays: this.initialStability,
    });

    await this.pg.upsertItem(item);

    // 4b. Auto-link to matching kg_entities (graph-first retrieval seed).
    // Deterministic substring match over all known entities. Runs in-DB via
    // a single CTE - cheap, no extra roundtrip for entity fetch. Failures
    // are non-fatal; the item is still usable without graph links.
    const linkText = item.raw?.text ?? '';
    if (linkText.length > 0) {
      await this.pg.linkItemToMatchingEntities(item.id, linkText).catch(() => 0);
    }

    // 5. Write embedding.
    const qdPayload: QdrantPayload = {
      type: item.type,
      status: item.status,
      level: item.level,
      project: hint.project,
      model: this.embedder.model,
      lastAccessedAt: item.lastAccessedAt.toISOString(),
      importance: item.importance,
      confidence: item.conf.alpha / (item.conf.alpha + item.conf.beta),
    };
    await this.qd.upsert([{ id: item.id, vector: vec, payload: qdPayload }]);

    // 6. Link event → item.
    await this.pg.insertEvent(event, item.id, 'created');

    return { itemId: item.id, action: 'created', noveltyScore: novelty };
  }
}

function buildItem(args: {
  id: string;
  type: ItemType;
  payload: Record<string, unknown>;
  raw: RawContent;
  provenance: Provenance;
  timestamp: Date;
  importance: number;
  initialStabilityDays: number;
}): MemoryItem {
  const now = args.timestamp;
  return {
    id: args.id,
    type: args.type,
    payload: args.payload,
    raw: args.raw,
    status: 'active',
    level: 0,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    conf: Conf.uninformative(),
    stability: args.initialStabilityDays,
    importance: Math.max(0, Math.min(1, args.importance)),
    accessCount: 0,
    provenance: {
      ...args.provenance,
      chain: [...args.provenance.chain, 'ingest'],
    },
    trainingEligible: false,
    metadata: {},
  };
}

function defaultPayloadFor(
  type: ItemType,
  event: MemoryEvent,
  hint: IngestHint,
): Record<string, unknown> {
  const text = event.content.text;
  const project = hint.project;
  switch (type) {
    case 'episode':
      return {
        summary: text.slice(0, 500),
        actors: event.actors,
        project,
        tags: [],
      };
    case 'fact':
      return { subject: 'unknown', statement: text.slice(0, 500), project };
    case 'relation':
      return { from: 'unknown', to: 'unknown', relationType: 'related', project };
    case 'procedure':
      return {
        pattern: text.slice(0, 200),
        trigger: '',
        action: '',
        successCount: 0,
        failureCount: 0,
        project,
      };
    case 'abstraction':
      return {
        title: text.slice(0, 120),
        summary: text.slice(0, 500),
        childCount: 0,
        project,
      };
  }
}
