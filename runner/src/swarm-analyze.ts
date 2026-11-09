#!/usr/bin/env tsx
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import dotenv from 'dotenv'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') })

import { sendReport } from './observer/telegram.js'

// ═══════════════════════════════════════════
// Swarm Meta-Analyzer
// ═══════════════════════════════════════════
//
// Reads recent observer results (with full telemetry),
// pipes them to Claude CLI for meta-analysis of swarm performance,
// and sends the analysis to Telegram.
//
// Usage:
//   tsx src/swarm-analyze.ts              — analyze last 7 results
//   tsx src/swarm-analyze.ts --count=14   — analyze last 14 results
//   tsx src/swarm-analyze.ts --dry-run    — print, don't send to Telegram
//   tsx src/swarm-analyze.ts --model=haiku — use specific model

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const RESULTS_DIR = join(__dirname, '..', 'results')

const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? ''
const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'] ?? ''

interface AgentContribution {
  agentId: string
  signalsEmitted: number
  proposalsMade: number
  challengesMade: number
  votesCast: number
  avgConfidence: number
}

interface MathAnalysis {
  entropy: { final: number; normalized: number; history: number[] }
  informationGain: { total: number; perRound: number; lastRound: number }
  redundancy: {
    averageNMI: number
    redundantAgents: string[]
    mostUniqueAgent: string | undefined
  } | null
}

interface ResultFile {
  timestamp: number
  conversations: number
  messages: number
  tokens: number
  analysis: string
  signals?: number
  rounds?: number
  cost?: number
  memoriesStored?: number
  entitiesExtracted?: number
  relationsExtracted?: number
  swarmDurationMs?: number
  confidence?: number
  agentContributions?: Record<string, AgentContribution>
  mathAnalysis?: MathAnalysis
  consensus?: unknown
  signalLog?: unknown[]
}

function hasSwarmTelemetry(r: ResultFile): boolean {
  return r.cost !== undefined && r.signals !== undefined && r.rounds !== undefined
}

function parseArgs() {
  const args = process.argv.slice(2)
  const countArg = args.find(a => a.startsWith('--count='))
  const count = countArg ? Number(countArg.split('=')[1]) : 7
  const dryRun = args.includes('--dry-run')
  const modelArg = args.find(a => a.startsWith('--model='))
  const model = modelArg ? modelArg.split('=')[1] : 'sonnet'
  return { count, dryRun, model }
}

function loadResults(count: number): ResultFile[] {
  if (!existsSync(RESULTS_DIR)) return []

  const files = readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith('observer-') && f.endsWith('.json'))
    .sort()
    .slice(-count)

  return files.map(f => {
    const raw = readFileSync(join(RESULTS_DIR, f), 'utf-8')
    return JSON.parse(raw) as ResultFile
  })
}

function buildTelemetrySummary(results: ResultFile[]): string {
  const lines: string[] = ['# Swarm Telemetry Data\n']

  for (const r of results) {
    const date = new Date(r.timestamp).toISOString().slice(0, 16)
    lines.push(`## Run: ${date}`)
    lines.push(`- Conversations: ${r.conversations}, Messages: ${r.messages}, Tokens: ${r.tokens.toLocaleString()}`)
    lines.push(`- Signals: ${r.signals ?? 0}, Rounds: ${r.rounds ?? 0}, Cost: $${(r.cost ?? 0).toFixed(4)}`)
    lines.push(`- Duration: ${r.swarmDurationMs ? (r.swarmDurationMs / 1000).toFixed(1) + 's' : 'N/A'}`)
    lines.push(`- Confidence: ${r.confidence?.toFixed(3) ?? 'N/A'}`)
    lines.push(`- Entities: ${r.entitiesExtracted ?? 0}, Relations: ${r.relationsExtracted ?? 0}, Memories: ${r.memoriesStored ?? 0}`)

    if (r.agentContributions) {
      lines.push(`\n### Agent Contributions:`)
      for (const [id, c] of Object.entries(r.agentContributions)) {
        lines.push(`  ${id}: signals=${c.signalsEmitted} proposals=${c.proposalsMade} challenges=${c.challengesMade} votes=${c.votesCast} avgConf=${c.avgConfidence.toFixed(3)}`)
      }
    }

    if (r.mathAnalysis) {
      const m = r.mathAnalysis
      lines.push(`\n### Math Analysis:`)
      lines.push(`  Entropy: final=${m.entropy.final.toFixed(4)} normalized=${m.entropy.normalized.toFixed(4)} history=[${m.entropy.history.map(h => h.toFixed(3)).join(', ')}]`)
      lines.push(`  Info Gain: total=${m.informationGain.total.toFixed(4)} perRound=${m.informationGain.perRound.toFixed(4)} lastRound=${m.informationGain.lastRound.toFixed(4)}`)
      if (m.redundancy) {
        lines.push(`  Redundancy: avgNMI=${m.redundancy.averageNMI.toFixed(4)} redundant=[${m.redundancy.redundantAgents.join(', ')}] mostUnique=${m.redundancy.mostUniqueAgent ?? 'none'}`)
      }
    }

    lines.push('')
  }

  return lines.join('\n')
}

