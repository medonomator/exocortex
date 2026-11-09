-- Migration 002: mem_events
--
-- Raw input events received via ingest(). Preserved for:
--   • Audit trail ("where did this item come from")
--   • Reprocessing (migration to better extractors without losing data)
--   • Batch consolidate windows
--
-- Events are immutable once stored. Downstream items reference events via
-- provenance.derivedFrom (the UUID of the event id, or other item ids).

DO $$ BEGIN
  CREATE TYPE mem_event_kind AS ENUM (
    'session-turn', 'observation', 'error', 'commit', 'message', 'manual', 'summary'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS mem_events (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind               mem_event_kind NOT NULL,

  -- Content
  content_text       TEXT NOT NULL,
  content_type       TEXT NOT NULL DEFAULT 'text/plain',
  content_source_uri TEXT,

  actors             TEXT[] NOT NULL DEFAULT '{}',

  -- Logical timestamp of the event (not storage time)
  timestamp          TIMESTAMPTZ NOT NULL,

  -- Storage timestamp
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Original raw payload (JSON)
  raw                JSONB NOT NULL DEFAULT '{}',

  -- Provenance
  provenance_source  TEXT NOT NULL,
  provenance_session TEXT,
  provenance_agent   TEXT,
  provenance_model   TEXT,
  provenance         JSONB NOT NULL DEFAULT '{}',

  -- Link to item this event produced (if any). Many events may not produce
  -- items (deduped, skipped, etc.) - nullable.
  resulting_item_id  UUID REFERENCES mem_items(id) ON DELETE SET NULL,
  resulting_action   TEXT -- 'created' | 'reinforced' | 'skipped' | 'archived'
);

CREATE INDEX IF NOT EXISTS idx_mem_events_kind        ON mem_events(kind);
CREATE INDEX IF NOT EXISTS idx_mem_events_timestamp   ON mem_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mem_events_received    ON mem_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_events_session     ON mem_events(provenance_session)
  WHERE provenance_session IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_events_result_item ON mem_events(resulting_item_id)
  WHERE resulting_item_id IS NOT NULL;
