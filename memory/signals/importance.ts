/**
 * importance signal.
 *
 * Straight passthrough of item.importance (0..1). Importance is set by
 * ingest / pipeline / user feedback. Keeping this as its own signal means
 * ranker weights can tune "how much do we trust the stored importance".
 */

import type { Signal, SignalContext } from '../core/contracts.js';

export class ImportanceSignal implements Signal {
  readonly name = 'importance';
  readonly version = '1.0.0';

  async score(ctx: SignalContext): Promise<Float32Array> {
    const out = new Float32Array(ctx.candidates.length);
    for (let i = 0; i < ctx.candidates.length; i++) {
      out[i] = ctx.candidates[i]!.importance;
    }
    return out;
  }
}
