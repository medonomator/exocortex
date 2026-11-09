#!/usr/bin/env node

import pg from 'pg'
import { loadEnv } from './env-loader.mjs'

loadEnv()

const { Pool } = pg

let _pool = null

export function getPool() {
  if (!_pool) {
    _pool = new Pool({
      host: process.env.PG_HOST ?? 'localhost',
      port: Number(process.env.PG_PORT ?? 5433),
      user: process.env.PG_USER ?? 'mindforge',
      password: process.env.PG_PASSWORD ?? 'mindforge123',
      database: process.env.PG_DATABASE ?? 'mindforge',
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 3000,
    })
    // Suppress connection errors (hook must never crash Claude Code)
    _pool.on('error', () => {})
  }
  return _pool
}

/**
 * Run a parameterized query against the knowledge graph.
 * Returns rows or empty array on any error.
 */
export async function queryGraph(sql, params = []) {
  try {
    const pool = getPool()
    const result = await pool.query(sql, params)
    return result.rows
  } catch {
    return []
  }
}

/**
 * Search entities by keywords with word-boundary regex matching.
 *
 * Why not ILIKE '%kw%': substring match is far too permissive - a 4-char
 * keyword inside a long entity name ("ошибку" inside "Устранить ошибку
 * `403 Country not supported`") produces a false-positive hit, and the
 * entity then leaks into every unrelated conversation that happens to
 * mention similar words. We saw this in prod: a 3D-rendering question
 * surfaced a `403 Country not supported` decision from cognitive-swarm.
 *
 * Fixes applied:
 *   1. Word-boundary match via POSIX regex `(^|\W)kw(\W|$)` on LOWER(name)
 *      - avoids mid-word substring hits, language-agnostic
 *   2. Confidence ≥ 0.4 - drops low-signal extracted entities
 *   3. Score = count of matching keywords, order by score DESC - a 2-hit
 *      entity ranks above a 1-hit high-mention_count entity
 *   4. LIMIT 5 (was 15) - surfacing less is better than surfacing noise
 *   5. Min keyword length 3 enforced (1-2 char keywords can't be precise)
 *
 * NOTE: project-scoping is intentionally NOT here. The graph is global
 * by design - cross-project connections are often the most valuable
 * context. Project scoping belongs in session-start-briefing where the
 * current cwd is known and intent is "summarize this project".
 */
export async function searchByKeywords(keywords) {
  if (keywords.length === 0) return []

  const safe = keywords
    .filter((k) => k && k.length >= 3)
    .map((k) => k.toLowerCase())
  if (safe.length === 0) return []

  // POSIX-style word-boundary: non-alnum char OR string start/end on either side.
  // [^[:alnum:]] is Unicode-aware under default UTF-8 collation so Cyrillic
  // word boundaries work too. We wrap the keyword (already sanitized in the
  // hook via /[^\w\u0400-\u04FF-]/g) without further escaping.
  const patterns = safe.map((k) => `(^|[^[:alnum:]])${k}([^[:alnum:]]|$)`)
  const conditions = patterns.map((_, i) => `LOWER(e.name) ~ $${i + 1}`).join(' OR ')
  // Match-count score: number of regex patterns the name satisfies.
  const scoreExpr = patterns
    .map((_, i) => `CASE WHEN LOWER(e.name) ~ $${i + 1} THEN 1 ELSE 0 END`)
    .join(' + ')

  const sql = `
    WITH matched AS (
      SELECT e.id, (${scoreExpr}) AS match_score
      FROM kg_entities e
      WHERE e.confidence >= 0.4
        AND (${conditions})
    )
    SELECT e.name, e.type, e.project, e.mention_count, e.confidence,
           m.match_score,
           r.type as rel_type, e2.name as related_name, e2.type as related_type
    FROM matched m
    JOIN kg_entities e ON e.id = m.id
    LEFT JOIN kg_relations r ON r.from_id = e.id
    LEFT JOIN kg_entities e2 ON e2.id = r.to_id
    WHERE m.match_score >= 1
    ORDER BY m.match_score DESC, e.confidence DESC, e.mention_count DESC
    LIMIT 5`

  return queryGraph(sql, patterns)
}

/**
 * Traverse graph from an entity name, up to maxDepth hops.
 */
