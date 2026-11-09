/**
 * LLM-as-reranker via OpenAI gpt-4o-mini.
 *
 * Cross-encoder quality at zero extra infra: we already use OpenAI for
 * embeddings, so a listwise rerank call over the signal-fused top-K
 * candidates gives us SOTA reordering without pulling in Cohere, Ollama,
 * onnx or any local model.
 *
 * Flow:
 *   1. Take top-K candidates (typically K=20) from RecallService.
 *   2. Render a numbered list with short text previews.
 *   3. Ask gpt-4o-mini to return the topN indices as a JSON array, best
 *      first. JSON mode + temperature 0 for determinism.
 *   4. Reorder: [picked top-N, in chosen order] + [unpicked, original order].
 *
 * Cost: ~2500 input + 50 output tokens per call @ gpt-4o-mini.
 *         ≈ $0.0001 per recall. ~$0.50/month at 150 prompts/day.
 * Latency: ~500-900ms typical. Hard-capped by curlJson's --max-time 6.
 *
 * Fallback: any failure (network, parse, missing key) returns the input
 * order untouched, so rerank is never load-bearing.
 */

import { curlJson } from './utils.mjs'

const RERANK_MODEL = process.env.EXOCORTEX_RERANK_MODEL ?? 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const PREVIEW_CHARS = 320

/**
 * @param {string} query - user question, used as the rerank target.
 * @param {Array<{item: any}>} ranked - recall results; item.raw?.text is
 *   used as the preview source.
 * @param {number} topN - how many to keep (default 5).
 * @param {string} [apiKey] - overrides process.env.OPENAI_API_KEY.
 * @returns {Array} reordered candidates; same element shape as input.
 */
export function rerankWithLLM(query, ranked, topN = 5, apiKey) {
  const key = apiKey ?? process.env.OPENAI_API_KEY
  if (!key) return ranked
  if (!Array.isArray(ranked) || ranked.length <= topN) return ranked

  // Render numbered candidates. Keep previews short - they dominate cost,
  // and the reranker only needs enough text to judge relevance.
  const numbered = ranked.map((r, i) => {
    const text = (r.item?.raw?.text ?? '').slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim()
    const type = r.item?.type ?? '?'
    return `[${i + 1}] (${type}) ${text}`
  }).join('\n\n')

  const prompt = `You are a retrieval reranker.

User question:
${query}

Candidate memories:
${numbered}

Pick the ${topN} candidates MOST relevant to answering the question. Return a JSON object with a single key "ranked" whose value is an array of candidate numbers in order of relevance, best first. No extra keys, no prose.

Example format: {"ranked": [3, 1, 5, 2, 4]}`

  const body = {
    model: RERANK_MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    max_tokens: 64,
    temperature: 0,
  }

  const resp = curlJson(OPENAI_URL, body, key)
  const content = resp?.choices?.[0]?.message?.content
  if (!content) return ranked

  let picked
  try {
    const parsed = JSON.parse(content)
    picked = parsed?.ranked
  } catch {
    return ranked
  }
  if (!Array.isArray(picked) || picked.length === 0) return ranked

  // Validate indices: must be 1-based within [1, ranked.length] and unique.
  const seen = new Set()
  const validIdx = []
  for (const n of picked) {
    const i = Number(n)
    if (!Number.isInteger(i) || i < 1 || i > ranked.length || seen.has(i)) continue
    seen.add(i)
    validIdx.push(i - 1)
    if (validIdx.length >= topN) break
  }
  if (validIdx.length === 0) return ranked

  const head = validIdx.map((i) => ranked[i])
  // Append the un-picked tail in original order so downstream code still has
  // access to the full candidate pool if it wants it (hook truncates to topN
  // anyway).
  const tail = ranked.filter((_, i) => !seen.has(i + 1))
  return [...head, ...tail]
}
