-- ═════════════════════════════════════════════════════════════════════════
-- Migration 004: mem_forgetting_log
--
-- Audit trail of every lifecycle transition: when an item decayed, was
-- archived, contradicted, tombstoned, or reactivated. Allows:
--   • Retrospective "why did this get archived"
--   • Confidence calibration (compare predicted vs actual outcomes)
--   • Rolling back mass-archive mistakes
--
-- Append-only. Never updated or deleted.
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mem_forgetting_log (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id        UUID NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
  policy         TEXT NOT NULL, -- 'decay-ebbinghaus' | 'contradiction-archive' | ...
  from_status    mem_lifecycle_status NOT NULL,
  to_status      mem_lifecycle_status NOT NULL,
  reason         TEXT,
  /** Snapshot of key item fields at time of transition, for post-hoc analysis. */
  snapshot       JSONB NOT NULL DEFAULT '{}',
  at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mem_fl_item   ON mem_forgetting_log(item_id);
CREATE INDEX IF NOT EXISTS idx_mem_fl_policy ON mem_forgetting_log(policy);
CREATE INDEX IF NOT EXISTS idx_mem_fl_at     ON mem_forgetting_log(at DESC);
