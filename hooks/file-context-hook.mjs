#!/usr/bin/env node

/**
 * File Context Hook — PostToolUse on Read/Edit.
 * When Claude reads or edits a file, injects git intelligence:
 *   - Recent changes to this file
 *   - Co-change companions ("don't forget to update these too")
 *   - Landmine warnings (high bug ratio)
 *   - Recent bugs in this file
 *
 * Zero API calls — reads from pre-built .file-index.json (built by git-file-analyzer.mjs)
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { readStdinSync } from './utils.mjs'

// ═══════════════════════════════════════════
// Parse hook input
// ═══════════════════════════════════════════

const raw = readStdinSync()
let input
try { input = JSON.parse(raw) } catch { process.exit(0) }

const toolName = input?.tool_name ?? ''

// Only trigger on Read and Edit
if (toolName !== 'Read' && toolName !== 'Edit') process.exit(0)

const filePath = input?.tool_input?.file_path ?? ''
if (!filePath) process.exit(0)

// ═══════════════════════════════════════════
// Find repo root and file-index.json
// ═══════════════════════════════════════════

let repoRoot
try {
  repoRoot = execSync(`git -C "${resolve(filePath, '..')}" rev-parse --show-toplevel`, {
    encoding: 'utf-8',
    timeout: 3000,
  }).trim()
} catch {
  // Not in a git repo
  process.exit(0)
}

const indexPath = resolve(repoRoot, '.file-index.json')
if (!existsSync(indexPath)) process.exit(0)

// ═══════════════════════════════════════════
// Load index and lookup file
// ═══════════════════════════════════════════

let index
try {
  index = JSON.parse(readFileSync(indexPath, 'utf-8'))
} catch {
  process.exit(0)
}

// Convert absolute path to relative (matching index keys)
const relPath = relative(repoRoot, filePath)
const fileData = index[relPath]

if (!fileData) process.exit(0) // File not in index (< 2 commits or not tracked)

// ═══════════════════════════════════════════
// Build context
// ═══════════════════════════════════════════

const lines = []

// Header
lines.push(`FILE INTELLIGENCE: ${relPath}`)
lines.push(`  Changed ${fileData.totalCommits}× in last 3 months | ${fileData.fixCommits} bug fixes | Last: ${fileData.lastChanged}`)

// Landmine warning
if (fileData.hotspot) {
  lines.push(`  ⚠️ HOTSPOT: ${Math.round(fileData.bugRatio * 100)}% of commits were bug fixes — test carefully!`)
}

// Recent changes
if (fileData.recentChanges?.length > 0) {
  lines.push('  Recent changes:')
  for (const c of fileData.recentChanges.slice(0, 5)) {
    const marker = c.isFix ? '🔧' : '  '
    lines.push(`    ${marker} ${c.date} ${c.hash}: ${c.subject}`)
  }
}

// Recent bugs
if (fileData.recentBugs?.length > 0) {
  lines.push('  Known bugs in this file:')
  for (const b of fileData.recentBugs) {
    lines.push(`    • ${b.date}: ${b.summary}`)
  }
}

// Co-change companions
if (fileData.companions?.length > 0) {
  lines.push('  Usually changes together with:')
  for (const c of fileData.companions.slice(0, 4)) {
    lines.push(`    → ${c.file} (${c.ratio}% co-change)`)
  }
}

// ═══════════════════════════════════════════
// Output
// ═══════════════════════════════════════════

const output = {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: lines.join('\n'),
  },
}

process.stdout.write(JSON.stringify(output))
