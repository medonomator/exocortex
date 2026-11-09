/**
 * Relation: typed link between two entities.
 * Represents graph edges extracted from episodes.
 */

export interface RelationPayload {
  /** Source entity name. */
  from: string;
  /** Target entity name. */
  to: string;
  /** Relation type ('depends_on', 'caused_by', 'part_of', 'decided', 'mentions'). */
  relationType: string;
  /** Optional human-readable explanation. */
  description?: string;
  project?: string;
  tags?: string[];
}
