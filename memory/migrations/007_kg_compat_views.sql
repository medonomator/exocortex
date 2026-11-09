-- Migration 007: Compatibility views over existing kg_* tables
--
-- We do NOT migrate kg_entities / kg_relations / kg_procedures physically.
-- Instead we expose them as mem_items-shaped views so the new recall/ingest
-- code can query them uniformly. Old code keeps writing to kg_* (no break).
--
-- Write path: new events go into mem_items. Reads: UNION over both.
-- Physical migration is deferred - can be done later if and when we
-- decommission kg_*.

-- Procedures → mem_items-shaped view
CREATE OR REPLACE VIEW mem_items_compat_procedures AS
SELECT
  id,
  'procedure'::mem_item_type                                   AS type,
  jsonb_build_object(
    'pattern',       pattern,
    'trigger',       trigger_condition,
    'action',        action,
    'tags',          tags,
    'project',       project,
    'successCount',  success_count,
    'failureCount',  failure_count,
    'lastAppliedAt', last_applied
  )                                                            AS payload,
  pattern || ' → ' || action                                   AS raw_text,
  'text/plain'                                                 AS raw_content_type,
  NULL::text                                                   AS raw_source_uri,
  'active'::mem_lifecycle_status                               AS status,
  0::smallint                                                  AS level,
  first_seen                                                   AS created_at,
  last_seen                                                    AS updated_at,
  COALESCE(last_applied, last_seen)                            AS last_accessed_at,
  GREATEST(1, success_count::double precision + 1)             AS conf_alpha,
  GREATEST(1, failure_count::double precision + 1)             AS conf_beta,
  confidence::double precision                                 AS confidence,
  7::double precision                                          AS stability,
  LEAST(1.0, 0.5 + (success_count::real / NULLIF(success_count + failure_count, 0) * 0.5))::real AS importance,
  NULL::real                                                   AS emotion_valence,
  NULL::real                                                   AS emotion_arousal,
  success_count + failure_count                                AS access_count,
  source_type                                                  AS provenance_source,
  NULL::text                                                   AS provenance_session,
  NULL::text                                                   AS provenance_agent,
  NULL::text                                                   AS provenance_model,
  jsonb_build_object('source', source_type, 'chain', ARRAY['kg_procedures-adapter']) AS provenance,
  NULL::boolean                                                AS human_approved,
  NULL::text                                                   AS human_corrected,
  FALSE                                                        AS training_eligible,
  metadata
FROM kg_procedures;

-- Entities → mem_items-shaped view (as facts)
CREATE OR REPLACE VIEW mem_items_compat_entities AS
SELECT
  id,
  'fact'::mem_item_type                                        AS type,
  jsonb_build_object(
    'subject',     name,
    'subjectType', type,
    'statement',   name || ' (' || type || ')',
    'project',     project
  )                                                            AS payload,
  COALESCE(name, '') || ' — ' || COALESCE(type, '')            AS raw_text,
  'text/plain'                                                 AS raw_content_type,
  NULL::text                                                   AS raw_source_uri,
  'active'::mem_lifecycle_status                               AS status,
  0::smallint                                                  AS level,
  first_seen                                                   AS created_at,
  last_seen                                                    AS updated_at,
  last_seen                                                    AS last_accessed_at,
  GREATEST(1, mention_count::double precision + 1)             AS conf_alpha,
  1::double precision                                          AS conf_beta,
  confidence::double precision                                 AS confidence,
  7::double precision                                          AS stability,
  0.5::real                                                    AS importance,
  NULL::real                                                   AS emotion_valence,
  NULL::real                                                   AS emotion_arousal,
  mention_count                                                AS access_count,
  'observer'                                                   AS provenance_source,
  NULL::text                                                   AS provenance_session,
  NULL::text                                                   AS provenance_agent,
  NULL::text                                                   AS provenance_model,
  jsonb_build_object('source', 'observer', 'chain', ARRAY['kg_entities-adapter']) AS provenance,
  NULL::boolean                                                AS human_approved,
  NULL::text                                                   AS human_corrected,
  FALSE                                                        AS training_eligible,
  metadata
FROM kg_entities;

-- Unified read-only view: all items from new table + legacy adapters.
-- Use this for cross-cutting recall.
CREATE OR REPLACE VIEW mem_items_all AS
  SELECT * FROM mem_items
  UNION ALL
  SELECT * FROM mem_items_compat_procedures
  UNION ALL
  SELECT * FROM mem_items_compat_entities;
