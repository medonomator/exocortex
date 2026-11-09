import pg from 'pg'
import type { PgConfig, EntityInput, RelationInput, Entity, ProcedureInput, Procedure } from './types.js'

const { Pool } = pg

type Queryable = pg.Pool | pg.PoolClient

const UPSERT_ENTITY_SQL = `
  INSERT INTO kg_entities (name, type, project, metadata, confidence)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (name, type) DO UPDATE SET
    last_seen = NOW(),
    mention_count = kg_entities.mention_count + 1,
    confidence = GREATEST(kg_entities.confidence, EXCLUDED.confidence),
    project = COALESCE(EXCLUDED.project, kg_entities.project),
    metadata = kg_entities.metadata || EXCLUDED.metadata
  RETURNING id`

const UPSERT_RELATION_SQL = `
  INSERT INTO kg_relations (from_id, to_id, type, metadata, confidence, session_id)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (from_id, to_id, type) DO UPDATE SET
    confidence = GREATEST(kg_relations.confidence, EXCLUDED.confidence),
    metadata = kg_relations.metadata || EXCLUDED.metadata,
    session_id = EXCLUDED.session_id
  RETURNING id`

export class GraphStore {
  private pool: pg.Pool

  constructor(config?: PgConfig) {
    this.pool = new Pool({
      host: config?.host ?? process.env['PG_HOST'] ?? 'localhost',
      port: config?.port ?? Number(process.env['PG_PORT'] ?? 5433),
      user: config?.user ?? process.env['PG_USER'] ?? 'mindforge',
      password: config?.password ?? process.env['PG_PASSWORD'] ?? 'mindforge123',
      database: config?.database ?? process.env['PG_DATABASE'] ?? 'mindforge',
      max: 5,
      idleTimeoutMillis: 10_000,
    })
  }

  private async upsertEntityWith(db: Queryable, input: EntityInput): Promise<string> {
    const result = await db.query<{ id: string }>(UPSERT_ENTITY_SQL, [
      input.name,
      input.type,
      input.project ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.confidence ?? 1.0,
    ])
    return result.rows[0].id
  }

  private async upsertRelationWith(db: Queryable, input: RelationInput): Promise<string> {
    const fromId = await this.upsertEntityWith(db, input.from)
    const toId = await this.upsertEntityWith(db, input.to)

    const result = await db.query<{ id: string }>(UPSERT_RELATION_SQL, [
      fromId,
      toId,
      input.relationType,
      JSON.stringify(input.metadata ?? {}),
      input.confidence ?? 1.0,
      input.sessionId ?? null,
    ])
    return result.rows[0].id
  }

  async upsertEntity(input: EntityInput): Promise<string> {
    return this.upsertEntityWith(this.pool, input)
  }

  /**
   * Auto-link an entity to similar existing entities by trigram similarity.
   * Creates `related_to` relations for matches above threshold.
   */
  private async autoLinkSimilar(
    db: Queryable,
    entityId: string,
    input: EntityInput,
    threshold: number,
    maxLinks: number,
  ): Promise<number> {
    const similar = await db.query<{ id: string; name: string; type: string; sim: number }>(`
      SELECT id, name, type, similarity(name, $1) as sim
      FROM kg_entities
      WHERE id != $2
        AND similarity(name, $1) >= $3
        AND NOT (LOWER(name) = LOWER($1) AND type = $4)
      ORDER BY sim DESC
      LIMIT $5`,
      [input.name, entityId, threshold, input.type, maxLinks],
    )

    let linked = 0
    for (const row of similar.rows) {
      const existing = await db.query<{ n: number }>(
        `SELECT 1 as n FROM kg_relations
         WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
         LIMIT 1`,
        [entityId, row.id],
      )
      if ((existing.rowCount ?? 0) === 0) {
        await db.query(UPSERT_RELATION_SQL, [
          entityId,
          row.id,
          'related_to',
          JSON.stringify({ autoLinked: true, similarity: row.sim }),
          Math.min(row.sim, input.confidence ?? 1.0),
          null,
        ])
        linked++
      }
    }
    return linked
  }

  async upsertRelation(input: RelationInput): Promise<string> {
    return this.upsertRelationWith(this.pool, input)
  }

