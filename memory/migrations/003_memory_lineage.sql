-- Migration 003: mem_lineage
--
-- Explicit derivedFrom edges between items. Duplicates what's in
-- provenance.derivedFrom JSONB, but materialized for efficient graph
-- traversal ("what did this abstraction come from", "what items descended
-- from this episode").
--
-- Populated automatically by ingest / consolidate services.

CREATE TABLE IF NOT EXISTS mem_lineage (
  parent_id   UUID NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
  child_id    UUID NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
  /** Optional relation label: 'derived', 'consolidated', 'contradicted', 'reinforced'. */
  relation    TEXT NOT NULL DEFAULT 'derived',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, child_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_mem_lineage_parent ON mem_lineage(parent_id);
CREATE INDEX IF NOT EXISTS idx_mem_lineage_child  ON mem_lineage(child_id);
CREATE INDEX IF NOT EXISTS idx_mem_lineage_rel    ON mem_lineage(relation);
