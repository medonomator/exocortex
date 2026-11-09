/**
 * recency signal.
 *
 * exp(-gap / stability) - the same "freshness" used by decay. Items that were
 * recently accessed score 1, ones long untouched approach 0. We use each
 * item's own stability so high-stability core items decay more gently.
 */

import type { Signal, SignalContext } from '../core/contracts.js';
import { freshness } from '../core/decay.js';

export class RecencySignal implements Signal {
  readonly name = 'recency';
  readonly version = '1.0.0';

  async score(ctx: SignalContext): Promise<Float32Array> {
    const out = new Float32Array(ctx.candidates.length);
    for (let i = 0; i < ctx.candidates.length; i++) {
      out[i] = freshness(ctx.candidates[i]!, ctx.now);
    }
    return out;
  }
}