  async batchUpsert(
    entities: EntityInput[],
    relations: RelationInput[],
    options?: { relink?: boolean; similarityThreshold?: number },
  ): Promise<{ entities: number; relations: number; autoLinked: number }> {
    const doRelink = options?.relink ?? true
    const threshold = options?.similarityThreshold ?? 0.3

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const entityIds: string[] = []
      for (const entity of entities) {
        const id = await this.upsertEntityWith(client, entity)
        entityIds.push(id)
      }

      for (const rel of relations) {
        await this.upsertRelationWith(client, rel)
      }

      // Reactive re-linking: auto-discover relations for new entities
      let autoLinked = 0
      if (doRelink && entities.length > 0) {
        for (let i = 0; i < entities.length; i++) {
          autoLinked += await this.autoLinkSimilar(client, entityIds[i], entities[i], threshold, 5)
        }
      }

      await client.query('COMMIT')
      return { entities: entities.length, relations: relations.length, autoLinked }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getEntity(name: string): Promise<Entity | null> {
    const result = await this.pool.query<Entity>(
      `SELECT id, name, type, project, metadata, confidence,
              first_seen as "firstSeen", last_seen as "lastSeen",
              mention_count as "mentionCount"
       FROM kg_entities WHERE LOWER(name) = LOWER($1)`,
      [name],
    )
    return result.rows[0] ?? null
  }

  /**
   * Apply confidence decay to entities not seen recently.
   * Reduces confidence by decayRate for every decayPeriodDays since last_seen.
   * Floor prevents entities from reaching zero.
   * Returns number of entities affected.
   */
  async applyConfidenceDecay(options?: {
    decayRate?: number       // multiplier per period (default 0.95)
    decayPeriodDays?: number // how often decay applies (default 7)
    floor?: number           // minimum confidence (default 0.1)
  }): Promise<number> {
    const rate = options?.decayRate ?? 0.95
    const period = options?.decayPeriodDays ?? 7
    const floor = options?.floor ?? 0.1

    const result = await this.pool.query<{ count: string }>(`
      WITH decayed AS (
        UPDATE kg_entities
        SET confidence = GREATEST(
          $3,
          confidence * POWER($1::real, EXTRACT(EPOCH FROM (NOW() - last_seen)) / ($2 * 86400))
        )
        WHERE last_seen < NOW() - INTERVAL '1 day' * $2
          AND confidence > $3
        RETURNING id
      )
      SELECT count(*) FROM decayed`,
      [rate, period, floor],
    )
    return Number(result.rows[0].count)
  }

  /**
   * Mark an entity as deprecated (sets confidence to floor, adds deprecated metadata).
   */
  async deprecateEntity(name: string, reason?: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kg_entities
       SET confidence = 0.1,
           metadata = metadata || $2
       WHERE LOWER(name) = LOWER($1)`,
      [name, JSON.stringify({ deprecated: true, deprecatedAt: new Date().toISOString(), deprecatedReason: reason ?? 'manual' })],
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Prune entities below a confidence threshold that haven't been seen in minAgeDays.
   * Returns number of entities deleted.
   */
  async pruneStale(options?: {
    maxConfidence?: number
    minAgeDays?: number
  }): Promise<number> {
    const maxConf = options?.maxConfidence ?? 0.15
    const minAge = options?.minAgeDays ?? 60

    const result = await this.pool.query<{ count: string }>(`
      WITH pruned AS (
        DELETE FROM kg_entities
        WHERE confidence <= $1
          AND last_seen < NOW() - INTERVAL '1 day' * $2
        RETURNING id
      )
      SELECT count(*) FROM pruned`,
      [maxConf, minAge],
    )
    return Number(result.rows[0].count)
  }

  async getRecentDecisions(options?: {
    project?: string
    days?: number
    limit?: number
  }): Promise<Entity[]> {
    const days = options?.days ?? 30
    const limit = options?.limit ?? 20
    const params: unknown[] = [days, limit]
    let projectClause = ''
    if (options?.project) {
      params.push(options.project)
      projectClause = `AND (project = $${params.length} OR project IS NULL)`
    }
    const result = await this.pool.query<Entity>(
      `SELECT id, name, type, project, metadata, confidence,
              first_seen as "firstSeen", last_seen as "lastSeen",
              mention_count as "mentionCount"
       FROM kg_entities
       WHERE type = 'decision'
         AND last_seen > NOW() - INTERVAL '1 day' * $1
         ${projectClause}
       ORDER BY last_seen DESC
       LIMIT $2`,
      params,
    )
    return result.rows
  }

  async getStats(): Promise<{ entities: number; relations: number }> {
    const entities = await this.pool.query<{ count: string }>('SELECT count(*) FROM kg_entities')
    const relations = await this.pool.query<{ count: string }>('SELECT count(*) FROM kg_relations')
    return {
      entities: Number(entities.rows[0].count),
      relations: Number(relations.rows[0].count),
    }
  }

  async upsertProcedure(input: ProcedureInput): Promise<string> {
    const result = await this.pool.query<{ id: string }>(`
      INSERT INTO kg_procedures (pattern, trigger_condition, action, project, tags, source_type, confidence, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (pattern, project) DO UPDATE SET
        last_seen = NOW(),
        action = EXCLUDED.action,
        trigger_condition = EXCLUDED.trigger_condition,
        tags = ARRAY(SELECT DISTINCT unnest(kg_procedures.tags || EXCLUDED.tags)),
        confidence = GREATEST(kg_procedures.confidence, EXCLUDED.confidence),
        metadata = kg_procedures.metadata || EXCLUDED.metadata
      RETURNING id`,
      [
        input.pattern,
        input.triggerCondition,
        input.action,
        input.project ?? null,
        input.tags ?? [],
        input.sourceType ?? 'swarm',
        input.confidence ?? 0.5,
        JSON.stringify(input.metadata ?? {}),
      ],
    )
    return result.rows[0].id
  }

  async batchUpsertProcedures(procedures: ProcedureInput[]): Promise<number> {
    if (procedures.length === 0) return 0
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const proc of procedures) {
        await client.query(`
          INSERT INTO kg_procedures (pattern, trigger_condition, action, project, tags, source_type, confidence, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (pattern, project) DO UPDATE SET
            last_seen = NOW(),
            action = EXCLUDED.action,
            trigger_condition = EXCLUDED.trigger_condition,
            tags = ARRAY(SELECT DISTINCT unnest(kg_procedures.tags || EXCLUDED.tags)),
            confidence = GREATEST(kg_procedures.confidence, EXCLUDED.confidence),
            metadata = kg_procedures.metadata || EXCLUDED.metadata`,
          [
            proc.pattern,
            proc.triggerCondition,
            proc.action,
            proc.project ?? null,
            proc.tags ?? [],
            proc.sourceType ?? 'swarm',
            proc.confidence ?? 0.5,
            JSON.stringify(proc.metadata ?? {}),
          ],
        )
      }
      await client.query('COMMIT')
      return procedures.length
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Search procedures by trigram similarity on pattern + trigger_condition.
   * Returns procedures sorted by relevance (similarity * confidence).
   */
  async searchProcedures(query: string, options?: {
    project?: string
    tags?: string[]
    limit?: number
    minConfidence?: number
  }): Promise<Procedure[]> {
    const limit = options?.limit ?? 10
    const minConf = options?.minConfidence ?? 0.2
    const params: unknown[] = [query, minConf, limit]
    const conditions: string[] = ['confidence >= $2']

    if (options?.project) {
      params.push(options.project)
      conditions.push(`(project = $${params.length} OR project IS NULL)`)
    }
    if (options?.tags && options.tags.length > 0) {
      params.push(options.tags)
      conditions.push(`tags && $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const result = await this.pool.query<Procedure>(`
      SELECT id, pattern, trigger_condition as "triggerCondition",
             action, project, tags, source_type as "sourceType",
             confidence, success_count as "successCount",
             failure_count as "failureCount",
             first_seen as "firstSeen", last_seen as "lastSeen",
             last_applied as "lastApplied", metadata,
             GREATEST(
               similarity(pattern, $1),
               similarity(trigger_condition, $1)
             ) as sim
      FROM kg_procedures
      ${where}
      ORDER BY sim * confidence DESC
      LIMIT $3`,
      params,
    )
    return result.rows
  }

  /**
   * Record that a procedure was applied successfully or unsuccessfully.
   */
  async recordProcedureOutcome(id: string, success: boolean): Promise<void> {
    const confDelta = success ? 0.05 : -0.05
    // Two separate queries to avoid SQL interpolation of column names
    if (success) {
      await this.pool.query(`
        UPDATE kg_procedures
        SET success_count = success_count + 1,
            last_applied = NOW(),
            confidence = GREATEST(0.1, LEAST(1.0, confidence + $2))
        WHERE id = $1`,
        [id, confDelta],
      )
    } else {
      await this.pool.query(`
        UPDATE kg_procedures
        SET failure_count = failure_count + 1,
            last_applied = NOW(),
            confidence = GREATEST(0.1, LEAST(1.0, confidence + $2))
        WHERE id = $1`,
        [id, confDelta],
      )
    }
  }

  async applyProcedureDecay(options?: {
    decayRate?: number
    decayPeriodDays?: number
    floor?: number
  }): Promise<number> {
    const rate = options?.decayRate ?? 0.95
    const period = options?.decayPeriodDays ?? 14
    const floor = options?.floor ?? 0.2

    const result = await this.pool.query<{ count: string }>(`
      WITH decayed AS (
        UPDATE kg_procedures
        SET confidence = GREATEST(
          $3,
          confidence * POWER($1::real, EXTRACT(EPOCH FROM (NOW() - last_seen)) / ($2 * 86400))
        )
        WHERE last_seen < NOW() - INTERVAL '1 day' * $2
          AND confidence > $3
        RETURNING id
      )
      SELECT count(*) FROM decayed`,
      [rate, period, floor],
    )
    return Number(result.rows[0].count)
  }

  async getProcedureStats(): Promise<{ total: number; avgConfidence: number }> {
    const result = await this.pool.query<{ total: string; avg: string }>(`
      SELECT count(*) as total, COALESCE(avg(confidence), 0) as avg FROM kg_procedures`)
    return {
      total: Number(result.rows[0].total),
      avgConfidence: Number(Number(result.rows[0].avg).toFixed(2)),
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
