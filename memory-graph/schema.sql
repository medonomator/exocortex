-- Exocortex Knowledge Graph Schema
-- Run: docker exec -i mind-forge-db psql -U mindforge -d mindforge < memory-graph/schema.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS kg_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  project VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  confidence REAL DEFAULT 1.0,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  mention_count INT DEFAULT 1,
  UNIQUE(name, type)
);

CREATE TABLE IF NOT EXISTS kg_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id UUID REFERENCES kg_entities(id) ON DELETE CASCADE,
  to_id UUID REFERENCES kg_entities(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  metadata JSONB DEFAULT '{}',
  confidence REAL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  session_id VARCHAR(100),
  UNIQUE(from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_name_trgm ON kg_entities USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kg_entities_project ON kg_entities(project);
CREATE INDEX IF NOT EXISTS idx_kg_relations_from ON kg_relations(from_id);
CREATE INDEX IF NOT EXISTS idx_kg_relations_to ON kg_relations(to_id);
CREATE INDEX IF NOT EXISTS idx_kg_relations_type ON kg_relations(type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_metadata ON kg_entities USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_kg_entities_last_seen ON kg_entities(last_seen);

-- Confidence decay: reduce confidence for entities not seen recently
-- Run periodically to keep graph fresh. Entities below threshold can be pruned.
-- Formula: confidence = confidence * 0.95 for every 7 days since last_seen
-- Minimum confidence floor: 0.1 (never fully delete, just deprioritize)

-- ═══════════════════════════════════════════
-- Procedural Memory — "how to do things"
-- ═══════════════════════════════════════════
-- Stores verified patterns extracted from sessions:
-- "When X happens → do Y" with success tracking.
-- Complements kg_entities (semantic: what is known)
-- and kg_relations (connections between entities).

CREATE TABLE IF NOT EXISTS kg_procedures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern VARCHAR(500) NOT NULL,
  trigger_condition VARCHAR(500) NOT NULL,
  action TEXT NOT NULL,
  project VARCHAR(100),
  tags TEXT[] DEFAULT '{}',
  source_type VARCHAR(50) DEFAULT 'swarm',
  confidence REAL DEFAULT 0.5,
  success_count INT DEFAULT 0,
  failure_count INT DEFAULT 0,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  last_applied TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  UNIQUE(pattern, project)
);

CREATE INDEX IF NOT EXISTS idx_kg_procedures_project ON kg_procedures(project);
CREATE INDEX IF NOT EXISTS idx_kg_procedures_tags ON kg_procedures USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_kg_procedures_pattern_trgm ON kg_procedures USING gin (pattern gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kg_procedures_trigger_trgm ON kg_procedures USING gin (trigger_condition gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kg_procedures_confidence ON kg_procedures(confidence DESC);
