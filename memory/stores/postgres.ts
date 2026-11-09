/**
 * Postgres store for MemoryItem + MemoryEvent.
 *
 * Only structured data lives here; embeddings are in Qdrant (see qdrant.ts).
 * Cross-referenced by MemoryItem.id which is the same UUID used as the
 * Qdrant point id.
 */

import { Pool, type PoolClient } from 'pg';
import type {
  MemoryItem,
  MemoryEvent,
  ItemType,
  LifecycleStatus,
  AbstractionLevel,
  Confidence,
  Provenance,
  RawContent,
  Emotion,
  TimeRange,
} from '../core/types.js';
import { StoreError } from '../core/errors.js';

export interface PostgresStoreOpts {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  poolSize?: number;
}

export interface ItemFilter {
  types?: ItemType[];
  levels?: AbstractionLevel[];
  statuses?: LifecycleStatus[];
  project?: string;
  since?: Date;
  until?: Date;
  minConfidence?: number;
  minImportance?: number;
  /** Compat mode: include entries from legacy kg_* adapter views. */
  includeCompat?: boolean;
  limit?: number;
  offset?: number;
}

export class PostgresStore {
  private readonly pool: Pool;

  constructor(opts: PostgresStoreOpts = {}) {
    this.pool = new Pool({
      host: opts.host ?? process.env.PG_HOST ?? 'localhost',
      port: opts.port ?? Number(process.env.PG_PORT ?? 5433),
      user: opts.user ?? process.env.PG_USER,
      password: opts.password ?? process.env.PG_PASSWORD,
      database: opts.database ?? process.env.PG_DATABASE,
      max: opts.poolSize ?? 10,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertItem(item: MemoryItem): Promise<void> {
    const sql = `
      INSERT INTO mem_items (
        id, type, payload, raw_text, raw_content_type, raw_source_uri,
        status, level, created_at, updated_at, last_accessed_at,
        conf_alpha, conf_beta, stability,
        importance, emotion_valence, emotion_arousal, access_count,
        provenance_source, provenance_session, provenance_agent, provenance_model, provenance,
        human_approved, human_corrected, training_eligible, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21, $22, $23,
        $24, $25, $26, $27
      )
      ON CONFLICT (id) DO UPDATE SET
        payload          = EXCLUDED.payload,
        raw_text         = EXCLUDED.raw_text,
        raw_content_type = EXCLUDED.raw_content_type,
        raw_source_uri   = EXCLUDED.raw_source_uri,
        status           = EXCLUDED.status,
        level            = EXCLUDED.level,
        last_accessed_at = EXCLUDED.last_accessed_at,
        conf_alpha       = EXCLUDED.conf_alpha,
        conf_beta        = EXCLUDED.conf_beta,
        stability        = EXCLUDED.stability,
        importance       = EXCLUDED.importance,
        emotion_valence  = EXCLUDED.emotion_valence,
        emotion_arousal  = EXCLUDED.emotion_arousal,
        access_count     = EXCLUDED.access_count,
        provenance       = EXCLUDED.provenance,
        human_approved   = EXCLUDED.human_approved,
        human_corrected  = EXCLUDED.human_corrected,
        training_eligible = EXCLUDED.training_eligible,
        metadata         = EXCLUDED.metadata
    `;
    try {
      await this.pool.query(sql, [
        item.id,
        item.type,
        item.payload,
        item.raw.text,
        item.raw.contentType,
        item.raw.sourceUri ?? null,
        item.status,
        item.level,
        item.createdAt,
        item.updatedAt,
        item.lastAccessedAt,
        item.conf.alpha,
        item.conf.beta,
        item.stability,
        item.importance,
        item.emotion?.valence ?? null,
        item.emotion?.arousal ?? null,
        item.accessCount,
        item.provenance.source,
        item.provenance.sessionId ?? null,
        item.provenance.agentId ?? null,
        item.provenance.model ?? null,
        item.provenance,
        item.humanApproved ?? null,
        item.humanCorrected ?? null,
        item.trainingEligible,
        item.metadata,
      ]);
    } catch (err) {
      throw new StoreError(`upsertItem failed for ${item.id}`, err);
    }
  }

  async getItem(id: string, { includeCompat = false } = {}): Promise<MemoryItem | null> {
    const table = includeCompat ? 'mem_items_all' : 'mem_items';
    const res = await this.pool.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
    if (res.rowCount === 0) return null;
    return rowToItem(res.rows[0]);
  }

  async listItems(filter: ItemFilter = {}): Promise<MemoryItem[]> {
    const table = filter.includeCompat ? 'mem_items_all' : 'mem_items';
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, v: unknown): void => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.types?.length) push('type = ANY(?)', filter.types);
    if (filter.levels?.length) push('level = ANY(?)', filter.levels);
    if (filter.statuses?.length) push('status = ANY(?)', filter.statuses);
    if (filter.project) push("payload->>'project' = ?", filter.project);
    if (filter.since) push('last_accessed_at >= ?', filter.since);
    if (filter.until) push('last_accessed_at <= ?', filter.until);
    if (filter.minConfidence !== undefined) push('confidence >= ?', filter.minConfidence);
    if (filter.minImportance !== undefined) push('importance >= ?', filter.minImportance);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql = filter.limit ? `LIMIT ${Math.max(1, Math.min(10_000, filter.limit))}` : '';
    const offsetSql = filter.offset ? `OFFSET ${Math.max(0, filter.offset)}` : '';

    const res = await this.pool.query(
      `SELECT * FROM ${table} ${whereSql} ORDER BY last_accessed_at DESC ${limitSql} ${offsetSql}`,
      params,
    );
    return res.rows.map(rowToItem);
  }

  async deleteItem(id: string): Promise<void> {
    await this.pool.query('DELETE FROM mem_items WHERE id = $1', [id]);
  }

  /** Partial update. Only touches columns whose patch field is defined. */
  async patchItem(id: string, patch: Partial<MemoryItem>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, v: unknown): void => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.level !== undefined) push('level', patch.level);
    if (patch.lastAccessedAt !== undefined) push('last_accessed_at', patch.lastAccessedAt);
    if (patch.conf !== undefined) {
      push('conf_alpha', patch.conf.alpha);
      push('conf_beta', patch.conf.beta);
    }
    if (patch.stability !== undefined) push('stability', patch.stability);
    if (patch.importance !== undefined) push('importance', patch.importance);
    if (patch.accessCount !== undefined) push('access_count', patch.accessCount);
    if (patch.humanApproved !== undefined) push('human_approved', patch.humanApproved);
    if (patch.humanCorrected !== undefined) push('human_corrected', patch.humanCorrected);
    if (patch.trainingEligible !== undefined) push('training_eligible', patch.trainingEligible);
    if (patch.metadata !== undefined) push('metadata', patch.metadata);
    if (patch.payload !== undefined) push('payload', patch.payload);
    if (sets.length === 0) return;
    params.push(id);
    await this.pool.query(
      `UPDATE mem_items SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  /**
   * Returns item IDs + raw tsv rank, for use as a sparse retrieval signal.
   * Restricted to active items only for hot-path recall.
   *
   * `project` narrows results to items whose project matches, OR whose
   * project is NULL (legacy/user-wide). This mirrors the recall-side
   * Qdrant filter so lexical can't re-introduce cross-project bleed
   * that vector search was carefully scoped against.
   */
  async lexicalSearch(
    query: string,
    limit = 50,
    opts: {
      includeDecayed?: boolean;
      includeArchived?: boolean;
      project?: string;
    } = {},
  ): Promise<Array<{ id: string; score: number }>> {
    const statuses: LifecycleStatus[] = ['active'];
    if (opts.includeDecayed) statuses.push('decayed');
    if (opts.includeArchived) statuses.push('archived');

    const params: unknown[] = [query, statuses];
    let projectClause = '';
    if (opts.project) {
      params.push(opts.project);
      // mem_items stores project inside the JSONB payload, not as a
      // top-level column. The existing getItem filter on line ~161 uses
      // the same payload->>'project' path, so we mirror that here.
      const idx = params.length;
      projectClause = `AND (payload->>'project' = $${idx} OR payload->>'project' IS NULL)`;
    }
    params.push(limit);
    const limitIdx = params.length;

    const res = await this.pool.query<{ id: string; score: string }>(
      `
      SELECT id,
             ts_rank_cd(to_tsvector('simple', raw_text), plainto_tsquery('simple', $1)) AS score
      FROM mem_items
      WHERE status = ANY($2)
        AND to_tsvector('simple', raw_text) @@ plainto_tsquery('simple', $1)
        ${projectClause}
      ORDER BY score DESC
      LIMIT $${limitIdx}
      `,
      params,
    );
    return res.rows.map((r) => ({ id: r.id, score: Number(r.score) }));
  }

  /**
   * Scan text for occurrences of known kg_entities names and link the given
   * item to every entity whose name appears verbatim. Idempotent - dupes are
   * dropped via ON CONFLICT.
   *
   * Short Latin-only names (≤5 chars) require word boundaries to avoid false
   * positives (e.g. "RAG" matching "storage"). Longer names and names
   * containing non-Latin chars use plain case-insensitive substring match.
   *
   * Runs in-DB via a single CTE so we don't ship 100+ entities over the
   * wire on every ingest. Returns the number of links inserted.
   */
  async linkItemToMatchingEntities(itemId: string, text: string): Promise<number> {
    if (!text || text.length === 0) return 0;
    // Postgres regex for word-boundary match on short names. For longer or
    // Cyrillic names we fall back to ILIKE. The CASE below gates per-entity.
    const sql = `
      WITH matched AS (
        SELECT e.id
        FROM kg_entities e
        WHERE length(e.name) >= 3
          AND (
            -- Short Latin-only name: require word boundary.
            (length(e.name) <= 5 AND e.name ~ '^[A-Za-z0-9_-]+$'
             AND $2 ~* ('(^|[^[:alnum:]_])' || e.name || '([^[:alnum:]_]|$)'))
            OR
            -- Longer name or non-Latin name: plain substring match.
            (NOT (length(e.name) <= 5 AND e.name ~ '^[A-Za-z0-9_-]+$')
             AND $2 ILIKE '%' || e.name || '%')
          )
      )
      INSERT INTO mem_item_entities (item_id, entity_id, source, confidence)
      SELECT $1, id, 'substring', 1.0 FROM matched
      ON CONFLICT (item_id, entity_id) DO NOTHING
    `;
    const res = await this.pool.query(sql, [itemId, text]);
    return res.rowCount ?? 0;
  }

  async insertEvent(event: MemoryEvent, resultingItemId?: string, action?: string): Promise<void> {
    const sql = `
      INSERT INTO mem_events (
        id, kind, content_text, content_type, content_source_uri,
        actors, timestamp, raw,
        provenance_source, provenance_session, provenance_agent, provenance_model, provenance,
        resulting_item_id, resulting_action
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        resulting_item_id = EXCLUDED.resulting_item_id,
        resulting_action  = EXCLUDED.resulting_action
    `;
    await this.pool.query(sql, [
      event.id,
      event.kind,
      event.content.text,
      event.content.contentType,
      event.content.sourceUri ?? null,
      event.actors ?? [],
      event.timestamp,
      event.raw,
      event.provenance.source,
      event.provenance.sessionId ?? null,
      event.provenance.agentId ?? null,
      event.provenance.model ?? null,
      event.provenance,
      resultingItemId ?? null,
      action ?? null,
    ]);
  }

  async listEvents(window?: TimeRange): Promise<MemoryEvent[]> {
    const sql = window
      ? `SELECT * FROM mem_events WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp ASC`
      : `SELECT * FROM mem_events ORDER BY timestamp ASC`;
    const params = window ? [window.from, window.to] : [];
    const res = await this.pool.query(sql, params);
    return res.rows.map(rowToEvent);
  }

  async addLineage(parentId: string, childId: string, relation = 'derived'): Promise<void> {
    await this.pool.query(
      `INSERT INTO mem_lineage (parent_id, child_id, relation) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [parentId, childId, relation],
    );
  }

