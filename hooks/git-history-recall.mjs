#!/usr/bin/env node

/**
 * UserPromptSubmit hook - surface relevant commits from memory.
 *
 * Commits live as `episode` items with payload.source='git-commit'. We scope
 * the recall to type=episode and filter payloads with commit metadata when
 * formatting, so legacy non-commit episodes don't bleed into the context.
 */

import { readStdinSync } from './utils.mjs'
import { recallText, closeMemory } from './memory-client.mjs'

const MAX_RESULTS = 5

async function main() {
  const raw = readStdinSync()
  if (!raw) process.exit(0)

  let input
  try { input = JSON.parse(raw) } catch { process.exit(0) }

  const query = input?.hookSpecificInput?.userMessage
    ?? input?.prompt
    ?? input?.user_message
    ?? ''
  if (!query || query.length < 10) process.exit(0)

  let res = null
  try {
    res = await recallText(query, {
      types: ['episode'],
      limit: MAX_RESULTS,
      mode: 'warm',
    })
  } catch {
    await closeMemory().catch(() => {})
    process.exit(0)
  }

  // Single convention: commit items carry payload.source='git-commit'.
  // Both git-commit-indexer and git-history-indexer (and the legacy migration)
  // set this, so no fallback on agentId is needed.
  const commits = (res?.items ?? []).filter((r) => r.item.payload?.source === 'git-commit')

  if (commits.length === 0) {
    await closeMemory()
    process.exit(0)
  }

  const lines = ['GIT HISTORY (relevant commits):']
  for (const r of commits) {
    const p = r.item.payload ?? {}
    const files = Array.isArray(p.files) ? p.files : []
    const filesShort = files.slice(0, 5).join(', ')
    const more = files.length > 5 ? ` (+${files.length - 5} more)` : ''
    const date = typeof p.date === 'string' ? p.date.slice(0, 10) : ''
    const hash = typeof p.hash === 'string' ? p.hash.slice(0, 8) : ''
    const message = p.message ?? r.item.raw?.text?.split('\n')[0] ?? ''

    lines.push(`  [${date}] ${hash} (score: ${r.score.toFixed(2)})`)
    lines.push(`    ${message}`)
    if (p.body) lines.push(`    ${String(p.body).slice(0, 200)}`)
    if (filesShort) lines.push(`    Files: ${filesShort}${more}`)
    lines.push('')
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: lines.join('\n'),
    },
  }))

  await closeMemory()
}

main().catch(async () => {
  await closeMemory().catch(() => {})
  process.exit(0)
})
