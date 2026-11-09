/**
 * frequency signal.
 *
 * log1p(accessCount) normalized by the batch max. Captures "things you ask
 * about a lot" independent of how recently they were accessed. Complements
 * recency: a thing can be frequent but stale, or recent but one-off.
 */

import type { Signal, SignalContext } from '../core/contracts.js';

export class FrequencySignal implements Signal {
  readonly name = 'frequency';
  readonly version = '1.0.0';

  async score(ctx: SignalContext): Promise<Float32Array> {
    const raw = new Float32Array(ctx.candidates.length);
    let max = 0;
    for (let i = 0; i < ctx.candidates.length; i++) {
      const v = Math.log1p(ctx.candidates[i]!.accessCount);
      raw[i] = v;
      if (v > max) max = v;
    }
    if (max === 0) return raw;
    for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! / max;
    return raw;
  }
}
