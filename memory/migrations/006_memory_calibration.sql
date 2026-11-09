-- Migration 006: mem_calibration
--
-- Tracks predicted confidence vs actual outcomes. For each procedure that
-- got applied, we record whether it worked; for each fact, whether it was
-- later contradicted. Used to:
--   • Compute Brier score / calibration curve
--   • Adjust Beta priors for future items
--   • Surface poorly-calibrated subsets (e.g. "Claude's confidence is
--     systematically too high for Docker-related procedures")

CREATE TABLE IF NOT EXISTS mem_calibration (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id          UUID NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
  predicted_conf   DOUBLE PRECISION NOT NULL, -- confidence at time of prediction
  actual_outcome   BOOLEAN NOT NULL,          -- did it work / was it right
  weight           REAL NOT NULL DEFAULT 1,   -- importance of this observation
  context          JSONB NOT NULL DEFAULT '{}',
  at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mem_calib_item ON mem_calibration(item_id);
CREATE INDEX IF NOT EXISTS idx_mem_calib_at   ON mem_calibration(at DESC);
