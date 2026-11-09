#!/usr/bin/env tsx
/**
 * Swarm Strategic Analysis runner — feeds pre-processed analytics data
 * to the cognitive swarm for multi-agent deliberation.
 *
 * Usage: npx tsx runner/src/run-analytics.ts
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') })

import { SwarmOrchestrator } from '@cognitive-swarm/orchestrator'
import {
  OpenAiLlmProvider,
  OpenAiEmbeddingProvider,
  InMemoryStore,
} from './observer/providers.js'
import { chainSynthesize, type ChainSynthesisResult } from './chain-synthesizer.js'
import { LangfuseSwarmTracer } from './langfuse-swarm-tracer.js'
import { LangfuseLlmWrapper } from './langfuse-llm-wrapper.js'
import type { SwarmAgentDef, SignalType } from '@cognitive-swarm/core'
import type { EngineConfig } from '@cognitive-engine/core'

// ── Config ──

const API_KEY = process.env['OPENAI_API_KEY'] ?? ''
if (!API_KEY) throw new Error('OPENAI_API_KEY not set')

const MODEL = 'gpt-5.4-mini'
const SYNTH_MODEL = 'gpt-5.4'
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'swarm-data')
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'results')

// ── Strategic analyst agents ──

function createAnalystAgents(engine: EngineConfig): SwarmAgentDef[] {
  const base = {
    listens: ['task:new', 'discovery', 'proposal', 'challenge', 'vote'] as readonly SignalType[],
    weight: 1,
  }

  return [
    {
      config: {
        ...base,
        id: 'habit-champion',
        name: 'Habit Product Champion',
        role: 'You believe the data clearly shows habits as the core product. 11 users × 63 actions/user = daily ritual behavior. Tasks (4.5/user) is commodity. Creator tools have zero proven traction. You advocate compressing everything into an AI habit coaching app. Challenge anyone who wants to keep creator features — they are unproven distractions.',
        personality: { curiosity: 0.6, caution: 0.3, conformity: 0.2, verbosity: 0.6 },
        canEmit: ['discovery', 'proposal', 'challenge', 'vote'] as readonly SignalType[],
      },
      engine,
    },
    {
      config: {
        ...base,
        id: 'creator-economy',
        name: 'Creator Economy Strategist',
        role: 'You argue that habits are a retention feature, NOT a business. Nobody pays $5/mo for a habit checkbox. Creator monetization (events, tickets, products) is where revenue comes from — Stripe/Yookassa are already integrated. The 11 habit users generate $0 revenue. You advocate doubling down on creator tools and treating habits as engagement glue, not core product.',
        personality: { curiosity: 0.7, caution: 0.4, conformity: 0.2, verbosity: 0.6 },
        canEmit: ['discovery', 'proposal', 'challenge', 'vote'] as readonly SignalType[],
      },
      engine,
    },
    {
      config: {
        ...base,
        id: 'bridge-architect',
        name: 'Bridge Architect',
        role: 'You see a third path: mentors who use habits to structure their own practice AND sell their methodology to audience. The bridge is "build your habit system → package it as a course/event → sell it." This makes habits AND creator tools synergistic. Challenge both purists — pure habit tracker and pure creator platform both miss the synergy.',
        personality: { curiosity: 0.8, caution: 0.5, conformity: 0.2, verbosity: 0.5 },
        canEmit: ['discovery', 'proposal', 'challenge', 'vote'] as readonly SignalType[],
      },
      engine,
    },
    {
      config: {
        ...base,
        id: 'unit-economics',
        name: 'Unit Economics Hawk',
        role: 'You only care about numbers that lead to survival. Team of 2, 6 months runway. Every path must answer: what is the revenue model, what is realistic ARPU, how many paying users in 6 months, and does the math work? Kill any proposal that cannot show a credible path to $5K MRR in 6 months. Be ruthless about financial viability.',
        personality: { curiosity: 0.5, caution: 0.8, conformity: 0.1, verbosity: 0.5 },
        canEmit: ['challenge', 'discovery', 'proposal', 'vote'] as readonly SignalType[],
      },
      engine,
    },
    {
      config: {
        ...base,
        id: 'competitive-intel',
        name: 'Competitive Intelligence',
        role: 'You analyze the competitive landscape. Habit trackers: Streaks, Habitica, Habitify (all have AI features now). Creator platforms: Patreon, Gumroad, Teachable (massive moats). Where can a team of 2 realistically compete? What niche is underserved? Surface competitive risks for every proposed direction.',
        personality: { curiosity: 0.9, caution: 0.4, conformity: 0.2, verbosity: 0.5 },
        canEmit: ['discovery', 'challenge', 'vote'] as readonly SignalType[],
      },
      engine,
    },
    {
      config: {
        ...base,
        id: 'devil-advocate',
        name: "Devil's Advocate",
        role: 'You destroy weak arguments. If Habit Champion says "63 actions = PMF" — challenge: is 11 users a signal or noise? If Creator Economy says "revenue potential" — challenge: 0 creators currently monetizing. If Bridge says "synergy" — challenge: two-sided complexity for team of 2. Find the fatal flaw in every proposal. Never agree easily.',
        personality: { curiosity: 0.8, caution: 0.3, conformity: 0.1, verbosity: 0.6 },
        canEmit: ['challenge', 'doubt', 'discovery', 'vote'] as readonly SignalType[],
      },
      engine,
    },
  ]
}

// ── Synthesizer prompt ──

const synthesizerPrompt = `You are compiling a TRADE-OFF MAP from a heated multi-agent strategic debate about a product's direction.

The agents debated THREE possible paths:
A) Pivot to AI habit coaching app (compress everything to habits)
B) Double down on creator monetization tools (events, tickets, products)
C) Bridge model: mentors build habits → package as courses → sell

Your job is NOT to pick a winner. Your job is to map the trade-offs so a founder can make an informed decision.

Structure your output as:

CONTEXT
2-3 sentences: what was debated and why this decision matters.

PATH A: COMPRESS TO HABIT COACH
- Strongest arguments FOR (with data cited)
- Strongest arguments AGAINST (with data cited)
- Revenue model and realistic 6-month projection
- Key risk that could kill this path
- What must be true for this path to work

PATH B: DOUBLE DOWN ON CREATOR TOOLS
- Strongest arguments FOR (with data cited)
- Strongest arguments AGAINST (with data cited)
- Revenue model and realistic 6-month projection
- Key risk that could kill this path
- What must be true for this path to work

PATH C: BRIDGE MODEL (HABITS → COURSES → MONETIZATION)
- Strongest arguments FOR (with data cited)
- Strongest arguments AGAINST (with data cited)
- Revenue model and realistic 6-month projection
- Key risk that could kill this path
- What must be true for this path to work

COMPETITIVE REALITY CHECK
Which paths have defensible niches vs which face dominant incumbents?

WHERE AGENTS AGREED
Points that all or most agents converged on — these are likely true regardless of path chosen.

WHERE AGENTS CLASHED HARDEST
The most heated disagreements and why they matter for the decision.

DECISION FRAMEWORK
What information does the founder still need to make this call? What should be tested before committing?

CRITICAL RULES:
- Report ONLY what agents actually argued. Do NOT add your own analysis, projections, or arguments.
- If agents gave revenue projections — include them. If they did NOT — write "Agents did not project revenue for this path."
- If agents disagreed — show both sides faithfully. Do NOT smooth over conflicts.
- If a section has no agent coverage — write "Not discussed by agents" instead of filling gaps.
- Your job is FAITHFUL COMPILATION, not original analysis.

Write in RUSSIAN with technical terms in English. Be specific — cite numbers from agent briefings.
Use plain text, no markdown formatting.`

// ── CLI flags ──

const CHEAP_MODE = process.argv.includes('--cheap')
const SKIP_SYNTHESIS = process.argv.includes('--no-synth')

// ── Main ──

async function main() {
  console.log('🧠 Swarm Strategic Analysis')
  if (CHEAP_MODE) console.log('   💰 CHEAP MODE: 3 agents, 2 rounds, no synthesis (~$0.20-0.40)')

  // Load task
  const summaryPath = join(DATA_DIR, 'confyday-analytics', 'executive-summary.md')
  const taskTemplatePath = join(DATA_DIR, 'confyday-swarm-task-v2.md')

  if (!existsSync(summaryPath) || !existsSync(taskTemplatePath)) {
    throw new Error(`Missing data files. Run prepare-summary.ts first.`)
  }

  const summary = readFileSync(summaryPath, 'utf-8')
  const taskTemplate = readFileSync(taskTemplatePath, 'utf-8')
  const task = taskTemplate.replace('${EXECUTIVE_SUMMARY}', summary)

  console.log(`   Task size: ${task.length} chars`)
  console.log(`   Agents model: ${MODEL}`)
  console.log(`   Synthesis model: ${SYNTH_MODEL}`)

  // Set up LLM
  const rawLlm = new OpenAiLlmProvider(API_KEY, MODEL)
  const llm = new LangfuseLlmWrapper(rawLlm, MODEL)
  const embedding = new OpenAiEmbeddingProvider(API_KEY)
  const engine: EngineConfig = { llm, embedding, store: new InMemoryStore() }

  const rawSynthLlm = new OpenAiLlmProvider(API_KEY, MODEL)
  const synthLlm = new LangfuseLlmWrapper(rawSynthLlm, MODEL)

  const allAgents = createAnalystAgents(engine)
  // Cheap mode: 3 core agents for fast iteration
  const agents = CHEAP_MODE
    ? allAgents.filter(a => ['habit-champion', 'creator-economy', 'devil-advocate'].includes(a.config.id))
    : allAgents
  console.log(`   Agents: ${agents.map(a => a.config.id).join(', ')}`)

  // Set up orchestrator
  const maxRounds = CHEAP_MODE ? 3 : 5
  const maxSignals = CHEAP_MODE ? 30 : 80
  const orchestrator = new SwarmOrchestrator({
    agents,
    maxRounds,
    maxSignals,
    timeout: CHEAP_MODE ? 120_000 : 300_000,
    consensus: { strategy: 'confidence-weighted' as const, threshold: 0.5 },
    synthesizer: { llm: synthLlm, prompt: synthesizerPrompt },
    math: { entropyThreshold: 0.3, minInformationGain: 0.03, redundancyThreshold: 0.5 },
    agentSelection: CHEAP_MODE ? undefined : { topK: 4 },
  })

  // Langfuse tracing
  const swarmTracer = new LangfuseSwarmTracer()
  await swarmTracer.init()
  swarmTracer.attach(orchestrator, {
    task: 'confyday-identity-crisis',
    agentCount: agents.length,
    maxRounds: 5,
    conversations: 0,
    hours: 0,
  })

  const lfTrace = swarmTracer.getTrace()
  llm.setTrace(lfTrace)
  synthLlm.setTrace(lfTrace)

  // Run swarm
  console.log(`   Running deliberation (${agents.length} agents, max ${maxRounds} rounds)...`)
  const startTime = Date.now()

  const HARD_TIMEOUT_MS = 600_000
  const hardTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout exceeded')), HARD_TIMEOUT_MS),
  )

  let result: Awaited<ReturnType<typeof orchestrator.solve>>
  try {
    result = await Promise.race([orchestrator.solve(task), hardTimeout])
  } catch (error) {
    swarmTracer.detach()
    orchestrator.destroy()
    throw error
  }

  const durationMs = Date.now() - startTime
  const duration = (durationMs / 1000).toFixed(1)
  swarmTracer.finalize(result)
  swarmTracer.detach()
  orchestrator.destroy()

  let reportText = result.answer
  const swarmTokens = rawLlm.tokensUsed + rawSynthLlm.tokensUsed
  console.log(`   Swarm done in ${duration}s (signals: ${result.signalLog.length}, rounds: ${result.timing.roundsUsed}, tokens: ${swarmTokens})`)

  // ── Chain synthesis with gpt-5.4 ──
  let synthTokens = 0
  let chainData: ChainSynthesisResult | null = null
  const shouldSynthesize = !CHEAP_MODE && !SKIP_SYNTHESIS && result.signalLog.length > 10
  if (shouldSynthesize) {
    const synthFinalLlm = new OpenAiLlmProvider(API_KEY, SYNTH_MODEL)
    const synthFinalWrapped = new LangfuseLlmWrapper(synthFinalLlm, SYNTH_MODEL)
    synthFinalWrapped.setTrace(lfTrace)

    console.log(`   Final synthesis with ${SYNTH_MODEL} (${result.signalLog.length} signals)...`)
    try {
      chainData = await chainSynthesize(
        synthFinalWrapped,
        task,
        result.signalLog,
        synthesizerPrompt,
      )
      if (chainData.report && chainData.report.length > reportText.length * 0.8) {
        reportText = chainData.report
        console.log(`   Synthesis improved report (${reportText.length} chars)`)
      }
      synthTokens = synthFinalLlm.tokensUsed
    } catch (err) {
      console.log(`   Synthesis failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Cost ──
  const baseCost = swarmTokens * 0.00000075 // gpt-5.4-mini
  const synthCost = synthTokens * 0.000005   // gpt-5.4
  const totalCost = baseCost + synthCost
  console.log(`   Tokens: ${swarmTokens} (swarm) + ${synthTokens} (${SYNTH_MODEL} synthesis) = ${swarmTokens + synthTokens}`)
  console.log(`   Cost: $${totalCost.toFixed(4)} (swarm: $${baseCost.toFixed(4)}, synthesis: $${synthCost.toFixed(4)})`)

  // ── Save results ──
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true })

  const contributions = Object.fromEntries(
    [...result.agentContributions.entries()].map(([id, c]) => [id, {
      agentId: id,
      signalsEmitted: c.signalsEmitted,
      proposalsMade: c.proposalsMade,
      challengesMade: c.challengesMade,
      votesCast: c.votesCast,
      avgConfidence: c.avgConfidence,
    }]),
  )

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const resultFile = join(RESULTS_DIR, `analytics-${timestamp}.json`)

  const resultData = {
    type: 'strategic-analysis',
    timestamp: Date.now(),
    task: 'confyday-analytics',
    analysis: reportText,
    signals: result.signalLog.length,
    rounds: result.timing.roundsUsed,
    durationMs,
    cost: totalCost,
    tokensSwarm: swarmTokens,
    tokensSynthesis: synthTokens,
    synthModel: SYNTH_MODEL,
    agentContributions: contributions,
    mathAnalysis: result.mathAnalysis,
    consensus: result.consensus,
    // Intermediate synthesis data for transparency
    chainSynthesis: chainData ? {
      groupSummaries: chainData.groupSummaries,
      rawSignalsByAgent: chainData.rawSignalsByAgent,
    } : null,
  }

  writeFileSync(resultFile, JSON.stringify(resultData, null, 2))
  console.log(`   Results saved to ${resultFile}`)

  // Save readable agent logs separately
  if (chainData) {
    const agentLogFile = join(RESULTS_DIR, `analytics-${timestamp}-agents.txt`)
    const agentLog = chainData.rawSignalsByAgent
      .map(g => `\n${'═'.repeat(50)}\n${g.agent.toUpperCase()} (${g.signals.length} raw signals)\n${'═'.repeat(50)}\n${g.signals.join('\n')}`)
      .join('\n')
    const summaryLog = chainData.groupSummaries
      .map(g => `\n${'─'.repeat(50)}\n${g.agent} — SUMMARY (fed to gpt-5.4)\n${'─'.repeat(50)}\n${g.summary}`)
      .join('\n')
    writeFileSync(agentLogFile, `RAW AGENT SIGNALS\n${agentLog}\n\n${'═'.repeat(50)}\nGROUP SUMMARIES (input to final synthesis)\n${summaryLog}\n`)
    console.log(`   Agent logs saved to ${agentLogFile}`)
  }

  // Print report
  console.log('\n' + '═'.repeat(60))
  console.log('STRATEGIC ANALYSIS REPORT')
  console.log('═'.repeat(60))
  console.log(reportText)
  console.log('═'.repeat(60))

  // Flush Langfuse
  await swarmTracer.shutdown()
  console.log('   Langfuse flushed')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
