#!/usr/bin/env node

/**
 * UserPromptSubmit hook - semantic + graph recall using @exocortex/memory.
 *
 * Replaces the legacy 5-collection hybrid RRF setup with a single RecallService
 * call: vector + lexical + multi-signal ranking, Ebbinghaus decay, automatic
 * reactivation of the top-N. kg_entities graph traversal is kept since it
 * lives in PostgreSQL (not Qdrant) and the new memory system doesn't replace
 * the explicit entity graph.
 */

import { appendFileSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { readStdinSync } from './utils.mjs'
import {
  searchByKeywords,
  traverseFrom,
  closePool,
  ackRecallsForSession,
  decayStaleRecalls,
  logRecall,
  resolveQueryEntityNeighborhood,
  countItemEntityMatches,
} from './pg-client.mjs'
import { recallText, closeMemory } from './memory-client.mjs'
import { rerankWithLLM } from './llm-rerank.mjs'
import { generateHyDE } from './hyde.mjs'
import { canonicalProject, projectFromCwd } from './project-alias.mjs'

const MAX_RESULTS = 5
const HYDE_ENABLED = process.env.EXOCORTEX_HYDE !== '0'
// Signal gate: drop items that can't clear a minimum relevance bar.
// Below these thresholds we're polluting Claude's context with noise -
// better to show nothing than to surface "User completed_project_for
// клиент A" when the user asked about RAG quality.
//
// Bumped from 0.40 → 0.50 after empirical analysis: real relevant hits
// in conversation logs sit at cos 0.53-0.58, while cross-domain noise
// on math/ML questions clusters at 0.40-0.46. The old floor let almost
// all cross-domain noise through on the large confyday-backend index.
const MIN_COSINE = Number(process.env.EXOCORTEX_MIN_COSINE ?? 0.50)
const MIN_LEXICAL = Number(process.env.EXOCORTEX_MIN_LEXICAL ?? 0.10)
// Top-1 floor: if the best candidate after rerank is below this, the
// whole batch is suppressed - "best of garbage is still garbage". This
// prevents low-confidence batches (top-1 ≈ 0.42 on definitional queries)
// from reaching Claude at all, even when individual items pass MIN_COSINE.
const MIN_TOP1_COSINE = Number(process.env.EXOCORTEX_MIN_TOP1 ?? 0.55)
// Per-type cosine floors. Episodes (commit summaries) are narrow and
// noisy on cross-domain queries - tighter floor. Facts/relations are
// usually short and specific - looser floor is fine.
const TYPE_COSINE_FLOORS = {
  episode: 0.55,
  procedure: 0.50,
  abstraction: 0.50,
  fact: 0.45,
  relation: 0.45,
}
// Rerank pool: candidates we pull from RecallService before LLM rerank
// narrows them down. 20 is the sweet spot - enough recall breadth to let
// the cross-encoder find the best 5, small enough to keep the prompt under
// 3K tokens (~$0.0001 per call at gpt-4o-mini).
const RERANK_POOL = 20
const RERANK_ENABLED = process.env.EXOCORTEX_LLM_RERANK !== '0'
const HOOK_LOG = '/tmp/hook-debug.log'

function log(msg) {
  try { appendFileSync(HOOK_LOG, `[${new Date().toISOString()}] qdrant-recall: ${msg}\n`) } catch { /* ignore */ }
}

// Stopwords for keyword extraction (for graph traversal only - memory-client
// does its own ranking with lexical/vector/recency/importance/etc.)
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'ought',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'from', 'by', 'about',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'if', 'then', 'else', 'when', 'up', 'out', 'off', 'over', 'under',
  'как', 'что', 'это', 'для', 'не', 'на', 'по', 'из', 'за', 'от',
  'да', 'нет', 'все', 'мне', 'мы', 'ты', 'он', 'она', 'они', 'его',
  'её', 'тут', 'там', 'уже', 'ещё', 'тоже', 'очень', 'так', 'вот',
  'ли', 'же', 'бы', 'ну', 'ок', 'если', 'при', 'без', 'или',
])

function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\sа-яёА-ЯЁ-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8)
}

