/**
 * Core types for @exocortex/memory
 *
 * Five fundamental abstractions:
 * 1. MemoryEvent  - atomic input
 * 2. MemoryItem   - universal stored cell
 * 3. Provenance   - first-class origin metadata with causal lineage
 * 4. Query        - recall request
 * 5. Confidence   - Beta distribution (not scalar)
 *
 * All stored memory goes through MemoryItem<T>. Items are distinguished by the
 * `type` discriminator and their type-specific `payload`.
 */

/**
 * Confidence represented as a Beta distribution.
 * alpha = successes/confirmations + 1
 * beta  = failures/contradictions + 1
 *
 * Point estimate: alpha / (alpha + beta)
 * Variance:       alpha*beta / ((alpha+beta)^2 * (alpha+beta+1))
 */
export interface Confidence {
  alpha: number; // >= 1, monotonically non-decreasing (only grows via reinforce)
  beta: number; // >= 1, monotonically non-decreasing (only grows via contradict)
}

export interface Emotion {
  valence: number; // -1 (negative) .. 1 (positive)
  arousal: number; // 0 (calm) .. 1 (excited)
}

export type ProvenanceSource =
  | 'claude-session'
  | 'swarm'
  | 'observer'
  | 'manual'
  | 'evolve'
  | 'curiosity'
  | 'consolidate'
  | 'external'
  | 'hook';

export interface Provenance {
  /** Where this event/item originally came from. */
  source: ProvenanceSource;

  /** Session that produced this (if applicable). */
  sessionId?: string;

  /** Agent (swarm agent, cron job name, hook name). */
  agentId?: string;

  /** When the producing event actually happened. May differ from storage time. */
  producedAt: Date;

  /**
   * IDs of other MemoryItems that this was derived from.
   * Enables causal lineage: "which episodes produced this abstraction",
   * "which observations contradicted that fact", etc.
   */
  derivedFrom?: string[];

  /**
   * Pipeline stages this passed through, for observability.
   * e.g. ['extract', 'embed', 'cluster', 'consolidate']
   */
  chain: string[];

  /**
   * Model that produced this item (LLM or embedder).
   * e.g. 'claude-opus-4-7', 'text-embedding-3-small'
   */
  model?: string;

  /** Optional free-form metadata for source-specific context. */
  extra?: Record<string, unknown>;
}

export interface RawContent {
  text: string;
  contentType: string; // 'text/plain' | 'text/markdown' | 'application/json' | ...
  sourceUri?: string;
}

export type EventKind =
  | 'session-turn'
  | 'observation'
  | 'error'
  | 'commit'
  | 'message'
  | 'manual'
  | 'summary';

export interface MemoryEvent {
  id: string;
  kind: EventKind;
  content: RawContent;
  /** Actors involved (user ids, agent names). */
  actors?: string[];
  /** Logical timestamp of the event (not storage time). */
  timestamp: Date;
  /** Original raw payload as received. Kept for audit / reprocessing. */
  raw: unknown;
  provenance: Provenance;
}

export type LifecycleStatus =
  /** Freshly relevant; participates in hot-path recall. */
  | 'active'
  /** Decayed in stability; still indexed but down-weighted in ranking. */
  | 'decayed'
  /** Archived; excluded from hot-path recall, retrievable via cold mode. */
  | 'archived'
  /** Tombstoned; kept only as an audit record that it existed. */
  | 'tombstoned';

/** Abstraction ladder levels. */
export type AbstractionLevel =
  /** Raw event / episode. */
  | 0
  /** Clustered episodes sharing a pattern. */
  | 1
  /** Topic / theme spanning multiple L1 patterns. */
  | 2
  /** Identity-level fact (persistent trait, preference, principle). */
  | 3;

/** Discriminator for payload shape. */
export type ItemType =
  | 'episode' // a time-stamped event or observation
  | 'fact' // declarative knowledge ("X is Y")
  | 'relation' // link between two entities ("X depends_on Y")
  | 'procedure' // "when X happens, do Y" pattern
  | 'abstraction'; // summary over a cluster of lower-level items

