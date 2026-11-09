import pg from 'pg'
import type { PgConfig, GraphSearchResult, EntitySummary, EntityType, Entity } from './types.js'

const { Pool } = pg



interface RawTraversalRow {
  id: string
  name: string
  type: string
  project: string | null
  metadata: Record<string, unknown>
  confidence: number
  mention_count: number
  depth: number
}

interface RawRelationRow {
  entity_name: string
  entity_type: string
  entity_project: string | null
  entity_mentions: number
  entity_confidence: number
  rel_type: string | null
  related_name: string | null
  related_type: string | null
  related_project: string | null
  direction: 'outgoing' | 'incoming' | null
}

export class GraphSearch {
  private pool: pg.Pool

  constructor(config?: PgConfig) {
    this.pool = new Pool({
      host: config?.host ?? process.env['PG_HOST'] ?? 'localhost',
      port: config?.port ?? Number(process.env['PG_PORT'] ?? 5433),
      user: config?.user ?? process.env['PG_USER'],
      password: config?.password ?? process.env['PG_PASSWORD'],
      database: config?.database ?? process.env['PG_DATABASE'],
      max: 5,
      idleTimeoutMillis: 10_000,
    })
  }

  async searchByKeywords(keywords: string[]): Promise<GraphSearchResult[]> {
    if (keywords.length === 0) return []

    const conditions = keywords.map((_, i) => `e.name ILIKE $${i + 1}`).join(' OR ')
    const params = keywords.map(k => `%${k}%`)

    const result = await this.pool.query<RawRelationRow>(
      `SELECT
        e.name as entity_name, e.type as entity_type, e.project as entity_project,
        e.mention_count as entity_mentions, e.confidence as entity_confidence,
        r.type as rel_type,
        e2.name as related_name, e2.type as related_type, e2.project as related_project,
        'outgoing' as direction
      FROM kg_entities e
      LEFT JOIN kg_relations r ON r.from_id = e.id
      LEFT JOIN kg_entities e2 ON e2.id = r.to_id
      WHERE ${conditions}
      UNION ALL
      SELECT
        e.name, e.type, e.project,
        e.mention_count, e.confidence,
        r.type,
        e2.name, e2.type, e2.project,
        'incoming'
      FROM kg_entities e
      LEFT JOIN kg_relations r ON r.to_id = e.id
      LEFT JOIN kg_entities e2 ON e2.id = r.from_id
      WHERE ${conditions} AND r.id IS NOT NULL
      ORDER BY entity_mentions DESC
      LIMIT 30`,
      params,
    )

    return this.groupResults(result.rows)
  }

  async traverseFrom(entityName: string, maxDepth = 2): Promise<RawTraversalRow[]> {
    const result = await this.pool.query<RawTraversalRow>(
      `WITH RECURSIVE graph AS (
        SELECT e.id, e.name, e.type, e.project, e.metadata, e.confidence, e.mention_count, 0 as depth
        FROM kg_entities e WHERE e.name ILIKE $1
        UNION ALL
        SELECT e2.id, e2.name, e2.type, e2.project, e2.metadata, e2.confidence, e2.mention_count, g.depth + 1
        FROM graph g
        JOIN kg_relations r ON r.from_id = g.id OR r.to_id = g.id
        JOIN kg_entities e2 ON e2.id = CASE WHEN r.from_id = g.id THEN r.to_id ELSE r.from_id END
        WHERE g.depth < $2
      )
      SELECT DISTINCT ON (id) * FROM graph ORDER BY id, depth`,
      [`%${entityName}%`, maxDepth],
    )
    return result.rows
  }

  async getRecentEntities(hours = 24): Promise<Entity[]> {
    const result = await this.pool.query<Entity>(
      `SELECT id, name, type, project, metadata, confidence,
              first_seen as "firstSeen", last_seen as "lastSeen",
              mention_count as "mentionCount"
       FROM kg_entities
       WHERE last_seen > NOW() - INTERVAL '1 hour' * $1
       ORDER BY mention_count DESC
       LIMIT 20`,
      [hours],
    )
    return result.rows
  }

  formatForContext(results: GraphSearchResult[]): string {
    if (results.length === 0) return ''

    const lines: string[] = []
    for (const r of results) {
      const entityLabel = `${r.entity.name} (${r.entity.type}${r.entity.project ? `, ${r.entity.project}` : ''})`

      if (r.relations.length === 0) {
        lines.push(`  ${entityLabel} [mentions: ${r.entity.mentionCount}]`)
      } else {
        for (const rel of r.relations) {
          if (rel.direction === 'outgoing') {
            lines.push(`  ${r.entity.name} —[${rel.relationType}]→ ${rel.relatedEntity.name} (${rel.relatedEntity.type})`)
          } else {
            lines.push(`  ${rel.relatedEntity.name} —[${rel.relationType}]→ ${r.entity.name} (${r.entity.type})`)
          }
        }
      }
    }
    return lines.join('\n')
  }

  private isEntityType(value: string): value is EntityType {
    const valid: ReadonlySet<string> = new Set([
      'project', 'technology', 'bug', 'decision', 'person', 'concept', 'file', 'service',
    ])
    return valid.has(value)
  }

  private toEntityType(value: string): EntityType {
    return this.isEntityType(value) ? value : 'concept'
  }

  private groupResults(rows: RawRelationRow[]): GraphSearchResult[] {
    const entityMap = new Map<string, GraphSearchResult>()

    for (const row of rows) {
      const key = `${row.entity_name}|${row.entity_type}`
      if (!entityMap.has(key)) {
        entityMap.set(key, {
          entity: {
            name: row.entity_name,
            type: this.toEntityType(row.entity_type),
            project: row.entity_project ?? undefined,
            confidence: row.entity_confidence,
            mentionCount: row.entity_mentions,
          },
          relations: [],
        })
      }

      const entry = entityMap.get(key)!
      if (row.rel_type && row.related_name) {
        entry.relations.push({
          relationType: row.rel_type,
          direction: row.direction ?? 'outgoing',
          relatedEntity: {
            name: row.related_name,
            type: this.toEntityType(row.related_type ?? 'concept'),
            project: row.related_project ?? undefined,
            confidence: 1.0,
            mentionCount: 0,
          },
        })
      }
    }

    return Array.from(entityMap.values())
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