/**
 * Read the tail of a transcript JSONL and extract recent TEXT turns for the
 * given role ('user' or 'assistant'). Transcripts grow to tens of MB - we
 * tail in chunks of 512KB, walking backwards until we either collect
 * maxTurns text turns or hit a 4MB budget.
 *
 * Assistant turns dominate the tail byte-count (tool calls + tool_results),
 * so a naive 128KB tail often contains zero real user messages on
 * tool-heavy sessions. The chunked walk-back handles that.
 *
 * Skips synthetic/system messages:
 *   - content starting with "<" (XML-like system reminders)
 *   - "This session is being continued" (auto-compaction preamble)
 *   - turns whose content is all tool_use/tool_result parts (no text)
 *
 * Returns an array of { text, ts } with the MOST RECENT turn LAST.
 */
function readRecentTurns(transcriptPath, maxTurns = 3, role = 'user') {
  if (!transcriptPath) return []
  const CHUNK = 512 * 1024
  const BUDGET = 4 * 1024 * 1024
  let fd = null
  try {
    const stat = statSync(transcriptPath)
    const size = stat.size
    fd = openSync(transcriptPath, 'r')

    const collected = [] // newest-first while we walk backwards
    let offset = size
    let readTotal = 0
    let partialHead = ''

    while (collected.length < maxTurns && offset > 0 && readTotal < BUDGET) {
      const len = Math.min(CHUNK, offset)
      offset -= len
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      readTotal += len
      const chunk = buf.toString('utf-8') + partialHead
      const firstNewline = chunk.indexOf('\n')
      // Keep the partial record at the head for the next (earlier) chunk.
      if (offset > 0 && firstNewline > 0) {
        partialHead = chunk.slice(0, firstNewline)
      } else {
        partialHead = ''
      }
      const body = offset > 0 && firstNewline > 0 ? chunk.slice(firstNewline + 1) : chunk
      const lines = body.split('\n').filter((l) => l.length > 0)

      for (let i = lines.length - 1; i >= 0; i--) {
        let obj
        try { obj = JSON.parse(lines[i]) } catch { continue }
        if (obj.type !== role || obj.message?.role !== role) continue
        const raw = obj.message.content
        let textContent = ''
        if (typeof raw === 'string') textContent = raw
        else if (Array.isArray(raw)) {
          for (const p of raw) {
            if (p.type === 'text' && typeof p.text === 'string') textContent += (textContent ? '\n' : '') + p.text
          }
        }
        if (!textContent) continue
        const trimmed = textContent.trim()
        if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('This session is being continued')) continue
        collected.push({ text: trimmed, ts: obj.timestamp ?? '' })
        if (collected.length >= maxTurns) break
      }
    }
    closeSync(fd)
    fd = null
    return collected.reverse() // oldest-first, most recent last
  } catch {
    if (fd !== null) { try { closeSync(fd) } catch { /* */ } }
    return []
  }
}

// Back-compat shim: earlier code called this name directly.
function readRecentUserTurns(transcriptPath, maxTurns = 3) {
  return readRecentTurns(transcriptPath, maxTurns, 'user')
}

/**
 * Build an enriched query string when the current turn is too short/ambiguous
 * to produce a useful embedding on its own.
 *
 * Two sources, picked by query shape:
 *   1) PREV USER TURN - topic continuity. "делать все постепенно" inherits
 *      the topic from the prior user question.
 *   2) PREV ASSISTANT TURN - meta acknowledgements. "ок делаем", "улучшим
 *      еще", "давай дальше" carry zero topic signal, and the previous user
 *      turn is often equally thin ("что дальше?" → "продолжим"). The topic
 *      actually lives in what the assistant just said.
 *
 * Selection rule: prefer USER turn if it has ≥3 content words AND current
 * turn isn't a bare meta-ack. Otherwise fall through to ASSISTANT turn.
 *
 * Enrichment kicks in only when the current turn has < 5 content words.
 * For long/specific queries we leave the query untouched - adding stale
 * context then dilutes the signal. Lowered from <8 to <5 because the prev
 * turn often brings off-topic keywords (last thing discussed), and for
 * 5-7 word queries HyDE does a better job than stale context injection.
 */
