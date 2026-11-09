#!/usr/bin/env tsx
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

// Load .env from exocortex root (parent of runner/)
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') })

// cognitive-swarm imports (npm packages)
import { SwarmOrchestrator } from '@cognitive-swarm/orchestrator'

// observer modules (local — moved from cognitive-swarm after observer package removal)
import {
  OpenAiLlmProvider,
  OpenAiEmbeddingProvider,
  InMemoryStore,
} from './observer/providers.js'
import { createObserverAgents } from './observer/agents.js'
import { loadRecentConversations, buildAnalysisTask } from './observer/log-parser.js'
import { formatTelegramReport, sendReport } from './observer/telegram.js'

// exocortex imports
import { GraphStore } from '../../memory-graph/src/index.js'
import { extractEntities } from './entity-extractor.js'
import { extractProcedures } from './procedure-extractor.js'
import { detectContradictions, formatContradictions } from './contradiction-detector.js'
import { FileBanditStorage } from './file-bandit-storage.js'
import { analyzeSessionLogs, formatSessionStats } from './session-analyzer.js'
import { chainSynthesize } from './chain-synthesizer.js'
import { LangfuseTracer } from './langfuse-tracer.js'
import { LangfuseSwarmTracer } from './langfuse-swarm-tracer.js'
import { LangfuseLlmWrapper } from './langfuse-llm-wrapper.js'


// ═══════════════════════════════════════════
// Exocortex Runner — Extended Claude Observer
// ═══════════════════════════════════════════
//
// Extends cognitive-swarm observer with:
// - Entity extraction → PostgreSQL knowledge graph
// - Contradiction detection
//
// Usage:
//   tsx src/run.ts              — analyze last 24h, send report
//   tsx src/run.ts --hours=48   — analyze last 48h
//   tsx src/run.ts --no-telegram - save to graph only
//   tsx src/run.ts --verbose    — show full swarm output

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const API_KEY = process.env['OPENAI_API_KEY'] ?? ''
const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? ''
const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'] ?? ''
const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333'

const STATE_DIR = join(__dirname, '..', '.state')
const RESULTS_DIR = join(__dirname, '..', 'results')
const LAST_RUN_FILE = join(STATE_DIR, 'last-run.json')

