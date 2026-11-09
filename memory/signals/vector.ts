/**
 * vector signal.
 *
 * Dense embedding similarity. The candidates passed to score() are assumed
 * to have already been retrieved from Qdrant with their scores; we carry the
 * per-candidate score through a side-channel Map keyed by item id.
 *
 * We don't re-embed or re-search here - that's the job of the recall pipeline,
 * which seeds candidates from vector search + lexical search + recency tails.
 */

import type { Signal, SignalContext } from '../core/contracts.js';

export class VectorSignal implements Signal {
  readonly name = 'vector';
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
