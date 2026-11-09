import type { ProcedureInput, ProcedureSourceType } from '../../memory-graph/src/types.js'
import type { LlmProvider } from './types.js'

// Takes the swarm's analysis text and extracts
// procedural memory: "when X happens → do Y"

interface RawProcedure {
  pattern: string
  trigger: string
  action: string
  project?: string
  tags?: string[]
  confidence?: number
}

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'swarm', 'error-learner', 'manual', 'git-history',
])

function isSourceType(value: string): value is ProcedureSourceType {
  return VALID_SOURCE_TYPES.has(value)
}

const PROCEDURE_EXTRACTION_PROMPT = `You are a procedural memory extractor for a developer's knowledge system.

Given an analysis of Claude Code sessions, extract ACTIONABLE procedures — recurring patterns where a specific trigger leads to a specific fix/action.

Focus on:
- Bug fixes: "Error X → Fix: do Y"
- Configuration patterns: "When setting up X → always do Y"
- Workflow patterns: "Before deploying X → run Y"
- Debugging patterns: "When X fails → check Y first"
- Tool usage: "For task X → use tool Y with flags Z"

Rules:
- pattern: SHORT name for the procedure (max 100 chars), human-readable
- trigger: SPECIFIC condition that triggers this procedure (error message, situation, task type)
- action: CONCRETE steps to take (code snippets, commands, specific instructions)
- Only extract procedures that are REUSABLE across sessions
- Do NOT extract one-time fixes or project-specific hacks
- Set confidence 0.3-0.9 based on how well-established the pattern is (mentioned multiple times = higher)
- Include relevant tags: "typescript", "docker", "nestjs", "ios", "deploy", "debug", "git", etc.

Return JSON:
{
  "procedures": [
    {
      "pattern": "Fix NestJS port binding with ConfigService",
      "trigger": "uWebSockets.js crashes on startup with invalid port",
      "action": "ConfigService.get() returns string. Wrap in Number(): Number(configService.get('PORT', 3777))",
      "project": "backend",
      "tags": ["nestjs", "config", "bug"],
      "confidence": 0.8
    }
  ]
}`

export async function extractProcedures(
  llm: LlmProvider,
  analysisText: string,
): Promise<ProcedureInput[]> {
  const response = await llm.completeJson<{ procedures: RawProcedure[] }>(
    [
      { role: 'system', content: PROCEDURE_EXTRACTION_PROMPT },
      { role: 'user', content: analysisText.slice(0, 12_000) },
    ],
    { maxTokens: 2000 },
  )

  const raw = response.parsed.procedures ?? []

  return raw
    .filter(p => p.pattern && p.trigger && p.action)
    .map(p => ({
      pattern: p.pattern.slice(0, 500),
      triggerCondition: p.trigger.slice(0, 500),
      action: p.action,
      project: p.project,
      tags: p.tags?.filter(t => typeof t === 'string') ?? [],
      sourceType: 'swarm' as ProcedureSourceType,
      confidence: Math.min(0.9, Math.max(0.3, p.confidence ?? 0.5)),
    }))
}
