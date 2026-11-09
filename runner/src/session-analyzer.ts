import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ═══════════════════════════════════════════
// Session Log Analyzer
// ═══════════════════════════════════════════
// Parses session-YYYY-MM-DD.jsonl files to extract
// usage patterns, tool failure rates, and session stats.

const LOG_DIR = join(homedir(), '.claude', 'logs')

interface SessionEntry {
  ts: string
  session: string
  cwd: string
  tools: string[]
  errors?: Array<{ tool: string; error: string }>
  stop?: string
}

export interface SessionStats {
  totalSessions: number
  uniqueProjects: string[]
  toolUsage: Record<string, number>
  toolErrors: Record<string, number>
  errorRate: number
  topErrors: Array<{ tool: string; error: string; count: number }>
  avgToolsPerSession: number
  sessionsWithErrors: number
}

export function analyzeSessionLogs(hours = 24): SessionStats | null {
  if (!existsSync(LOG_DIR)) return null

  const cutoff = Date.now() - hours * 60 * 60 * 1000
  const entries: SessionEntry[] = []

  try {
    const files = readdirSync(LOG_DIR)
      .filter(f => f.startsWith('session-') && f.endsWith('.jsonl'))
      .sort()
      .reverse()

    for (const file of files) {
      // Quick date check from filename: session-YYYY-MM-DD.jsonl
      const dateStr = file.replace('session-', '').replace('.jsonl', '')
      const fileDate = new Date(dateStr).getTime()
      if (fileDate < cutoff - 86_400_000) break // Skip files older than range + 1 day buffer

      const content = readFileSync(join(LOG_DIR, file), 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as SessionEntry
          if (new Date(entry.ts).getTime() >= cutoff) {
            entries.push(entry)
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch {
    return null
  }

  if (entries.length === 0) return null

  const toolUsage: Record<string, number> = {}
  const toolErrors: Record<string, number> = {}
  const errorMessages: Map<string, number> = new Map()
  const projects = new Set<string>()
  let sessionsWithErrors = 0

  for (const entry of entries) {
    if (entry.cwd) projects.add(entry.cwd)

    for (const tool of entry.tools) {
      toolUsage[tool] = (toolUsage[tool] ?? 0) + 1
    }

    if (entry.errors && entry.errors.length > 0) {
      sessionsWithErrors++
      for (const err of entry.errors) {
        toolErrors[err.tool] = (toolErrors[err.tool] ?? 0) + 1
        const key = `${err.tool}|${err.error.slice(0, 100)}`
        errorMessages.set(key, (errorMessages.get(key) ?? 0) + 1)
      }
    }
  }

  const topErrors = [...errorMessages.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [tool, error] = key.split('|')
      return { tool, error, count }
    })

  const totalTools = entries.reduce((sum, e) => sum + e.tools.length, 0)

  return {
    totalSessions: entries.length,
    uniqueProjects: [...projects],
    toolUsage,
    toolErrors,
    errorRate: entries.length > 0 ? sessionsWithErrors / entries.length : 0,
    topErrors,
    avgToolsPerSession: entries.length > 0 ? Math.round(totalTools / entries.length) : 0,
    sessionsWithErrors,
  }
}

export function formatSessionStats(stats: SessionStats): string {
  const lines: string[] = [
    'SESSION ANALYTICS:',
    `  Sessions: ${stats.totalSessions} (${stats.sessionsWithErrors} with errors, ${(stats.errorRate * 100).toFixed(0)}% error rate)`,
    `  Avg tools/session: ${stats.avgToolsPerSession}`,
    `  Projects: ${stats.uniqueProjects.slice(0, 5).join(', ')}`,
  ]

  const topTools = Object.entries(stats.toolUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  if (topTools.length > 0) {
    lines.push(`  Top tools: ${topTools.map(([t, n]) => `${t}(${n})`).join(', ')}`)
  }

  if (stats.topErrors.length > 0) {
    lines.push('  Recurring errors:')
    for (const err of stats.topErrors) {
      lines.push(`    ${err.tool}: "${err.error}" (×${err.count})`)
    }
  }

  return lines.join('\n')
}
