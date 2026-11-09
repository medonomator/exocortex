/**
 * Signal combination for recall.
 *
 * Two combination modes:
 *   - rrf: Reciprocal Rank Fusion. Robust when signals live in different
 *          scales (vector cosine vs tsvector rank vs 0..1 importance).
 *          No normalization required; weights act as per-signal multipliers.
 *   - weighted: plain weighted sum of min-max normalized signals. Easier to
 *               reason about per-signal contribution; sensitive to outliers.
 *
 * rrf is the default. weighted is for diagnosis and learning-to-rank labels.
 */

import type { MemoryItem, RankedItem } from './types.js';

export type RankMode = 'rrf' | 'weighted';

export interface RankInput {
  candidates: MemoryItem[];
  /** signalName → raw scores aligned with candidates. */
  signalScores: Map<string, Float32Array>;
  /** signalName → weight (positive; will be normalized to sum=1). */
  weights: Map<string, number>;
  mode?: RankMode;
  /** RRF constant; default 60 (classic paper value). */
  rrfK?: number;
  limit?: number;
}

export function rank(input: RankInput): RankedItem[] {
  const mode = input.mode ?? 'rrf';
  const weights = normalizeWeights(input.weights);
  const n = input.candidates.length;
  if (n === 0) return [];

  const combined = new Float32Array(n);
  const breakdown: Record<string, number>[] = Array.from({ length: n }, () => ({}));

  if (mode === 'rrf') {
    const k = input.rrfK ?? 60;
    for (const [signalName, raw] of input.signalScores.entries()) {
      const w = weights.get(signalName) ?? 0;
      if (w === 0) continue;
      const ranks = toRanks(raw);
      for (let i = 0; i < n; i++) {
        const r = ranks[i]!;
        const contribution = r > 0 ? w / (k + r) : 0;
        combined[i] = (combined[i] ?? 0) + contribution;
        breakdown[i]![signalName] = contribution;
      }
    }
  } else {
    for (const [signalName, raw] of input.signalScores.entries()) {
      const w = weights.get(signalName) ?? 0;
      if (w === 0) continue;
      const norm = minMaxNormalize(raw);
      for (let i = 0; i < n; i++) {
        const contribution = norm[i]! * w;
        combined[i] = (combined[i] ?? 0) + contribution;
        breakdown[i]![signalName] = contribution;
      }
    }
  }

  const ranked: RankedItem[] = input.candidates.map((item, i) => ({
    item,
    score: combined[i]!,
    breakdown: breakdown[i]!,
  }));
  ranked.sort((a, b) => b.score - a.score);
  return input.limit ? ranked.slice(0, input.limit) : ranked;
}

function normalizeWeights(weights: Map<string, number>): Map<string, number> {
  let total = 0;
  for (const v of weights.values()) total += Math.max(0, v);
  if (total === 0) return weights;
  const out = new Map<string, number>();
  for (const [k, v] of weights.entries()) out.set(k, Math.max(0, v) / total);
  return out;
}

/**
 * Return an array of ranks (1-based, with 0 meaning "did not participate").
 * Items with raw=0 are treated as non-participants - they get rank 0.
 * Ties take the average rank.
 */
function toRanks(raw: Float32Array): Int32Array {
  const n = raw.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => (raw[b]! - raw[a]!) || a - b);
  const ranks = new Int32Array(n);
  for (let pos = 0; pos < n; pos++) {
    const idx = indices[pos]!;
    if (raw[idx] === 0) {
      ranks[idx] = 0;
    } else {
      ranks[idx] = pos + 1;
    }
  }
  return ranks;
}

function minMaxNormalize(raw: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = new Float32Array(raw.length);
  if (max === min) return out;
  const range = max - min;
  for (let i = 0; i < raw.length; i++) out[i] = (raw[i]! - min) / range;
  return out;
}

/** Sensible default weights per recall mode. Callers can override via Query.weights.
 *
 * Weights rebalanced 2026-04-24 to prioritize semantic match over recency:
 * previous 0.45/0.15/0.15 split let recent-but-off-topic items bubble up on
 * queries with weak vector match. New balance keeps vector dominant so short
 * queries don't fall into "recent and important" fallback.
 */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  vector: 0.68,
  lexical: 0.15,
  recency: 0.05,
  importance: 0.05,
  emotion: 0.02,
  frequency: 0.03,
  'provenance-affinity': 0.02,
};
