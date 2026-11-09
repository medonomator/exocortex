/**
 * Beta-distribution confidence math.
 *
 * A scalar "confidence" can't tell "0.8 after one observation" apart from
 * "0.8 after a hundred observations". Beta(α, β) can: evidence accumulates
 * in the two parameters and variance shrinks with sample size.
 *
 * Convention:
 *   α = 1 + (weighted) confirmations
 *   β = 1 + (weighted) contradictions
 *
 *   mean = α / (α + β)
 *   mode = (α - 1) / (α + β - 2)   for α, β > 1
 *   variance = αβ / ((α+β)² (α+β+1))
 *
 * Both α and β are floored at 1 so we start from a uniform prior and never
 * drop below it.
 */

import type { Confidence } from './types.js';

const MIN = 1;

/**
 * Helpers for the Beta-distribution Confidence type.
 * Named `Conf` (not `Confidence`) so the type name stays canonical.
 */
export const Conf = {
  /** Uniform prior: Beta(1, 1) - indifferent. */
  uninformative(): Confidence {
    return { alpha: 1, beta: 1 };
  },

  /** A prior that expects confirmation (e.g. procedures come in "usually-correct"). */
  optimistic(strength = 2): Confidence {
    return { alpha: 1 + strength, beta: 1 };
  },

  /** Point estimate (posterior mean). */
  mean(c: Confidence): number {
    return c.alpha / (c.alpha + c.beta);
  },

  /** Posterior variance - lower means more certain, regardless of point estimate. */
  variance(c: Confidence): number {
    const s = c.alpha + c.beta;
    return (c.alpha * c.beta) / (s * s * (s + 1));
  },

  /** Standard deviation of the posterior. */
  stddev(c: Confidence): number {
    return Math.sqrt(Conf.variance(c));
  },

  /** Add evidence in favor. Returns a NEW Confidence (immutable). */
  reinforce(c: Confidence, weight = 1): Confidence {
    return { alpha: Math.max(MIN, c.alpha + weight), beta: c.beta };
  },

  /** Add evidence against. Returns a NEW Confidence (immutable). */
  contradict(c: Confidence, weight = 1): Confidence {
    return { alpha: c.alpha, beta: Math.max(MIN, c.beta + weight) };
  },

  /**
   * Merge two independent confidence posteriors.
   * Subtract (MIN - 1) once from each side to avoid double-counting the prior.
   */
  merge(a: Confidence, b: Confidence): Confidence {
    return {
      alpha: a.alpha + b.alpha - 1,
      beta: a.beta + b.beta - 1,
    };
  },

  /**
   * Effective sample size. α + β = 2 is "one fresh observation";
   * α + β = 20 is "lots of evidence".
   */
  strength(c: Confidence): number {
    return c.alpha + c.beta - 2;
  },

  /** Clamp to avoid floating-point creep below 1 after many operations. */
  normalize(c: Confidence): Confidence {
    return {
      alpha: Math.max(MIN, c.alpha),
      beta: Math.max(MIN, c.beta),
    };
  },
};
