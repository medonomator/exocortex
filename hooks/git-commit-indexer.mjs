#!/usr/bin/env node

/**
 * PostToolUse hook - on successful `git commit`, ingest the commit as an
 * `episode` item (kind=commit). Novelty gate in IngestService handles
 * idempotency across replays.
 */

import { execSync } from 'node:child_process'
import { readStdinSync } from './utils.mjs'
import { ingestText, closeMemory } from './memory-client.mjs'
import {
  getFilesChanged,
  getDiffStat,
  readLastCommit,
  buildCommitText,
  buildCommitPayload,
} from './git-commit-helpers.mjs'

async function main() {
  const raw = readStdinSync()
  if (!raw) process.exit(0)

  let input
  try { input = JSON.parse(raw) } catch { process.exit(0) }

  if ((input?.tool_name ?? '') !== 'Bash') process.exit(0)
  const command = input?.tool_input?.command ?? ''
  const exitCode = input?.tool_output?.exit_code ?? 1
  if (!command.includes('git commit')) process.exit(0)
  if (exitCode !== 0) process.exit(0)

  // Detect repo from command or CWD.
  let repoDir = null
  const cdMatch = command.match(/git\s+-C\s+"?([^"\s]+)"?/)
  if (cdMatch) {
    repoDir = cdMatch[1]
  } else {
    try {
      repoDir = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', timeout: 3000 }).trim()
    } catch { process.exit(0) }
  }
  if (!repoDir) process.exit(0)

  let commit
  try {
    commit = readLastCommit(repoDir)
  } catch { process.exit(0) }

  const files = getFilesChanged(repoDir, commit.hash)
  const stat = getDiffStat(repoDir, commit.hash)
  const project = repoDir.split('/').filter(Boolean).pop() ?? 'unknown'
  const payload = buildCommitPayload({ ...commit, files, stat, project })
  const text = buildCommitText({ subject: commit.subject, body: commit.body, files })

  try {
    await ingestText(text, {
      kind: 'commit',
      type: 'episode',
      source: 'hook',
      agentId: 'git-commit-indexer',
      sessionId: input?.session_id,
      project,
      // Commits are the backbone of episodic memory but they're also
      // frequent + repetitive. Lowered from 0.5 to 0.35 so per-turn
      // user conversation / error learnings (0.6) sit above day-to-day
      // commit noise in the importance signal. Hot commits can still
      // bubble up on vector/lexical/recency.
      importance: 0.35,
      timestamp: commit.date ? new Date(commit.date) : new Date(),
      payload,
      extra: { hash: commit.hash, project },
    })
  } catch { /* silent - don't break commit flow */ }

  await closeMemory().catch(() => {})
}

main().catch(async () => {
  await closeMemory().catch(() => {})
  process.exit(0)
})
