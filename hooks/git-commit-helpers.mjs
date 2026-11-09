/**
 * git-commit-helpers.mjs - shared git-commit extraction used by
 * git-commit-indexer (single, PostToolUse) and git-history-indexer (bulk CLI).
 *
 * Keeps the commit payload shape identical across both producers, so the
 * legacy migration and git-history-recall can rely on a single format.
 */

import { execSync } from 'node:child_process'

const SEP = '\x1f'
const END = '\x1e'

function git(repo, argStr, timeoutMs = 5000) {
  return execSync(`git -C "${repo}" ${argStr}`, { encoding: 'utf-8', timeout: timeoutMs }).trim()
}

/** List files changed by a commit. */
export function getFilesChanged(repo, hash) {
  try {
    const raw = git(repo, `diff-tree --no-commit-id -r --name-only ${hash}`)
    return raw.split('\n').filter(Boolean)
  } catch { return [] }
}

/** Short textual diff stat. */
export function getDiffStat(repo, hash) {
  try {
    return git(repo, `diff-tree --no-commit-id -r --stat=200 ${hash}`)
  } catch { return '' }
}

/** Parse `git log -1` one-commit output. */
export function readLastCommit(repo) {
  const info = git(repo, `log -1 --format="%H${SEP}%s${SEP}%b${SEP}%aI${SEP}%an"`)
  const [hash, subject, body, date, author] = info.split(SEP)
  return { hash, subject, body, date, author }
}

/** Parse `git log --since=...` multi-commit output. */
export function readCommitLog(repo, since) {
  const format = `%H${SEP}%s${SEP}%b${SEP}%aI${SEP}%an${END}`
  const raw = execSync(
    `git -C "${repo}" log --since="${since}" --format="${format}" --no-merges`,
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
  )
  return raw
    .split(END)
    .filter((c) => c.trim())
    .map((c) => {
      const [hash, subject, body, date, author] = c.split(SEP).map((s) => s.trim())
      return { hash, subject, body, date, author }
    })
}

/** Build the text we embed for a commit. Stable across indexers. */
export function buildCommitText({ subject, body, files }) {
  const parts = [subject]
  if (body) parts.push(body)
  if (files && files.length) parts.push(`Files: ${files.join(', ')}`)
  return parts.filter(Boolean).join('\n')
}

/** Build the MemoryItem payload for a commit. Stable shape across producers. */
export function buildCommitPayload({ hash, subject, body, date, author, files, stat, project }) {
  return {
    source: 'git-commit',
    hash,
    message: subject,
    body: body || '',
    date,
    author,
    files,
    stat,
    project,
    summary: subject,
  }
}
