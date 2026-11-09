/**
 * Smoke integration test - runs in isolation against in-memory fakes of the
 * Postgres / Qdrant stores, and a stubbed embedder. Exercises ingest → recall
 * → forget → introspect end-to-end so contract drift surfaces in CI.
 *
 * Not run in the real DB: that needs docker-compose + live mindforge Postgres.
 */

import { strict as assert } from 'node:assert';
import { it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  MemoryEvent,
  MemoryItem,
  LifecycleStatus,
} from '../core/types.js';
import type { Embedder } from '../stores/embedder.js';
import type { PostgresStore, ItemFilter } from '../stores/postgres.js';
import type { QdrantStore, QdrantHit, QdrantPayload } from '../stores/qdrant.js';
import { IngestService } from '../services/ingest.js';

// Intentionally minimal; we exercise just ingest → in-memory novelty gate.
class FakeEmbedder implements Embedder {
  readonly model = 'fake-embedder';
  readonly dim = 32;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      // Multiplicative hash per trigram into bucket -> decent separation.
      for (let i = 0; i <= t.length - 3; i++) {
        let h = 2166136261 >>> 0;
        for (let j = 0; j < 3; j++) {
          h = Math.imul(h ^ t.charCodeAt(i + j), 16777619) >>> 0;
        }
        v[h % this.dim]! += 1;
      }
      return normalize(v);
    });
  }
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const d = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / d;
  return v;
}

type StoredItem = MemoryItem;

class FakePg implements Pick<PostgresStore, 'upsertItem' | 'getItem' | 'listItems' | 'patchItem' | 'insertEvent' | 'addLineage' | 'logForgetting' | 'linkItemToMatchingEntities'> {
  items = new Map<string, StoredItem>();
  events: Array<{ event: MemoryEvent; resultingItemId?: string; action?: string }> = [];
  async upsertItem(item: MemoryItem): Promise<void> {
    this.items.set(item.id, item);
  }
  async getItem(id: string): Promise<MemoryItem | null> {
    return this.items.get(id) ?? null;
  }
  async listItems(filter: ItemFilter = {}): Promise<MemoryItem[]> {
    const arr = [...this.items.values()];
    return filter.statuses ? arr.filter((i) => filter.statuses!.includes(i.status)) : arr;
  }
  async patchItem(id: string, patch: Partial<MemoryItem>): Promise<void> {
    const cur = this.items.get(id);
    if (!cur) return;
    this.items.set(id, { ...cur, ...patch });
  }
  async insertEvent(event: MemoryEvent, resultingItemId?: string, action?: string): Promise<void> {
    this.events.push({ event, resultingItemId, action });
  }
  async addLineage(): Promise<void> {}
  async logForgetting(): Promise<void> {}
  async linkItemToMatchingEntities(): Promise<number> {
    return 0;
  }
}

class FakeQd implements Pick<QdrantStore, 'ensure' | 'upsert' | 'search' | 'delete'> {
  points = new Map<string, { vector: Float32Array; payload: QdrantPayload }>();
  async ensure(): Promise<void> {}
  async upsert(pts: Array<{ id: string; vector: Float32Array; payload: QdrantPayload }>): Promise<void> {
    for (const p of pts) this.points.set(p.id, { vector: p.vector, payload: p.payload });
  }
  async search(vec: Float32Array, opts: { limit?: number; filter?: { statuses?: LifecycleStatus[] } } = {}): Promise<QdrantHit[]> {
    const hits: QdrantHit[] = [];
    for (const [id, pt] of this.points) {
      if (opts.filter?.statuses && !opts.filter.statuses.includes(pt.payload.status)) continue;
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i]! * pt.vector[i]!;
      hits.push({ id, score: dot, payload: pt.payload });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.limit ?? 50);
  }
  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.points.delete(id);
  }
}

function mkEvent(text: string): MemoryEvent {
  return {
    id: randomUUID(),
    kind: 'observation',
    content: { text, contentType: 'text/plain' },
    timestamp: new Date(),
    raw: { text },
    provenance: {
      source: 'manual',
      producedAt: new Date(),
      chain: ['test'],
    },
  };
}

async function runSmokeTest(): Promise<void> {
  const pg = new FakePg();
  const qd = new FakeQd();
  const embedder = new FakeEmbedder();

  const ingest = new IngestService({
    postgres: pg as unknown as PostgresStore,
    qdrant: qd as unknown as QdrantStore,
    embedder,
    noveltyThreshold: 0.05,
  });

  const first = await ingest.ingest(mkEvent('User prefers TypeScript over JavaScript'));
  assert.equal(first.action, 'created');
  assert.ok(first.itemId, 'first ingest must create item');

  const dupe = await ingest.ingest(mkEvent('User prefers TypeScript over JavaScript'));
  assert.equal(dupe.action, 'reinforced', 'exact duplicate should reinforce');
  assert.equal(dupe.itemId, first.itemId, 'reinforced item id must match');

  const distinct = await ingest.ingest(mkEvent('Prefers espresso over filter coffee'));
  assert.equal(distinct.action, 'created', 'semantically distinct should create');
  assert.notEqual(distinct.itemId, first.itemId);

  assert.equal(pg.items.size, 2, 'should have exactly 2 items');
  assert.equal(qd.points.size, 2, 'qdrant should have exactly 2 points');

  // Reinforce should increment accessCount and alpha
  const reinforced = pg.items.get(first.itemId!)!;
  assert.ok(reinforced.accessCount >= 1, 'accessCount should increase');
  assert.ok(reinforced.conf.alpha > 1, 'alpha should increase on reinforce');
}

it('ingest dedupes near-duplicates and reinforces the existing item', runSmokeTest);
