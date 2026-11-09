#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readStdinSync } from './utils.mjs'

// ═══════════════════════════════════════════
// Hook: Session Logger (Stop)
// ═══════════════════════════════════════════

const LOG_DIR = join(homedir(), '.claude', 'logs')

function main() {
  try {
    const input = readStdinSync()
    if (!input) process.exit(0)

    const parsed = JSON.parse(input)

    const sessionId = parsed?.session_id ?? 'unknown'
    const cwd = parsed?.cwd ?? ''
    const stopReason = parsed?.stop_reason ?? ''

    const toolsUsed = parsed?.tool_results
      ?.map((t) => t.tool_name)
      ?.filter(Boolean) ?? []

    const errors = parsed?.tool_results
      ?.filter((t) => t.exit_code !== 0 && t.exit_code !== undefined)
      ?.map((t) => ({
        tool: t.tool_name,
        error: (t.stderr || '').slice(0, 200),
      })) ?? []

    const entry = {
      ts: new Date().toISOString(),
      session: sessionId.slice(0, 8),
      cwd: cwd.replace(homedir(), '~'),
      tools: [...new Set(toolsUsed)],
      errors: errors.length > 0 ? errors : undefined,
      stop: stopReason || undefined,
    }

    mkdirSync(LOG_DIR, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const logFile = join(LOG_DIR, `session-${today}.jsonl`)

    appendFileSync(logFile, JSON.stringify(entry) + '\n')
  } catch {
    process.exit(0)
  }
}

main()
