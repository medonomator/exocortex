import type { EntityInput, RelationInput, EntityType, RelationType } from '../../memory-graph/src/types.js'
import type { LlmProvider } from './types.js'

// ═══════════════════════════════════════════
// Entity Extractor — Post-swarm GPT call
// ═══════════════════════════════════════════
// Takes the swarm's analysis text and extracts
// structured entities + relations for the knowledge graph.

interface RawExtractedData {
  entities: Array<{
    name: string
    type: string
    project?: string
    confidence?: number
    source_quote?: string
  }>
  relations: Array<{
    from: string
    fromType: string
    to: string
    toType: string
    relationType: string
    confidence?: number
  }>
}

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'project', 'technology', 'bug', 'decision', 'person', 'concept', 'file', 'service',
])

const VALID_RELATION_TYPES: ReadonlySet<string> = new Set([
  'uses', 'depends_on', 'fixed_by', 'caused_by', 'decided', 'contradicts',
  'replaced_by', 'works_on', 'part_of', 'related_to',
])

function isEntityType(value: string): value is EntityType {
  return VALID_ENTITY_TYPES.has(value)
}

function isRelationType(value: string): value is RelationType {
  return VALID_RELATION_TYPES.has(value)
}

const EXTRACTION_PROMPT = `You are an entity extractor for a knowledge graph about a developer's work.

Given an analysis of Claude Code conversations, extract ALL specific entities and relationships mentioned.

Entity types: project, technology, bug, decision, person, concept, file, service
Relation types: uses, depends_on, fixed_by, caused_by, decided, contradicts, replaced_by, works_on, part_of, related_to

Rules:
- Only extract SPECIFIC things: "BullMQ" yes, "queue" no
- "cognitive-swarm" yes, "project" no
- Include project context when clear
- Set confidence 0.5-1.0 based on how explicitly it was mentioned
- Extract decisions as entities of type "decision" with descriptive names
- Include source_quote: a SHORT verbatim excerpt (1-2 sentences max) from the text that mentions this entity. This preserves ground truth for later verification.

Return JSON:
{
  "entities": [{"name": "...", "type": "...", "project": "...", "confidence": 0.8, "source_quote": "..."}],
  "relations": [{"from": "...", "fromType": "...", "to": "...", "toType": "...", "relationType": "...", "confidence": 0.8}]
}`

export async function extractEntities(
  llm: LlmProvider,
  analysisText: string,
): Promise<{ entities: EntityInput[]; relations: RelationInput[] }> {
  const response = await llm.completeJson<RawExtractedData>(
    [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: analysisText.slice(0, 12_000) },
    ],
    { maxTokens: 2000 },
  )

  const data = response.parsed

  const entities: EntityInput[] = []
  for (const e of data.entities ?? []) {
    if (e.name && isEntityType(e.type)) {
      entities.push({
        name: e.name,
        type: e.type,
        project: e.project,
        confidence: e.confidence ?? 0.8,
        metadata: e.source_quote ? { source_quote: e.source_quote } : undefined,
      })
    }
  }

  const relations: RelationInput[] = []
  for (const r of data.relations ?? []) {
    if (r.from && r.to && isRelationType(r.relationType) && isEntityType(r.fromType) && isEntityType(r.toType)) {
      relations.push({
        from: { name: r.from, type: r.fromType },
        to: { name: r.to, type: r.toType },
        relationType: r.relationType,
        confidence: r.confidence ?? 0.8,
      })
    }
  }

  return { entities, relations }
}
