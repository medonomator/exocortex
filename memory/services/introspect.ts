/**
 * IntrospectService - health, export, time-series over the memory store.
 *
 * "Meta-memory": visibility into the memory itself, including fine-tune
 * readiness exports. Read-only; never mutates state.
 */

import type {
  MemoryIntrospect,
  MemoryHealth,
  ExportOpts,
  ExportEmbeddingsOpts,
  TimeSeriesPoint,
} from '../core/memory.js';
import type { MemoryItem, Query } from '../core/types.js';
import { Conf } from '../core/confidence.js';
import type { PostgresStore } from '../stores/postgres.js';

export interface IntrospectServiceOpts {
  postgres: PostgresStore;
}

export class IntrospectService implements MemoryIntrospect {
  private readonly pg: PostgresStore;

  constructor(opts: IntrospectServiceOpts) {
    this.pg = opts.postgres;
  }

  async health(): Promise<MemoryHealth> {
    return this.pg.withClient(async (c) => {
      const total = await c.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM mem_items');
      const byType = await c.query<{ type: string; n: string }>(
        `SELECT type, COUNT(*)::text AS n FROM mem_items GROUP BY type`,
      );
      const byStatus = await c.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM mem_items GROUP BY status`,
      );
      const byLevel = await c.query<{ level: string; n: string }>(
        `SELECT level::text, COUNT(*)::text AS n FROM mem_items GROUP BY level`,
      );
      const avg = await c.query<{ avg: string | null }>(
        `SELECT AVG(confidence)::text AS avg FROM mem_items WHERE status IN ('active','decayed')`,
      );
      const oldest = await c.query<{ d: Date | null }>(
        `SELECT MIN(last_accessed_at) AS d FROM mem_items WHERE status = 'active'`,
      );
      const newest = await c.query<{ d: Date | null }>(
        `SELECT MAX(last_accessed_at) AS d FROM mem_items WHERE status = 'active'`,
      );
      const contradictions = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM mem_items WHERE conf_beta > conf_alpha AND status IN ('active','decayed')`,
      );
      const eligible = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM mem_items WHERE training_eligible = true`,
      );

      return {
        total: Number(total.rows[0]?.n ?? 0),
        byType: Object.fromEntries(byType.rows.map((r) => [r.type, Number(r.n)])),
        byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.n)])),
        byLevel: Object.fromEntries(byLevel.rows.map((r) => [r.level, Number(r.n)])),
        avgConfidence: Number(avg.rows[0]?.avg ?? 0),
        oldestAccess: oldest.rows[0]?.d ?? null,
        newestAccess: newest.rows[0]?.d ?? null,
        contradictions: Number(contradictions.rows[0]?.n ?? 0),
        trainingEligible: Number(eligible.rows[0]?.n ?? 0),
        generatedAt: new Date(),
      };
    });
  }

  async getItem(id: string): Promise<MemoryItem | null> {
    return this.pg.getItem(id, { includeCompat: true });
  }

  async exportForFineTuning(opts: ExportOpts): Promise<{ train: string; eval: string }> {
    const items = await this.loadEligibleForTuning(opts);
    const split = opts.splitRatio ?? { train: 0.9, eval: 0.1 };
    const cutoff = Math.floor(items.length * split.train / (split.train + split.eval));
    const trainItems = items.slice(0, cutoff);
    const evalItems = items.slice(cutoff);

    const format = opts.format;
    const render = (its: MemoryItem[]): string =>
      its.map((it) => formatExample(it, format)).filter(Boolean).join('\n');

    return { train: render(trainItems), eval: render(evalItems) };
  }

  async exportEmbeddings(opts: ExportEmbeddingsOpts): Promise<Buffer> {
    // CSV/JSONL of id + payload summary + raw_text. Actual vector export
    // belongs to a Qdrant snapshot job; this is the metadata companion.
    const types = opts.filter?.types;
    const since = opts.filter?.since;

    const items = await this.pg.listItems({
      types: types as MemoryItem['type'][] | undefined,
      since,
      limit: 10_000,
    });

    if (opts.format === 'jsonl') {
      return Buffer.from(
        items
          .map((it) => JSON.stringify({ id: it.id, type: it.type, text: it.raw.text, importance: it.importance }))
          .join('\n'),
      );
    }
    if (opts.format === 'csv') {
      const rows = ['id,type,importance,text'];
      for (const it of items) {
        rows.push(
          `${it.id},${it.type},${it.importance},${JSON.stringify(it.raw.text.slice(0, 500))}`,
        );
      }
      return Buffer.from(rows.join('\n'));
    }
    // .npy would need a typed-array dump of vectors from Qdrant; not here.
    throw new Error(`exportEmbeddings format '${opts.format}' not supported by IntrospectService`);
  }

  async timeSeries(
    query: Query,
    bucket: 'day' | 'week' | 'month',
  ): Promise<TimeSeriesPoint[]> {
    // Buckets over last_accessed_at, restricted by query.
    const truncUnit = bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month';
    const params: unknown[] = [];
    const where: string[] = ["status IN ('active','decayed')"];
    const push = (sql: string, v: unknown): void => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (query.types?.length) push('type = ANY(?)', query.types);
    if (query.since) push('last_accessed_at >= ?', query.since);
    if (query.until) push('last_accessed_at <= ?', query.until);
    if (query.project) push("payload->>'project' = ?", query.project);

    const sql = `
      SELECT DATE_TRUNC('${truncUnit}', last_accessed_at) AS bucket,
             COUNT(*)::text AS n,
             AVG(confidence)::text AS avg_conf,
             AVG(importance)::text AS avg_imp
      FROM mem_items
      WHERE ${where.join(' AND ')}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    const res = await this.pg.withClient((c) => c.query<{
      bucket: Date;
      n: string;
      avg_conf: string | null;
      avg_imp: string | null;
    }>(sql, params));
    return res.rows.map((r) => ({
      bucket: r.bucket,
      count: Number(r.n),
      avgConfidence: Number(r.avg_conf ?? 0),
      avgImportance: Number(r.avg_imp ?? 0),
    }));
  }

  private async loadEligibleForTuning(opts: ExportOpts): Promise<MemoryItem[]> {
    const f = opts.filter ?? {};
    const items = await this.pg.listItems({
      minImportance: f.minImportance,
      since: f.since,
      statuses: ['active', 'decayed'],
      limit: 10_000,
    });
    return items.filter((it) => {
      if (f.onlyApproved && !it.humanApproved) return false;
      if (f.minStability !== undefined && it.stability < f.minStability) return false;
      if (!it.trainingEligible && !it.humanApproved) return false;
      if (Conf.mean(it.conf) < 0.6) return false;
      return true;
    });
  }
}

function formatExample(item: MemoryItem, format: ExportOpts['format']): string {
  switch (format) {
    case 'openai-chat': {
      // {messages: [{role, content}, ...]}
      const userMsg = item.raw.text;
      const assistant = renderAssistantOutput(item);
      if (!assistant) return '';
      return JSON.stringify({
        messages: [
          { role: 'user', content: userMsg },
          { role: 'assistant', content: assistant },
        ],
      });
    }
    case 'alpaca':
      return JSON.stringify({
        instruction: item.raw.text,
        input: '',
        output: renderAssistantOutput(item) ?? '',
      });
    case 'sharegpt':
      return JSON.stringify({
        conversations: [
          { from: 'human', value: item.raw.text },
          { from: 'gpt', value: renderAssistantOutput(item) ?? '' },
        ],
      });
    case 'dpo-pairs': {
      // Need humanCorrected for a proper DPO pair; otherwise skip.
      if (!item.humanCorrected) return '';
      return JSON.stringify({
        prompt: item.raw.text,
        chosen: item.humanCorrected,
        rejected: renderAssistantOutput(item) ?? '',
      });
    }
  }
}

function renderAssistantOutput(item: MemoryItem): string | null {
  const payload = item.payload as Record<string, unknown> | null;
  if (!payload) return null;
  if (typeof payload.summary === 'string') return payload.summary;
  if (typeof payload.statement === 'string') return payload.statement;
  if (typeof payload.action === 'string') return payload.action;
  return null;
}
