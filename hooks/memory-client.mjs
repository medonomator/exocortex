/**
 * memory-client.mjs - singleton wrapper around @exocortex/memory for hooks.
 *
 * All 7 hooks import this. We construct Postgres pool, Qdrant client,
 * embedder and the three services once per process. On process exit the
 * Postgres pool is flushed via `closeMemory()` - hooks MUST call it before
 * exiting, otherwise Node keeps the pool open and the hook never terminates.
 *
 * Design:
 *   • Collection name is namespaced by embedder model. Default is
 *     `mem_items_3small_1536` (text-embedding-3-small at native 1536-dim).
 *   • `ingestText` / `recallText` are convenience wrappers around
 *     IngestService / RecallService so hook code stays terse.
 *   • Failures bubble up; hooks decide whether to swallow or surface.
 */

import { randomUUID } from 'node:crypto'
import { loadEnv } from './env-loader.mjs'

loadEnv()

// Proxy bootstrap: Node's built-in fetch ignores HTTPS_PROXY env. Installing
// undici ProxyAgent as the global dispatcher lets OpenAIEmbedder reach
// api.openai.com from regions where the API is geo-blocked. Must happen
// BEFORE importing the memory bundle (which binds fetch at module-eval time).
{
  const hasProxyEnv = !!process.env.HTTPS_PROXY
    || !!process.env.https_proxy
    || !!process.env.HTTP_PROXY
    || !!process.env.http_proxy
  if (hasProxyEnv) {
    if (!process.env.NO_PROXY && !process.env.no_proxy) {
      process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    }
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new EnvHttpProxyAgent())
  }
}

const {
  PostgresStore,
  QdrantStore,
  OpenAIEmbedder,
  IngestService,
  RecallService,
  IntrospectService,
} = await import('../memory/dist/index.js')

const EMBED_MODEL = process.env.EXOCORTEX_EMBED_MODEL ?? 'text-embedding-3-small'
const EMBED_DIM = Number(process.env.EXOCORTEX_EMBED_DIM ?? 1536)
const COLLECTION = process.env.EXOCORTEX_COLLECTION
  ?? `mem_items_${EMBED_MODEL.includes('small') ? '3small' : '3large'}_${EMBED_DIM}`

let _pg = null
let _qd = null
let _emb = null
let _ingest = null
let _recall = null
let _introspect = null

function build() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set - cannot build memory client')
  }

  _pg = new PostgresStore()
  _qd = new QdrantStore({
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    collection: COLLECTION,
    vectorSize: EMBED_DIM,
  })
  _emb = new OpenAIEmbedder({
    apiKey: process.env.OPENAI_API_KEY,
    model: EMBED_MODEL,
    dim: EMBED_DIM,
  })

  _ingest = new IngestService({
    postgres: _pg,
    qdrant: _qd,
    embedder: _emb,
    noveltyThreshold: 0.15,
  })
  _recall = new RecallService({
    postgres: _pg,
    qdrant: _qd,
    embedder: _emb,
  })
  _introspect = new IntrospectService({ postgres: _pg })
}

function ensureBuilt() {
  if (!_pg) build()
}

export function getServices() {
  ensureBuilt()
  return { pg: _pg, qd: _qd, embedder: _emb, ingest: _ingest, recall: _recall, introspect: _introspect }
}

export async function closeMemory() {
  if (_pg) {
    try { await _pg.close() } catch { /* ignore */ }
  }
  _pg = _qd = _emb = _ingest = _recall = _introspect = null
}

/**
 * Build a MemoryEvent from caller-friendly fields and ingest it.
 *
 * @param {string} text             required; content.text
 * @param {object} opts
 *   - kind      EventKind (default 'observation')
 *   - type      ItemType hint for IngestService (default 'episode')
 *   - source    ProvenanceSource (default 'hook')
 *   - agentId   hook name, for observability
 *   - sessionId Claude Code session id
 *   - actors    string[]
 *   - project   payload.project
 *   - importance 0..1
 *   - payload   explicit payload override
 *   - extra     provenance.extra
 *   - raw       override content.raw (else {text})
 *   - sourceUri content.sourceUri
 *   - contentType default 'text/plain'
 *   - timestamp  default now
 */
export async function ingestText(text, opts = {}) {
  ensureBuilt()
  const now = opts.timestamp ?? new Date()
  const event = {
    id: randomUUID(),
    kind: opts.kind ?? 'observation',
    content: {
      text,
      contentType: opts.contentType ?? 'text/plain',
      sourceUri: opts.sourceUri,
    },
    actors: opts.actors,
    timestamp: now,
    raw: opts.raw ?? { text },
    provenance: {
      source: opts.source ?? 'hook',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      producedAt: now,
      chain: opts.chain ?? ['hook'],
      extra: opts.extra,
    },
  }
  const hint = {
    type: opts.type,
    payload: opts.payload,
    importance: opts.importance,
    project: opts.project,
  }
  return _ingest.ingest(event, hint)
}

/**
 * Recall against the new memory.
 *
 * @param {string} text
 * @param {object} opts - forwarded as Query fields (types, levels, project,
 *                       since, until, limit, mode, weights), plus:
 *   - readOnly / rankMode / provenancePrefs → RecallOpts
 */
export async function recallText(text, opts = {}) {
  ensureBuilt()
  const { readOnly, rankMode, provenancePrefs, ...queryFields } = opts
  return _recall.recall({ text, ...queryFields }, { readOnly, rankMode, provenancePrefs })
}
