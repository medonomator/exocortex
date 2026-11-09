-- Migration 009: mem_item_entities
--
-- M:N link between mem_items and kg_entities. Enables graph-first retrieval:
--   • At recall - find entities mentioned in the query, expand via the KG
--     graph (kg_relations), and seed/boost items linked to any entity in
--     that neighbourhood.
--   • At ingest - scan the item's text for known kg_entities names and
--     auto-link (cheap deterministic substring match, no LLM call).
--
-- Without this table the item store and the knowledge graph are two
-- disjoint worlds - recall sees vectors+text but not "this memory is about
-- cognitive-swarm, and cognitive-swarm is also related to Exocortex, so
-- Exocortex queries should surface this memory too".
--
-- The cross-db FK (mem_items → kg_entities) is fine here because both
-- tables live in the same Postgres instance.

CREATE TABLE IF NOT EXISTS mem_item_entities (
  item_id     UUID NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
  entity_id   UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  /**
   * How the link was established:
   *   'substring' - kg_entity.name found verbatim in item text (ingest-time)
   *   'manual'    - explicit tag
   *   'llm'       - future: LLM-extracted
   */
  source      TEXT NOT NULL DEFAULT 'substring',
  /** 0..1 - substring matches default to 1.0, future LLM matches carry model score. */
  confidence  REAL NOT NULL DEFAULT 1.0,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_mem_ie_item   ON mem_item_entities (item_id);
CREATE INDEX IF NOT EXISTS idx_mem_ie_entity ON mem_item_entities (entity_id);
