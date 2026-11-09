#!/usr/bin/env tsx
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import dotenv from 'dotenv'

// Load .env from exocortex root
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') })

import { loadRecentConversations, buildAnalysisTask } from './observer/log-parser.js'
import { formatTelegramReport, sendReport } from './observer/telegram.js'
import { GraphStore } from '../../memory-graph/src/index.js'
import { analyzeSessionLogs, formatSessionStats } from './session-analyzer.js'

// ═══════════════════════════════════════════
// Exocortex Runner v2 - Claude CLI Edition
// ═══════════════════════════════════════════
//
// Replaces SwarmOrchestrator + OpenAI with a single
// Claude CLI call (claude-opus-4-6).
//
// Usage:
//   tsx src/run-claude.ts              - analyze last 24h
//   tsx src/run-claude.ts --hours=48   - analyze last 48h
//   tsx src/run-claude.ts --dry-run    - no telegram, print report
//   tsx src/run-claude.ts --no-telegram - save to graph only

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? ''
const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'] ?? ''

const STATE_DIR = join(__dirname, '..', '.state')
const RESULTS_DIR = join(__dirname, '..', 'results')
const LAST_RUN_FILE = join(STATE_DIR, 'last-run.json')

interface RunState {
  lastRunAt: string
  conversationsAnalyzed: number
  totalEntities: number
  totalRelations: number
  processedFiles?: string[]
}

function loadState(): RunState | null {
  if (!existsSync(LAST_RUN_FILE)) return null
  try {
    return JSON.parse(readFileSync(LAST_RUN_FILE, 'utf-8')) as RunState
  } catch {
    return null
  }
}

function saveState(state: RunState): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(LAST_RUN_FILE, JSON.stringify(state, null, 2))
}

function parseArgs() {
  const args = process.argv.slice(2)
  const hoursArg = args.find(a => a.startsWith('--hours='))
  return {
    hours: hoursArg ? Number(hoursArg.split('=')[1]) : 24,
    dryRun: args.includes('--dry-run'),
    noTelegram: args.includes('--no-telegram'),
    verbose: args.includes('--verbose'),
  }
}

// ═══════════════════════════════════════════
// Claude CLI call - single prompt, all-in-one
// ═══════════════════════════════════════════

const CLAUDE_SYSTEM_PROMPT = `You are an intelligence analyst reviewing a developer's daily Claude Code sessions.

You must output a structured report with TWO sections separated by "---JSON---" marker.

SECTION 1: Human-readable report in RUSSIAN (technical terms in English).

Structure:
SUMMARY
One paragraph: what was the user working on today?

KEY DECISIONS
- Decision: ... | Why: ... | Risk: ...

RECURRING PATTERNS
- Pattern: ... | Action: ...

MISTAKES & LESSONS
- Mistake: ... | Root cause: ... | Prevention: ...

NEW KNOWLEDGE
- Fact: ... | Context: ... | When useful: ...

FOCUS & PRODUCTIVITY
- Projects and time distribution
- Context switches
- Unfinished work

SECTION 2: After "---JSON---" marker, output valid JSON for knowledge graph extraction:

{
  "entities": [
    {"name": "specific name", "type": "project|technology|bug|decision|concept|service", "project": "optional", "confidence": 0.5-1.0}
  ],
  "relations": [
    {"from": "name", "fromType": "type", "to": "name", "toType": "type", "relationType": "uses|depends_on|fixed_by|caused_by|decided|contradicts|replaced_by|part_of|related_to", "confidence": 0.5-1.0}
  ],
  "procedures": [
    {"pattern": "short name", "trigger": "when this happens", "action": "do this", "tags": ["tag1"], "confidence": 0.3-0.9}
  ]
}

Rules for extraction:
- Only SPECIFIC things: "BullMQ" yes, "queue" no
- Decisions as entities with descriptive names
- Procedures: only REUSABLE patterns, not one-time fixes
- Keep it concise. Every point must be ACTIONABLE or INFORMATIVE.`

