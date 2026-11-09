#!/usr/bin/env tsx
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') })

import { sendTelegramMessage } from './observer/telegram.js'
import { createPool } from './shared/db.js'

// ═══════════════════════════════════════════
// Memory Consolidation
// ═══════════════════════════════════════════
//
// 1. Merge similar entities (pg_trgm similarity)
// 2. Create shortcut relations (frequent 2-hop paths)
// 3. Flag isolated entities
// 4. Extract meta-patterns via Claude CLI
// 5. Report to Telegram
//
// Usage:
//   tsx src/consolidate.ts            — run consolidation
//   tsx src/consolidate.ts --dry-run  — preview without modifying DB

const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? ''
const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'] ?? ''

function parseArgs() {
  return { dryRun: process.argv.includes('--dry-run') }
}

// ── Step 1: Merge similar entities ──

interface SimilarPair {
  a_id: string; a_name: string; a_type: string
  b_id: string; b_name: string; b_type: string
  sim: number
}

async function findSimilarEntities(pool: pg.Pool): Promise<SimilarPair[]> {
  const { rows } = await pool.query<SimilarPair>(`
    SELECT a.id as a_id, a.name as a_name, a.type as a_type,
           b.id as b_id, b.name as b_name, b.type as b_type,
           similarity(a.name, b.name) as sim
    FROM kg_entities a
    JOIN kg_entities b ON a.id < b.id AND a.type = b.type
    WHERE similarity(a.name, b.name) > 0.7
    ORDER BY sim DESC
    LIMIT 50
  `)
  return rows
}

