import { describe, expect, it } from 'vitest';
import type { SignalContext } from '../core/contracts.js';
import type { MemoryItem } from '../core/types.js';
import {
  EmotionSignal,
  FrequencySignal,
  ImportanceSignal,
  LexicalSignal,
  ProvenanceAffinitySignal,
  RecencySignal,
  VectorSignal,
} from '../signals/index.js';
import { makeItem } from '../testing/in-memory.js';

const now = new Date('2026-03-10T00:00:00Z');
const ctx = (candidates: MemoryItem[]): SignalContext => ({ query: { text: 'q' }, candidates, now });
const arr = (x: Float32Array) => Array.from(x);

describe('signals', () => {
  it('vector and lexical pass through side-channel scores in candidate order', async () => {
    const cands = [makeItem({ id: 'x' }), makeItem({ id: 'y' })];
    const scores = new Map([['y', 0.75]]);
    expect(arr(await new VectorSignal(scores).score(ctx(cands)))).toEqual([0, 0.75]);
    expect(arr(await new LexicalSignal(scores).score(ctx(cands)))).toEqual([0, 0.75]);
  });

  it('recency prefers recently touched items', async () => {
    const fresh = makeItem({ id: 'f', lastAccessedAt: now });
    const stale = makeItem({ id: 's', lastAccessedAt: new Date('2026-01-01T00:00:00Z') });
    const [a, b] = await new RecencySignal().score(ctx([fresh, stale]));
    expect(a).toBe(1);
    expect(b!).toBeLessThan(0.01);
  });

  it('importance is a passthrough', async () => {
    const out = await new ImportanceSignal().score(ctx([makeItem({ id: 'a', importance: 0.9 })]));
    expect(out[0]).toBeCloseTo(0.9);
  });

  it('frequency is log-scaled and normalized by the batch max', async () => {
    const out = arr(await new FrequencySignal().score(ctx([
      makeItem({ id: 'a', accessCount: 0 }),
      makeItem({ id: 'b', accessCount: 3 }),
      makeItem({ id: 'c', accessCount: 15 }),
    ])));
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(Math.log1p(3) / Math.log1p(15));
    expect(out[2]).toBe(1);
  });

  it('frequency is all zeros when nothing was accessed', async () => {
    const out = arr(await new FrequencySignal().score(ctx([makeItem({ id: 'a' })])));
    expect(out).toEqual([0]);
  });

  it('emotion scores arousal times absolute valence', async () => {
    const out = arr(await new EmotionSignal().score(ctx([
      makeItem({ id: 'a' }),
      makeItem({ id: 'b', emotion: { valence: -0.8, arousal: 0.5 } }),
    ])));
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.4);
  });

  it('provenance affinity is a no-op without preferences', async () => {
    const out = arr(await new ProvenanceAffinitySignal().score(ctx([makeItem({ id: 'a' })])));
    expect(out).toEqual([0]);
  });

  it('provenance affinity scores the fraction of matching preferences', async () => {
    const hook = makeItem({ id: 'h', provenance: { source: 'hook', agentId: 'git', producedAt: now, chain: [] } });
    const manual = makeItem({ id: 'm', provenance: { source: 'manual', agentId: 'git', producedAt: now, chain: [] } });
    const sig = new ProvenanceAffinitySignal({ preferSource: 'hook', preferAgent: 'git', strength: 0.5 });
    const out = arr(await sig.score(ctx([hook, manual])));
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.25);
  });
});
