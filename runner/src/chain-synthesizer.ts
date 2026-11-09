import type { LlmProvider } from './types.js'

// ═══════════════════════════════════════════
// Chain Synthesizer — Multi-step synthesis
// ═══════════════════════════════════════════
// When swarm produces many signals (40+), single-pass
// synthesis loses information. Chain synthesis:
// 1. Groups signals by source agent
// 2. Summarizes each group (parallel LLM calls)
// 3. Final synthesis from group summaries (plain text, no JSON)
//
// This preserves signal detail without hitting token limits.

interface SignalLike {
  readonly source: string
  readonly type: string
  readonly payload: object
  readonly confidence: number
}

export interface ChainSynthesisResult {
  /** Final synthesized report */
  readonly report: string
  /** Per-agent group summaries that were fed to final synthesis */
  readonly groupSummaries: readonly { agent: string; summary: string }[]
  /** Raw signals grouped by agent (for logging) */
  readonly rawSignalsByAgent: readonly { agent: string; signals: readonly string[] }[]
}

const GROUP_SUMMARY_PROMPT = `Summarize the following agent discoveries and proposals into a concise briefing.
Keep ALL specific details: numbers, percentages, dollar amounts, competitor names.
Be concise but lose NO information. Write in Russian with technical terms in English.
Respond in json format: {"summary": "your summary here"}.`

export async function chainSynthesize(
  llm: LlmProvider,
  task: string,
  signals: readonly SignalLike[],
  systemPrompt: string,
): Promise<ChainSynthesisResult> {
  // Step 1: Group signals by source agent
  const groups = new Map<string, SignalLike[]>()
  for (const sig of signals) {
    const key = sig.source
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(sig)
  }

  // Build raw signals log for transparency
  const rawSignalsByAgent = [...groups.entries()].map(([agent, agentSignals]) => ({
    agent,
    signals: agentSignals.map((s, i) => {
      const content = extractPayloadText(s.payload)
      return `${i + 1}. [${s.type}] (conf: ${s.confidence.toFixed(2)}): ${content}`
    }),
  }))

  // Step 2: Summarize each group in parallel (JSON — short responses, safe)
  const groupSummaries = await Promise.all(
    [...groups.entries()].map(async ([agent, agentSignals]) => {
      const signalText = agentSignals
        .map((s, i) => {
          const content = extractPayloadText(s.payload)
          return `${i + 1}. [${s.type}] (confidence: ${s.confidence.toFixed(2)}): ${content}`
        })
        .join('\n')

      try {
        const response = await llm.completeJson<{ summary: string }>(
          [
            { role: 'system', content: GROUP_SUMMARY_PROMPT },
            { role: 'user', content: `Agent: ${agent}\nSignals (${agentSignals.length}):\n${signalText}` },
          ],
          { maxTokens: 1500 },
        )
        return { agent, summary: response.parsed.summary }
      } catch {
        const fallback = agentSignals.map(s => extractPayloadText(s.payload)).join('; ')
        return { agent, summary: fallback }
      }
    }),
  )

  // Step 3: Final synthesis — plain text, high token limit
  const summariesText = groupSummaries
    .map(g => `[${g.agent}]\n${g.summary}`)
    .join('\n\n')

  const result = await llm.complete(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Original task:\n${task}\n\n---\n\nAgent briefings from deliberation (${groups.size} agents, ${signals.length} total signals):\n\n${summariesText}\n\nIMPORTANT: Your report must be based ONLY on what agents actually said in their briefings above. Do not invent data, projections, or arguments that are not grounded in agent output. If agents did not discuss something, note it as a gap, do not fill it with your own analysis.`,
      },
    ],
    { maxTokens: 8000 },
  )

  return {
    report: result.content,
    groupSummaries,
    rawSignalsByAgent,
  }
}

function extractPayloadText(payload: object): string {
  if ('finding' in payload) return String(payload.finding)
  if ('content' in payload) return String(payload.content)
  if ('text' in payload) return String(payload.text)
  return JSON.stringify(payload).slice(0, 300)
}