const SYSTEM_PROMPT = `You are a swarm intelligence performance analyst. You receive telemetry data from a cognitive-swarm system that runs daily analysis of Claude Code conversations.

The swarm has 6 agents: pattern-detector, decision-tracker, knowledge-extractor, mistake-analyzer, productivity-analyst, report-compiler.

Analyze the telemetry and produce a CONCISE report (max 2000 chars) in Russian with technical terms in English:

1. ЭФФЕКТИВНОСТЬ АГЕНТОВ — кто вносит вклад, кто балласт (signals, proposals, confidence)
2. СХОДИМОСТЬ — entropy trends, достаточно ли раундов или можно сократить
3. ИНФОРМАЦИОННЫЙ ВЫИГРЫШ — information gain per round, есть ли diminishing returns
4. ДУБЛИРОВАНИЕ — redundant agents, можно ли объединить/убрать
5. СТОИМОСТЬ — cost trends, оптимизация
6. РЕКОМЕНДАЦИИ — конкретные actionable изменения конфигурации

Be data-driven. Reference specific numbers. No fluff.
Use plain text, no markdown formatting.`

async function main() {
  const { count, dryRun, model } = parseArgs()

  console.log(`\n🔬 Swarm Meta-Analyzer`)
  console.log(`   Loading last ${count} results...`)

  const allResults = loadResults(count)
  if (allResults.length === 0) {
    console.log('   No results found. Run observe first.')
    return
  }

  // Skip legacy-format results that lack swarm telemetry — meta-analysis on them is meaningless
  const results = allResults.filter(hasSwarmTelemetry)
  const withFullTelemetry = results.filter(r => r.agentContributions || r.mathAnalysis)
  console.log(`   Found ${allResults.length} results (${results.length} swarm-format, ${withFullTelemetry.length} with full telemetry)`)

  if (results.length === 0) {
    console.log('   ⚠️  No swarm-format results found (only legacy observer output). Run observe again with current pipeline.')
    return
  }

  const telemetry = buildTelemetrySummary(results)

  console.log(`   Sending to Claude CLI (model: ${model})...`)

  // Write system prompt to temp file (avoids shell escaping issues)
  const promptFile = join(tmpdir(), 'swarm-analyze-prompt.txt')
  writeFileSync(promptFile, SYSTEM_PROMPT)

  // Pipe telemetry to Claude CLI via spawn (no shell escaping needed)
  let analysis: string
  try {
    const result = spawnSync('claude', [
      '-p',
      '--model', model,
      '--max-budget-usd', '0.50',
      '--system-prompt-file', promptFile,
    ], {
      input: telemetry,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })

    if (result.status !== 0) {
      console.error(`   ❌ Claude CLI failed (exit ${result.status})`)
      if (result.stderr) console.error(`   stderr: ${result.stderr.slice(0, 500)}`)
      if (result.stdout) console.error(`   stdout: ${result.stdout.slice(0, 500)}`)
      return
    }
    analysis = result.stdout.trim()
  } catch (err) {
    console.error(`   ❌ Claude CLI failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  console.log(`   Analysis received (${analysis.length} chars)`)

  if (dryRun) {
    console.log('\n--- Analysis Preview ---')
    console.log(analysis)
    return
  }

  // Send to Telegram
  console.log('   Sending to Telegram...')

  const header = `🔬 Swarm Meta-Analysis (${results.length} runs)\n\n`
  const message = header + analysis

  const sent = await sendReport(
    { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID },
    message,
  )

  console.log(sent ? '   ✅ Sent!' : '   ❌ Failed to send')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
