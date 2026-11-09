/**
 * emotion signal.
 *
 * Emotion-tagged items (set by a future emotion-extraction stage in
 * consolidate) get a bias proportional to arousal * |valence|. This is the
 * "flashbulb memory" effect - emotionally charged events surface more easily.
 *
 * Items without emotion get 0, which is neutral in RRF but can be noisy in
 * weighted-sum; the ranker should handle both cases.
 */

import type { Signal, SignalContext } from '../core/contracts.js';

export class EmotionSignal implements Signal {
  readonly name = 'emotion';
  readonly version = '1.0.0';

  async score(ctx: SignalContext): Promise<Float32Array> {
    const out = new Float32Array(ctx.candidates.length);
    for (let i = 0; i < ctx.candidates.length; i++) {
      const e = ctx.candidates[i]!.emotion;
      if (!e) {
        out[i] = 0;
        continue;
      }
      out[i] = Math.max(0, Math.min(1, e.arousal * Math.abs(e.valence)));
    }
    return out;
  }
}