const META_ACK = /^(ок|окей|ok|okay|да|ага|yes|yep|nope|делаем|поехали|let'?s go|давай|погнали|продолжим|продолжаем|согласен|agreed|sounds good|go ahead|круто|отлично)\b/i

// Definitional / explainer questions - exocortex has no general knowledge,
// only project-specific episodes. Showing commit summaries on "what is X?"
// is pure noise. Skip recall entirely for these patterns UNLESS the query
// also has episodic markers ("помнишь", "когда мы", "в нашем проекте").
//
// IMPORTANT: JS \b is ASCII-only and won't fire after cyrillic letters
// (т.к. "е" в "такое" — non-word char для ASCII). Используем
// /u flag + Unicode-aware lookarounds: (?=non-letter|end), (?<=non-letter|start).
const NON_LETTER = '(?:[^\\p{L}\\p{N}]|^|$)'
const NON_LETTER_AHEAD = '(?=[^\\p{L}\\p{N}]|$)'
const NON_LETTER_BEHIND = '(?<=[^\\p{L}\\p{N}]|^)'
const DEFINITIONAL = new RegExp(
  `^\\s*(что такое|что значит|что есть|объясни|расскажи про|расскажи о|как читать|как понять|как понимать|как работает|почему именно|зачем нужен|what is|what does|explain|how does|why does|tell me about)${NON_LETTER_AHEAD}`,
  'iu',
)
const EPISODIC = new RegExp(
  `${NON_LETTER_BEHIND}(помнишь|когда мы|как мы|раньше|вчера|на прошлой|прошлый раз|в нашем|в моём проекте|на проде|на деве|в коде)${NON_LETTER_AHEAD}`,
  'iu',
)

// Math / abstract markers - if a short query contains these, the topic
// is almost certainly theoretical (formulas, ML concepts, math notation)
// rather than project-specific. Used to skip both recall AND assistant-turn
// enrichment, which otherwise pulls a long ML explanation into the embed
// and drags it cross-domain into backend commit space.
//
// /u flag is mandatory here: cyrillic word boundaries (\b around "градиент")
// don't work without it. Using Unicode lookarounds for cross-script support.
const FORMULA_OR_ABSTRACT = new RegExp(
  `(${NON_LETTER_BEHIND}(gradient|градиент|loss|entropy|энтропи|softmax|sigmoid|relu|tensor|тензор|cosine|cosin|корень|производн|derivative|integral|интеграл|формул|formula|theorem|теорем|matrix|матриц|vector|вектор|probability|вероятност|distribution|распределен|bayes|байес|likelihood|правдоподоби|sgd|adam|backprop|loglik)${NON_LETTER_AHEAD}|[∇∂∑∏∫√≤≥≠≈±∞⊕⊗·×÷ŷθηβλμσπφψ])`,
  'iu',
)

function maybeEnrichQuery(current, transcriptPath) {
  const currentWords = extractKeywords(current)
  if (currentWords.length >= 5) return { text: current, enriched: false, source: null, prev: null }

  // Don't enrich math/abstract queries with assistant-turn context. The
  // prior assistant turn for "∇ что значит?" is a 2KB ML explanation that
  // drags the embedding into a cross-domain neighborhood, then matches
  // backend commits with shared tokens. Better to embed the bare query
  // (HyDE may still augment it) than poison it with off-topic context.
  if (FORMULA_OR_ABSTRACT.test(current)) {
    return { text: current, enriched: false, source: null, prev: null }
  }

  const isMetaAck = META_ACK.test(current.trim()) || currentWords.length < 4

  // Find prev user turn first.
  const userTurns = readRecentTurns(transcriptPath, 3, 'user')
  let prevUser = null
  for (let i = userTurns.length - 1; i >= 0; i--) {
    if (userTurns[i].text.trim() !== current.trim()) { prevUser = userTurns[i]; break }
  }
  const prevUserWords = prevUser ? extractKeywords(prevUser.text) : []

  // Decide source: USER turn wins if substantive AND current isn't just
  // a bare ack. Otherwise try ASSISTANT turn.
  let chosen = null
  let source = null
  if (prevUser && prevUserWords.length >= 3 && !isMetaAck) {
    chosen = prevUser
    source = 'user'
  } else {
    // Assistant fallback: meta queries get topic from what assistant just said.
    // Multi-tool-call turns split assistant output into many short "lead-in"
    // text blocks (each before a tool call). One such block rarely has enough
    // content to ground the embedding, so we concatenate the most recent
    // asst turns into a single "recent assistant thread" blob.
    const asstTurns = readRecentTurns(transcriptPath, 8, 'assistant')
    if (asstTurns.length > 0) {
      const joined = asstTurns.map((t) => t.text.trim()).join(' ').slice(0, 1500)
      if (extractKeywords(joined).length >= 5) {
        chosen = { text: joined, ts: asstTurns[asstTurns.length - 1].ts }
        source = 'assistant'
      }
    }
    if (!chosen && prevUser && prevUserWords.length >= 3) {
      // No usable assistant context - fall back to user turn even if meta-ack.
      chosen = prevUser
      source = 'user'
    }
  }

  if (!chosen) return { text: current, enriched: false, source: null, prev: null }

  // Cap prev to avoid blowing up the embedding with a huge paste.
  // Assistant turns tend to be longer; a 1000ch cap still fits in budget.
  const CAP = source === 'assistant' ? 1000 : 800
  const prevSnippet = chosen.text.length > CAP ? chosen.text.slice(0, CAP) : chosen.text
  return {
    text: `${prevSnippet}\n\n${current}`,
    enriched: true,
    source,
    prev: prevSnippet,
  }
}

/**
 * Parse a temporal hint from the query and return {since, until} bounds
 * (or null if no hint). Bounds are calendar-aligned to local time so
 * "yesterday" maps to [yesterday 00:00, today 00:00).
 *
 * Without this, embedding similarity alone can't distinguish "вчера" from
 * "позавчера" - daily summaries all start with "Сегодня основной фокус..."
 * and hit cosine > 0.7 regardless of which day they describe.
 *
 * Returns null for ambiguous queries (no window applied - embedding wins).
 */
function parseTemporalHint(text) {
  // Pad with spaces so lookaheads/lookbehinds can treat start/end as boundaries.
  // JS \b is ASCII-only and won't work for Cyrillic - we use explicit
  // non-letter boundaries matching both ASCII and Cyrillic alphabets.
  const q = ` ${text.toLowerCase()} `
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const d = (days) => new Date(startOfToday.getTime() - days * 86400000)

  // Boundary chars: anything NOT in Latin/Cyrillic letter classes.
  const B = '[^a-zа-яё]'
  const re = (phrase) => new RegExp(`${B}${phrase}${B}`, 'i')

  // Order matters: match more-specific phrases first.
  if (re('(позавчера|day before yesterday)').test(q)) {
    return { since: d(2), until: d(1), label: 'day-before-yesterday' }
  }
  if (re('(вчера|yesterday)').test(q)) {
    return { since: d(1), until: d(0), label: 'yesterday' }
  }
  if (re('(сегодня|today)').test(q)) {
    return { since: d(0), until: new Date(startOfToday.getTime() + 86400000), label: 'today' }
  }
  if (re('(на прошлой неделе|last week|прошлую неделю)').test(q)) {
    return { since: d(14), until: d(7), label: 'last-week' }
  }
  if (re('(на этой неделе|this week|эту неделю)').test(q)) {
    return { since: d(7), until: new Date(startOfToday.getTime() + 86400000), label: 'this-week' }
  }
  // Relaxed "recently" - wider window, still useful to keep ancient items out.
  if (re('(недавно|recently|пару дней назад|a few days ago|на днях)').test(q)) {
    return { since: d(5), until: new Date(startOfToday.getTime() + 86400000), label: 'recent-5d' }
  }
  return null
}

/**
 * Heuristic query-intent classifier. Narrows the `types` filter so e.g. a
 * troubleshooting question doesn't pull in user-preference facts.
 *
 * Returns undefined (no filter) on ambiguous queries so we don't over-filter.
 */
function inferTypes(text) {
  const q = text.toLowerCase()
  const troubleshoot = /\b(как|почему|зачем|fix|debug|issue|bug|падает|падает|сломал|ошибк|проблем|не работает|не запускается|broken|crash|error|exception)\b/i
  const preference = /\b(помнишь|знаешь|лайк|like|prefer|предпочит|привычк|habit|кто я|мои|what do i|who am i)\b/i
  const howto = /\b(how to|как сделать|как использовать|как настроить|how do i)\b/i

  if (howto.test(q)) return ['procedure', 'episode', 'abstraction']
  if (troubleshoot.test(q)) return ['episode', 'procedure']
  if (preference.test(q)) return ['fact', 'relation']
  return undefined
}

async function searchGraph(keywords) {
  if (keywords.length === 0) return []
  const safe = keywords
    .map((k) => k.replace(/[^\w\u0400-\u04FF-]/g, ''))
    .filter((k) => k.length > 0)
  if (safe.length === 0) return []
  return searchByKeywords(safe)
}

function formatGraphContext(rows) {
  if (rows.length === 0) return ''
  const seen = new Set()
  const lines = []
  for (const r of rows) {
    const key = `${r.name}|${r.related_name}|${r.rel_type}`
    if (seen.has(key)) continue
    seen.add(key)
    if (r.related_name) {
      lines.push(`  ${r.name} (${r.type}) -[${r.rel_type}]→ ${r.related_name} (${r.related_type})`)
    } else {
      lines.push(`  ${r.name} (${r.type}, mentions: ${r.mention_count})`)
    }
  }
  return lines.join('\n')
}

function formatItemContext(items) {
  if (items.length === 0) return ''
  return items
    .map((r, i) => {
      const it = r.item
      const preview = (it.raw?.text ?? '').slice(0, 500)
      const scope = it.payload?.project ? `, ${it.payload.project}` : ''
      // Prefer raw cosine (interpretable 0..1). Fall back to RRF score for
      // items that matched only via lexical search (no vector hit).
      const cos = r.breakdown?.cosine
      const label = cos !== undefined
        ? `cosine: ${cos.toFixed(3)}`
        : `lex: ${(r.breakdown?.lexical_raw ?? 0).toFixed(3)}`
      return `[Memory ${i + 1}] (${it.type}${scope}, ${label}):\n${preview}`
    })
    .join('\n\n')
}

// Hard kill before Claude Code's 15s timeout
setTimeout(() => { log('TIMEOUT self-kill'); process.exit(0) }, 12000).unref()

async function main() {
  try {
    log('started')
    const input = readStdinSync()
    if (!input) process.exit(0)

    const parsed = JSON.parse(input)
    const userMessage = parsed?.prompt
      ?? parsed?.hookSpecificInput?.userMessage
      ?? parsed?.user_message
      ?? ''
    const transcriptPath = parsed?.transcript_path ?? parsed?.transcriptPath ?? null
    const sessionId = parsed?.session_id ?? parsed?.sessionId ?? null
    const cwd = parsed?.cwd ?? ''
    // Resolve cwd basename → canonical project name the store uses. If the
    // cwd is unknown (empty, or a dir we don't map), we pass no project
    // filter so legacy null-project items still surface.
    const project = canonicalProject(projectFromCwd(cwd))
    if (project) log(`project scope: ${project} (from cwd)`)

    if (!userMessage || userMessage.length < 10) process.exit(0)

    const trimmed = userMessage.toLowerCase().trim()
    if (/^(hi|hello|привет|ок|да|нет|спасибо|thanks|ok|yes|no)\s*[!.?]?$/i.test(trimmed)) {
      process.exit(0)
    }

    // Definitional short-circuit: questions like "что такое X?" / "explain Y"
    // belong to general knowledge, which exocortex doesn't index - it only
    // has project-specific episodes (commits, notes, decisions). Forcing a
    // recall here surfaces backend commits with shared keywords ("loss",
    // "gradient" in code logs, etc.) that look relevant to the embedder
    // but are pure noise to the user. Skip unless the query also has
    // episodic markers ("помнишь", "когда мы делали", etc).
    if (DEFINITIONAL.test(userMessage) && !EPISODIC.test(userMessage)) {
      log('skip: definitional question without episodic markers')
      process.exit(0)
    }
    // Formula-only short queries: "∇ что значит?" / "log это что?". Same
    // logic - exocortex won't have it, and embedding such queries with
    // assistant-turn enrichment pulls the embed into a cross-domain
    // neighborhood, false-positive matching backend commits.
    if (userMessage.length < 50 && FORMULA_OR_ABSTRACT.test(userMessage) && !EPISODIC.test(userMessage)) {
      log('skip: short formula/abstract query without episodic markers')
      process.exit(0)
    }

    // Query enrichment: for short follow-ups, prepend the previous user turn
    // so the embedder has real context. Intent classification still runs on
    // the CURRENT turn (the user's immediate ask), not the enriched blob.
    const enrichment = maybeEnrichQuery(userMessage, transcriptPath)
    const queryText = enrichment.text
    if (enrichment.enriched) log(`enriched: +${enrichment.prev.length}ch prev-${enrichment.source}-turn context`)

    // Semantic-gate: only hard-skip if BOTH current turn AND enriched query
    // are too thin. With enrichment a short "делать все постепенно" becomes
    // usable because the previous turn carries the topic.
    const enrichedWords = extractKeywords(queryText)
    if (enrichedWords.length < 2) {
      log(`skip: only ${enrichedWords.length} content word(s) after enrichment`)
      process.exit(0)
    }

    // HyDE: embed a query+hypothetical-answer combo. Short questions have
    // weak cosine against long stored answers; a 2-3 sentence plausible
    // answer closes the query-answer asymmetry. Lexical search still sees
    // original words (concat, not replacement). Silent no-op on failure.
    //
    // Gated by length: HyDE helps on short queries (<7 content words) and
    // HURTS specific long queries by diluting the embedding with hypo-
    // thetical phrasing. Empirically the break-even is ~7 content words
    // for our collection; tune via EXOCORTEX_HYDE_MAX_WORDS.
    const HYDE_MAX_WORDS = Number(process.env.EXOCORTEX_HYDE_MAX_WORDS ?? 5)
    let queryForEmbed = queryText
    if (HYDE_ENABLED && enrichedWords.length < HYDE_MAX_WORDS) {
      const hyde = generateHyDE(queryText)
      if (hyde.hypothetical) {
        queryForEmbed = hyde.text
        log(`hyde: +${hyde.hypothetical.length}ch hypothetical (words=${enrichedWords.length}<${HYDE_MAX_WORDS})`)
      }
    } else if (HYDE_ENABLED) {
      log(`hyde: skip (words=${enrichedWords.length}≥${HYDE_MAX_WORDS})`)
    }

    // ── Feedback: ack previous recalls that the user engaged with.
    // Ack runs on the CURRENT turn's content words (not enriched) - the
    // current turn IS "what the user actually said next" from the previous
    // recall's perspective. Enriched text would contaminate with prev-turn
    // words and falsely ack the prev recall with itself.
    const currentWords = extractKeywords(userMessage)
    const ackPromise = sessionId && currentWords.length > 0
      ? ackRecallsForSession(sessionId, currentWords)
      : Promise.resolve(0)
    const decayPromise = decayStaleRecalls()

    // ── Memory recall: vector + lexical + signals (RRF fusion via RecallService) ──
    let recallRes = null
    try {
      // Intent comes from the current turn - user's "как починить X?" stays
      // a troubleshoot query even if the prior turn was something else.
      const types = inferTypes(userMessage)
      // Temporal hint also runs on the current turn - the follow-up "а что
      // насчёт вчерашнего?" should scope down to yesterday even if the
      // enriched prev turn is topic-agnostic.
      const temporal = parseTemporalHint(userMessage)
      // Pull a larger pool so the LLM reranker has real headroom. When
      // rerank is disabled we just fetch MAX_RESULTS directly.
      const fetchLimit = RERANK_ENABLED ? RERANK_POOL : MAX_RESULTS
      const opts = { limit: fetchLimit, mode: 'warm' }
      if (types) opts.types = types
      if (temporal) {
        opts.since = temporal.since
        opts.until = temporal.until
      }
      // Project scoping: prevents cross-project bleed (e.g. sitting in
      // ~/exocortex but surfacing confyday-backend items because of a
      // shared embedding neighbourhood). Null-project items (legacy /
      // user-wide) are still matched - scoping is applied inside Qdrant
      // filter and lexical search as "project = X OR project IS NULL".
      if (project) opts.project = project
      recallRes = await recallText(queryForEmbed, opts)
      if (types) log(`intent filter → types=${types.join(',')}`)
      if (temporal) {
        log(`temporal filter → ${temporal.label} [${temporal.since.toISOString().slice(0,10)}..${temporal.until.toISOString().slice(0,10)})`)
      }
    } catch (err) {
      log(`recall failed: ${err?.message ?? err}`)
    }

    // ── Graph-proximity boost ──
    // For each recall candidate, check how many of its linked kg_entities
    // fall in the query's entity-neighbourhood (query keywords → matching
    // entities + 1-hop graph expansion). Items with ≥1 match get promoted.
    //
    // Runs BEFORE the LLM reranker: if graph promotes a topically-relevant
    // item out of the tail into the top-20, the reranker sees it too. If
    // it runs after rerank, we'd undo the LLM's decision.
    if (recallRes?.items?.length > 0) {
      try {
        const qKeywords = extractKeywords(queryText)
        const neighborhood = await resolveQueryEntityNeighborhood(qKeywords)
        if (neighborhood.size > 0) {
          const itemIds = recallRes.items.map((r) => r.item.id)
          const counts = await countItemEntityMatches(itemIds, neighborhood)
          // Compute proximity per candidate and re-sort: (proximity desc,
          // original rank asc). Proximity is matched/total (0..1). Candidates
          // with no links fall back to their fusion rank.
          const withProx = recallRes.items.map((r, idx) => {
            const c = counts.get(r.item.id)
            const prox = c && c.total > 0 ? c.matched / c.total : 0
            r.breakdown = r.breakdown ?? {}
            r.breakdown.graph_proximity = prox
            return { r, prox, idx }
          })
          // Stable re-sort: only promote items with non-zero proximity above
          // zero-proximity peers; inside each band, preserve fusion rank.
          withProx.sort((a, b) => (b.prox - a.prox) || (a.idx - b.idx))
          const boosted = withProx.filter((x) => x.prox > 0).length
          if (boosted > 0) {
            recallRes.items = withProx.map((x) => x.r)
            log(`graph-boost: ${boosted}/${recallRes.items.length} items have entity overlap (|N|=${neighborhood.size})`)
          }
        }
      } catch (err) {
        log(`graph-boost failed: ${err?.message ?? err}`)
      }
    }

    // ── Cross-encoder rerank (OpenAI gpt-4o-mini as listwise judge) ──
    // Runs only when we have a pool worth reranking. Failures fall back
    // to the fusion-rank order silently.
    if (RERANK_ENABLED && recallRes?.items?.length > MAX_RESULTS) {
      try {
        const before = recallRes.items.length
        const reranked = rerankWithLLM(userMessage, recallRes.items, MAX_RESULTS)
        // Cap to MAX_RESULTS so downstream formatting stays terse.
        recallRes.items = reranked.slice(0, MAX_RESULTS)
        log(`rerank: ${before} → ${recallRes.items.length}`)
      } catch (err) {
        log(`rerank failed: ${err?.message ?? err}`)
        recallRes.items = recallRes.items.slice(0, MAX_RESULTS)
      }
    } else if (recallRes?.items?.length) {
      recallRes.items = recallRes.items.slice(0, MAX_RESULTS)
    }

    // ── Signal gate ──
    // Drop items that fail both vector and lexical thresholds. Runs AFTER
    // rerank so we first let the LLM judge pick the "best of what we have",
    // then veto the whole batch if even the best is below the relevance
    // floor. This prevents low-cosine noise (0.30-0.38 on meta queries
    // like "можем улучшить") from leaking into Claude's context.
    //
    // Two-stage gate:
    //   1. Per-type cosine floors - episodes (commit summaries) need
    //      cos≥0.55, looser types like fact/relation cleared at 0.45.
    //      This targets episode-noise specifically without hurting recall
    //      of short factual items.
    //   2. Top-1 floor - if even the best survivor is below MIN_TOP1_COSINE,
    //      suppress the whole batch. "best of garbage is still garbage" -
    //      a recall with no clear winner just adds noise.
    let semanticHadCandidates = false
    let semanticAllGated = false
    if (recallRes?.items?.length) {
      semanticHadCandidates = true
      const before = recallRes.items.length
      recallRes.items = recallRes.items.filter((r) => {
        const cos = r.breakdown?.cosine
        const lex = r.breakdown?.lexical_raw ?? 0
        if (cos !== undefined) {
          // Per-type floor (defaults to global MIN_COSINE for unknown types).
          const typeFloor = TYPE_COSINE_FLOORS[r.item?.type] ?? MIN_COSINE
          return cos >= typeFloor
        }
        return lex >= MIN_LEXICAL
      })
      const after = recallRes.items.length
      if (after < before) log(`signal-gate: ${before} → ${after} (per-type floors, lex≥${MIN_LEXICAL})`)

      // Top-1 floor: even if some items passed the per-type filter, demand
      // that the best one clears MIN_TOP1_COSINE. Otherwise we're showing a
      // mediocre top-of-mediocre batch, which dilutes Claude's context.
      if (after > 0) {
        const top1Cos = recallRes.items[0].breakdown?.cosine ?? 0
        if (top1Cos < MIN_TOP1_COSINE) {
          log(`top1-gate: best cos=${top1Cos.toFixed(3)} < ${MIN_TOP1_COSINE}, suppress all`)
          recallRes.items = []
        }
      }
      if (recallRes.items.length === 0) semanticAllGated = true
    }

    // Await feedback ops (they race with recall above).
    const [ackedN, decayedN] = await Promise.all([ackPromise, decayPromise])
    if (ackedN > 0) log(`acked ${ackedN} prior recall(s) (+importance)`)
    if (decayedN > 0) log(`decayed ${decayedN} stale recall(s) (-importance)`)

    // Log what we recalled this turn so the NEXT turn can ack/decay it.
    if (sessionId && recallRes?.items?.length) {
      const itemIds = recallRes.items.map((r) => r.item.id)
      await logRecall(sessionId, itemIds, userMessage).catch(() => 0)
    }

    // ── Graph: still lives in PostgreSQL ──
    // Use the enriched query so that "делать все постепенно" pulls keywords
    // from the previous turn's topic instead of just "постепенно".
    //
    // Suppression rule: if the signal gate vetoed ALL semantic candidates,
    // the topic is almost certainly not in memory. Substring/keyword graph
    // matches in that regime are noise (the canonical example: a scene3d
    // question surfacing an unrelated "403 Country not supported" decision
    // because some enriched keyword happened to appear in the entity name).
    // Graph already uses word-boundary matching in searchByKeywords, but
    // even a legit word-boundary hit on an off-topic entity is not useful
    // context when semantic recall has nothing. Let graph through only when
    // semantic recall produced at least one item that cleared the gate, or
    // when there were no semantic candidates at all (so we can't infer
    // "semantic says no" vs "semantic wasn't tried").
    const suppressGraph = semanticHadCandidates && semanticAllGated
    if (suppressGraph) log(`graph: suppressed (semantic gated all ${RERANK_ENABLED ? 'reranked ' : ''}candidates)`)

    const keywords = extractKeywords(queryText)
    const graphRows = suppressGraph ? [] : await searchGraph(keywords).catch(() => [])
    const graphContext = formatGraphContext(graphRows)

    let traversalContext = ''
    if (!suppressGraph && keywords.length > 0) {
      try {
        const rows = await traverseFrom(keywords[0], 2)
        if (rows.length > 1) {
          const lines = rows
            .filter((r) => r.depth > 0)
            .slice(0, 10)
            .map((r) => `  [depth ${r.depth}] ${r.name} (${r.type}${r.project ? `, ${r.project}` : ''})`)
          if (lines.length > 0) {
            traversalContext = `GRAPH TRAVERSAL (from "${keywords[0]}"):\n${lines.join('\n')}`
          }
        }
      } catch { /* non-critical */ }
    }

    // ── Assemble output ──
    const parts = []
    const memContext = recallRes ? formatItemContext(recallRes.items) : ''
    if (memContext) {
      parts.push(`SEMANTIC MEMORY (exocortex):\n${memContext}`)
    }
    if (graphContext) parts.push(`KNOWLEDGE GRAPH (PostgreSQL):\n${graphContext}`)
    if (traversalContext) parts.push(traversalContext)

    if (parts.length === 0) {
      await closeMemory()
      await closePool()
      process.exit(0)
    }

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `EXOCORTEX MEMORY RECALL:\n\n${parts.join('\n\n')}`,
      },
    })
    process.stdout.write(output)
    log(`output ${output.length}b, items=${recallRes?.items?.length ?? 0}, graph=${graphRows.length}`)

    await closeMemory()
    await closePool()
  } catch (err) {
    log(`ERROR: ${err?.message ?? err}`)
    await closeMemory().catch(() => {})
    await closePool().catch(() => {})
    process.exit(0)
  }
}

main().catch((err) => {
  log(`UNCAUGHT: ${err?.message ?? err}`)
  process.exit(0)
})
