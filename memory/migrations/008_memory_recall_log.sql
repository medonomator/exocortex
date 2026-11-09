-- Migration 008: mem_recall_log
--
-- Feedback signal for auto-importance learning. Every recall writes one row
-- per returned item. The next user turn either "acks" the recall (meaning
-- the user engaged with that topic - word overlap with the item text) or
-- ages out unacked.
--
-- Engagement semantics:
--   • acked = true  → user's next turn shared content with this memory
--                     → importance +ack_delta (recorded here, applied to
--                       mem_items)
--   • acked = false AND aged (>= AGE_CUTOFF minutes) → importance decays
--                                                      slightly
--
-- This lets the system *learn* which memories actually help: recalled-and-
-- engaged stays easy to surface, recalled-and-ignored fades. Without this
-- signal importance drifts only via manual review.
--
-- Append-style; rows are updated once (when acked or decayed) then kept for
-- audit. Prune old rows via a cron if table grows too large.

CREATE TABLE IF NOT EXISTS mem_recall_log (
  id           BIGSERIAL PRIMARY KEY,
  item_id      UUID NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  query_text   TEXT,                    -- user query snapshot (first 500ch)
  recalled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acked        BOOLEAN NOT NULL DEFAULT FALSE,
  acked_at     TIMESTAMPTZ,
  ack_delta    REAL NOT NULL DEFAULT 0, -- +/- applied to item importance
  decayed      BOOLEAN NOT NULL DEFAULT FALSE
);

-- Fast lookup of un-acked rows for a given session (this is the hot path:
-- every UserPromptSubmit hook scans recent un-acked rows for the current
-- session to decide whether to bump importance).
CREATE INDEX IF NOT EXISTS idx_mem_rl_session_unacked
  ON mem_recall_log (session_id, recalled_at DESC)
  WHERE acked = FALSE AND decayed = FALSE;

-- Per-item history for analytics ("was this item recalled a lot but never
-- acked?" → candidate for manual review).
CREATE INDEX IF NOT EXISTS idx_mem_rl_item ON mem_recall_log (item_id, recalled_at DESC);