  async getChildren(parentId: string): Promise<string[]> {
    const res = await this.pool.query<{ child_id: string }>(
      `SELECT child_id FROM mem_lineage WHERE parent_id = $1`,
      [parentId],
    );
    return res.rows.map((r) => r.child_id);
  }

  async getParents(childId: string): Promise<string[]> {
    const res = await this.pool.query<{ parent_id: string }>(
      `SELECT parent_id FROM mem_lineage WHERE child_id = $1`,
      [childId],
    );
    return res.rows.map((r) => r.parent_id);
  }

  async logForgetting(
    itemId: string,
    policy: string,
    fromStatus: LifecycleStatus,
    toStatus: LifecycleStatus,
    reason: string,
    snapshot: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mem_forgetting_log (item_id, policy, from_status, to_status, reason, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [itemId, policy, fromStatus, toStatus, reason, snapshot],
    );
  }

  async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
}

interface ItemRow {
  id: string;
  type: ItemType;
  payload: unknown;
  raw_text: string;
  raw_content_type: string;
  raw_source_uri: string | null;
  status: LifecycleStatus;
  level: number;
  created_at: Date;
  updated_at: Date;
  last_accessed_at: Date;
  conf_alpha: string | number;
  conf_beta: string | number;
  stability: string | number;
  importance: number;
  emotion_valence: number | null;
  emotion_arousal: number | null;
  access_count: number;
  provenance_source: string;
  provenance_session: string | null;
  provenance_agent: string | null;
  provenance_model: string | null;
  provenance: Provenance;
  human_approved: boolean | null;
  human_corrected: string | null;
  training_eligible: boolean;
  metadata: Record<string, unknown>;
}

