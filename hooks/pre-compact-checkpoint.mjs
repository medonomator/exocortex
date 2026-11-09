#!/usr/bin/env node

/**
 * PreCompact hook - mark the session in the knowledge graph before the
 * transcript is compacted.
 *
 * Historical note (2026-04-24):
 *   This hook used to also ingest the last ~5 user turns into mem_items as
 *   "session-turn episodes". That was the #1 source of RAG noise - users
 *   paste long swarm outputs / architectural prose, which embeds to generic
 *   "analytical prose" vectors that then false-positive against any
 *   introspective question. When we cleaned mem_items, 219 of 397 items
 *   (55%) were legacy-migration checkpoint dumps with chain=['legacy-
 *   migration','ingest']. Disabled entirely - if a turn is worth
 *   remembering, the observer/ingest pipeline picks it up via actual
 *   episode events, not raw paste snippets.
 *
 * The kg_entities session upsert is kept so cross-session graph traversal
 * still knows a compaction happened in this cwd.
 */

import { queryGraph, closePool } from './pg-client.mjs'
import { readStdinSync } from './utils.mjs'
import { projectFromCwd } from './project-alias.mjs'

// Hard kill before Claude Code's timeout
setTimeout(() => process.exit(0), 12000).unref()

async function upsertSessionEntity(sessionId, cwd) {
  try {
    await queryGraph(
      `INSERT INTO kg_entities (id, name, type, project, metadata, confidence, first_seen, last_seen, mention_count)
       VALUES (gen_random_uuid(), $1, 'session', $2, $3, 0.6, NOW(), NOW(), 1)
       ON CONFLICT (name, type) DO UPDATE SET
         last_seen = NOW(),
         mention_count = kg_entities.mention_count + 1`,
      [
        `session-${sessionId?.slice(0, 8) ?? 'unknown'}`,
        projectFromCwd(cwd) ?? 'unknown',
        JSON.stringify({ compacted: true, timestamp: new Date().toISOString() }),
      ],
    )
  } catch { /* non-critical */ }
}

async function main() {
  try {
    const input = readStdinSync()
    if (!input) process.exit(0)

    const parsed = JSON.parse(input)
    const sessionId = parsed?.session_id ?? ''
    const cwd = parsed?.cwd ?? ''

    await upsertSessionEntity(sessionId, cwd)
  } finally {
    await closePool().catch(() => {})
  }
}

main().catch(() => process.exit(0))
