-- ═════════════════════════════════════════════════════════════════════════
-- @exocortex/memory - Migration 001: memory_items
--
-- Universal MemoryItem<T> table. Every long-term-stored cell uses this
-- shape regardless of type (episode / fact / relation / procedure /
-- abstraction). Type-specific data lives in `payload` JSONB.
--
-- Design notes:
--   • Prefix mem_ avoids collision with Prisma tables in shared mindforge DB.
--   • Confidence is Beta(α, β) - two fields, not one scalar.
--   • Lifecycle status is orthogonal to confidence.
--   • Embeddings are NOT stored here - they live in Qdrant (cross-ref by id).
--   • raw_text is always preserved for re-embedding / re-processing.
-- ═════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Enum-like CHECK domains. Use text for flexibility; JSONB elsewhere. ───
DO $$ BEGIN
  CREATE TYPE mem_item_type AS ENUM ('episode', 'fact', 'relation', 'procedure', 'abstraction');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mem_lifecycle_status AS ENUM ('active', 'decayed', 'archived', 'tombstoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mem_items (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Type and payload (discriminated union)
  type               mem_item_type NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}',

  -- Original content (always preserved)
  raw_text           TEXT NOT NULL,
  raw_content_type   TEXT NOT NULL DEFAULT 'text/plain',
  raw_source_uri     TEXT,

  -- Lifecycle
  status             mem_lifecycle_status NOT NULL DEFAULT 'active',
  level              SMALLINT NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 3),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Confidence as Beta distribution (α >= 1, β >= 1 enforced)
  conf_alpha         DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (conf_alpha >= 1),
  conf_beta          DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (conf_beta >= 1),
  -- Computed point estimate for convenient indexing/sorting
  confidence         DOUBLE PRECISION GENERATED ALWAYS AS (conf_alpha / (conf_alpha + conf_beta)) STORED,

  -- Ebbinghaus stability (days until half-life of this memory)
  stability          DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (stability > 0),

  -- Salience
  importance         REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  emotion_valence    REAL CHECK (emotion_valence IS NULL OR (emotion_valence >= -1 AND emotion_valence <= 1)),
  emotion_arousal    REAL CHECK (emotion_arousal IS NULL OR (emotion_arousal >= 0 AND emotion_arousal <= 1)),
  access_count       INT NOT NULL DEFAULT 0,

  -- Provenance (denormalized for query ergonomics, full object in provenance JSONB)
  provenance_source  TEXT NOT NULL,
  provenance_session TEXT,
  provenance_agent   TEXT,
  provenance_model   TEXT,
  provenance         JSONB NOT NULL DEFAULT '{}',

  -- Fine-tune readiness
  human_approved     BOOLEAN,
  human_corrected    TEXT,
  training_eligible  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Freeform extension
  metadata           JSONB NOT NULL DEFAULT '{}'
);

-- ── Indexes ──────────────────────────────────────────────────────────────

-- Type / status / level are the most common filters.
CREATE INDEX IF NOT EXISTS idx_mem_items_type       ON mem_items(type);
CREATE INDEX IF NOT EXISTS idx_mem_items_status     ON mem_items(status);
CREATE INDEX IF NOT EXISTS idx_mem_items_level      ON mem_items(level);

-- Access-time sorting (recency signal).
CREATE INDEX IF NOT EXISTS idx_mem_items_last_access ON mem_items(last_accessed_at DESC);

-- Lexical search via trigrams. GIN so ILIKE / similarity() is fast.
CREATE INDEX IF NOT EXISTS idx_mem_items_raw_trgm   ON mem_items USING gin (raw_text gin_trgm_ops);

-- Full-text search (BM25-ish via ts_rank) for hybrid retrieval.
CREATE INDEX IF NOT EXISTS idx_mem_items_raw_tsv    ON mem_items
  USING gin (to_tsvector('simple', raw_text));

-- JSONB indexes for payload / provenance / metadata introspection.
CREATE INDEX IF NOT EXISTS idx_mem_items_payload    ON mem_items USING gin (payload);
CREATE INDEX IF NOT EXISTS idx_mem_items_metadata   ON mem_items USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_mem_items_provenance ON mem_items USING gin (provenance);

-- Common composite: recall active items of a given type sorted by confidence.
CREATE INDEX IF NOT EXISTS idx_mem_items_active_conf ON mem_items(type, confidence DESC)
  WHERE status = 'active';

-- Session scoping (common provenance query).
CREATE INDEX IF NOT EXISTS idx_mem_items_prov_session ON mem_items(provenance_session)
  WHERE provenance_session IS NOT NULL;

-- ── updated_at auto-bump trigger ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION mem_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mem_items_updated_at ON mem_items;
CREATE TRIGGER trg_mem_items_updated_at
  BEFORE UPDATE ON mem_items
  FOR EACH ROW EXECUTE FUNCTION mem_bump_updated_at();
