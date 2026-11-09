#!/usr/bin/env node

/**
 * CLI - bulk-index git history into @exocortex/memory.
 *
 *   node git-history-indexer.mjs --repo=/path/to/repo [--since="3 months ago"] [--project=backend]
 *
 * Each commit becomes an `episode` item (kind=commit). Idempotent: IngestService's
 * novelty gate + reinforcement path handles repeated runs; the payload carries
 * the commit hash so it's easy to reason about later.
 */

import { ingestText, closeMemory } from './memory-client.mjs'
import {
  readCommitLog,
  getFilesChanged,
  getDiffStat,
  buildCommitText,
  buildCommitPayload,
} from './git-commit-helpers.mjs'

// ── Args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)

const REPO = args.repo
const SINCE = args.since ?? '3 months ago'
const PROJECT = args.project ?? 'unknown'

if (!REPO) {
  console.error('Usage: node git-history-indexer.mjs --repo=/path/to/repo [--since="3 months ago"] [--project=backend]')
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set')
  process.exit(1)
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Indexing git history: ${REPO}`)
  console.log(`Since: ${SINCE} | Project: ${PROJECT}`)

  const commits = readCommitLog(REPO, SINCE)
  console.log(`Found ${commits.length} commits in range`)
  if (commits.length === 0) return

  let created = 0
  let reinforced = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]
    const files = getFilesChanged(REPO, c.hash)
    const stat = getDiffStat(REPO, c.hash)
    const payload = buildCommitPayload({ ...c, files, stat, project: PROJECT })
    const text = buildCommitText({ subject: c.subject, body: c.body, files })

    try {
      const res = await ingestText(text, {
        kind: 'commit',
        type: 'episode',
        source: 'hook',
        agentId: 'git-history-indexer',
        project: PROJECT,
        importance: 0.5,
        timestamp: c.date ? new Date(c.date) : new Date(),
        payload,
        extra: { hash: c.hash, project: PROJECT },
      })
      if (res.action === 'created') created++
      else if (res.action === 'reinforced') reinforced++
      else skipped++
    } catch (err) {
      failed++
      process.stderr.write(`\nFailed ${c.hash.slice(0, 8)}: ${err?.message ?? err}\n`)
    }

    process.stdout.write(
      `\r  Progress: ${i + 1}/${commits.length} (new=${created} reinforced=${reinforced} skipped=${skipped} err=${failed})`,
    )
  }

  console.log(`\nDone. created=${created} reinforced=${reinforced} skipped=${skipped} failed=${failed}`)
  await closeMemory()
}

main().catch(async (err) => {
  console.error('Fatal:', err?.message ?? err)
  await closeMemory().catch(() => {})
  process.exit(1)
})
