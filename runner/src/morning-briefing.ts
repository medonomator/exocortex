#!/usr/bin/env tsx
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import type pg from 'pg'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') })

import { sendReport } from './observer/telegram.js'
import { analyzeSessionLogs, formatSessionStats } from './session-analyzer.js'
import { createPool } from './shared/db.js'

// Zero LLM cost — pure graph queries + formatting
//
// Usage:
//   tsx src/morning-briefing.ts            — send to Telegram
//   tsx src/morning-briefing.ts --dry-run  — preview only

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const RESULTS_DIR = join(__dirname, '..', 'results')

const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? ''
const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'] ?? ''

function parseArgs() {
  return { dryRun: process.argv.includes('--dry-run') }
}

interface RecentEntity {
  name: string
  type: string
  project: string | null
  mention_count: number
  confidence: number
}

interface RecentDecision {
  name: string
  project: string | null
  confidence: number
}

interface IsolatedEntity {
  name: string
  type: string
}

async function getRecentEntities(pool: pg.Pool, hours = 48): Promise<RecentEntity[]> {
  const { rows } = await pool.query<RecentEntity>(`
    SELECT name, type, project, mention_count, confidence
    FROM kg_entities
    WHERE last_seen > NOW() - INTERVAL '1 hour' * $1
      AND confidence > 0.3
    ORDER BY mention_count DESC, last_seen DESC
    LIMIT 10
  `, [hours])
  return rows
}

async function getActiveDecisions(pool: pg.Pool): Promise<RecentDecision[]> {
  const { rows } = await pool.query<RecentDecision>(`
    SELECT name, project, confidence
    FROM kg_entities
    WHERE type = 'decision'
      AND last_seen > NOW() - INTERVAL '7 days'
      AND confidence > 0.5
    ORDER BY last_seen DESC
    LIMIT 5
  `)
  return rows
}

async function getIsolatedEntities(pool: pg.Pool): Promise<IsolatedEntity[]> {
  const { rows } = await pool.query<IsolatedEntity>(`
    SELECT name, type FROM kg_entities
    WHERE (metadata->>'isolated')::boolean = true
      AND confidence > 0.3
    ORDER BY last_seen DESC
    LIMIT 5
  `)
  return rows
}

interface ResultSummary {
  conversations: number
  messages: number
  tokens: number
  entities: number
  relations: number
  procedures: number
}

function loadLatestResult(): ResultSummary | null {
  try {
    const files = readdirSync(RESULTS_DIR)
      .filter(f => f.startsWith('observer-') && f.endsWith('.json'))
      .sort()

    if (files.length === 0) return null

    const latest = files[files.length - 1]!
    const raw = readFileSync(join(RESULTS_DIR, latest), 'utf-8')
    return JSON.parse(raw) as ResultSummary
  } catch {
    return null
  }
}

function formatBriefing(
  entities: RecentEntity[],
  decisions: RecentDecision[],
  isolated: IsolatedEntity[],
  result: ResultSummary | null,
  sessionStats: string | null,
): string {
  const date = new Date().toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const lines: string[] = [
    `Утренний брифинг | ${date}`,
    '',
  ]

  if (result) {
    const tokensK = ((result.tokens ?? 0) / 1000).toFixed(1)
    lines.push('ПОСЛЕДНИЙ АНАЛИЗ:')
    lines.push(`  ${result.conversations ?? 0} разговоров, ${result.messages ?? 0} сообщений, ${tokensK}K токенов`)
    lines.push(`  +${result.entities ?? 0} entities, +${result.relations ?? 0} relations, +${result.procedures ?? 0} procedures`)
    lines.push('')
  }

  if (entities.length > 0) {
    lines.push('АКТИВНЫЙ ФОКУС:')
    for (const e of entities) {
      const proj = e.project ? `, ${e.project}` : ''
      lines.push(`  - ${e.name} (${e.type}${proj}) — ${e.mention_count} упоминаний`)
    }
    lines.push('')
  }

  if (decisions.length > 0) {
    lines.push('РЕШЕНИЯ:')
    for (const d of decisions) {
      const proj = d.project ? ` [${d.project}]` : ''
      lines.push(`  - ${d.name}${proj} (confidence: ${Number(d.confidence).toFixed(2)})`)
    }
    lines.push('')
  }

  if (sessionStats) {
    // Extract just the summary line from session stats
    const firstLine = sessionStats.split('\n').find(l => l.includes('sessions'))
    if (firstLine) {
      lines.push('СЕССИИ:')
      lines.push(`  ${firstLine.trim()}`)
      lines.push('')
    }
  }

  if (isolated.length > 0) {
    lines.push('ИЗОЛИРОВАННЫЕ ENTITIES (нет связей):')
    lines.push(`  ${isolated.map(e => `${e.name} (${e.type})`).join(', ')}`)
    lines.push('')
  }

  if (lines.length <= 2) {
    lines.push('Нет данных для брифинга. Граф пока пуст.')
  }

  return lines.join('\n')
}

async function main() {
  const { dryRun } = parseArgs()
  const pool = createPool()

  console.log(`\n☀️ Morning Briefing${dryRun ? ' [dry-run]' : ''}`)

  try {
    const [entities, decisions, isolated] = await Promise.all([
      getRecentEntities(pool),
      getActiveDecisions(pool),
      getIsolatedEntities(pool),
    ])

    const result = loadLatestResult()
    const sessionStats = analyzeSessionLogs(24)
    const statsText = sessionStats ? formatSessionStats(sessionStats) : null

    const briefing = formatBriefing(entities, decisions, isolated, result, statsText)

    if (dryRun) {
      console.log('\n--- Briefing Preview ---')
      console.log(briefing)
      return
    }

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      // Escape MarkdownV2 special chars — briefing is plain text, no formatting needed
      const escaped = briefing.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
      const sent = await sendReport(
        { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID },
        escaped,
      )
      console.log(sent ? '   ✅ Sent!' : '   ❌ Failed to send')
    } else {
      console.log('   No Telegram credentials, printing:')
      console.log(briefing)
    }
  } finally {
    await pool.end()
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
