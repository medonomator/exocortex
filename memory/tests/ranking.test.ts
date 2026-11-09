import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, rank } from '../core/ranking.js';
import { makeItem } from '../testing/in-memory.js';

const items = ['a', 'b', 'c'].map((id) => makeItem({ id }));
const f = (...xs: number[]) => Float32Array.from(xs);

describe('rank (rrf)', () => {
  it('orders by a single signal', () => {
    const out = rank({
      candidates: items,
      signalScores: new Map([['vector', f(0.2, 0.9, 0.5)]]),
      weights: new Map([['vector', 1]]),
    });
    expect(out.map((r) => r.item.id)).toEqual(['b', 'c', 'a']);
    expect(out[0]!.score).toBeCloseTo(1 / 61);
  });

  it('fuses signals on rank, so a huge raw score cannot swamp the others', () => {
    const out = rank({
      candidates: items,
      signalScores: new Map([
        ['vector', f(0.9, 0.1, 0.5)],
        ['lexical', f(0.001, 500, 0)],
      ]),
      weights: new Map([['vector', 1], ['lexical', 1]]),
    });
    expect(out.map((r) => r.item.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]!.score).toBeCloseTo(0.5 / 61 + 0.5 / 62);
  });

  it('treats a zero score as non-participation', () => {
    const out = rank({
      candidates: items,
      signalScores: new Map([['lexical', f(0, 0, 3)]]),
      weights: new Map([['lexical', 1]]),
    });
    const byId = Object.fromEntries(out.map((r) => [r.item.id, r]));
    expect(byId.a!.score).toBe(0);
    expect(byId.c!.breakdown.lexical).toBeCloseTo(1 / 61);
  });

  it('normalizes weights and ignores zero-weight signals', () => {
    const out = rank({
      candidates: items,
      signalScores: new Map([
        ['vector', f(1, 0.5, 0.2)],
        ['recency', f(0.1, 0.2, 0.9)],
      ]),
      weights: new Map([['vector', 4], ['recency', 0]]),
    });
    expect(out.map((r) => r.item.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]!.breakdown.recency).toBeUndefined();
    expect(out[0]!.score).toBeCloseTo(1 / 61);
  });

  it('respects limit and rrfK', () => {
    const out = rank({
      candidates: items,
      signalScores: new Map([['vector', f(3, 2, 1)]]),
      weights: new Map([['vector', 1]]),
      rrfK: 0,
      limit: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.score).toBeCloseTo(1);
    expect(out[1]!.score).toBeCloseTo(0.5);
  });

  it('returns nothing for no candidates', () => {
    expect(rank({ candidates: [], signalScores: new Map(), weights: new Map() })).toEqual([]);
  });
});

describe('rank (weighted)', () => {
  it('min-max normalizes each signal before summing', () => {
    const out = rank({
      candidates: items,
      signalScores: new Map([
        ['vector', f(10, 20, 30)],
        ['importance', f(1, 0, 0.5)],
      ]),
      weights: new Map([['vector', 1], ['importance', 1]]),
      mode: 'weighted',
    });
    const byId = Object.fromEntries(out.map((r) => [r.item.id, r.score]));
    expect(byId.a).toBeCloseTo(0.5);
    expect(byId.b).toBeCloseTo(0.25);
    expect(byId.c).toBeCloseTo(0.75);
  });

  it('a constant signal contributes nothing', () => {
    const out = rank({
      candidates: items,
      signalScores: new Map([['importance', f(0.5, 0.5, 0.5)]]),
      weights: new Map([['importance', 1]]),
      mode: 'weighted',
    });
    expect(out.every((r) => r.score === 0)).toBe(true);
  });
});

describe('DEFAULT_WEIGHTS', () => {
  it('keeps the vector signal dominant and sums to 1', () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    const max = Math.max(...Object.values(DEFAULT_WEIGHTS));
    expect(DEFAULT_WEIGHTS.vector).toBe(max);
  });
});
