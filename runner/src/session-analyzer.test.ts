import { describe, it, expect, vi, beforeEach } from 'vitest'
import { analyzeSessionLogs, formatSessionStats, type SessionStats } from './session-analyzer.js'

// Mock fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  }
})

import { existsSync, readdirSync, readFileSync } from 'node:fs'

describe('analyzeSessionLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return null when log dir does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)

    const result = analyzeSessionLogs(24)

    expect(result).toBeNull()
  })

  it('should parse session entries and compute stats', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue([`session-${new Date().toISOString().slice(0, 10)}.jsonl`] as any)

    const entries = [
      JSON.stringify({
        ts: new Date().toISOString(),
        session: 'abc123',
        cwd: '~/project-a',
        tools: ['Bash', 'Read', 'Grep'],
        errors: [{ tool: 'Bash', error: 'command not found' }],
      }),
      JSON.stringify({
        ts: new Date().toISOString(),
        session: 'def456',
        cwd: '~/project-b',
        tools: ['Read', 'Edit'],
      }),
    ].join('\n')

    vi.mocked(readFileSync).mockReturnValue(entries)

    const stats = analyzeSessionLogs(24)

    expect(stats).not.toBeNull()
    expect(stats!.totalSessions).toBe(2)
    expect(stats!.sessionsWithErrors).toBe(1)
    expect(stats!.errorRate).toBe(0.5)
    expect(stats!.toolUsage['Read']).toBe(2)
    expect(stats!.toolUsage['Bash']).toBe(1)
    expect(stats!.toolErrors['Bash']).toBe(1)
    expect(stats!.uniqueProjects).toContain('~/project-a')
    expect(stats!.topErrors).toHaveLength(1)
    expect(stats!.topErrors[0].tool).toBe('Bash')
  })

  it('should return null when no entries in time range', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue(['session-2020-01-01.jsonl'] as any)
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ ts: '2020-01-01T00:00:00Z', session: 'x', cwd: '~', tools: [] }),
    )

    const stats = analyzeSessionLogs(24)

    expect(stats).toBeNull()
  })
})

describe('formatSessionStats', () => {
  it('should format stats into readable text', () => {
    const stats: SessionStats = {
      totalSessions: 10,
      uniqueProjects: ['~/project-a', '~/project-b'],
      toolUsage: { Read: 50, Bash: 30, Edit: 20 },
      toolErrors: { Bash: 5 },
      errorRate: 0.2,
      topErrors: [{ tool: 'Bash', error: 'not found', count: 3 }],
      avgToolsPerSession: 10,
      sessionsWithErrors: 2,
    }

    const text = formatSessionStats(stats)

    expect(text).toContain('Sessions: 10')
    expect(text).toContain('2 with errors')
    expect(text).toContain('20%')
    expect(text).toContain('Read(50)')
    expect(text).toContain('Recurring errors')
    expect(text).toContain('not found')
  })
})
