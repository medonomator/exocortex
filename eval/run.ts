import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import type { ItemType, MemoryItem, RankedItem } from '../memory/core/types.js';
import { RecallService } from '../memory/services/recall.js';
import { OpenAIEmbedder, type Embedder } from '../memory/stores/embedder.js';
import {
  HashEmbedder,
  InMemoryPostgres,
  InMemoryQdrant,
  makeItem,
  seed,
} from '../memory/testing/in-memory.js';
import { generateHyDE } from '../hooks/hyde.mjs';
import { rerankWithLLM } from '../hooks/llm-rerank.mjs';
import { mean, mrrAt, ndcgAt, recallAt, type Grades } from './metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '.cache');
loadEnv({ path: join(HERE, '..', '.env') });

const OFFLINE = process.argv.includes('--offline') || !process.env.OPENAI_API_KEY;
const NOW = new Date('2026-11-01T00:00:00Z');
const DAY = 86_400_000;
const POOL = 20;
const TOP_N = 5;
const HYDE_MAX_WORDS = 5;
const TYPE_COSINE_FLOORS: Record<string, number> = { episode: 0.55, procedure: 0.5, abstraction: 0.5, fact: 0.45, relation: 0.45 };
const MIN_TOP1_COSINE = 0.55;

interface CorpusRow { id: string; type: ItemType; project?: string; daysAgo: number; text: string }
interface QueryRow { id: string; text: string; project?: string; kind: string; relevant: Grades }
interface Config { name: string; lexicalArm?: boolean; weights?: Record<string, number>; hyde?: boolean; rerank?: boolean; online?: boolean }

const ZERO = { vector: 0, lexical: 0, recency: 0, importance: 0, emotion: 0, frequency: 0, 'provenance-affinity': 0 };

const CONFIGS: Config[] = [
  { name: 'lexical arm only', lexicalArm: true },
  { name: 'vector only', weights: { ...ZERO, vector: 1 } },
  { name: 'hybrid (RRF, all signals)' },
  { name: 'hybrid + HyDE', hyde: true, online: true },
  { name: 'hybrid + rerank', rerank: true, online: true },
  { name: 'hybrid + HyDE + rerank', hyde: true, rerank: true, online: true },
];

function readJsonl<T>(file: string): T[] {
  return readFileSync(join(HERE, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

class JsonCache<V> {
  private readonly data: Record<string, V>;
  constructor(private readonly file: string) {
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }
  get(k: string): V | undefined { return this.data[k]; }
  set(k: string, v: V): void { this.data[k] = v; }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data));
  }
}

class CachedEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  calls = 0;
  private readonly cache: JsonCache<string>;
  constructor(private readonly inner: Embedder) {
    this.model = inner.model;
    this.dim = inner.dim;
    this.cache = new JsonCache(join(CACHE_DIR, `embeddings-${inner.model}.json`));
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const missing = [...new Set(texts.filter((t) => !this.cache.get(sha(t))))];
    for (let i = 0; i < missing.length; i += 256) {
      const batch = missing.slice(i, i + 256);
      const vecs = await this.inner.embed(batch);
      this.calls += 1;
      batch.forEach((t, j) => this.cache.set(sha(t), Buffer.from(vecs[j]!.buffer).toString('base64')));
    }
    if (missing.length) this.cache.save();
    return texts.map((t) => {
      const buf = Buffer.from(this.cache.get(sha(t))!, 'base64');
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    });
  }
}

const llmCache = new JsonCache<unknown>(join(CACHE_DIR, 'llm.json'));
let llmCalls = 0;

function hyde(text: string): string {
  const key = `hyde:${sha(text)}`;
  let out = llmCache.get(key) as string | undefined;
  if (out === undefined) {
    out = generateHyDE(text).text;
    llmCalls += 1;
    llmCache.set(key, out);
  }
  return out;
}

