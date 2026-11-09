/**
 * Langfuse Swarm Tracer — traces all 20 cognitive-swarm event types.
 *
 * Uses Langfuse SDK directly (not OTel) because the self-hosted Langfuse
 * instance is v2.x which doesn't support OTLP ingestion.
 *
 * Subscribes to SwarmOrchestrator events and creates:
 *   trace (exocortex-swarm)
 *     ├── span (round-1)
 *     │   ├── span (agent:pattern-analyst)
 *     │   ├── span (agent:decision-tracker)
 *     │   ├── event (signal:discovery)
 *     │   ├── event (consensus:check)
 *     │   └── event (math:analysis)
 *     ├── span (round-2)
 *     │   └── ...
 *     ├── span (debate)     — if triggered
 *     └── span (synthesis)
 *   scores: confidence, entropy, information_gain, signal_count
 */

import type {
  LangfuseClient,
  LangfuseTrace,
  LangfuseSpan,
} from './langfuse-types.js'
import { createLangfuseClient } from './langfuse-types.js'
import type { SwarmEventMap, SwarmResult } from '@cognitive-swarm/core'

interface SwarmOrchestrator {
  on<K extends keyof SwarmEventMap & string>(
    event: K,
    handler: (data: SwarmEventMap[K]) => void,
  ): () => void
}

export class LangfuseSwarmTracer {
  private client: LangfuseClient | null = null
  private trace: LangfuseTrace | null = null
  private roundSpans = new Map<number, LangfuseSpan>()
  private debateSpan: LangfuseSpan | null = null
  private synthesisSpan: LangfuseSpan | null = null
  private cleanups: Array<() => void> = []

  async init(): Promise<boolean> {
    this.client = await createLangfuseClient('swarm tracer')
    return this.client !== null
  }

  get enabled(): boolean {
    return this.client !== null
  }

  /**
   * Start tracing and subscribe to all swarm events.
   */
  attach(orchestrator: SwarmOrchestrator, meta: {
    task: string
    agentCount: number
    maxRounds: number
    conversations: number
    hours: number
  }): void {
    if (!this.client) return

    this.trace = this.client.trace({
      name: 'exocortex-swarm',
      userId: 'dmitry',
      sessionId: `swarm-${new Date().toISOString().slice(0, 10)}`,
      tags: ['exocortex', 'swarm', 'observer'],
      input: {
        task: meta.task.slice(0, 500),
        agentCount: meta.agentCount,
        maxRounds: meta.maxRounds,
        conversations: meta.conversations,
        analysisWindow: `${meta.hours}h`,
      },
      metadata: { agentCount: meta.agentCount, maxRounds: meta.maxRounds },
    })

    this.attachRoundEvents(orchestrator)
    this.attachSignalEvents(orchestrator)
    this.attachAgentEvents(orchestrator)
    this.attachConsensusEvents(orchestrator)
    this.attachDebateEvents(orchestrator)
    this.attachMiscEvents(orchestrator)
  }

  /** Record final results and scores */
  finalize(result: SwarmResult): void {
    if (!this.trace) return

    try {
      this.trace.update({
        output: {
          answerLength: result.answer.length,
          rounds: result.timing.roundsUsed,
          signals: result.signalLog.length,
          confidence: result.confidence,
        },
      })

      this.trace.score({ name: 'confidence', value: result.confidence })
      this.trace.score({ name: 'signal_count', value: result.signalLog.length })
      this.trace.score({ name: 'rounds_used', value: result.timing.roundsUsed })

      this.trace.score({ name: 'entropy', value: result.mathAnalysis.entropy.final })
      this.trace.score({ name: 'information_gain', value: result.mathAnalysis.informationGain.total })
      if (result.mathAnalysis.surprise) {
        this.trace.score({ name: 'surprise', value: result.mathAnalysis.surprise.meanSurprise })
      }
      this.trace.score({ name: 'cost_usd', value: result.cost.estimatedUsd })
    } catch (err) {
      this.logError('finalize', err)
    }
  }

  /** Get the current trace (for wrapping LLM providers). */
  getTrace(): LangfuseTrace | null {
    return this.trace
  }

  /** Detach all event listeners */
  detach(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups.length = 0

    for (const span of this.roundSpans.values()) {
      try { span.end() } catch { /* span already ended */ }
    }
    this.roundSpans.clear()

    if (this.debateSpan) {
      try { this.debateSpan.end() } catch { /* span already ended */ }
      this.debateSpan = null
    }
    if (this.synthesisSpan) {
      try { this.synthesisSpan.end() } catch { /* span already ended */ }
      this.synthesisSpan = null
    }
  }

  async shutdown(): Promise<void> {
    this.detach()
    if (!this.client) return
    try {
      await this.client.flushAsync()
      await this.client.shutdownAsync()
      console.log('   Langfuse swarm tracer: flushed')
    } catch (err) {
      this.logError('shutdown', err)
    }
  }

  // ── Private: event group subscriptions ──

  private attachRoundEvents(orchestrator: SwarmOrchestrator): void {
    this.subscribe(orchestrator, 'round:start', (data) => {
      if (!this.trace) return
      const span = this.trace.span({
        name: `round-${data.round}`,
        metadata: { round: data.round },
      })
      this.roundSpans.set(data.round, span)
    })

    this.subscribe(orchestrator, 'round:end', (data) => {
      const span = this.roundSpans.get(data.round)
      if (span) {
        span.update({ metadata: { signalCount: data.signalCount } })
        span.end()
        this.roundSpans.delete(data.round)
      }
    })
  }

