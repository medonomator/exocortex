/**
 * The Memory facade - five primitive operations.
 *
 * This is the only surface consumers should use. Internal services
 * (IngestService, RecallService, etc.) are wired into a Memory instance
 * at bootstrap; callers never see them directly.
 */

import type {
  MemoryEvent,
  Query,
  RecallResult,
  IngestResult,
  ConsolidateResult,
  ForgetPolicy,
  ForgetResult,
  TimeRange,
  MemoryItem,
} from './types.js';

export interface MemoryIntrospect {
  health(): Promise<MemoryHealth>;
  getItem(id: string): Promise<MemoryItem | null>;
  exportForFineTuning(opts: ExportOpts): Promise<{ train: string; eval: string }>;
  exportEmbeddings(opts: ExportEmbeddingsOpts): Promise<Buffer>;
  timeSeries(query: Query, bucket: 'day' | 'week' | 'month'): Promise<TimeSeriesPoint[]>;
}

export interface MemoryHealth {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byLevel: Record<string, number>;
  avgConfidence: number;
  oldestAccess: Date | null;
  newestAccess: Date | null;
  contradictions: number;
  trainingEligible: number;
  driftScore?: number;
  generatedAt: Date;
}

export interface ExportOpts {
  format: 'openai-chat' | 'alpaca' | 'sharegpt' | 'dpo-pairs';
  filter?: {
    minImportance?: number;
    minStability?: number;
    onlyApproved?: boolean;
    since?: Date;
  };
  splitRatio?: { train: number; eval: number };
}

export interface ExportEmbeddingsOpts {
  format: 'csv' | 'jsonl' | 'npy';
  filter?: { types?: string[]; since?: Date };
}

export interface TimeSeriesPoint {
  bucket: Date;
  count: number;
  avgConfidence: number;
  avgImportance: number;
}

/**
 * The facade. Five operations - nothing else.
 */
export interface Memory {
  /**
   * Accept a new event. The system decides what (if anything) becomes a
   * persisted MemoryItem based on novelty / dedupe / consolidate rules.
   */
  ingest(event: MemoryEvent): Promise<IngestResult>;

  /**
   * Retrieve relevant items for a query. Ranking is multi-signal and the
   * result includes per-signal breakdown for observability.
   */
  recall(query: Query): Promise<RecallResult>;

  /**
   * Batch consolidate events into higher-level items. Typically invoked by
   * a nightly cron with a day-wide window; can be run ad-hoc.
   */
  consolidate(window?: TimeRange): Promise<ConsolidateResult>;

  /**
   * Apply a lifecycle policy (decay, archive, promote, GC).
   * Safe to run repeatedly: policies are idempotent.
   */
  forget(policy: ForgetPolicy): Promise<ForgetResult>;

  /**
   * Meta operations: health, export for ML, time series, etc.
   */
  introspect(): MemoryIntrospect;
}
