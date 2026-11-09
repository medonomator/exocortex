import { createHash } from 'node:crypto';
import type {
  LifecycleStatus,
  MemoryEvent,
  MemoryItem,
} from '../core/types.js';
import { Conf } from '../core/confidence.js';
import type { Embedder } from '../stores/embedder.js';
import type { ItemFilter, PostgresStore } from '../stores/postgres.js';
import type {
  QdrantFilter,
  QdrantHit,
  QdrantPayload,
  QdrantStore,
} from '../stores/qdrant.js';

export interface ForgettingLogEntry {
  itemId: string;
  policy: string;
  from: LifecycleStatus;
  to: LifecycleStatus;
  reason: string;
}

export interface LineageEdge {
  parentId: string;
  childId: string;
  relation: string;
}

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

export class InMemoryPostgres {
  readonly items = new Map<string, MemoryItem>();
  readonly events: Array<{ event: MemoryEvent; resultingItemId?: string; action?: string }> = [];
  readonly forgettingLog: ForgettingLogEntry[] = [];
  readonly lineage: LineageEdge[] = [];
  readonly patches: Array<{ id: string; patch: Partial<MemoryItem> }> = [];

  asStore(): PostgresStore {
    return this as unknown as PostgresStore;
  }

  async upsertItem(item: MemoryItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async getItem(id: string): Promise<MemoryItem | null> {
    return this.items.get(id) ?? null;
  }

  async listItems(filter: ItemFilter = {}): Promise<MemoryItem[]> {
    let arr = [...this.items.values()];
    if (filter.statuses?.length) arr = arr.filter((i) => filter.statuses!.includes(i.status));
    if (filter.types?.length) arr = arr.filter((i) => filter.types!.includes(i.type));
    if (filter.minImportance !== undefined) arr = arr.filter((i) => i.importance >= filter.minImportance!);
    arr.sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
    return filter.limit ? arr.slice(0, filter.limit) : arr;
  }

  async patchItem(id: string, patch: Partial<MemoryItem>): Promise<void> {
    const cur = this.items.get(id);
    if (!cur) return;
    this.patches.push({ id, patch });
    this.items.set(id, { ...cur, ...patch });
  }

  async lexicalSearch(
    query: string,
    limit = 50,
    opts: { includeDecayed?: boolean; includeArchived?: boolean; project?: string } = {},
  ): Promise<Array<{ id: string; score: number }>> {
    const statuses: LifecycleStatus[] = ['active'];
    if (opts.includeDecayed) statuses.push('decayed');
    if (opts.includeArchived) statuses.push('archived');
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const hits: Array<{ id: string; score: number }> = [];
    for (const item of this.items.values()) {
      if (!statuses.includes(item.status)) continue;
      const project = projectOf(item);
      if (opts.project && project !== undefined && project !== opts.project) continue;
      const tokens = tokenize(item.raw.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      if (!terms.every((t) => tf.has(t))) continue;
      let score = 0;
      for (const t of terms) score += Math.log1p(tf.get(t)!);
      hits.push({ id: item.id, score: score / (1 + Math.log1p(tokens.length)) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async linkItemToMatchingEntities(): Promise<number> {
    return 0;
  }

  async insertEvent(event: MemoryEvent, resultingItemId?: string, action?: string): Promise<void> {
    this.events.push({ event, resultingItemId, action });
  }

  async addLineage(parentId: string, childId: string, relation = 'derived'): Promise<void> {
    this.lineage.push({ parentId, childId, relation });
  }

  async logForgetting(
    itemId: string,
    policy: string,
    from: LifecycleStatus,
    to: LifecycleStatus,
    reason: string,
  ): Promise<void> {
    this.forgettingLog.push({ itemId, policy, from, to, reason });
  }

  async withClient<T>(fn: (c: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> {
    return fn({
      query: async (_sql, params) => {
        const key = String(params[0]);
        const rows = [...this.items.values()]
          .filter((i) => i.metadata[key] === true && i.status !== 'tombstoned')
          .map((i) => ({ id: i.id, status: i.status }));
        return { rows };
      },
    });
  }
}

export class InMemoryQdrant {
  readonly points = new Map<string, { vector: Float32Array; payload: QdrantPayload }>();

  asStore(): QdrantStore {
    return this as unknown as QdrantStore;
  }

  async ensure(): Promise<void> {}

  async upsert(pts: Array<{ id: string; vector: Float32Array; payload: QdrantPayload }>): Promise<void> {
    for (const p of pts) this.points.set(p.id, { vector: p.vector, payload: p.payload });
  }

  async search(vec: Float32Array, opts: { limit?: number; filter?: QdrantFilter } = {}): Promise<QdrantHit[]> {
    const f = opts.filter ?? {};
    const hits: QdrantHit[] = [];
    for (const [id, pt] of this.points) {
      const p = pt.payload;
      if (f.statuses && !f.statuses.includes(p.status)) continue;
      if (f.types && !f.types.includes(p.type)) continue;
      if (f.model && p.model !== f.model) continue;
      if (f.project && p.project !== undefined && p.project !== f.project) continue;
      hits.push({ id, score: cosine(vec, pt.vector), payload: p });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.limit ?? 50);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.points.delete(id);
  }
}

export class HashEmbedder implements Embedder {
  readonly model = 'hash-trigram';

  constructor(readonly dim = 256) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      const s = ` ${t.toLowerCase()} `;
      for (let i = 0; i <= s.length - 3; i++) {
        const h = createHash('md5').update(s.slice(i, i + 3)).digest();
        v[h.readUInt32LE(0) % this.dim]! += 1;
      }
      return normalize(v);
    });
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const d = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / d;
  return v;
}

export function projectOf(item: MemoryItem): string | undefined {
  const p = (item.payload as { project?: unknown } | null)?.project;
  return typeof p === 'string' ? p : undefined;
}

export function makeItem(overrides: Partial<MemoryItem> & { id: string }): MemoryItem {
  const now = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    type: 'episode',
    payload: {},
    raw: { text: overrides.id, contentType: 'text/plain' },
    status: 'active',
    level: 0,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    conf: Conf.uninformative(),
    stability: 7,
    importance: 0.5,
    accessCount: 0,
    provenance: { source: 'manual', producedAt: now, chain: [] },
    trainingEligible: false,
    metadata: {},
    ...overrides,
  };
}

export async function seed(
  pg: InMemoryPostgres,
  qd: InMemoryQdrant,
  embedder: Embedder,
  items: MemoryItem[],
): Promise<void> {
  const vectors = await embedder.embed(items.map((i) => i.raw.text));
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    await pg.upsertItem(item);
    await qd.upsert([{
      id: item.id,
      vector: vectors[i]!,
      payload: {
        type: item.type,
        status: item.status,
        level: item.level,
        project: projectOf(item),
        model: embedder.model,
        lastAccessedAt: item.lastAccessedAt.toISOString(),
        importance: item.importance,
        confidence: Conf.mean(item.conf),
      },
    }]);
  }
}
