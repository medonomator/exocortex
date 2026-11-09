#!/usr/bin/env node

/**
 * PostToolUse hook - learn from bash errors.
 *
 * Two modes:
 *   1) On error: surface any similar past fix from memory as context.
 *   2) On success right after an error: ingest the ERROR/FIX pair as a
 *      `procedure` item. Novelty gate inside IngestService handles dedup +
 *      reinforcement; when the item's access count crosses PROMOTE_THRESHOLD
 *      we promote it to kg_procedures for the graph layer.
 */

import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readStdinSync } from './utils.mjs'
import { queryGraph, closePool } from './pg-client.mjs'
import { recallText, ingestText, getServices, closeMemory } from './memory-client.mjs'
import { canonicalProject, projectFromCwd } from './project-alias.mjs'

const STATE_FILE = join(tmpdir(), 'claude-bash-error-state.json')
const MAX_ERROR_AGE_MS = 300_000
const PROMOTE_THRESHOLD = 3
const RECALL_MIN_SCORE = 0.5

function loadState() {
  if (!existsSync(STATE_FILE)) return null
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    if (Date.now() - state.timestamp > MAX_ERROR_AGE_MS) {
      try { unlinkSync(STATE_FILE) } catch { /* */ }
      return null
    }
    return state
  } catch {
    return null
  }
}

function saveState(error, command) {
  writeFileSync(STATE_FILE, JSON.stringify({
    error: error.slice(0, 2000),
    command,
    timestamp: Date.now(),
  }))
}

function clearState() {
  try { unlinkSync(STATE_FILE) } catch { /* */ }
}

async function promoteToKgProcedure(item, reinforcements) {
  // Extract pattern/trigger/action from the procedure's raw text (ERROR:...FIX:...)
  const content = item.raw?.text ?? ''
  const lines = content.split('\n').filter((l) => l.trim())
  const errorLine = lines.find((l) => l.startsWith('ERROR:')) ?? lines[0] ?? ''
  const fixIdx = lines.findIndex((l) => l.startsWith('FIX:'))
  const fixLine = fixIdx >= 0 ? lines.slice(fixIdx).join('\n') : ''

  const pattern = errorLine.replace(/^ERROR:\s*/, '').slice(0, 200)
  const trigger = lines.slice(0, fixIdx >= 0 ? fixIdx : 2).join(' ').slice(0, 500)
  const action = fixLine.replace(/^FIX:\s*/, '').slice(0, 2000)
  if (!pattern || !action) return

  try {
    await queryGraph(
      `INSERT INTO kg_procedures (pattern, trigger_condition, action, tags, source_type, confidence, success_count)
       VALUES ($1, $2, $3, $4, 'error-learner', $5, $6)
       ON CONFLICT (pattern, project) DO UPDATE SET
         last_seen = NOW(),
         success_count = kg_procedures.success_count + 1,
         confidence = GREATEST(kg_procedures.confidence, EXCLUDED.confidence)`,
      [
        pattern,
        trigger,
        action,
        ['auto-promoted', 'error-fix'],
        Math.min(0.9, 0.4 + reinforcements * 0.1),
        reinforcements,
      ],
    )
  } catch { /* hooks must never crash */ }
}

async function main() {
  try {
    const input = readStdinSync()
    if (!input) process.exit(0)

    const parsed = JSON.parse(input)
    if ((parsed?.tool_name ?? '') !== 'Bash') process.exit(0)

    const stdout = parsed?.tool_output?.stdout ?? ''
    const stderr = parsed?.tool_output?.stderr ?? ''
    const exitCode = parsed?.tool_output?.exit_code ?? 0
    const command = parsed?.tool_input?.command ?? ''
    const sessionId = parsed?.session_id
    const project = canonicalProject(projectFromCwd(parsed?.cwd ?? '')) ?? undefined

    const isError = exitCode !== 0 || stderr.includes('Error') || stderr.includes('error')
    const prevError = loadState()

    if (isError) {
      const errorText = (stderr || stdout).slice(0, 1500)
      saveState(errorText, command)

      // Recall similar past fixes (procedure items) and surface as context.
      // Project scoping: pgxn install failures in confyday-backend and
      // exocortex differ; a Docker fix for one is rarely useful for the
      // other. Null-project procedures (legacy / user-wide) still match.
      const res = await recallText(errorText, {
        types: ['procedure'],
        limit: 2,
        mode: 'warm',
        ...(project ? { project } : {}),
      }).catch(() => null)

      const good = (res?.items ?? []).filter((r) => r.score >= RECALL_MIN_SCORE)
      if (good.length === 0) {
        await closeMemory()
        await closePool()
        process.exit(0)
      }

      const fixes = good
        .map((r, i) => `[Past fix ${i + 1}] (score: ${r.score.toFixed(2)}):\n${(r.item.raw?.text ?? '').slice(0, 400)}`)
        .join('\n\n')

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `EXOCORTEX ERROR MEMORY:\nSimilar error was seen before. Past fixes:\n\n${fixes}`,
        },
      }))
    } else if (prevError) {
      // Success after an error → ingest ERROR/FIX pair as a procedure.
      const fixEntry = [
        `ERROR: ${prevError.command}`,
        prevError.error.slice(0, 800),
        '',
        `FIX: ${command}`,
        stdout.slice(0, 500),
      ].join('\n')

      const result = await ingestText(fixEntry, {
        kind: 'error',
        type: 'procedure',
        source: 'hook',
        agentId: 'bash-error-learner',
        sessionId,
        ...(project ? { project } : {}),
        importance: 0.6,
        payload: {
          pattern: prevError.command.slice(0, 200),
          trigger: prevError.error.slice(0, 500),
          action: `${command}\n${stdout.slice(0, 500)}`,
          successCount: 1,
          failureCount: 0,
        },
      }).catch(() => null)

      // If this was a reinforcement, check whether we crossed the promotion threshold.
      if (result?.action === 'reinforced' && result.itemId) {
        const { pg } = getServices()
        const existing = await pg.getItem(result.itemId).catch(() => null)
        if (existing && existing.accessCount >= PROMOTE_THRESHOLD) {
          await promoteToKgProcedure(existing, existing.accessCount)
        }
      }

      clearState()
    }
  } catch {
    /* hooks must never crash */
  } finally {
    await closeMemory().catch(() => {})
    await closePool().catch(() => {})
  }
}

main()
