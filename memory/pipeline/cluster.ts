/**
 * cluster pipeline stage.
 *
 * Groups related items (typically L0 episodes from a time window) into
 * candidate clusters for abstraction. Implementation: simple greedy
 * single-link clustering over cosine similarity of embeddings.
 *
 * Intentionally not using a fancy algorithm here - the signal is noisy and
 * an LLM step downstream cleans up. What matters is:
 *   1. Recall of genuinely related items (we over-cluster, then let the
 *      abstract step reject bad clusters by returning null)
 *   2. Determinism (so running consolidate twice on the same window gives
 *      the same clusters)
 */

import type { PipelineStage, StageContext, StageOutcome } from '../core/contracts.js';
import type { MemoryItem } from '../core/types.js';
import type { Embedder } from '../stores/embedder.js';

export interface ClusterStageOpts {
  /** Cosine similarity to be considered "same cluster". Default 0.78. */
  linkThreshold?: number;
  /** Min cluster size for abstraction. Default 3. */
  minClusterSize?: number;
  /** Max items to embed in a single consolidate run. Default 200. */
  maxItems?: number;
  /** Only cluster items at this level (0→1, 1→2, ...). Default 0. */
  sourceLevel?: 0 | 1 | 2;
}

export interface ClusterOutput {
  /** Index of member items (positions inside StageContext.items). */
  members: number[];
  /** Centroid vector (mean of member embeddings). */
  centroid: Float32Array;
}

export class ClusterStage implements PipelineStage {
  readonly name = 'cluster';
  readonly version = '1.0.0';

  constructor(
    private readonly embedder: Embedder,
    private readonly opts: ClusterStageOpts = {},
  ) {}

  async run(ctx: StageContext): Promise<StageOutcome> {
    const cfg = { ...this.opts, ...(ctx.config ?? {}) } as ClusterStageOpts;
    const threshold = cfg.linkThreshold ?? 0.78;
    const minSize = cfg.minClusterSize ?? 3;
    const maxItems = cfg.maxItems ?? 200;
    const sourceLevel = cfg.sourceLevel ?? 0;

    const eligible = ctx.items
      .filter((it) => it.level === sourceLevel && it.status === 'active')
      .slice(0, maxItems);

    if (eligible.length < minSize) {
      return { stage: this.name, items: ctx.items, stats: { clusters: 0 } };
    }

    const vectors = await this.embedder.embed(eligible.map((it) => it.raw.text));

    // Union-find over pairwise similarities.
    const parent = Array.from({ length: eligible.length }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x]! !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const sim = cosine(vectors[i]!, vectors[j]!);
        if (sim >= threshold) union(i, j);
      }
    }

    const groups = new Map<number, number[]>();
    for (let i = 0; i < eligible.length; i++) {
      const root = find(i);
      const arr = groups.get(root) ?? [];
      arr.push(i);
      groups.set(root, arr);
    }

    const clusters: ClusterOutput[] = [];
    for (const members of groups.values()) {
      if (members.length < minSize) continue;
      const dim = vectors[0]!.length;
      const centroid = new Float32Array(dim);
      for (const m of members) {
        const v = vectors[m]!;
        for (let d = 0; d < dim; d++) centroid[d] = (centroid[d] ?? 0) + v[d]!;
      }
      for (let d = 0; d < dim; d++) centroid[d] = (centroid[d] ?? 0) / members.length;
      clusters.push({ members, centroid });
    }

    // Carry clusters forward via StageOutcome.stats side-channel in metadata.
    // Downstream AbstractStage reads from a shared clusters map.
    clustersByStageRun.set(ctx.now.getTime(), { eligible, clusters });

    return {
      stage: this.name,
      items: ctx.items,
      stats: { clusters: clusters.length, clusteredItems: clusters.reduce((a, c) => a + c.members.length, 0) },
    };
  }
}

/**
 * Side-channel for passing clusters to the next stage. Keyed by ctx.now (ms).
 * A cleaner design would thread a context bag through Pipeline; we'll add
 * that if/when a second cross-stage payload appears.
 */
export const clustersByStageRun = new Map<
  number,
  { eligible: MemoryItem[]; clusters: ClusterOutput[] }
>();

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  return dot / Math.max(1e-9, Math.sqrt(na) * Math.sqrt(nb));
}