async function mergePair(pool: pg.Pool, winnerId: string, loserId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Combine metadata and mention counts
    await client.query(`
      UPDATE kg_entities SET
        mention_count = mention_count + (SELECT mention_count FROM kg_entities WHERE id = $2),
        confidence = GREATEST(confidence, (SELECT confidence FROM kg_entities WHERE id = $2)),
        metadata = metadata || (SELECT metadata FROM kg_entities WHERE id = $2),
        last_seen = GREATEST(last_seen, (SELECT last_seen FROM kg_entities WHERE id = $2))
      WHERE id = $1
    `, [winnerId, loserId])

    // Reassign outgoing relations
    await client.query(`
      UPDATE kg_relations r_outer SET from_id = $1
      WHERE r_outer.from_id = $2
      AND NOT EXISTS (
        SELECT 1 FROM kg_relations r_dup
        WHERE r_dup.from_id = $1 AND r_dup.to_id = r_outer.to_id AND r_dup.type = r_outer.type
      )
    `, [winnerId, loserId])

    // Reassign incoming relations
    await client.query(`
      UPDATE kg_relations r_outer SET to_id = $1
      WHERE r_outer.to_id = $2
      AND NOT EXISTS (
        SELECT 1 FROM kg_relations r_dup
        WHERE r_dup.to_id = $1 AND r_dup.from_id = r_outer.from_id AND r_dup.type = r_outer.type
      )
    `, [winnerId, loserId])

    // Delete orphaned relations (conflicts) and loser entity
    await client.query('DELETE FROM kg_relations WHERE from_id = $1 OR to_id = $1', [loserId])
    await client.query('DELETE FROM kg_entities WHERE id = $1', [loserId])

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function mergeDuplicates(pool: pg.Pool, dryRun: boolean): Promise<string[]> {
  const pairs = await findSimilarEntities(pool)
  if (pairs.length === 0) return []

  const merged: string[] = []
  const alreadyMerged = new Set<string>()

  for (const pair of pairs) {
    if (alreadyMerged.has(pair.a_id) || alreadyMerged.has(pair.b_id)) continue

    const desc = `"${pair.a_name}" + "${pair.b_name}" (${pair.a_type}, sim=${pair.sim.toFixed(2)})`
    if (dryRun) {
      console.log(`   [dry-run] Would merge: ${desc}`)
    } else {
      await mergePair(pool, pair.a_id, pair.b_id)
      console.log(`   Merged: ${desc}`)
    }
    merged.push(desc)
    alreadyMerged.add(pair.b_id)
  }

  return merged
}

// ── Step 2: Create shortcut relations ──

async function createShortcuts(pool: pg.Pool, dryRun: boolean): Promise<number> {
  const { rows } = await pool.query<{
    from_id: string; to_id: string
    from_name: string; to_name: string
    rel1: string; rel2: string
  }>(`
    SELECT r1.from_id, r2.to_id,
           e1.name as from_name, e2.name as to_name,
           r1.type as rel1, r2.type as rel2
    FROM kg_relations r1
    JOIN kg_relations r2 ON r1.to_id = r2.from_id
    JOIN kg_entities e1 ON e1.id = r1.from_id
    JOIN kg_entities e2 ON e2.id = r2.to_id
    WHERE r1.from_id != r2.to_id
      AND NOT EXISTS (
        SELECT 1 FROM kg_relations r3
        WHERE r3.from_id = r1.from_id AND r3.to_id = r2.to_id
      )
    LIMIT 20
  `)

  if (rows.length === 0) return 0

  let count = 0
  for (const row of rows) {
    if (dryRun) {
      console.log(`   [dry-run] Shortcut: ${row.from_name} —→ ${row.to_name} (via ${row.rel1}→${row.rel2})`)
    } else {
      await pool.query(`
        INSERT INTO kg_relations (id, from_id, to_id, type, metadata, confidence, created_at)
        VALUES (gen_random_uuid(), $1, $2, 'related_to',
                $3::jsonb, 0.5, NOW())
        ON CONFLICT (from_id, to_id, type) DO NOTHING
      `, [row.from_id, row.to_id, JSON.stringify({
        is_shortcut: true,
        via_path: [row.rel1, row.rel2],
      })])
    }
    count++
  }

  return count
}

// ── Step 3: Flag isolated entities ──

async function flagIsolated(pool: pg.Pool, dryRun: boolean): Promise<number> {
  if (dryRun) {
    const { rows } = await pool.query<{ name: string; type: string }>(`
      SELECT name, type FROM kg_entities e
      WHERE NOT EXISTS (SELECT 1 FROM kg_relations WHERE from_id = e.id OR to_id = e.id)
        AND (metadata->>'isolated') IS NULL
    `)
    for (const r of rows) {
      console.log(`   [dry-run] Isolated: ${r.name} (${r.type})`)
    }
    return rows.length
  }

  const { rowCount } = await pool.query(`
    UPDATE kg_entities SET metadata = metadata || '{"isolated": true}'::jsonb
    WHERE id NOT IN (
      SELECT from_id FROM kg_relations UNION SELECT to_id FROM kg_relations
    )
    AND (metadata->>'isolated') IS NULL
  `)
  return rowCount ?? 0
}

// ── Step 4: Extract meta-patterns via Claude CLI ──

async function extractMetaPatterns(pool: pg.Pool, dryRun: boolean): Promise<number> {
  // Get entity clusters by type
  const { rows } = await pool.query<{
    type: string; names: string; cnt: number
  }>(`
    SELECT type, string_agg(name, ', ' ORDER BY mention_count DESC) as names, COUNT(*) as cnt
    FROM kg_entities
    WHERE confidence > 0.3
    GROUP BY type
    HAVING COUNT(*) >= 3
    ORDER BY cnt DESC
    LIMIT 10
  `)

  if (rows.length === 0) return 0

  const clusterText = rows
    .map(r => `${r.type} (${r.cnt}): ${r.names}`)
    .join('\n')

  const systemPrompt = `You are analyzing a knowledge graph for meta-patterns.
Given entity clusters grouped by type, identify higher-level patterns or concepts that emerge.
Output JSON array: [{"name": "pattern name", "type": "concept", "related": ["entity1", "entity2"]}]
Max 5 patterns. Only suggest patterns backed by 3+ entities. Be specific, not generic.`

  const promptFile = join(tmpdir(), 'consolidate-prompt.txt')
  writeFileSync(promptFile, systemPrompt)

  if (dryRun) {
    console.log(`   [dry-run] Would analyze clusters:\n${clusterText}`)
    return 0
  }

  const result = spawnSync('claude', [
    '-p', '--model', 'sonnet',
    '--max-budget-usd', '0.10',
    '--system-prompt-file', promptFile,
  ], {
    input: `Entity clusters in knowledge graph:\n\n${clusterText}`,
    encoding: 'utf-8',
    timeout: 60_000,
  })

  if (result.status !== 0) {
    console.log(`   Meta-pattern extraction skipped (Claude CLI unavailable)`)
    return 0
  }

  // Try to parse JSON from Claude's response
  const jsonMatch = result.stdout.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return 0

  try {
    const patterns = JSON.parse(jsonMatch[0]) as Array<{
      name: string; type: string; related: string[]
    }>

    for (const p of patterns.slice(0, 5)) {
      // Insert concept entity
      const { rows: [entity] } = await pool.query<{ id: string }>(`
        INSERT INTO kg_entities (id, name, type, metadata, confidence, first_seen, last_seen, mention_count)
        VALUES (gen_random_uuid(), $1, 'concept', '{"source": "consolidation"}'::jsonb, 0.6, NOW(), NOW(), 1)
        ON CONFLICT (name, type) DO UPDATE SET
          last_seen = NOW(),
          mention_count = kg_entities.mention_count + 1
        RETURNING id
      `, [p.name])

      // Link to related entities
      if (entity) {
        for (const relName of p.related) {
          await pool.query(`
            INSERT INTO kg_relations (id, from_id, to_id, type, metadata, confidence, created_at)
            SELECT gen_random_uuid(), $1, e.id, 'related_to',
                   '{"source": "consolidation"}'::jsonb, 0.5, NOW()
            FROM kg_entities e WHERE e.name = $2
            ON CONFLICT (from_id, to_id, type) DO NOTHING
          `, [entity.id, relName])
        }
      }

      console.log(`   Pattern: "${p.name}" → [${p.related.join(', ')}]`)
    }

    return patterns.length
  } catch {
    console.log(`   Failed to parse meta-patterns from Claude response`)
    return 0
  }
}

// ── Main ──

async function main() {
  const { dryRun } = parseArgs()
  const pool = createPool({ max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 })

  console.log(`\n🧠 Memory Consolidation${dryRun ? ' [dry-run]' : ''}`)

  try {
    // Step 1
    console.log('\n   Step 1: Finding similar entities...')
    const merged = await mergeDuplicates(pool, dryRun)
    console.log(`   ${merged.length} pairs ${dryRun ? 'found' : 'merged'}`)

    // Step 2
    console.log('\n   Step 2: Creating shortcut relations...')
    const shortcuts = await createShortcuts(pool, dryRun)
    console.log(`   ${shortcuts} shortcuts ${dryRun ? 'found' : 'created'}`)

    // Step 3
    console.log('\n   Step 3: Flagging isolated entities...')
    const isolated = await flagIsolated(pool, dryRun)
    console.log(`   ${isolated} isolated entities ${dryRun ? 'found' : 'flagged'}`)

    // Step 4
    console.log('\n   Step 4: Extracting meta-patterns...')
    const patterns = await extractMetaPatterns(pool, dryRun)
    console.log(`   ${patterns} meta-patterns ${dryRun ? 'would be' : ''} extracted`)

    // Step 5: Telegram report
    if (!dryRun && (merged.length > 0 || shortcuts > 0 || patterns > 0)) {
      const report = [
        '🧠 Memory Consolidation Report',
        '',
        `Merged: ${merged.length} duplicate pairs`,
        ...merged.slice(0, 5).map(m => `  - ${m}`),
        `Shortcuts: ${shortcuts} new connections`,
        `Isolated: ${isolated} entities flagged`,
        `Meta-patterns: ${patterns} extracted`,
      ].join('\n')

      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        // Plain text: the report contains raw '-' and '.' which are reserved
        // in MarkdownV2 but not escaped here.
        await sendTelegramMessage(
          { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID },
          report,
          { parseMode: 'plain' },
        )
      }
    }

    console.log('\n   ✅ Consolidation complete')
  } finally {
    await pool.end()
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
