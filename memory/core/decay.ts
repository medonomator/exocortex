/**
 * Ebbinghaus-style lazy decay.
 *
 * Rather than running a cron to multiply every confidence by 0.95 each day
 * (which breaks on backfill and forgets things that haven't been touched),
 * we store stability + lastAccessedAt and compute effective evidence on read:
 *
 *   effective_α(t) = 1 + (α - 1) · exp(-Δt / stability)
 *   effective_β(t) = 1 + (β - 1) · exp(-Δt / stability)
 *
 * where Δt is days since lastAccessedAt. The "+1" keeps us at the
 * uninformative prior in the limit.
 *
 * On recall (reactivation) stability grows - that's the spacing effect
 * (memories recalled after a gap come back stronger than they were).
 */

import type { Confidence, MemoryItem } from './types.js';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function daysSince(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Compute Confidence effective at `now`, lazily decayed from lastAccessedAt.
 * Does not mutate the item.
 */
export function effectiveConfidence(
  item: Pick<MemoryItem, 'conf' | 'stability' | 'lastAccessedAt'>,
  now: Date = new Date(),
): Confidence {
  const gap = daysSince(item.lastAccessedAt, now);
  const factor = Math.exp(-gap / Math.max(0.01, item.stability));
  return {
    alpha: 1 + (item.conf.alpha - 1) * factor,
    beta: 1 + (item.conf.beta - 1) * factor,
  };
}

/**
 * Reactivation: mutate an item in response to being surfaced in recall.
 *
 * stability *= 1 + log(1 + gapDays)   (spacing effect)
 * lastAccessedAt = now
 * accessCount += 1
 *
 * Returns a new Partial<MemoryItem> patch; the store applies it.
 */
export function reactivate(
  item: Pick<MemoryItem, 'stability' | 'lastAccessedAt' | 'accessCount'>,
  now: Date = new Date(),
): { stability: number; lastAccessedAt: Date; accessCount: number } {
  const gap = daysSince(item.lastAccessedAt, now);
  return {
    stability: item.stability * (1 + Math.log(1 + gap)),
    lastAccessedAt: now,
    accessCount: item.accessCount + 1,
  };
}

/**
 * A retrieval-time score modifier representing "how fresh" an item is.
 * Used by the recency signal; not a policy mutation.
 *
 * Returns a value in [0, 1]: 1 = just now, approaches 0 as gap → ∞.
 */
export function freshness(
  item: Pick<MemoryItem, 'lastAccessedAt' | 'stability'>,
  now: Date = new Date(),
): number {
  const gap = daysSince(item.lastAccessedAt, now);
  return Math.exp(-gap / Math.max(0.01, item.stability));
}
