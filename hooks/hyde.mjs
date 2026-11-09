/**
 * HyDE - Hypothetical Document Embedding.
 *
 * Gao et al. 2022: instead of embedding a short question (which has weak
 * semantic signal against long stored documents), ask an LLM to write a
 * hypothetical ideal answer, then embed that. Cosine against real stored
 * answers jumps 0.10-0.20 because we're comparing answer-to-answer, not
 * question-to-answer.
 *
 * This implementation is a HYBRID: we concatenate the original query and
 * the hypothetical answer before returning. Rationale:
 *   • Pure HyDE breaks lexical (tsvector) search - tsquery wants the
 *     user's actual words, not invented ones. The hybrid keeps them.
 *   • Vector embed sees both intent (query) and elaboration (hypothetical)
 *     - the embedder weighs both into the final 1536-d vector.
 *   • If the LLM hallucinates off-topic detail, the original query anchors
 *     the embedding so we don't drift too far.
 *
 * Cost: ~400 input + 120 output tokens per call @ gpt-4o-mini ≈ $0.0001.
 * Latency: 400-800ms typical, capped by curlJson --max-time 6.
 * Fallback: any failure returns the original query untouched.
 */

import { curlJson } from './utils.mjs'

const HYDE_MODEL = process.env.EXOCORTEX_HYDE_MODEL ?? 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * @param {string} query - the (already enriched) user query.
 * @param {string} [apiKey] - overrides process.env.OPENAI_API_KEY.
 * @returns {{ text: string, hypothetical: string | null }} - text is the
 *   augmented query ready to pass to the embedder; hypothetical is the raw
 *   generated answer (null on failure, for logging).
 */
export function generateHyDE(query, apiKey) {
  const key = apiKey ?? process.env.OPENAI_API_KEY
  if (!key || !query || query.length < 10) {
    return { text: query, hypothetical: null }
  }

  // Keep the prompt small - we only need a realistic-sounding answer,
  // not a correct one. Two-sentence cap so we don't inflate the final
  // embedding input beyond ~600 tokens total.
  const prompt = `You are helping build a retrieval query. Write 2-3 sentences of a realistic hypothetical answer to the question below, in the same language as the question. The answer should sound like a stored memory, technical note, or decision log entry - specific, grounded, with likely technical terms. Do not hedge, do not say "it depends", do not ask for clarification. If you do not know the real answer, invent a plausible one.

Question:
${query}

Hypothetical answer:`

  const body = {
    model: HYDE_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 150,
    temperature: 0.3,
  }

  const resp = curlJson(OPENAI_URL, body, key)
  const hypo = resp?.choices?.[0]?.message?.content?.trim()
  if (!hypo || hypo.length < 10) return { text: query, hypothetical: null }

  // Hybrid: concatenate so lexical search still matches original words.
  return {
    text: `${query}\n\n${hypo}`,
    hypothetical: hypo,
  }
}
