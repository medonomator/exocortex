#!/usr/bin/env node

/**
 * Git File Analyzer — builds per-file intelligence index from git history.
 *
 * Generates file-index.json with:
 *   - Recent commit summaries per file
 *   - Co-change companions (files that always change together)
 *   - Bug ratio (landmine detection)
 *   - Recent bug descriptions
 *
 * Usage:
 *   node git-file-analyzer.mjs --repo=/path/to/repo [--since="3 months ago"] [--output=file-index.json]
 */

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { loadEnv } from './env-loader.mjs'

loadEnv()

// ═══════════════════════════════════════════
// Args
// ═══════════════════════════════════════════

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)

const REPO = args.repo
const SINCE = args.since ?? '3 months ago'
const OUTPUT = args.output ?? `${REPO}/.file-index.json`
const MIN_COMMITS = 2 // Skip files with < 2 commits (not interesting)
const CO_CHANGE_THRESHOLD = 0.5 // 50%+ co-change = companion

if (!REPO) {
  console.error('Usage: node git-file-analyzer.mjs --repo=/path/to/repo')
  process.exit(1)
}

// ═══════════════════════════════════════════
// Git helpers
// ═══════════════════════════════════════════

function git(cmd) {
  return execSync(`git -C "${REPO}" ${cmd}`, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30000,
  }).trim()
}

function getCommits() {
  const SEP = '\x1f'
  const END = '\x1e'
  const raw = git(`log --since="${SINCE}" --no-merges --format="%H${SEP}%s${SEP}%aI${SEP}%an${END}"`)
  if (!raw) return []

  return raw.split(END).filter(c => c.trim()).map(c => {
    const [hash, subject, date, author] = c.split(SEP).map(s => s.trim())
    return { hash, subject, date, author }
  })
}

function getFilesForCommit(hash) {
  try {
    return git(`diff-tree --no-commit-id -r --name-only ${hash}`).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ═══════════════════════════════════════════
// Analysis
// ═══════════════════════════════════════════

function isBugFix(subject) {
  const lower = subject.toLowerCase()
  return lower.startsWith('fix') || lower.includes('bug') || lower.includes('hotfix')
    || lower.includes('patch') || lower.includes('revert')
}

function buildFileIndex(commits) {
  // Step 1: Build per-file commit history + per-commit file sets
  const fileHistory = new Map() // file → [{ hash, subject, date, author, isFix }]
  const commitFiles = new Map() // hash → [files]

  console.log(`Processing ${commits.length} commits...`)

  for (const commit of commits) {
    const files = getFilesForCommit(commit.hash)
    commitFiles.set(commit.hash, files)

    const entry = {
      hash: commit.hash.slice(0, 8),
      subject: commit.subject,
      date: commit.date.slice(0, 10),
      author: commit.author,
      isFix: isBugFix(commit.subject),
    }

    for (const file of files) {
      if (!fileHistory.has(file)) fileHistory.set(file, [])
      fileHistory.get(file).push(entry)
    }
  }

  console.log(`Found ${fileHistory.size} unique files`)

  // Step 2: Build co-change graph
  // For each file, count how often each other file appears in the same commit
  const coChange = new Map() // file → Map<otherFile, count>

  for (const [, files] of commitFiles) {
    if (files.length < 2 || files.length > 30) continue // Skip huge refactors
    for (const f1 of files) {
      if (!coChange.has(f1)) coChange.set(f1, new Map())
      const counts = coChange.get(f1)
      for (const f2 of files) {
        if (f1 === f2) continue
        counts.set(f2, (counts.get(f2) ?? 0) + 1)
      }
    }
  }

  // Step 3: Build final index
  const index = {}
  let hotspots = 0
  let withCompanions = 0

  for (const [file, history] of fileHistory) {
    if (history.length < MIN_COMMITS) continue

    const totalCommits = history.length
    const fixCommits = history.filter(c => c.isFix).length
    const bugRatio = fixCommits / totalCommits

    // Co-change companions
    const counts = coChange.get(file)
    const companions = []
    if (counts) {
      for (const [other, count] of counts) {
        const ratio = count / totalCommits
        if (ratio >= CO_CHANGE_THRESHOLD && count >= 2) {
          companions.push({ file: other, ratio: Math.round(ratio * 100) })
        }
      }
      companions.sort((a, b) => b.ratio - a.ratio)
    }

    // Recent bugs
    const recentBugs = history
      .filter(c => c.isFix)
      .slice(0, 5)
      .map(c => ({ date: c.date, summary: c.subject }))

    // Recent changes (non-fix)
    const recentChanges = history
      .slice(0, 8)
      .map(c => ({
        hash: c.hash,
        date: c.date,
        subject: c.subject,
        isFix: c.isFix,
      }))

    const isHotspot = bugRatio > 0.4 && fixCommits >= 2

    index[file] = {
      totalCommits,
      fixCommits,
      bugRatio: Math.round(bugRatio * 100) / 100,
      hotspot: isHotspot,
      companions: companions.slice(0, 5),
      recentBugs: recentBugs.slice(0, 3),
      recentChanges,
      lastChanged: history[0]?.date ?? '',
      authors: [...new Set(history.map(c => c.author))],
    }

    if (isHotspot) hotspots++
    if (companions.length > 0) withCompanions++
  }

  return { index, stats: { files: Object.keys(index).length, hotspots, withCompanions } }
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════

console.log(`Analyzing git history: ${REPO}`)
console.log(`Since: ${SINCE}`)

const commits = getCommits()
if (commits.length === 0) {
  console.log('No commits found.')
  process.exit(0)
}

const { index, stats } = buildFileIndex(commits)

writeFileSync(OUTPUT, JSON.stringify(index, null, 2))

console.log(`\nDone! Written to ${OUTPUT}`)
console.log(`Files indexed: ${stats.files}`)
console.log(`Hotspots (bug ratio > 40%): ${stats.hotspots}`)
console.log(`Files with companions: ${stats.withCompanions}`)
