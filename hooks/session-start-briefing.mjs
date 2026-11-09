#!/usr/bin/env node

import { loadEnv } from './env-loader.mjs'
import { readStdinSync } from './utils.mjs'
import { queryGraph, getProjectProcedures, closePool } from './pg-client.mjs'
import { resolveProjectNames, projectFromCwd } from './project-alias.mjs'

loadEnv()

// On session start, provides context from knowledge graph:
// - Recent decisions and entities for current project
// - Active work items (high mention_count, recent last_seen)
// - Cross-project connections relevant to cwd

// Hard kill before timeout
setTimeout(() => process.exit(0), 12000).unref()

// Project aliases live in ./project-alias.mjs so the UserPromptSubmit
// recall hook and this briefing resolve the same cwd → canonical project
// name. Add mappings there when you spot a new cwd/DB mismatch.

async function getRecentEntities(projects, hours = 48) {
  // LOWER(project) = ANY(projects) also catches case-duplicates like
  // "exocortex" vs "Exocortex" that historically slipped into the graph.
  return queryGraph(
    `SELECT e.name, e.type, e.confidence, e.mention_count,
            r.type as rel_type, e2.name as related_name, e2.type as related_type
     FROM kg_entities e
     LEFT JOIN kg_relations r ON r.from_id = e.id
     LEFT JOIN kg_entities e2 ON e2.id = r.to_id
     WHERE e.last_seen > NOW() - INTERVAL '1 hour' * $1
       AND (
         cardinality($2::text[]) = 0
         OR LOWER(e.project) = ANY($2::text[])
         OR e.project IS NULL
       )
       AND e.confidence > 0.3
     ORDER BY e.mention_count DESC, e.last_seen DESC
     LIMIT 20`,
    [hours, projects],
  )
}

/**
 * Recent high-confidence decisions, SCOPED to the current project.
 *
 * Historically this was global - a session in /exocortex would get dumped
 * decisions from /second-brain-backend and vice versa, making the briefing
 * actively misleading (the header said "EXOCORTEX BRIEFING (exocortex)"
 * while showing unrelated astro-bot decisions). Now decisions must belong
 * to the current project's alias set, or have NULL project (= treated as
 * user-wide not project-specific).
 */
async function getActiveDecisions(projects, hours = 168) {
  return queryGraph(
    `SELECT e.name, e.project, e.metadata, e.confidence, e.last_seen
     FROM kg_entities e
     WHERE e.type = 'decision'
       AND e.last_seen > NOW() - INTERVAL '1 hour' * $1
       AND e.confidence > 0.4
       AND (
         cardinality($2::text[]) = 0
         OR LOWER(e.project) = ANY($2::text[])
         OR e.project IS NULL
       )
     ORDER BY e.last_seen DESC
     LIMIT 5`,
    [hours, projects],
  )
}

function formatBriefing(entities, decisions, procedures, project) {
  const parts = []

  if (decisions.length > 0) {
    const decisionLines = decisions.map((d) => {
      const scope = d.project ? `, ${d.project}` : ', user-wide'
      return `  - ${d.name} (confidence: ${Number(d.confidence).toFixed(2)}${scope})`
    })
    parts.push(`RECENT DECISIONS:\n${decisionLines.join('\n')}`)
  }

  if (entities.length > 0) {
    const seen = new Set()
    const lines = []
    for (const r of entities) {
      if (seen.has(r.name)) continue
      seen.add(r.name)
      const rel = r.related_name
        ? ` —[${r.rel_type}]→ ${r.related_name}`
        : ''
      lines.push(`  ${r.name} (${r.type}, mentions: ${r.mention_count})${rel}`)
    }
    parts.push(`ACTIVE CONTEXT:\n${lines.slice(0, 10).join('\n')}`)
  }

  if (procedures.length > 0) {
    const procLines = procedures.map(p => {
      const stats = p.success_count > 0 ? ` [${p.success_count}x verified]` : ''
      return `  - WHEN: ${p.trigger_condition}\n    DO: ${p.action}${stats}`
    })
    parts.push(`PROCEDURAL MEMORY (known fixes & patterns):\n${procLines.join('\n')}`)
  }

  if (parts.length === 0) return ''
  return `EXOCORTEX BRIEFING (${project || 'global'}):\n\n${parts.join('\n\n')}`
}

async function main() {
  try {
    const input = readStdinSync()
    if (!input) process.exit(0)

    const parsed = JSON.parse(input)
    const cwd = parsed?.cwd ?? ''

    // Extract project name from cwd; resolve to the alias set used by the
    // observer (so a session in "mind-forge-backend" matches entities stored
    // under both "mind-forge" and "mind-forge-backend").
    const project = projectFromCwd(cwd) ?? ''
    const projects = resolveProjectNames(project)

    const [entities, decisions, procedures] = await Promise.all([
      getRecentEntities(projects),
      getActiveDecisions(projects),
      getProjectProcedures(project),
    ])

    const briefing = formatBriefing(entities, decisions, procedures, project)

    if (!briefing) {
      await closePool()
      process.exit(0)
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: briefing,
      },
    }))

    await closePool()
  } catch {
    await closePool().catch(() => {})
    process.exit(0)
  }
}

main().catch(() => process.exit(0))
