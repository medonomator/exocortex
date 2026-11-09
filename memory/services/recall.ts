/**
 * RecallService - hybrid retrieval + multi-signal ranking.
 *
 * Flow:
 *   1. Candidate seeding from multiple sources, fanned in parallel:
 *        - Qdrant dense search (top K_vector)
 *        - Postgres tsvector lexical search (top K_lex)
 *        - (Optional) recency tail: most recently accessed items matching filters
 *   2. Dedup by id; enrich with full MemoryItem via Postgres.
 *   3. Signals compute per-candidate scores; ranker fuses.
 *   4. Reactivate top-N: patch stability/lastAccessedAt/accessCount.
 *      Only top-N (not all candidates) - we reward actual recall, not mere consideration.
 */

import type {
  MemoryItem,
  Query,
  RecallResult,
  RankedItem,
  LifecycleStatus,
} from '../core/types.js';
import type { Signal } from '../core/contracts.js';
import { PluginRegistry } from '../core/registry.js';
import { rank, DEFAULT_WEIGHTS, type RankMode } from '../core/ranking.js';
import { reactivate } from '../core/decay.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { QdrantStore } from '../stores/qdrant.js';
import type { Embedder } from '../stores/embedder.js';
import { VectorSignal } from '../signals/vector.js';
import { LexicalSignal } from '../signals/lexical.js';
import { RecencySignal } from '../signals/recency.js';
import { ImportanceSignal } from '../signals/importance.js';
import { EmotionSignal } from '../signals/emotion.js';
import { FrequencySignal } from '../signals/frequency.js';
import {
  ProvenanceAffinitySignal,
  type ProvenanceAffinityPrefs,
} from '../signals/provenance-affinity.js';

export interface RecallServiceOpts {
  postgres: PostgresStore;
  qdrant: QdrantStore;
  embedder: Embedder;
  /**
   * Optional registry of non-builtin signals. The 7 builtins are attached
   * automatically; registry entries with the same name override them.
   */
  registry?: PluginRegistry<Signal>;
  /** Default rank mode. Defaults to 'rrf'. */
  rankMode?: RankMode;
  /** Default reactivate-on-recall. Defaults to true. */
  reactivateOnRecall?: boolean;
  /** Default number of top-N to reactivate. Defaults to min(3, limit). */
  reactivateTopN?: number;
  /** Default provenance-affinity preferences. */
  defaultProvenancePrefs?: ProvenanceAffinityPrefs;
  /** Default vector-search fan-out. */
  vectorTopK?: number;
  /** Default lexical-search fan-out. */
  lexicalTopK?: number;
  /**
   * Minimum cosine similarity from Qdrant to treat a vector hit as a valid
   * candidate. Hits below this score are dropped at seed time so they cannot
   * be revived by recency/importance/etc. Set to 0 to disable. Default 0.30.
   */
  cosineThreshold?: number;
}

export interface RecallOpts {
  /** Per-query provenance preference override. */
  provenancePrefs?: ProvenanceAffinityPrefs;
  /** Force a specific rank mode for this query. */
  rankMode?: RankMode;
  /** Skip reactivation for this query (e.g. introspection reads). */
  readOnly?: boolean;
}

export class RecallService {
  private readonly pg: PostgresStore;
  private readonly qd: QdrantStore;
  private readonly embedder: Embedder;
  private readonly registry: PluginRegistry<Signal>;
  private readonly rankMode: RankMode;
  private readonly reactivateDefault: boolean;
  private readonly reactivateTopN?: number;
  private readonly defaultProvenancePrefs?: ProvenanceAffinityPrefs;
  private readonly vectorTopK: number;
  private readonly lexicalTopK: number;
  private readonly cosineThreshold: number;

  constructor(opts: RecallServiceOpts) {
    this.pg = opts.postgres;
    this.qd = opts.qdrant;
    this.embedder = opts.embedder;
    this.registry = opts.registry ?? new PluginRegistry<Signal>('signal');
    this.rankMode = opts.rankMode ?? 'rrf';
    this.reactivateDefault = opts.reactivateOnRecall ?? true;
    this.reactivateTopN = opts.reactivateTopN;
    this.defaultProvenancePrefs = opts.defaultProvenancePrefs;
    this.vectorTopK = opts.vectorTopK ?? 50;
    this.lexicalTopK = opts.lexicalTopK ?? 50;
    this.cosineThreshold = opts.cosineThreshold ?? 0.30;
  }