function callClaude(task: string, verbose: boolean): string {
  const tmpFile = join(STATE_DIR, 'claude-task.txt')
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(tmpFile, task)

  const cmd = `claude --model claude-opus-4-6 -p --tools "" < "${tmpFile}"`

  console.log('   Running Claude CLI (opus 4.6)...')
  const startTime = Date.now()

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000, // 5 min
      env: {
        ...process.env,
        ANTHROPIC_MODEL: 'claude-opus-4-6',
      },
    })

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`   Claude done in ${duration}s (${output.length} chars)`)

    if (verbose) {
      console.log('\n--- Raw output ---')
      console.log(output.slice(0, 2000))
      console.log('...\n')
    }

    return output
  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.error(`   Claude CLI failed after ${duration}s: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

function parseClaudeOutput(raw: string): {
  report: string
  entities: Array<{ name: string; type: string; project?: string; confidence?: number }>
  relations: Array<{ from: string; fromType: string; to: string; toType: string; relationType: string; confidence?: number }>
  procedures: Array<{ pattern: string; trigger: string; action: string; tags?: string[]; confidence?: number }>
} {
  const jsonMarker = '---JSON---'
  const markerIdx = raw.indexOf(jsonMarker)

  let report: string
  let jsonPart: string

  if (markerIdx >= 0) {
    report = raw.slice(0, markerIdx).trim()
    jsonPart = raw.slice(markerIdx + jsonMarker.length).trim()
  } else {
    // Try to find JSON block at the end
    const jsonMatch = raw.match(/\{[\s\S]*"entities"[\s\S]*\}/)
    if (jsonMatch) {
      const jsonStart = raw.indexOf(jsonMatch[0])
      report = raw.slice(0, jsonStart).trim()
      jsonPart = jsonMatch[0]
    } else {
      return { report: raw.trim(), entities: [], relations: [], procedures: [] }
    }
  }

  // Extract JSON from possible markdown code blocks
  const codeBlockMatch = jsonPart.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    jsonPart = codeBlockMatch[1]!
  }

  try {
    const data = JSON.parse(jsonPart)
    return {
      report,
      entities: data.entities ?? [],
      relations: data.relations ?? [],
      procedures: data.procedures ?? [],
    }
  } catch (err) {
    console.warn(`   Warning: failed to parse JSON section: ${err instanceof Error ? err.message : String(err)}`)
    return { report, entities: [], relations: [], procedures: [] }
  }
}

// ═══════════════════════════════════════════
// Entity/procedure types validation
// ═══════════════════════════════════════════

const VALID_ENTITY_TYPES = new Set([
  'project', 'technology', 'bug', 'decision', 'person', 'concept', 'file', 'service',
])
const VALID_RELATION_TYPES = new Set([
  'uses', 'depends_on', 'fixed_by', 'caused_by', 'decided', 'contradicts',
  'replaced_by', 'works_on', 'part_of', 'related_to',
])

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════

async function main() {
  const { hours, dryRun, noTelegram, verbose } = parseArgs()
  const state = loadState()

  console.log(`\n🧠 Exocortex Runner v2 (Claude CLI)`)
  console.log(`   Analyzing last ${hours}h of conversations...`)
  if (state) {
    console.log(`   Last run: ${state.lastRunAt} (${state.totalEntities ?? 0} entities)`)
  }

  // -- Load conversations (with deduplication) --
  const allConversations = loadRecentConversations(hours)
  const processedSet = new Set(state?.processedFiles ?? [])
  const conversations = allConversations.filter(c => !processedSet.has(c.filePath))

  if (conversations.length === 0) {
    const skipped = allConversations.length - conversations.length
    console.log(`   No new conversations found.${skipped > 0 ? ` (${skipped} already processed)` : ''} Nothing to analyze.`)
    return
  }

  const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0)
  const totalTokens = conversations.reduce((sum, c) => sum + c.totalTokens, 0)
  const skippedCount = allConversations.length - conversations.length

  console.log(`   Found ${conversations.length} new conversations (${totalMessages} messages, ${totalTokens.toLocaleString()} tokens)${skippedCount > 0 ? ` [${skippedCount} skipped]` : ''}`)

  // -- Build task --
  const conversationData = buildAnalysisTask(conversations)
  const fullPrompt = `${CLAUDE_SYSTEM_PROMPT}\n\n${conversationData}`

  // -- Call Claude CLI --
  const rawOutput = callClaude(fullPrompt, verbose)
  const { report, entities, relations, procedures } = parseClaudeOutput(rawOutput)

  let reportText = report

  // -- Knowledge Graph enrichment --
  const graphStore = new GraphStore()
  let entityCount = 0
  let relationCount = 0

  try {
    // Entities
    const validEntities = entities
      .filter(e => e.name && VALID_ENTITY_TYPES.has(e.type))
      .map(e => ({
        name: e.name,
        type: e.type as 'project' | 'technology' | 'bug' | 'decision' | 'concept' | 'service',
        project: e.project,
        confidence: e.confidence ?? 0.8,
      }))

    const validRelations = relations
      .filter(r => r.from && r.to && VALID_RELATION_TYPES.has(r.relationType) && VALID_ENTITY_TYPES.has(r.fromType) && VALID_ENTITY_TYPES.has(r.toType))
      .map(r => ({
        from: { name: r.from, type: r.fromType as 'project' | 'technology' },
        to: { name: r.to, type: r.toType as 'project' | 'technology' },
        relationType: r.relationType as 'uses' | 'depends_on' | 'related_to',
        confidence: r.confidence ?? 0.8,
      }))

    if (validEntities.length > 0 || validRelations.length > 0) {
      const counts = await graphStore.batchUpsert(validEntities, validRelations)
      entityCount = counts.entities
      relationCount = counts.relations
      const autoLinkedMsg = counts.autoLinked > 0 ? ` (+${counts.autoLinked} auto-linked)` : ''
      console.log(`   Knowledge graph: ${entityCount} entities, ${relationCount} relations${autoLinkedMsg}`)
    }

    // Procedures
    const validProcedures = procedures
      .filter(p => p.pattern && p.trigger && p.action)
      .map(p => ({
        pattern: p.pattern.slice(0, 500),
        triggerCondition: p.trigger.slice(0, 500),
        action: p.action,
        tags: p.tags?.filter((t: string) => typeof t === 'string') ?? [],
        sourceType: 'swarm' as const,
        confidence: Math.min(0.9, Math.max(0.3, p.confidence ?? 0.5)),
      }))

    if (validProcedures.length > 0) {
      const procCount = await graphStore.batchUpsertProcedures(validProcedures)
      console.log(`   Procedural memory: ${procCount} procedures`)
    }

    // Confidence decay + pruning
    const decayed = await graphStore.applyConfidenceDecay()
    if (decayed > 0) console.log(`   Confidence decay: ${decayed} entities`)

    const procDecayed = await graphStore.applyProcedureDecay()
    if (procDecayed > 0) console.log(`   Procedure decay: ${procDecayed}`)

    const pruned = await graphStore.pruneStale()
    if (pruned > 0) console.log(`   Pruned ${pruned} stale entities`)

  } catch (err) {
    console.error(`   Graph enrichment failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await graphStore.close()
  }

  // -- Session log analysis --
  const sessionStats = analyzeSessionLogs(hours)
  if (sessionStats) {
    const statsText = formatSessionStats(sessionStats)
    console.log(`   ${statsText.split('\n')[1]?.trim()}`)
    reportText += '\n\n' + statsText
  }

  // -- Telegram --
  if (!dryRun && !noTelegram) {
    console.log('   Sending report to Telegram...')
    const formatted = formatTelegramReport(reportText, {
      conversations: conversations.length,
      totalMessages,
      totalTokens,
      memoriesStored: entityCount + relationCount,
    })
    const sent = await sendReport(
      { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID },
      formatted,
    )
    console.log(sent ? '   ✅ Report sent!' : '   ❌ Failed to send report')
  } else if (dryRun) {
    console.log('\n--- Report Preview ---')
    console.log(reportText)
  } else {
    console.log('   [no-telegram] Graph updated, no report sent')
  }

  // -- Save results --
  mkdirSync(RESULTS_DIR, { recursive: true })
  const filename = join(RESULTS_DIR, `observer-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`)
  writeFileSync(filename, JSON.stringify({
    timestamp: Date.now(),
    version: 'v2-claude-cli',
    conversations: conversations.length,
    messages: totalMessages,
    tokens: totalTokens,
    analysis: reportText,
    entities: entityCount,
    relations: relationCount,
    procedures: procedures.length,
  }, null, 2))
  console.log(`   Results saved to ${filename}`)

  // -- Save state --
  const newProcessedFiles = conversations.map(c => c.filePath)
  const allProcessed = [...(state?.processedFiles ?? []), ...newProcessedFiles].slice(-200)
  saveState({
    lastRunAt: new Date().toISOString(),
    conversationsAnalyzed: (state?.conversationsAnalyzed ?? 0) + conversations.length,
    totalEntities: (state?.totalEntities ?? 0) + entityCount,
    totalRelations: (state?.totalRelations ?? 0) + relationCount,
    processedFiles: allProcessed,
  })

  console.log('   Done!')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