export async function traverseFrom(entityName, maxDepth = 2) {
  const sql = `
    WITH RECURSIVE graph AS (
      SELECT e.id, e.name, e.type, e.project, e.confidence, e.mention_count, 0 as depth
      FROM kg_entities e WHERE e.name ILIKE $1
      UNION ALL
      SELECT e2.id, e2.name, e2.type, e2.project, e2.confidence, e2.mention_count, g.depth + 1
      FROM graph g
      JOIN kg_relations r ON r.from_id = g.id OR r.to_id = g.id
      JOIN kg_entities e2 ON e2.id = CASE WHEN r.from_id = g.id THEN r.to_id ELSE r.from_id END
      WHERE g.depth < $2
    )
    SELECT DISTINCT ON (id) id, name, type, project, confidence, mention_count, depth
    FROM graph ORDER BY id, depth`

  return queryGraph(sql, [`%${entityName}%`, maxDepth])
}

/**
 * Get relevant procedures for a project.
 * Returns top procedures by confidence, optionally filtered by project.
 */
export async function getProjectProcedures(project, limit = 5) {
  const sql = `
    SELECT pattern, trigger_condition, action, project, tags,
           confidence, success_count, failure_count
    FROM kg_procedures
    WHERE ($1 = '' OR project = $1 OR project IS NULL)
      AND confidence >= 0.3
    ORDER BY confidence DESC, success_count DESC
    LIMIT $2`

  return queryGraph(sql, [project, limit])
}

// Recall feedback (auto-importance learning)
//
// Flow per UserPromptSubmit hook turn:
//   1. ackRecallsForSession() - look at un-acked recalls from PREVIOUS turn(s)
//      in this session, bump importance on items that overlap with the
//      current query (= user engaged with that memory).
//   2. decayStaleRecalls() - items recalled ≥AGE_MIN min ago and never acked
//      get a small importance decrement (= recall didn't help).
//   3. logRecall() - record items recalled on this turn, so the NEXT turn
//      can ack them.

const ACK_DELTA = 0.02        // +importance when user engages with recalled item
const DECAY_DELTA = -0.01     // -importance when recalled but unused
const AGE_MIN_MINUTES = 10    // min age before an un-acked recall is decayed
const ACK_WINDOW_MINUTES = 20 // how far back to look for recent recalls to ack
const MIN_OVERLAP_WORDS = 2   // min shared content words to count as "engaged"

/**
 * Count shared content words (case-insensitive, length>2) between the query
 * and an item's text. Crude but language-agnostic and dependency-free.
 */
function overlapCount(queryWords, itemText) {
  if (!itemText || queryWords.size === 0) return 0
  const hay = itemText.toLowerCase()
  let c = 0
  for (const w of queryWords) {
    if (hay.includes(w)) c++
  }
  return c
}

/**
 * Walk un-acked recall_log rows for the session (last ACK_WINDOW_MINUTES).
 * For each row, check if the current query shares ≥MIN_OVERLAP_WORDS content
 * words with the item's text; if yes, bump item importance and mark acked.
 *
 * Returns the number of items acked (for logging).
 */
export async function ackRecallsForSession(sessionId, currentQueryWords) {
  if (!sessionId || !currentQueryWords || currentQueryWords.length === 0) return 0
  const wordSet = new Set(currentQueryWords.map((w) => w.toLowerCase()))
  try {
    const pool = getPool()
    // Fetch un-acked recalls with item text.
    const { rows } = await pool.query(
      `SELECT rl.id AS rl_id, rl.item_id, i.raw_text, i.importance
         FROM mem_recall_log rl
         JOIN mem_items i ON i.id = rl.item_id
        WHERE rl.session_id = $1
          AND rl.acked = FALSE
          AND rl.decayed = FALSE
          AND rl.recalled_at > NOW() - ($2 || ' minutes')::INTERVAL`,
      [sessionId, ACK_WINDOW_MINUTES],
    )
    let acked = 0
    for (const r of rows) {
      const c = overlapCount(wordSet, r.raw_text)
      if (c >= MIN_OVERLAP_WORDS) {
        const newImportance = Math.min(1.0, (r.importance ?? 0.5) + ACK_DELTA)
        // Single UPDATE per item; rl row + item in one transaction would be
        // nicer, but for a hook that must stay under 12s the two-stmt path is
        // fine - worst case we ack the log but fail to bump importance, and
        // the row stays acked so we don't double-count.
        await pool.query(
          'UPDATE mem_recall_log SET acked = TRUE, acked_at = NOW(), ack_delta = $1 WHERE id = $2',
          [ACK_DELTA, r.rl_id],
        )
        await pool.query('UPDATE mem_items SET importance = $1 WHERE id = $2', [
          newImportance,
          r.item_id,
        ])
        acked++
      }
    }
    return acked
  } catch {
    return 0
  }
}