function rerank(query: string, ranked: RankedItem[]): RankedItem[] {
  const key = `rerank:${sha(query + '\n' + ranked.map((r) => r.item.id).join(','))}`;
  let order = llmCache.get(key) as string[] | undefined;
  if (order === undefined) {
    order = (rerankWithLLM(query, ranked, TOP_N) as RankedItem[]).map((r) => r.item.id);
    llmCalls += 1;
    llmCache.set(key, order);
  }
  const byId = new Map(ranked.map((r) => [r.item.id, r]));
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

function contentWords(text: string): number {
  return text.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2).length;
}

function applyGate(items: RankedItem[]): RankedItem[] {
  const kept = items.filter((r) => {
    const cos = r.breakdown.cosine;
    if (cos !== undefined) return cos >= (TYPE_COSINE_FLOORS[r.item.type] ?? 0.5);
    return (r.breakdown.lexical_raw ?? 0) >= 0.1;
  });
  return kept.length > 0 && (kept[0]!.breakdown.cosine ?? 0) >= MIN_TOP1_COSINE ? kept : [];
}

function toItem(row: CorpusRow): MemoryItem {
  const at = new Date(NOW.getTime() - row.daysAgo * DAY);
  return makeItem({
    id: row.id,
    type: row.type,
    raw: { text: row.text, contentType: 'text/plain' },
    payload: row.project ? { project: row.project } : {},
    createdAt: at,
    updatedAt: at,
    lastAccessedAt: at,
  });
}

const pct = (x: number) => x.toFixed(3);

function formatContext(items: RankedItem[]): string {
  const blocks = items.map((r, i) => {
    const project = (r.item.payload as { project?: string }).project;
    const scope = project ? `, ${project}` : '';
    const cos = r.breakdown.cosine;
    const label = cos !== undefined ? `cosine: ${cos.toFixed(3)}` : `lex: ${(r.breakdown.lexical_raw ?? 0).toFixed(3)}`;
    return `[Memory ${i + 1}] (${r.item.type}${scope}, ${label}):\n${(r.item.raw?.text ?? '').slice(0, 500)}`;
  });
  return `EXOCORTEX MEMORY RECALL:\n\nSEMANTIC MEMORY (exocortex):\n${blocks.join('\n\n')}`;
}

function demoQuery(): { text: string; project?: string } | undefined {
  const i = process.argv.indexOf('--demo');
  if (i === -1) return undefined;
  const text = process.argv[i + 1];
  if (!text) throw new Error('usage: npm run eval -- --demo "<query>" [--project <name>]');
  const p = process.argv.indexOf('--project');
  return { text, project: p === -1 ? undefined : process.argv[p + 1] };
}

