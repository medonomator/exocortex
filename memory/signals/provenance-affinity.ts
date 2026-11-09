/**
 * provenance-affinity signal.
 *
 * Boost candidates whose provenance source/agent matches the current session
 * context. Lets the caller steer: "I'm in the observer pipeline, prefer items
 * that came from observer" or "this is a swarm recall, prefer swarm-derived
 * items." Without context, returns 0 for all (no-op contribution).
 */

import type { Signal, SignalContext } from '../core/contracts.js';
import type { ProvenanceSource } from '../core/types.js';

export interface ProvenanceAffinityPrefs {
  preferSource?: ProvenanceSource;
  preferAgent?: string;
  preferSession?: string;
  /** Boost applied when the match hits. 0..1. */
  strength?: number;
}

export class ProvenanceAffinitySignal implements Signal {
  readonly name = 'provenance-affinity';
  readonly version = '1.0.0';

  constructor(private readonly prefs: ProvenanceAffinityPrefs = {}) {}

  async score(ctx: SignalContext): Promise<Float32Array> {
    const out = new Float32Array(ctx.candidates.length);
    const strength = this.prefs.strength ?? 1;
    if (
      !this.prefs.preferSource &&
      !this.prefs.preferAgent &&
      !this.prefs.preferSession
    ) {
      return out;
    }
    for (let i = 0; i < ctx.candidates.length; i++) {
      const p = ctx.candidates[i]!.provenance;
      let hits = 0;
      let total = 0;
      if (this.prefs.preferSource) {
        total += 1;
        if (p.source === this.prefs.preferSource) hits += 1;
      }
      if (this.prefs.preferAgent) {
        total += 1;
        if (p.agentId === this.prefs.preferAgent) hits += 1;
      }
      if (this.prefs.preferSession) {
        total += 1;
        if (p.sessionId === this.prefs.preferSession) hits += 1;
      }
      out[i] = total > 0 ? (hits / total) * strength : 0;
    }
    return out;
  }
}