/**
 * Decay importance of items that were recalled but never engaged with.
 * Runs opportunistically from the hook - no separate cron needed.
 *
 * Only decays rows aged ≥AGE_MIN_MINUTES so we don't punish recalls that
 * might still get acked by the next turn.
 */
export async function decayStaleRecalls() {
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT rl.id AS rl_id, rl.item_id, i.importance
         FROM mem_recall_log rl
         JOIN mem_items i ON i.id = rl.item_id
        WHERE rl.acked = FALSE
          AND rl.decayed = FALSE
          AND rl.recalled_at < NOW() - ($1 || ' minutes')::INTERVAL
        LIMIT 50`,
      [AGE_MIN_MINUTES],
    )
    let decayed = 0
    for (const r of rows) {
      const newImportance = Math.max(0.0, (r.importance ?? 0.5) + DECAY_DELTA)
      await pool.query(
        'UPDATE mem_recall_log SET decayed = TRUE, ack_delta = $1 WHERE id = $2',
        [DECAY_DELTA, r.rl_id],
      )
      await pool.query('UPDATE mem_items SET importance = $1 WHERE id = $2', [
        newImportance,
        r.item_id,
      ])
      decayed++
    }
    return decayed
  } catch {
    return 0
  }
}

/**
 * Record that these items were recalled on this turn, so the NEXT turn can
 * either ack or decay them.
 */
export async function logRecall(sessionId, itemIds, queryText) {
  if (!sessionId || !itemIds || itemIds.length === 0) return 0
  try {
    const pool = getPool()
    const snippet = (queryText ?? '').slice(0, 500)
    // Multi-value INSERT.
    const values = itemIds.map((_, i) => `($1, $${i + 3}, $2)`).join(', ')
    await pool.query(
      `INSERT INTO mem_recall_log (session_id, item_id, query_text) VALUES ${values}`,
      [sessionId, snippet, ...itemIds],
    )
    return itemIds.length
  } catch {
    return 0
  }
}

/**
 * Resolve query keywords to kg_entities ids, then expand by 1 hop over
 * kg_relations. Returns a Set of entity IDs that form the "topic
 * neighbourhood" of the query.
 *
 * Used to score candidates: items linked to entities in this set get a
 * graph-proximity boost.
 */
export async function resolveQueryEntityNeighborhood(keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return new Set()
  const safe = keywords.filter((k) => k.length > 0)
  if (safe.length === 0) return new Set()
  const conds = safe.map((_, i) => `name ILIKE $${i + 1}`).join(' OR ')
  const params = safe.map((k) => `%${k}%`)
  const sql = `
    WITH seeds AS (
      SELECT id FROM kg_entities
      WHERE ${conds}
      ORDER BY mention_count DESC
      LIMIT 10
    ),
    expanded AS (
      SELECT id FROM seeds
      UNION
      SELECT CASE WHEN r.from_id IN (SELECT id FROM seeds) THEN r.to_id ELSE r.from_id END
      FROM kg_relations r
      WHERE r.from_id IN (SELECT id FROM seeds) OR r.to_id IN (SELECT id FROM seeds)
    )
    SELECT id FROM expanded
  `
  const rows = await queryGraph(sql, params)
  return new Set(rows.map((r) => r.id))
}

/**
 * Fetch entity link counts for a batch of item IDs and how many of each
 * item's linked entities fall inside the query's entity neighbourhood.
 *
 * Returns Map<item_id, { total, matched }>. Caller computes proximity =
 * matched / max(total, 1).
 */
export async function countItemEntityMatches(itemIds, neighborhoodIds) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return new Map()
  if (!(neighborhoodIds instanceof Set) || neighborhoodIds.size === 0) return new Map()
  const nIds = Array.from(neighborhoodIds)
  const sql = `
    SELECT item_id,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE entity_id = ANY($2::uuid[]))::int AS matched
    FROM mem_item_entities
    WHERE item_id = ANY($1::uuid[])
    GROUP BY item_id
  `
  const rows = await queryGraph(sql, [itemIds, nIds])
  const out = new Map()
  for (const r of rows) out.set(r.item_id, { total: r.total, matched: r.matched })
  return out
}

/**
 * Clean up pool on process exit.
 */
export async function closePool() {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}
