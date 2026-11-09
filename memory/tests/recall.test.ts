import { beforeEach, describe, expect, it } from 'vitest';
import { RecallService } from '../services/recall.js';
import {
  HashEmbedder,
  InMemoryPostgres,
  InMemoryQdrant,
  makeItem,
  seed,
} from '../testing/in-memory.js';

const text = (t: string) => ({ text: t, contentType: 'text/plain' });

let pg: InMemoryPostgres;
let qd: InMemoryQdrant;
let svc: RecallService;

beforeEach(async () => {
  pg = new InMemoryPostgres();
  qd = new InMemoryQdrant();
  const embedder = new HashEmbedder();
  await seed(pg, qd, embedder, [
    makeItem({ id: 'redis', raw: text('Fixed redis connection timeout by raising pool size'), payload: { project: 'api' } }),
    makeItem({ id: 'redis-other', raw: text('Fixed redis connection timeout in the worker'), payload: { project: 'worker' } }),
    makeItem({ id: 'global', raw: text('Prefer redis streams over pub/sub for durable queues') }),
    makeItem({ id: 'css', raw: text('Dark mode toggle uses CSS custom properties'), payload: { project: 'api' } }),
    makeItem({ id: 'old-redis', raw: text('Fixed redis connection timeout last year'), status: 'decayed', payload: { project: 'api' } }),
    makeItem({ id: 'fact', type: 'fact', raw: text('Redis connection pool default size is ten'), payload: { project: 'api' } }),
  ]);
  svc = new RecallService({ postgres: pg.asStore(), qdrant: qd.asStore(), embedder, cosineThreshold: 0.2 });
});

describe('RecallService', () => {
  it('returns the best semantic match first with both retrieval sources', async () => {
    const res = await svc.recall({ text: 'redis connection timeout', limit: 3 });
    expect(res.items[0]!.item.id).toMatch(/redis/);
    expect(res.sources).toEqual(['vector', 'lexical']);
    expect(res.items[0]!.breakdown.cosine).toBeGreaterThan(0.2);
  });

  it('scopes by project but keeps project-less items', async () => {
    const res = await svc.recall({ text: 'redis connection timeout', project: 'api', limit: 10 });
    const ids = res.items.map((r) => r.item.id);
    expect(ids).not.toContain('redis-other');
    expect(ids).toContain('global');
  });

  it('hot mode hides decayed items and warm mode shows them', async () => {
    const hot = await svc.recall({ text: 'redis connection timeout last year', limit: 10 });
    const warm = await svc.recall({ text: 'redis connection timeout last year', limit: 10, mode: 'warm' });
    expect(hot.items.map((r) => r.item.id)).not.toContain('old-redis');
    expect(warm.items.map((r) => r.item.id)).toContain('old-redis');
  });

  it('filters by item type', async () => {
    const res = await svc.recall({ text: 'redis connection pool size', types: ['fact'], limit: 10 });
    expect(res.items.map((r) => r.item.id)).toEqual(['fact']);
  });

  it('drops weak vector hits below the cosine threshold', async () => {
    const strict = new RecallService({
      postgres: pg.asStore(),
      qdrant: qd.asStore(),
      embedder: new HashEmbedder(),
      cosineThreshold: 0.99,
    });
    const res = await strict.recall({ text: 'kubernetes ingress controller' });
    expect(res.items).toHaveLength(0);
  });

  it('reactivates only the top results', async () => {
    const res = await svc.recall({ text: 'redis connection timeout', limit: 5 });
    const touched = new Set(pg.patches.map((p) => p.id));
    expect(touched.size).toBe(Math.min(3, res.items.length));
    for (const r of res.items.slice(0, touched.size)) expect(touched.has(r.item.id)).toBe(true);
    expect(pg.items.get(res.items[0]!.item.id)!.accessCount).toBe(1);
  });

  it('read-only recall does not touch items', async () => {
    await svc.recall({ text: 'redis connection timeout' }, { readOnly: true });
    expect(pg.patches).toHaveLength(0);
  });

  it('since/until filter on creation time', async () => {
    await pg.patchItem('global', { createdAt: new Date('2026-05-01T00:00:00Z') });
    const res = await svc.recall({ text: 'redis', since: new Date('2026-04-01T00:00:00Z'), limit: 10 }, { readOnly: true });
    expect(res.items.map((r) => r.item.id)).toEqual(['global']);
  });
});
