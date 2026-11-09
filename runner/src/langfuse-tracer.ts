/**
 * Langfuse tracer for Exocortex swarm runs.
 *
 * Creates a rich trace hierarchy:
 *   trace (exocortex-observer)
 *     ├── span (swarm-solve)           — orchestrator.solve()
 *     │   ├── span (round-1..N)        — each deliberation round
 *     │   └── span (synthesis)         — final synthesis
 *     ├── span (entity-extraction)     — LLM entity extraction
 *     ├── span (procedure-extraction)  — LLM procedure extraction
 *     ├── span (contradiction-detection)
 *     ├── span (chain-synthesis)       — optional chain re-synthesis
 *     └── span (evolution)             — swarm self-evolution
 *   scores: confidence, signal_density, cost_efficiency, entity_yield
 *
 * Gracefully degrades to no-ops when Langfuse is not configured.
 */

import type {
  LangfuseClient,
  LangfuseTrace,
  LangfuseSpan,
} from './langfuse-types.js'
import { createLangfuseClient } from './langfuse-types.js'
import type { SwarmResult } from '@cognitive-swarm/core'


export class LangfuseTracer {
  private client: LangfuseClient | null = null
  private trace: LangfuseTrace | null = null
  private swarmSpan: LangfuseSpan | null = null

  async init(): Promise<void> {
    this.client = await createLangfuseClient('observer tracer')
  }

  get enabled(): boolean {
    return this.client !== null
  }

  /** Start top-level trace for an observer run */
  startTrace(opts: {
    conversations: number
    messages: number
    tokens: number
    hours: number
    activeGenome?: string
    evolvedAgents?: string[]
  }): void {
    if (!this.client) return

    try {
      this.trace = this.client.trace({
        name: 'exocortex-observer',
        userId: 'dmitry',
        sessionId: `observer-${new Date().toISOString().slice(0, 10)}`,
        tags: ['exocortex', 'observer', 'daily'],
        metadata: {
          conversations: opts.conversations,
          messages: opts.messages,
          tokens: opts.tokens,
          hours: opts.hours,
          activeGenome: opts.activeGenome,
          evolvedAgents: opts.evolvedAgents,
        },
        input: {
          conversations: opts.conversations,
          messages: opts.messages,
          analysisWindow: `${opts.hours}h`,
        },
      })
    } catch (err) {
      this.logError('startTrace', err)
    }
  }

  /** Start swarm solve span */
  startSwarmSolve(agentCount: number, maxRounds: number, model: string): void {
    if (!this.trace) return

    try {
      this.swarmSpan = this.trace.span({
        name: 'swarm-solve',
        metadata: { agentCount, maxRounds, model },
      })
    } catch (err) {
      this.logError('startSwarmSolve', err)
    }
  }

  /** End swarm solve span with results */
  endSwarmSolve(result: SwarmResult, durationMs: number, model: string): void {
    if (!this.swarmSpan || !this.trace) return

    try {
      this.swarmSpan.update({
        metadata: {
          rounds: result.timing.roundsUsed,
          signals: result.signalLog.length,
          confidence: result.confidence,
          entropy: result.mathAnalysis.entropy.final,
          normalizedEntropy: result.mathAnalysis.entropy.normalized,
          informationGain: result.mathAnalysis.informationGain.total,
          surprise: result.mathAnalysis.surprise?.meanSurprise,
          consensusDecided: result.consensus.decided,
          durationMs,
        },
        output: {
          answerLength: result.answer.length,
          rounds: result.timing.roundsUsed,
          signals: result.signalLog.length,
        },
      })
      this.swarmSpan.end()

      // Agent contribution generations
      for (const [agentId, contrib] of result.agentContributions) {
        this.trace.generation({
          name: `agent-${agentId}`,
          model,
          metadata: {
            signalsEmitted: contrib.signalsEmitted,
            proposalsMade: contrib.proposalsMade,
            avgConfidence: contrib.avgConfidence,
          },
        })
      }
    } catch (err) {
      this.logError('endSwarmSolve', err)
    }
  }

  /** Create a tracked span for post-solve operations */
  startSpan(name: string, metadata?: Record<string, unknown>): SpanHandle {
    if (!this.trace) return NO_OP_SPAN_HANDLE

    try {
      const span = this.trace.span({ name, metadata })
      return {
        end: (output?: Record<string, unknown>) => {
          try {
            if (output) span.update({ output })
            span.end()
          } catch {
            // Span already ended or trace closed
          }
        },
        generation: (genName: string, model: string, input?: unknown) => {
          try {
            const gen = span.generation({ name: genName, model, input })
            return {
              end: (output?: unknown, usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) => {
                try {
                  gen.end({ output, usage })
                } catch {
                  // Generation already ended
                }
              },
            }
          } catch {
            return NO_OP_GEN_HANDLE
          }
        },
      }
    } catch {
      return NO_OP_SPAN_HANDLE
    }
  }

  /** Record numeric scores for the trace */
  scoreTrace(scores: Record<string, number>): void {
    if (!this.trace) return

    try {
      for (const [name, value] of Object.entries(scores)) {
        this.trace.score({ name, value })
      }
    } catch (err) {
      this.logError('scoreTrace', err)
    }
  }

  /** Finalize trace with output and flush */
  async finalize(output: {
    report: string
    entities: number
    relations: number
    procedures: number
    contradictions: number
    cost: number
  }): Promise<void> {
    if (!this.trace) return

    try {
      this.trace.update({
        output: {
          reportLength: output.report.length,
          entities: output.entities,
          relations: output.relations,
          procedures: output.procedures,
          contradictions: output.contradictions,
          cost: output.cost,
        },
      })
    } catch (err) {
      this.logError('finalize', err)
    }

    await this.shutdown()
  }

  async shutdown(): Promise<void> {
    if (!this.client) return

    try {
      await this.client.flushAsync()
      await this.client.shutdownAsync()
      console.log('   Langfuse flushed')
    } catch (err) {
      this.logError('shutdown', err)
    }
  }

  private logError(method: string, err: unknown): void {
    console.log(`   Langfuse ${method} error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface SpanHandle {
  end(output?: Record<string, unknown>): void
  generation(name: string, model: string, input?: unknown): GenHandle
}

export interface GenHandle {
  end(output?: unknown, usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): void
}

const NO_OP_GEN_HANDLE: GenHandle = { end: () => {} }
const NO_OP_SPAN_HANDLE: SpanHandle = {
  end: () => {},
  generation: () => NO_OP_GEN_HANDLE,
}
