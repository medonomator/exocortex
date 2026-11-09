import { beforeEach, describe, expect, it } from 'vitest';
import {
  ContradictionArchivePolicy,
  CorePromotionPolicy,
  DecayEbbinghausPolicy,
  DuplicateGcPolicy,
  ExplicitTombstonePolicy,
} from '../policies/index.js';
import {
  HashEmbedder,
  InMemoryPostgres,
  InMemoryQdrant,
  makeItem,
  seed,
} from '../testing/in-memory.js';

const DAY = 86_400_000;
const now = new Date('2026-06-01T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);

let pg: InMemoryPostgres;

beforeEach(() => {
  pg = new InMemoryPostgres();
});

describe('DecayEbbinghausPolicy', () => {
  beforeEach(async () => {
    await pg.upsertItem(makeItem({ id: 'fresh', conf: { alpha: 2, beta: 1 }, stability: 7, lastAccessedAt: daysAgo(3) }));
    await pg.upsertItem(makeItem({ id: 'fading', conf: { alpha: 2, beta: 1 }, stability: 30, lastAccessedAt: daysAgo(40) }));
    await pg.upsertItem(makeItem({ id: 'gone', conf: { alpha: 2, beta: 1 }, stability: 7, lastAccessedAt: daysAgo(60) }));
  });

  it('moves idle items to decayed or archived by effective strength', async () => {
    const out = await new DecayEbbinghausPolicy(pg.asStore()).apply({ now });
    expect(out.itemsScanned).toBe(3);
    expect(out.transitions).toEqual({ decayed: 1, archived: 1 });
    expect(pg.items.get('fresh')!.status).toBe('active');
    expect(pg.items.get('fading')!.status).toBe('decayed');
    expect(pg.items.get('gone')!.status).toBe('archived');
    expect(pg.forgettingLog.map((l) => [l.itemId, l.to])).toEqual([['fading', 'decayed'], ['gone', 'archived']]);
  });

  it('never rewrites confidence', async () => {
    await new DecayEbbinghausPolicy(pg.asStore()).apply({ now });
    expect(pg.patches.every((p) => p.patch.conf === undefined)).toBe(true);
  });

  it('is idempotent', async () => {
    const policy = new DecayEbbinghausPolicy(pg.asStore());
    await policy.apply({ now });
    const second = await policy.apply({ now });
    expect(second.itemsAffected).toBe(0);
  });

  it('dry run reports without writing', async () => {
    const out = await new DecayEbbinghausPolicy(pg.asStore()).apply({ now, dryRun: true });
    expect(out.itemsAffected).toBe(2);
    expect(pg.patches).toHaveLength(0);
    expect(pg.forgettingLog).toHaveLength(0);
  });
});

describe('ContradictionArchivePolicy', () => {
  it('archives items whose evidence is mostly against them', async () => {
    await pg.upsertItem(makeItem({ id: 'rejected', conf: { alpha: 1, beta: 6 } }));
    await pg.upsertItem(makeItem({ id: 'noisy', conf: { alpha: 1, beta: 2 } }));
    await pg.upsertItem(makeItem({ id: 'trusted', conf: { alpha: 9, beta: 3 } }));

    const out = await new ContradictionArchivePolicy(pg.asStore()).apply({ now });

    expect(out.itemsAffected).toBe(1);
    expect(pg.items.get('rejected')!.status).toBe('archived');
    expect(pg.items.get('noisy')!.status).toBe('active');
    expect(pg.items.get('trusted')!.status).toBe('active');
  });

  it('thresholds are configurable per run', async () => {
    await pg.upsertItem(makeItem({ id: 'noisy', conf: { alpha: 1, beta: 2 } }));
    const out = await new ContradictionArchivePolicy(pg.asStore()).apply({
      now,
      config: { minStrength: 1, minBetaAlphaRatio: 2 },
    });
    expect(out.itemsAffected).toBe(1);
  });
});

describe('CorePromotionPolicy', () => {
  it('promotes well-evidenced, frequently recalled items', async () => {
    await pg.upsertItem(makeItem({
      id: 'core',
      status: 'decayed',
      conf: { alpha: 30, beta: 2 },
      accessCount: 12,
      importance: 0.8,
      stability: 20,
    }));
    await pg.upsertItem(makeItem({ id: 'rarely-used', conf: { alpha: 30, beta: 2 }, accessCount: 2, importance: 0.8 }));

    const out = await new CorePromotionPolicy(pg.asStore()).apply({ now });
    const core = pg.items.get('core')!;

    expect(out.itemsAffected).toBe(1);
    expect(out.transitions).toEqual({ active: 1 });
    expect(core.status).toBe('active');
    expect(core.stability).toBe(180);
    expect(core.level).toBe(1);
    expect(pg.items.get('rarely-used')!.level).toBe(0);
  });

  it('stops at the max level', async () => {
    await pg.upsertItem(makeItem({
      id: 'top',
      level: 3,
      conf: { alpha: 30, beta: 2 },
      accessCount: 20,
      importance: 0.9,
      stability: 365,
    }));
    const out = await new CorePromotionPolicy(pg.asStore()).apply({ now });
    expect(out.itemsAffected).toBe(0);
  });
});

describe('ExplicitTombstonePolicy', () => {
  it('tombstones only user-marked items', async () => {
    await pg.upsertItem(makeItem({ id: 'marked', metadata: { tombstone: true } }));
    await pg.upsertItem(makeItem({ id: 'kept' }));

    const out = await new ExplicitTombstonePolicy(pg.asStore()).apply({ now });

    expect(out.transitions).toEqual({ tombstoned: 1 });
    expect(pg.items.get('marked')!.status).toBe('tombstoned');
    expect(pg.items.get('kept')!.status).toBe('active');
  });
});

describe('DuplicateGcPolicy', () => {
  it('merges the weaker duplicate into the stronger one', async () => {
    const qd = new InMemoryQdrant();
    const embedder = new HashEmbedder();
    await seed(pg, qd, embedder, [
      makeItem({ id: 'strong', raw: { text: 'Use pgvector HNSW index for embeddings', contentType: 'text/plain' }, conf: { alpha: 5, beta: 1 }, accessCount: 4, importance: 0.4 }),
      makeItem({ id: 'weak', raw: { text: 'Use pgvector HNSW index for embeddings!', contentType: 'text/plain' }, conf: { alpha: 2, beta: 1 }, accessCount: 1, importance: 0.9 }),
      makeItem({ id: 'other', raw: { text: 'Telegram bot sends the morning briefing', contentType: 'text/plain' } }),
    ]);

    const out = await new DuplicateGcPolicy(pg.asStore(), qd.asStore(), embedder).apply({ now });
    const strong = pg.items.get('strong')!;

    expect(out.itemsAffected).toBe(1);
    expect(pg.items.get('weak')!.status).toBe('archived');
    expect(pg.items.get('other')!.status).toBe('active');
    expect(strong.conf).toEqual({ alpha: 6, beta: 1 });
    expect(strong.accessCount).toBe(5);
    expect(strong.importance).toBe(0.9);
    expect(pg.lineage).toEqual([{ parentId: 'strong', childId: 'weak', relation: 'merged' }]);
    expect(qd.points.has('weak')).toBe(false);
  });
});
