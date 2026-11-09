import { describe, expect, it } from 'vitest';
import { mrrAt, ndcgAt, recallAt } from './metrics.js';

describe('retrieval metrics', () => {
  const grades = { a: 2, b: 1 };

  it('recall@k counts relevant items in the top k', () => {
    expect(recallAt(['x', 'a', 'y'], grades, 2)).toBe(0.5);
    expect(recallAt(['b', 'a'], grades, 2)).toBe(1);
    expect(recallAt(['a'], {}, 5)).toBe(0);
  });

  it('mrr uses the first relevant hit', () => {
    expect(mrrAt(['x', 'y', 'b'], grades, 10)).toBeCloseTo(1 / 3);
    expect(mrrAt(['x', 'y', 'b'], grades, 2)).toBe(0);
  });

  it('ndcg is 1 for the ideal order and lower otherwise', () => {
    expect(ndcgAt(['a', 'b', 'x'], grades, 10)).toBeCloseTo(1);
    const swapped = ndcgAt(['b', 'a'], grades, 10);
    expect(swapped).toBeLessThan(1);
    expect(swapped).toBeCloseTo((1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3)));
    expect(ndcgAt(['x'], grades, 10)).toBe(0);
  });
});