async function main(): Promise<void> {
  const corpus = readJsonl<CorpusRow>('corpus.jsonl');
  const queries = readJsonl<QueryRow>('queries.jsonl');
  const positives = queries.filter((q) => Object.keys(q.relevant).length > 0);
  const negatives = queries.filter((q) => Object.keys(q.relevant).length === 0);

  const embedder = new CachedEmbedder(
    OFFLINE ? new HashEmbedder(512) : new OpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY!, model: 'text-embedding-3-small' }),
  );
  const pg = new InMemoryPostgres();
  const qd = new InMemoryQdrant();
  await seed(pg, qd, embedder, corpus.map(toItem));
  const recall = new RecallService({ postgres: pg.asStore(), qdrant: qd.asStore(), embedder, vectorTopK: 50, lexicalTopK: 50 });

  const demo = demoQuery();
  if (demo) {
    const embedText = !OFFLINE && contentWords(demo.text) < HYDE_MAX_WORDS ? hyde(demo.text) : demo.text;
    const res = await recall.recall({ text: embedText, project: demo.project, limit: POOL, mode: 'warm' }, { readOnly: true });
    let items = res.items;
    if (!OFFLINE && items.length > TOP_N) items = rerank(demo.text, items);
    const kept = applyGate(items.slice(0, TOP_N));
    llmCache.save();
    console.log(kept.length ? formatContext(kept) : '(gate closed, nothing injected)');
    return;
  }

  const configs = CONFIGS.filter((c) => !OFFLINE || !c.online);
  const kinds = [...new Set(positives.map((q) => q.kind))];
  const rows: Array<Record<string, string | number>> = [];
  const byKind: Record<string, Record<string, number>> = {};
  let lexicalFired = 0;

  for (const cfg of configs) {
    const ndcg: number[] = [];
    const r5: number[] = [];
    const mrr: number[] = [];
    const kindNdcg: Record<string, number[]> = {};
    let answered = 0;
    let abstained = 0;

    for (const q of queries) {
      if (cfg.lexicalArm) {
        if (Object.keys(q.relevant).length === 0) continue;
        const ids = (await pg.lexicalSearch(q.text, POOL, { includeDecayed: true, project: q.project })).map((h) => h.id);
        if (ids.length) lexicalFired += 1;
        const n = ndcgAt(ids, q.relevant, 10);
        ndcg.push(n);
        r5.push(recallAt(ids, q.relevant, 5));
        mrr.push(mrrAt(ids, q.relevant, 10));
        (kindNdcg[q.kind] ??= []).push(n);
        continue;
      }
      const embedText = cfg.hyde && contentWords(q.text) < HYDE_MAX_WORDS ? hyde(q.text) : q.text;
      const res = await recall.recall(
        { text: embedText, project: q.project, limit: POOL, mode: 'warm', weights: cfg.weights },
        { readOnly: true },
      );
      let items = res.items;
      if (cfg.rerank && items.length > TOP_N) items = rerank(q.text, items);
      const ids = items.map((r) => r.item.id);
      const gated = applyGate(items.slice(0, TOP_N)).length > 0;

      if (Object.keys(q.relevant).length === 0) {
        if (!gated) abstained += 1;
        continue;
      }
      if (gated) answered += 1;
      const n = ndcgAt(ids, q.relevant, 10);
      ndcg.push(n);
      r5.push(recallAt(ids, q.relevant, 5));
      mrr.push(mrrAt(ids, q.relevant, 10));
      (kindNdcg[q.kind] ??= []).push(n);
    }

    rows.push({
      config: cfg.name,
      'nDCG@10': pct(mean(ndcg)),
      'Recall@5': pct(mean(r5)),
      'MRR@10': pct(mean(mrr)),
      'answered (pos)': cfg.lexicalArm || OFFLINE ? 'n/a' : `${answered}/${positives.length}`,
      'abstained (neg)': cfg.lexicalArm || OFFLINE ? 'n/a' : `${abstained}/${negatives.length}`,
    });
    byKind[cfg.name] = Object.fromEntries(kinds.map((k) => [k, mean(kindNdcg[k] ?? [])]));
  }
  llmCache.save();

  const table = (header: string[], body: string[][]) =>
    [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');

  const mainTable = table(Object.keys(rows[0]!), rows.map((r) => Object.values(r).map(String)));
  const kindTable = table(
    ['config', ...kinds.map((k) => `${k} (${positives.filter((q) => q.kind === k).length})`)],
    configs.map((c) => [c.name, ...kinds.map((k) => pct(byKind[c.name]![k]!))]),
  );

  const report = [
    `# Retrieval eval`,
    '',
    `Corpus ${corpus.length} items, ${positives.length} labeled queries, ${negatives.length} out-of-scope queries. Embedder \`${embedder.model}\`${OFFLINE ? ' (offline, HyDE and rerank skipped)' : ', HyDE and rerank on gpt-4o-mini'}.`,
    '',
    mainTable,
    '',
    `The lexical arm (\`plainto_tsquery('simple')\`, every word must match) returned anything for ${lexicalFired} of ${positives.length} labeled queries.`,
    '',
    'nDCG@10 by query kind:',
    '',
    kindTable,
    '',
  ].join('\n');

  console.log(report);
  console.log(`embedding calls ${embedder.calls}, llm calls ${llmCalls} (cache hits are free)`);
  if (!OFFLINE) writeFileSync(join(HERE, 'results.md'), report);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