  async recall(query: Query, opts: RecallOpts = {}): Promise<RecallResult> {
    const started = Date.now();
    const limit = query.limit ?? 10;
    const mode = query.mode ?? 'hot';
    const statuses = statusesForMode(mode);
    const sources: string[] = [];

    // 1. Dense seed
    const [vec] = await this.embedder.embed([query.text]);
    if (!vec) throw new Error('Embedder returned no vector');

    const vectorHitsRaw = await this.qd.search(vec, {
      limit: this.vectorTopK,
      filter: {
        model: this.embedder.model,
        statuses,
        project: query.project,
        types: query.types,
      },
    });
    // Cosine threshold: drop hits that Qdrant returned as "nearest neighbors"
    // but which are not semantically close enough to count as real candidates.
    // Without this, weak vector hits are revived by recency/importance signals
    // and the top-K fills with "recent but off-topic" items on any query that
    // has no strong semantic match in the store.
    const vectorHits = this.cosineThreshold > 0
      ? vectorHitsRaw.filter((h) => h.score >= this.cosineThreshold)
      : vectorHitsRaw;
    if (vectorHits.length) sources.push('vector');
    const vectorScoreById = new Map<string, number>();
    for (const h of vectorHits) vectorScoreById.set(h.id, h.score);

    // 2. Lexical seed
    // Project filter mirrors the Qdrant seed above so one retrieval arm
    // can't revive items the other correctly scoped out. Null-project
    // (legacy) items still pass through on both sides.
    const lexHits = await this.pg.lexicalSearch(query.text, this.lexicalTopK, {
      includeDecayed: mode !== 'hot',
      includeArchived: mode === 'cold' || mode === 'all',
      project: query.project,
    });
    if (lexHits.length) sources.push('lexical');
    const lexScoreById = new Map<string, number>();
    for (const h of lexHits) lexScoreById.set(h.id, h.score);

    // 3. Dedup + enrich
    const ids = new Set<string>([
      ...vectorScoreById.keys(),
      ...lexScoreById.keys(),
    ]);
    const candidates = (
      await Promise.all([...ids].map((id) => this.pg.getItem(id, { includeCompat: true })))
    ).filter(isItem);

    if (candidates.length === 0) {
      return {
        items: [],
        candidateCount: 0,
        elapsedMs: Date.now() - started,
        sources,
      };
    }

    // Query-time filters that we couldn't push down trivially.
    // since/until target createdAt (not lastAccessedAt) because "items from
    // yesterday" naturally means "items created yesterday". Using
    // lastAccessedAt would let any recently-reinforced old item leak through.
    const filtered = candidates.filter((c) => {
      if (query.types && !query.types.includes(c.type)) return false;
      if (query.levels && !query.levels.includes(c.level)) return false;
      if (query.since && c.createdAt < query.since) return false;
      if (query.until && c.createdAt > query.until) return false;
      return true;
    });

    // 4. Build signals (builtins + registry overrides)
    const provPrefs = opts.provenancePrefs ?? this.defaultProvenancePrefs ?? {};
    const signals: Signal[] = [
      this.registry.tryGet('vector') ?? new VectorSignal(vectorScoreById),
      this.registry.tryGet('lexical') ?? new LexicalSignal(lexScoreById),
      this.registry.tryGet('recency') ?? new RecencySignal(),
      this.registry.tryGet('importance') ?? new ImportanceSignal(),
      this.registry.tryGet('emotion') ?? new EmotionSignal(),
      this.registry.tryGet('frequency') ?? new FrequencySignal(),
      this.registry.tryGet('provenance-affinity') ??
        new ProvenanceAffinitySignal(provPrefs),
    ];

    const now = new Date();
    const signalScores = new Map<string, Float32Array>();
    await Promise.all(
      signals.map(async (s) => {
        const scores = await s.score({ query, candidates: filtered, now });
        signalScores.set(s.name, scores);
      }),
    );

    // 5. Rank
    const weights = new Map(Object.entries({ ...DEFAULT_WEIGHTS, ...(query.weights ?? {}) }));
    const ranked = rank({
      candidates: filtered,
      signalScores,
      weights,
      mode: opts.rankMode ?? this.rankMode,
      limit,
    });

    // Annotate breakdown with raw retrieval scores so consumers (hooks, UIs)
    // can display interpretable numbers instead of the RRF-squashed `score`
    // which ceilings at ~1/(k+1) ≈ 0.016 for the default k=60.
    for (const r of ranked) {
      const cos = vectorScoreById.get(r.item.id);
      if (cos !== undefined) r.breakdown.cosine = cos;
      const lex = lexScoreById.get(r.item.id);
      if (lex !== undefined) r.breakdown.lexical_raw = lex;
    }

    // 6. Reactivate top-N
    const reactivateEnabled = !opts.readOnly && this.reactivateDefault;
    if (reactivateEnabled && ranked.length > 0) {
      const topN = Math.min(this.reactivateTopN ?? 3, ranked.length);
      await Promise.all(
        ranked.slice(0, topN).map(async (r) => {
          const patch = reactivate(r.item, now);
          await this.pg.patchItem(r.item.id, patch);
        }),
      );
    }

    return {
      items: ranked,
      candidateCount: filtered.length,
      elapsedMs: Date.now() - started,
      sources,
    };
  }
}

function statusesForMode(
  mode: NonNullable<Query['mode']>,
): LifecycleStatus[] {
  switch (mode) {
    case 'hot':
      return ['active'];
    case 'warm':
      return ['active', 'decayed'];
    case 'cold':
      return ['active', 'decayed', 'archived'];
    case 'all':
      return ['active', 'decayed', 'archived', 'tombstoned'];
  }
}

function isItem(x: MemoryItem | null): x is MemoryItem {
  return x !== null;
}

// For callers constructing `RankedItem` arrays elsewhere, re-export.
export type { RankedItem };
