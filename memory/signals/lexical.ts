/**
 * lexical signal.
 *
 * BM25-ish score from Postgres tsvector ts_rank_cd. Complementary to vector:
 * catches rare proper nouns and exact-phrase recall that dense embeddings blur.
 */

import type { Signal, SignalContext } from '../core/contracts.js';

export class LexicalSignal implements Signal {
  readonly name = 'lexical';
  readonly version = '1.0.0';

  constructor(private readonly scores: Map<string, number>) {}

  async score(ctx: SignalContext): Promise<Float32Array> {
    const out = new Float32Array(ctx.candidates.length);
    for (let i = 0; i < ctx.candidates.length; i++) {
      out[i] = this.scores.get(ctx.candidates[i]!.id) ?? 0;
    }
    return out;
  }
}
