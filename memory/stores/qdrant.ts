/**
 * Qdrant vector store for MemoryItem embeddings.
 *
 * Point id = MemoryItem.id (UUID). Payload is a compact snapshot for
 * pre-filtering / quick inspection (full item lives in Postgres).
 *
 * We namespace by embedder model so swapping models keeps both sets
 * coexisting until we complete the migration.
 */

import { StoreError } from '../core/errors.js';
import type { ItemType, LifecycleStatus, AbstractionLevel } from '../core/types.js';

export interface QdrantStoreOpts {
  url?: string;
  apiKey?: string;
  collection: string; // e.g. 'mem_items_3small'
  vectorSize: number;
  distance?: 'Cosine' | 'Dot' | 'Euclid';
}

export interface QdrantHit {
  id: string;
  score: number;
  payload: QdrantPayload;
}

export interface QdrantPayload {
  type: ItemType;
  status: LifecycleStatus;
  level: AbstractionLevel;
  project?: string;
  tags?: string[];
  model: string;
  lastAccessedAt: string; // ISO
  importance: number;
  confidence: number;
}

export class QdrantStore {
  private readonly url: string;
  private readonly apiKey?: string;
  readonly collection: string;
  readonly vectorSize: number;
  private readonly distance: 'Cosine' | 'Dot' | 'Euclid';

  constructor(opts: QdrantStoreOpts) {
    this.url = (opts.url ?? process.env.QDRANT_URL ?? 'http://localhost:6333').replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? process.env.QDRANT_API_KEY;
    this.collection = opts.collection;
    this.vectorSize = opts.vectorSize;
    this.distance = opts.distance ?? 'Cosine';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['api-key'] = this.apiKey;
    return h;
  }

  /** Create the collection if missing. Safe to call repeatedly. */
  async ensure(): Promise<void> {
    const check = await fetch(`${this.url}/collections/${this.collection}`, {
      headers: this.headers(),
    });
    if (check.ok) return;
    if (check.status !== 404) {
      throw new StoreError(`Qdrant check failed: ${check.status} ${await check.text()}`);
    }
    const create = await fetch(`${this.url}/collections/${this.collection}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({
        vectors: { size: this.vectorSize, distance: this.distance },
      }),
    });
    if (!create.ok) {
      throw new StoreError(
        `Qdrant create failed: ${create.status} ${await create.text()}`,
      );
    }
  }

  async upsert(points: Array<{ id: string; vector: Float32Array; payload: QdrantPayload }>): Promise<void> {
    if (points.length === 0) return;
    const body = {
      points: points.map((p) => ({
        id: p.id,
        vector: Array.from(p.vector),
        payload: p.payload,
      })),
    };
    const resp = await fetch(`${this.url}/collections/${this.collection}/points?wait=true`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new StoreError(`Qdrant upsert failed: ${resp.status} ${await resp.text()}`);
    }
  }

  async search(
    vector: Float32Array,
    opts: {
      limit?: number;
      filter?: QdrantFilter;
      scoreThreshold?: number;
    } = {},
  ): Promise<QdrantHit[]> {
    const body = {
      vector: Array.from(vector),
      limit: opts.limit ?? 50,
      with_payload: true,
      filter: opts.filter ? toQdrantFilter(opts.filter) : undefined,
      score_threshold: opts.scoreThreshold,
    };
    const resp = await fetch(`${this.url}/collections/${this.collection}/points/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new StoreError(`Qdrant search failed: ${resp.status} ${await resp.text()}`);
    }
    const json = (await resp.json()) as { result: Array<{ id: string; score: number; payload: QdrantPayload }> };
    return json.result.map((r) => ({ id: String(r.id), score: r.score, payload: r.payload }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const resp = await fetch(`${this.url}/collections/${this.collection}/points/delete?wait=true`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ points: ids }),
    });
    if (!resp.ok) {
      throw new StoreError(`Qdrant delete failed: ${resp.status} ${await resp.text()}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface QdrantFilter {
  types?: ItemType[];
  statuses?: LifecycleStatus[];
  project?: string;
  model?: string;
  minImportance?: number;
}

function toQdrantFilter(f: QdrantFilter): object {
  const must: unknown[] = [];
  if (f.types) must.push({ key: 'type', match: { any: f.types } });
  if (f.statuses) must.push({ key: 'status', match: { any: f.statuses } });
  if (f.project) {
    // Match the named project OR a point that has no project payload at
    // all (legacy/user-wide items from pre-scoping ingests). Without the
    // is_empty branch those items would silently disappear the moment
    // recall started scoping by project.
    must.push({
      should: [
        { key: 'project', match: { value: f.project } },
        { is_empty: { key: 'project' } },
      ],
    });
  }
  if (f.model) must.push({ key: 'model', match: { value: f.model } });
  if (f.minImportance !== undefined)
    must.push({ key: 'importance', range: { gte: f.minImportance } });
  return { must };
}