  private attachSignalEvents(orchestrator: SwarmOrchestrator): void {
    this.subscribe(orchestrator, 'signal:emitted', (signal) => {
      this.emitRoundEvent('signal:emitted', {
        signalType: signal.type,
        source: signal.source,
        confidence: signal.confidence,
      })
    })

    this.subscribe(orchestrator, 'signal:delivered', (data) => {
      this.emitRoundEvent('signal:delivered', {
        targetAgent: data.targetAgentId,
        signalType: data.signal.type,
      })
    })

    this.subscribe(orchestrator, 'signal:expired', (signal) => {
      this.emitRoundEvent('signal:expired', { signalId: signal.id })
    })
  }

  private attachAgentEvents(orchestrator: SwarmOrchestrator): void {
    this.subscribe(orchestrator, 'agent:reacted', (reaction) => {
      // Don't create a generation here — LangfuseLlmWrapper already creates
      // llm-* generations with proper token usage. Creating another generation
      // without usage causes Langfuse to show $0 costs.
      this.emitRoundEvent('agent:reacted', {
        agentId: reaction.agentId,
        strategyUsed: reaction.strategyUsed,
        processingTimeMs: reaction.processingTimeMs,
        signalsEmitted: reaction.signals.length,
      })
    })

    this.subscribe(orchestrator, 'agent:error', (data) => {
      this.emitRoundEvent('agent:error', {
        agentId: data.agentId,
        error: data.error instanceof Error ? data.error.message : String(data.error),
      }, 'ERROR')
    })

    this.subscribe(orchestrator, 'tool:called', (data) => {
      this.emitRoundEvent('tool:called', {
        toolName: data.toolName,
        agentId: data.agentId,
        durationMs: data.durationMs,
      })
    })
  }

  private attachConsensusEvents(orchestrator: SwarmOrchestrator): void {
    this.subscribe(orchestrator, 'consensus:reached', (data) => {
      this.emitRoundEvent('consensus:reached', {
        confidence: data.confidence,
        decided: data.decided,
      })
    })

    this.subscribe(orchestrator, 'consensus:failed', (data) => {
      this.emitRoundEvent('consensus:failed', { reason: data.reason })
    })

    this.subscribe(orchestrator, 'proposal:submitted', (data) => {
      this.emitRoundEvent('proposal:submitted', {
        proposerId: data.sourceAgentId,
        summary: data.content.slice(0, 200),
      })
    })

    this.subscribe(orchestrator, 'vote:cast', (data) => {
      this.emitRoundEvent('vote:cast', {
        voterId: data.agentId,
        proposalId: data.proposalId,
      })
    })

    this.subscribe(orchestrator, 'conflict:detected', (data) => {
      this.emitRoundEvent('conflict:detected', {
        signalA: data.signalA.id,
        signalB: data.signalB.id,
      }, 'WARNING')
    })
  }

  private attachDebateEvents(orchestrator: SwarmOrchestrator): void {
    this.subscribe(orchestrator, 'debate:start', (data) => {
      if (!this.trace) return
      this.debateSpan = this.trace.span({
        name: 'debate',
        metadata: { proposalA: data.proposalA, proposalB: data.proposalB },
      })
    })

    this.subscribe(orchestrator, 'debate:round', (data) => {
      this.debateSpan?.event({
        name: 'debate:round',
        metadata: { round: data.round },
      })
    })

    this.subscribe(orchestrator, 'debate:end', (data) => {
      if (this.debateSpan) {
        this.debateSpan.update({ metadata: { resolved: data.resolved, rounds: data.roundsUsed } })
        this.debateSpan.end()
        this.debateSpan = null
      }
    })

    this.subscribe(orchestrator, 'synthesis:start', () => {
      if (!this.trace) return
      this.synthesisSpan = this.trace.span({ name: 'synthesis' })
    })

    this.subscribe(orchestrator, 'synthesis:complete', (data) => {
      if (this.synthesisSpan) {
        // Don't create a generation — LangfuseLlmWrapper handles LLM tracking with usage.
        this.synthesisSpan.update({ output: { answerLength: data.answer.length } })
        this.synthesisSpan.end()
        this.synthesisSpan = null
      }
    })
  }

  private attachMiscEvents(orchestrator: SwarmOrchestrator): void {
    this.subscribe(orchestrator, 'advisor:action', (advice) => {
      this.emitRoundEvent('advisor:action', {
        actionType: advice.type,
        reason: advice.reason,
      })
    })

    this.subscribe(orchestrator, 'topology:updated', (data) => {
      this.emitRoundEvent('topology:updated', { reason: data.reason })
    })
  }

  // ── Private: helpers ──

  /** Type-safe subscription that stores cleanup and wraps in try-catch. */
  private subscribe<K extends keyof SwarmEventMap & string>(
    orchestrator: SwarmOrchestrator,
    event: K,
    handler: (data: SwarmEventMap[K]) => void,
  ): void {
    const cleanup = orchestrator.on(event, (data) => {
      try {
        handler(data)
      } catch (err) {
        this.logError(event, err)
      }
    })
    this.cleanups.push(cleanup)
  }

  /** Emit an event on the latest round span (common pattern for most events). */
  private emitRoundEvent(
    name: string,
    metadata: Record<string, unknown>,
    level?: string,
  ): void {
    const roundSpan = this.getLatestRoundSpan()
    if (!roundSpan) return
    roundSpan.event({ name, metadata, ...(level ? { level } : {}) })
  }

  private getLatestRoundSpan(): LangfuseSpan | null {
    if (this.roundSpans.size === 0) return null
    let latest: LangfuseSpan | null = null
    let maxRound = -1
    for (const [round, span] of this.roundSpans) {
      if (round > maxRound) {
        maxRound = round
        latest = span
      }
    }
    return latest
  }

  private logError(context: string, err: unknown): void {
    console.log(`   Langfuse swarm [${context}]: ${err instanceof Error ? err.message : String(err)}`)
  }
}
