/**
 * Fact: declarative knowledge about an entity ("X is Y", "X has property Z").
 * Semantic memory, typically promoted from repeated episodic observations.
 */

export interface FactPayload {
  /** Entity this fact is about. */
  subject: string;
  /** Entity type ('person', 'project', 'concept', 'tool', ...). */
  subjectType?: string;
  /** The fact text ("is written in TypeScript", "depends on Postgres 15+"). */
  statement: string;
  /** Normalized predicate if extractable ("has_language", "depends_on"). */
  predicate?: string;
  /** Optional structured value. */
  object?: unknown;
  project?: string;
  tags?: string[];
}