/**
 * The universal memory cell. All long-term memory uses this shape.
 *
 * Type-specific data lives in `payload`; see items/*.ts for per-type payload
 * shapes. The rest of the fields are universal (lifecycle, confidence,
 * provenance, etc.) so that every policy, signal, and pipeline stage can
 * operate on any item regardless of type.
 */
export interface MemoryItem<T = unknown> {
  id: string;
  type: ItemType;
  payload: T;

  /**
   * Original text that produced this item. Always preserved so we can
   * re-embed on model change, re-parse on schema upgrade, or send to a
   * different LLM for re-summarization.
   */
  raw: RawContent;

  status: LifecycleStatus;
  level: AbstractionLevel;
  createdAt: Date;
  updatedAt: Date;
  /** Last time this item was surfaced in recall or reinforced. */
  lastAccessedAt: Date;

  conf: Confidence;

  /**
   * Ebbinghaus stability - days until half-life of this memory.
   * Grows with reactivation (spacing effect); shrinks on contradiction.
   */
  stability: number;

  /** 0..1; how important this item is regardless of recency. */
  importance: number;
  emotion?: Emotion;
  /** Count of hits across recall + reinforce. */
  accessCount: number;

  provenance: Provenance;

  /** User explicitly approved this item (thumbs up). */
  humanApproved?: boolean;
  /** User correction - stored for DPO training pairs. */
  humanCorrected?: string;
  /** True iff this item is eligible for inclusion in fine-tune datasets. */
  trainingEligible: boolean;

  /** Non-schema-critical context (project, tags, tokens spent, etc.). */
  metadata: Record<string, unknown>;
}

export type RecallMode =
  /** Active items only (default). */
  | 'hot'
  /** Active + decayed. */
  | 'warm'
  /** Active + decayed + archived. */
  | 'cold'
  /** All including tombstones (audit). */
  | 'all';

export interface Query {
  /** Free-form text query. May be embedded for vector search. */
  text: string;

  /** Restrict to specific item types. */
  types?: ItemType[];

  /** Restrict to specific abstraction levels. */
  levels?: AbstractionLevel[];

  /** Project/scope filter. */
  project?: string;

  /** Time window filter. */
  since?: Date;
  until?: Date;

  /** Max results. */
  limit?: number;

  /** Recall depth. */
  mode?: RecallMode;

  /** Override ranking weights for this query (name → weight, must sum to 1). */
  weights?: Record<string, number>;
}

export interface RankedItem<T = unknown> {
  item: MemoryItem<T>;
  /** Final combined score, [0, 1]. */
  score: number;
  /** Per-signal contribution for observability / future learning-to-rank. */
  breakdown: Record<string, number>;
}

export interface RecallResult {
  items: RankedItem[];
  /** Candidates considered before ranking. */
  candidateCount: number;
  /** Milliseconds spent on this recall. */
  elapsedMs: number;
  /** Which retrieval sources actually contributed. */
  sources: string[];
}

export interface IngestResult {
  /** Item created or updated as a result of this event. May be null if the event was deduplicated. */
  itemId: string | null;
  action: 'created' | 'reinforced' | 'skipped' | 'archived';
  noveltyScore?: number;
}

export interface ConsolidateResult {
  processedEvents: number;
  itemsCreated: number;
  itemsReinforced: number;
  itemsArchived: number;
  abstractionsPromoted: number;
  elapsedMs: number;
}

export type ForgetPolicyName =
  | 'decay-ebbinghaus'
  | 'contradiction-archive'
  | 'core-promotion'
  | 'explicit-tombstone'
  | 'duplicate-gc';

export interface ForgetPolicy {
  name: ForgetPolicyName;
  /** Policy-specific config. */
  config?: Record<string, unknown>;
}

export interface ForgetResult {
  policy: ForgetPolicyName;
  itemsAffected: number;
  itemsArchived: number;
  itemsTombstoned: number;
  elapsedMs: number;
}

export interface TimeRange {
  from: Date;
  to: Date;
}