function rowToItem(row: ItemRow): MemoryItem {
  const emotion: Emotion | undefined =
    row.emotion_valence !== null && row.emotion_arousal !== null
      ? { valence: row.emotion_valence, arousal: row.emotion_arousal }
      : undefined;
  const raw: RawContent = {
    text: row.raw_text,
    contentType: row.raw_content_type,
    sourceUri: row.raw_source_uri ?? undefined,
  };
  const conf: Confidence = {
    alpha: Number(row.conf_alpha),
    beta: Number(row.conf_beta),
  };
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    raw,
    status: row.status,
    level: row.level as AbstractionLevel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    conf,
    stability: Number(row.stability),
    importance: row.importance,
    emotion,
    accessCount: row.access_count,
    provenance: row.provenance,
    humanApproved: row.human_approved ?? undefined,
    humanCorrected: row.human_corrected ?? undefined,
    trainingEligible: row.training_eligible,
    metadata: row.metadata,
  };
}

interface EventRow {
  id: string;
  kind: MemoryEvent['kind'];
  content_text: string;
  content_type: string;
  content_source_uri: string | null;
  actors: string[];
  timestamp: Date;
  raw: unknown;
  provenance_source: string;
  provenance_session: string | null;
  provenance_agent: string | null;
  provenance_model: string | null;
  provenance: Provenance;
}

function rowToEvent(row: EventRow): MemoryEvent {
  return {
    id: row.id,
    kind: row.kind,
    content: {
      text: row.content_text,
      contentType: row.content_type,
      sourceUri: row.content_source_uri ?? undefined,
    },
    actors: row.actors,
    timestamp: row.timestamp,
    raw: row.raw,
    provenance: row.provenance,
  };
}
