import { strict as assert } from 'node:assert';
import { it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MemoryEvent } from '../core/types.js';
import { IngestService } from '../services/ingest.js';
import { HashEmbedder, InMemoryPostgres, InMemoryQdrant } from '../testing/in-memory.js';

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
  const pg = new InMemoryPostgres();
  const qd = new InMemoryQdrant();
  const embedder = new HashEmbedder();

  const ingest = new IngestService({
    postgres: pg.asStore(),
    qdrant: qd.asStore(),
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

  const reinforced = pg.items.get(first.itemId!)!;
  assert.ok(reinforced.accessCount >= 1, 'accessCount should increase');
  assert.ok(reinforced.conf.alpha > 1, 'alpha should increase on reinforce');
}

it('ingest dedupes near-duplicates and reinforces the existing item', runSmokeTest);
