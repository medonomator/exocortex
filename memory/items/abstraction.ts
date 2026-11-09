/**
 * Abstraction: summary item produced by clustering lower-level items.
 * Abstraction ladder:
 *   L1 = pattern across episodes
 *   L2 = theme across patterns
 *   L3 = identity-level fact / principle
 *
 * Children live in `provenance.derivedFrom`; this payload just holds the
 * summary semantics.
 */

export interface AbstractionPayload {
  /** Short title for the abstraction. */
  title: string;
  /** The summary itself, natural language. */
  summary: string;
  /** How many children this abstraction was built from. */
  childCount: number;
  /** Cluster cohesion score from the clusterer that produced it (0..1). */
  cohesion?: number;
  /** Dominant tags across children. */
  tags?: string[];
  project?: string;
}
