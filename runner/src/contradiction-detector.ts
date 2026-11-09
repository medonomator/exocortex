import type { GraphStore } from '../../memory-graph/src/graph-store.js'
import type { LlmProvider } from './types.js'

// ═══════════════════════════════════════════
// Contradiction Detector — Post-entity-extraction
// ═══════════════════════════════════════════
// Compares new decisions against recent decisions in the graph
// using semantic batch comparison (not just exact name match).

export interface Contradiction {
  newDecision: string
  oldDecision: string
  project?: string
  explanation: string
  severity: 'low' | 'medium' | 'high'
}

interface BatchComparisonItem {
  existingDecision: string
  isContradiction: boolean
  explanation: string
  severity: 'low' | 'medium' | 'high'
}

const BATCH_COMPARE_PROMPT = `You compare a NEW decision against a list of EXISTING decisions made by the same developer.

Find any contradictions where the new decision goes AGAINST an existing one without acknowledging the change.

NOT a contradiction: natural evolution, refinement, or explicitly changing approach.
IS a contradiction: doing the opposite of what was decided without explanation.

Return a JSON array. Only include entries where isContradiction is true.
Return empty array [] if no contradictions found.

Format:
[{
  "existingDecision": "name of conflicting existing decision",
  "isContradiction": true,
  "explanation": "brief explanation",
  "severity": "low" | "medium" | "high"
}]`

export async function detectContradictions(
  llm: LlmProvider,
  graphStore: Pick<GraphStore, 'getRecentDecisions'>,
  newDecisions: Array<{ name: string; project?: string }>,
): Promise<Contradiction[]> {
  if (newDecisions.length === 0) return []

  const contradictions: Contradiction[] = []

  // Group new decisions by project to minimize DB queries
  const byProject = new Map<string, typeof newDecisions>()
  for (const d of newDecisions) {
    const key = d.project ?? '__none__'
    const group = byProject.get(key) ?? []
    group.push(d)
    byProject.set(key, group)
  }

  for (const [, decisions] of byProject) {
    const project = decisions[0]?.project

    // Fetch recent decisions from graph (last 30 days)
    const existing = await graphStore.getRecentDecisions({ project, days: 30, limit: 20 })
    if (existing.length === 0) continue

    // Filter out exact name matches (those are updates, not contradictions to detect semantically)
    const newNames = new Set(decisions.map(d => d.name.toLowerCase()))
    const candidates = existing.filter(e => !newNames.has(e.name.toLowerCase()))
    if (candidates.length === 0) continue

    for (const newDecision of decisions) {
      try {
        const existingList = candidates
          .map((e, i) => `${i + 1}. "${e.name}" (seen: ${new Date(e.lastSeen).toLocaleDateString()})`)
          .join('\n')

        const response = await llm.completeJson<BatchComparisonItem[]>(
          [
            { role: 'system', content: BATCH_COMPARE_PROMPT },
            {
              role: 'user',
              content: `NEW DECISION: "${newDecision.name}"${project ? `\nProject: ${project}` : ''}\n\nEXISTING DECISIONS:\n${existingList}`,
            },
          ],
          { maxTokens: 500 },
        )

        const results = Array.isArray(response.parsed) ? response.parsed : []
        for (const item of results) {
          if (item.isContradiction && item.existingDecision) {
            contradictions.push({
              newDecision: newDecision.name,
              oldDecision: item.existingDecision,
              project,
              explanation: item.explanation,
              severity: item.severity ?? 'medium',
            })
          }
        }
      } catch {
        // Skip on error — don't block the pipeline
      }
    }
  }

  return contradictions
}

export function formatContradictions(contradictions: Contradiction[]): string {
  if (contradictions.length === 0) return ''

  const lines = contradictions.map(c =>
    `⚠️ CONTRADICTION [${c.severity}]: "${c.newDecision}" conflicts with "${c.oldDecision}"${c.project ? ` (${c.project})` : ''}\n   ${c.explanation}`,
  )

  return `\nCONTRADICTIONS DETECTED:\n${lines.join('\n\n')}`
}
