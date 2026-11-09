import { describe, it, expect, vi } from 'vitest'
import { detectContradictions, formatContradictions } from './contradiction-detector.js'
import type { LlmProvider } from './types.js'
import type { GraphStore } from '../../memory-graph/src/graph-store.js'

function mockLlm(responses: unknown[]): LlmProvider {
  const fn = vi.fn()
  for (const r of responses) {
    fn.mockResolvedValueOnce({ parsed: r })
  }
  return { complete: vi.fn(), completeJson: fn }
}

interface RecentDecision {
  name: string
  lastSeen: Date
}

function mockGraphStore(decisions: RecentDecision[]): Pick<GraphStore, 'getRecentDecisions'> {
  return { getRecentDecisions: vi.fn().mockResolvedValue(decisions) }
}

describe('detectContradictions', () => {
  it('returns contradictions reported by the LLM', async () => {
    const llm = mockLlm([[{
      existingDecision: 'Use PostgreSQL only',
      isContradiction: true,
      explanation: 'Goes against previous decision',
      severity: 'high',
    }]])
    const store = mockGraphStore([{ name: 'Use PostgreSQL only', lastSeen: new Date('2026-01-01') }])

    const result = await detectContradictions(llm, store, [{ name: 'Use SQLite', project: 'test' }])

    expect(result).toEqual([{
      newDecision: 'Use SQLite',
      oldDecision: 'Use PostgreSQL only',
      project: 'test',
      explanation: 'Goes against previous decision',
      severity: 'high',
    }])
    expect(store.getRecentDecisions).toHaveBeenCalledWith({ project: 'test', days: 30, limit: 20 })
  })

  it('skips the LLM when the graph has no recent decisions', async () => {
    const llm = mockLlm([])
    const store = mockGraphStore([])

    const result = await detectContradictions(llm, store, [{ name: 'Brand new decision' }])

    expect(result).toHaveLength(0)
    expect(llm.completeJson).not.toHaveBeenCalled()
  })

  it('does not compare a decision with itself', async () => {
    const llm = mockLlm([])
    const store = mockGraphStore([{ name: 'use sqlite', lastSeen: new Date() }])

    const result = await detectContradictions(llm, store, [{ name: 'Use SQLite' }])

    expect(result).toHaveLength(0)
    expect(llm.completeJson).not.toHaveBeenCalled()
  })

  it('ignores items the LLM marks as non-contradictions', async () => {
    const llm = mockLlm([[{
      existingDecision: 'Old approach',
      isContradiction: false,
      explanation: 'Natural evolution',
      severity: 'low',
    }]])
    const store = mockGraphStore([{ name: 'Old approach', lastSeen: new Date() }])

    const result = await detectContradictions(llm, store, [{ name: 'New approach' }])

    expect(result).toHaveLength(0)
  })

  it('swallows LLM errors', async () => {
    const llm: LlmProvider = {
      complete: vi.fn(),
      completeJson: vi.fn().mockRejectedValue(new Error('API error')),
    }
    const store = mockGraphStore([{ name: 'Old approach', lastSeen: new Date() }])

    const result = await detectContradictions(llm, store, [{ name: 'New approach' }])

    expect(result).toHaveLength(0)
  })
})

describe('formatContradictions', () => {
  it('should format contradictions with severity', () => {
    const text = formatContradictions([
      {
        newDecision: 'Use SQLite',
        oldDecision: 'Use PostgreSQL only',
        project: 'confyday',
        explanation: 'Contradicts DB strategy',
        severity: 'high',
      },
    ])

    expect(text).toContain('CONTRADICTIONS DETECTED')
    expect(text).toContain('[high]')
    expect(text).toContain('Use SQLite')
    expect(text).toContain('confyday')
  })

  it('should return empty string for no contradictions', () => {
    expect(formatContradictions([])).toBe('')
  })
})
