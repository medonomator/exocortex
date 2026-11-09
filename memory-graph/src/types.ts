export interface PgConfig {
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
}

export interface Entity {
  id: string
  name: string
  type: EntityType
  project?: string
  metadata: Record<string, unknown>
  confidence: number
  firstSeen: Date
  lastSeen: Date
  mentionCount: number
}

export interface EntitySummary {
  name: string
  type: EntityType
  project?: string
  confidence: number
  mentionCount: number
}

export interface Relation {
  id: string
  fromId: string
  toId: string
  type: RelationType
  metadata: Record<string, unknown>
  confidence: number
  createdAt: Date
  sessionId?: string
}

export interface EntityInput {
  name: string
  type: EntityType
  project?: string
  metadata?: Record<string, unknown>
  confidence?: number
}

export interface RelationInput {
  from: { name: string; type: EntityType }
  to: { name: string; type: EntityType }
  relationType: RelationType
  metadata?: Record<string, unknown>
  confidence?: number
  sessionId?: string
}

export interface GraphSearchResult {
  entity: EntitySummary
  relations: Array<{
    relationType: string
    direction: 'outgoing' | 'incoming'
    relatedEntity: EntitySummary
  }>
}

export type EntityType =
  | 'project'
  | 'technology'
  | 'bug'
  | 'decision'
  | 'person'
  | 'concept'
  | 'file'
  | 'service'

export type RelationType =
  | 'uses'
  | 'depends_on'
  | 'fixed_by'
  | 'caused_by'
  | 'decided'
  | 'contradicts'
  | 'replaced_by'
  | 'works_on'
  | 'part_of'
  | 'related_to'

export type ProcedureSourceType = 'swarm' | 'error-learner' | 'manual' | 'git-history'

export interface ProcedureInput {
  pattern: string
  triggerCondition: string
  action: string
  project?: string
  tags?: string[]
  sourceType?: ProcedureSourceType
  confidence?: number
  metadata?: Record<string, unknown>
}

export interface Procedure {
  id: string
  pattern: string
  triggerCondition: string
  action: string
  project?: string
  tags: string[]
  sourceType: ProcedureSourceType
  confidence: number
  successCount: number
  failureCount: number
  firstSeen: Date
  lastSeen: Date
  lastApplied?: Date
  metadata: Record<string, unknown>
}