interface RunState {
  lastRunAt: string
  conversationsAnalyzed: number
  totalInsights: number
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

function parseArgs(): {
  hours: number
  dryRun: boolean
  verbose: boolean
  noTelegram: boolean
} {
  const args = process.argv.slice(2)
  const hoursArg = args.find((a) => a.startsWith('--hours='))
  const hours = hoursArg ? Number(hoursArg.split('=')[1]) : 24
  const dryRun = args.includes('--dry-run')
  const verbose = args.includes('--verbose')
  const noTelegram = args.includes('--no-telegram')
  return { hours, dryRun, verbose, noTelegram }
}

async function main() {
  const { hours, dryRun, verbose, noTelegram } = parseArgs()
  const state = loadState()

  console.log(`\n🧠 Exocortex Runner`)
  console.log(`   Analyzing last ${hours}h of conversations...`)
  if (state) {
    console.log(`   Last run: ${state.lastRunAt} (${state.totalInsights} insights, ${state.totalEntities ?? 0} entities)`)
  }

  // ── Load conversations (with deduplication) ──
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

  console.log(`   Found ${conversations.length} new conversations (${totalMessages} messages, ${totalTokens.toLocaleString()} tokens)${skippedCount > 0 ? ` [${skippedCount} skipped as duplicates]` : ''}`)

  // ── Build analysis task ──
  const task = buildAnalysisTask(conversations)

  if (verbose) {
    console.log('\n--- Task ---')
    console.log(task.slice(0, 2000))
    console.log('...\n')
  }

  // ── Set up swarm (same as original observer) ──
  const MODEL = 'gpt-5.4-mini'
  const rawLlm = new OpenAiLlmProvider(API_KEY, MODEL)
  const llm = new LangfuseLlmWrapper(rawLlm, MODEL)
  const embedding = new OpenAiEmbeddingProvider(API_KEY)
  const engine = { llm, embedding, store: new InMemoryStore() }

  let agents = createObserverAgents(engine)

  const rawSynthLlm = new OpenAiLlmProvider(API_KEY, MODEL)
  const synthLlm = new LangfuseLlmWrapper(rawSynthLlm, MODEL)
  const synthesizerPrompt = `You are compiling a daily intelligence report about the user's Claude Code activity.

Structure your report as:

SUMMARY
One paragraph: what was the user working on today?

KEY DECISIONS
- Decision: ... | Why: ... | Alternatives considered: ...

RECURRING PATTERNS
- Pattern: ... | Frequency: ... | Action: ...

MISTAKES & LESSONS
- Mistake: ... | Root cause: ... | Prevention: ...

NEW KNOWLEDGE
- Fact: ... | Context: ... | When useful: ...

FOCUS & PRODUCTIVITY
- Projects worked on and time distribution
- Context switches
- Unfinished work

Keep it concise. Every bullet point must be ACTIONABLE or INFORMATIVE.
Write in RUSSIAN with technical terms in English.
Use plain text, no markdown formatting.`

  const orchMaxRounds = 3
  const orchMaxSignals = 50
  const orchConsensus = { strategy: 'confidence-weighted' as const, threshold: 0.3 }
  const orchMath = { entropyThreshold: 0.3, minInformationGain: 0.03, redundancyThreshold: 0.5 }

  // ── Observability: Langfuse ──
  const tracer = new LangfuseTracer()
  await tracer.init()

  const swarmTracer = new LangfuseSwarmTracer()
  await swarmTracer.init()

  const banditStorage = new FileBanditStorage(join(STATE_DIR, 'bandit.json'))
  const banditSummary = banditStorage.getSummary()
  if (banditSummary.actions > 0) {
    console.log(`   🎰 Bandit state loaded: ${banditSummary.actions} actions, last updated ${banditSummary.lastUpdated.slice(0, 10)}`)
  }

  const orchestrator = new SwarmOrchestrator({
    agents,
    maxRounds: orchMaxRounds,
    maxSignals: orchMaxSignals,
    timeout: 120_000,
    consensus: orchConsensus,
    synthesizer: {
      llm: synthLlm,
      prompt: synthesizerPrompt,
    },
    math: orchMath,
    banditStorage,
    agentSelection: { topK: 3 },
  })

  // ── Run swarm analysis ──
  const MAX_COST_USD = 0.50
  const HARD_TIMEOUT_MS = 600_000

  tracer.startTrace({
    conversations: conversations.length,
    messages: totalMessages,
    tokens: totalTokens,
    hours,
  })
  tracer.startSwarmSolve(agents.length, orchMaxRounds, MODEL)

  // Attach Langfuse swarm tracer (subscribes to all 20 event types)
  swarmTracer.attach(orchestrator, {
    task: task.slice(0, 500),
    agentCount: agents.length,
    maxRounds: orchMaxRounds,
    conversations: conversations.length,
    hours,
  })

  // Connect all LLM wrappers to the Langfuse trace for token tracking
  const lfTrace = swarmTracer.getTrace()
  llm.setTrace(lfTrace)
  synthLlm.setTrace(lfTrace)

  console.log(`   Running swarm analysis (${agents.length} agents, max ${orchMaxRounds} rounds, cap $${MAX_COST_USD})...`)
  const startTime = Date.now()

  const hardTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout exceeded (5 min)')), HARD_TIMEOUT_MS),
  )

