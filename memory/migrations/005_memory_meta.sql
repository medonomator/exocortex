-- ═════════════════════════════════════════════════════════════════════════
-- Migration 005: mem_meta_snapshots
--
-- Daily snapshots of aggregate memory metrics. Populated by introspect.health()
-- cron. Used for:
--   • Drift detection (how distributions change over time)
--   • Morning briefing: "your memory state today vs last week"
--   • Trigger warnings when bloat / contradiction count spikes
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mem_meta_snapshots (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_items         INT NOT NULL,
  by_type             JSONB NOT NULL DEFAULT '{}',
  by_status           JSONB NOT NULL DEFAULT '{}',
  by_level            JSONB NOT NULL DEFAULT '{}',
  avg_confidence      DOUBLE PRECISION NOT NULL,
  avg_importance      DOUBLE PRECISION NOT NULL,
  avg_stability       DOUBLE PRECISION NOT NULL,
  contradictions      INT NOT NULL DEFAULT 0,
  training_eligible   INT NOT NULL DEFAULT 0,
  drift_score         DOUBLE PRECISION,
  /** Free-form supplementary stats. */
  extras              JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mem_meta_at ON mem_meta_snapshots(at DESC);