  let result: Awaited<ReturnType<typeof orchestrator.solve>>
  let reportText = ''
  try {
    result = await Promise.race([orchestrator.solve(task), hardTimeout])
    reportText = result.answer
  } catch (error) {
    swarmTracer.detach()
    orchestrator.destroy()
    banditStorage.flush()
    await swarmTracer.shutdown()
    console.error(`   ❌ Swarm aborted: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const swarmDurationMs = Date.now() - startTime
  const swarmDuration = (swarmDurationMs / 1000).toFixed(1)
  swarmTracer.detach()
  orchestrator.destroy()
  banditStorage.flush()
  tracer.endSwarmSolve(result, swarmDurationMs, MODEL)
  console.log(`   🎰 Bandit state saved (${banditStorage.getSummary().actions} actions)`)

  const swarmTokens = rawLlm.tokensUsed + rawSynthLlm.tokensUsed

  console.log(`   Swarm done in ${swarmDuration}s (signals: ${result.signalLog.length}, rounds: ${result.timing.roundsUsed}, tokens: ${swarmTokens})`)

  // Shared post-solve LLM provider — tracks ALL post-solve tokens in one place
  const postSolveLlm = new OpenAiLlmProvider(API_KEY, MODEL)
  const postSolveWrapped = new LangfuseLlmWrapper(postSolveLlm, MODEL)
  postSolveWrapped.setTrace(swarmTracer.getTrace())

  // ── Chain synthesis for high-signal runs ──
  // Use gpt-5.4 for final synthesis — one smart call to distill the debate
  const SYNTH_MODEL = 'gpt-5.4'
  let synthFinalTokens = 0
  if (result.signalLog.length > 25) {
    const synthFinalLlm = new OpenAiLlmProvider(API_KEY, SYNTH_MODEL)
    const synthFinalWrapped = new LangfuseLlmWrapper(synthFinalLlm, SYNTH_MODEL)
    synthFinalWrapped.setTrace(swarmTracer.getTrace())

    console.log(`   Re-synthesizing with chain method (${result.signalLog.length} signals, model: ${SYNTH_MODEL})...`)
    const chainSpan = tracer.startSpan('chain-synthesis', { signals: result.signalLog.length, model: SYNTH_MODEL })
    try {
      const chainResult = await chainSynthesize(
        synthFinalWrapped,
        task,
        result.signalLog,
        synthesizerPrompt,
      )
      const improved = chainResult.report.length > reportText.length * 0.8
      if (improved) {
        reportText = chainResult.report
        console.log(`   Chain synthesis improved report (${reportText.length} chars vs original)`)
      }
      chainSpan.end({ improved })
    } catch (err) {
      chainSpan.end({ error: err instanceof Error ? err.message : String(err) })
      console.log(`   Chain synthesis failed, keeping original: ${err instanceof Error ? err.message : String(err)}`)
    }
    synthFinalTokens = synthFinalLlm.tokensUsed
  }

  // ═══════════════════════════════════════════
  // NEW: Entity extraction → Knowledge Graph
  // ═══════════════════════════════════════════
  const graphStore = new GraphStore()
  let entityCount = 0
  let relationCount = 0

  const entitySpan = tracer.startSpan('entity-extraction')
  try {
    console.log('   Extracting entities for knowledge graph...')
    const extracted = await extractEntities(postSolveWrapped, result.answer)

    if (extracted.entities.length > 0 || extracted.relations.length > 0) {
      const counts = await graphStore.batchUpsert(extracted.entities, extracted.relations)
      entityCount = counts.entities
      relationCount = counts.relations
      const autoLinkedMsg = counts.autoLinked > 0 ? ` (+${counts.autoLinked} auto-linked)` : ''
      console.log(`   Knowledge graph: ${entityCount} entities, ${relationCount} relations${autoLinkedMsg}`)
    } else {
      console.log('   No entities extracted')
    }

    // ═══════════════════════════════════════════
    // Procedural memory extraction
    // ═══════════════════════════════════════════
    const procSpan = tracer.startSpan('procedure-extraction')
    try {
      const procedures = await extractProcedures(postSolveWrapped, result.answer)
      if (procedures.length > 0) {
        const procCount = await graphStore.batchUpsertProcedures(procedures)
        console.log(`   Procedural memory: ${procCount} procedures extracted`)
        procSpan.end({ procedures: procCount })
      } else {
        procSpan.end({ procedures: 0 })
      }
    } catch (err) {
      procSpan.end({ error: err instanceof Error ? err.message : String(err) })
      console.log(`   ⚠️ Procedure extraction failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // ═══════════════════════════════════════════
    // Confidence decay + pruning
    // ═══════════════════════════════════════════
    const decayed = await graphStore.applyConfidenceDecay()
    if (decayed > 0) console.log(`   Confidence decay applied to ${decayed} stale entities`)

    const procDecayed = await graphStore.applyProcedureDecay()
    if (procDecayed > 0) console.log(`   Confidence decay applied to ${procDecayed} stale procedures`)

    const pruned = await graphStore.pruneStale()
    if (pruned > 0) console.log(`   Pruned ${pruned} stale entities (confidence < 0.15, age > 60d)`)

    // ═══════════════════════════════════════════
    // Contradiction detection
    // ═══════════════════════════════════════════
    const decisions = extracted.entities.filter(e => e.type === 'decision')
    let contradictionCount = 0
    if (decisions.length > 0) {
      const contradictSpan = tracer.startSpan('contradiction-detection', { decisions: decisions.length })
      console.log(`   Checking ${decisions.length} decisions for contradictions...`)
      const contradictions = await detectContradictions(postSolveWrapped, graphStore, decisions)
      contradictionCount = contradictions.length

      if (contradictions.length > 0) {
        const warning = formatContradictions(contradictions)
        console.log(warning)
        reportText += '\n\n' + warning
        contradictSpan.end({ contradictions: contradictions.length })
      } else {
        console.log('   No contradictions found')
        contradictSpan.end({ contradictions: 0 })
      }
    }
    entitySpan.end({ entities: entityCount, relations: relationCount, contradictions: contradictionCount })
  } catch (err) {
    entitySpan.end({ error: err instanceof Error ? err.message : String(err) })
    console.error(`   ⚠️ Graph/contradiction step failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await graphStore.close()
  }

  // ═══════════════════════════════════════════
  // ── Session log analysis ──
  const sessionStats = analyzeSessionLogs(hours)
  if (sessionStats) {
    const statsText = formatSessionStats(sessionStats)
    console.log(`   ${statsText.split('\n')[1]?.trim()}`)
    reportText += '\n\n' + statsText
  }

  // ── Cost summary ──
  const postSolveTokens = postSolveLlm.tokensUsed
  const totalTokensUsed = swarmTokens + postSolveTokens
  const baseCost = totalTokensUsed * 0.00000075 // gpt-5.4-mini rate
  // gpt-5.4 synthesis tokens tracked separately (higher rate)
  const synthCost = synthFinalTokens * 0.000005 // gpt-5.4 input rate ~$5/1M
  const totalCost = baseCost + synthCost
  console.log(`   Tokens: ${swarmTokens} (swarm) + ${postSolveTokens} (post-solve)${synthFinalTokens > 0 ? ` + ${synthFinalTokens} (${SYNTH_MODEL} synthesis)` : ''} = ${totalTokensUsed + synthFinalTokens}`)
  console.log(`   Total cost: $${totalCost.toFixed(4)}${synthCost > 0 ? ` (incl. $${synthCost.toFixed(4)} ${SYNTH_MODEL} synthesis)` : ''}`)

  // ── Finalize swarm tracer (after all post-solve LLM calls are recorded) ──
  swarmTracer.finalize(result)

  // ── Langfuse scores & finalize ──
  tracer.scoreTrace({
    confidence: result.confidence,
    signal_density: result.signalLog.length / result.timing.roundsUsed,
    cost_usd: totalCost,
    tokens_total: totalTokensUsed,
    tokens_swarm: swarmTokens,
    tokens_post_solve: postSolveTokens,
    entity_yield: entityCount + relationCount,
    rounds_used: result.timing.roundsUsed,
  })

  // ── Send to Telegram ──
  if (!dryRun && !noTelegram) {
    console.log('   Sending report to Telegram...')

    const report = formatTelegramReport(reportText, {
      conversations: conversations.length,
      totalMessages,
      totalTokens,
      memoriesStored: entityCount + relationCount,
    })

    const sent = await sendReport(
      { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID },
      report,
    )

    console.log(sent ? '   ✅ Report sent!' : '   ❌ Failed to send report')
  } else if (noTelegram) {
    console.log('   [no-telegram] Analysis saved to graph, no report sent')
  } else {
    console.log('   [dry-run] Skipping Telegram send')
    console.log('\n--- Report Preview ---')
    console.log(reportText)
  }

  // ── Save state (with dedup tracking, keep last 200 files) ──
  const newProcessedFiles = conversations.map(c => c.filePath)
  const allProcessed = [...(state?.processedFiles ?? []), ...newProcessedFiles].slice(-200)
  saveState({
    lastRunAt: new Date().toISOString(),
    conversationsAnalyzed: (state?.conversationsAnalyzed ?? 0) + conversations.length,
    totalInsights: entityCount + relationCount,
    totalEntities: (state?.totalEntities ?? 0) + entityCount,
    totalRelations: (state?.totalRelations ?? 0) + relationCount,
    processedFiles: allProcessed,
  })

  // ── Save raw results ──
  mkdirSync(RESULTS_DIR, { recursive: true })
  const filename = join(RESULTS_DIR, `observer-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`)
  // Convert agentContributions Map to plain object for JSON serialization
  const contributions: Record<string, unknown> = {}
  for (const [id, c] of result.agentContributions) {
    contributions[id] = c
  }

  writeFileSync(
    filename,
    JSON.stringify(
      {
        timestamp: Date.now(),
        conversations: conversations.length,
        messages: totalMessages,
        tokens: totalTokens,
        analysis: reportText,
        signals: result.signalLog.length,
        rounds: result.timing.roundsUsed,
        cost: totalCost,
        tokensSwarm: swarmTokens,
        tokensPostSolve: postSolveTokens,
        tokensSynthesis: synthFinalTokens,
        synthModel: synthFinalTokens > 0 ? SYNTH_MODEL : null,
        tokensTotal: totalTokensUsed + synthFinalTokens,
        memoriesStored: entityCount + relationCount,
        entitiesExtracted: entityCount,
        relationsExtracted: relationCount,
        // Swarm telemetry
        swarmDurationMs,
        confidence: result.confidence,
        agentContributions: contributions,
        mathAnalysis: result.mathAnalysis,
        consensus: result.consensus,
        signalLog: result.signalLog,
      },
      null,
      2,
    ),
  )
  console.log(`   Results saved to ${filename}`)

  // ── Observability finalize ──
  await tracer.finalize({
    report: reportText,
    entities: entityCount,
    relations: relationCount,
    procedures: 0, // counted inside the span
    contradictions: 0, // counted inside the span
    cost: totalCost,
  })
  await swarmTracer.shutdown()

}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
