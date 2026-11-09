import { describe, expect, it } from 'vitest';
import { daysSince, effectiveConfidence, freshness, reactivate } from '../core/decay.js';

const DAY = 86_400_000;
const t0 = new Date('2026-03-01T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);

describe('decay', () => {
  it('daysSince is never negative', () => {
    expect(daysSince(t0, at(2.5))).toBeCloseTo(2.5);
    expect(daysSince(at(3), t0)).toBe(0);
  });

  it('effective evidence decays toward the prior with stability as the time constant', () => {
    const item = { conf: { alpha: 11, beta: 3 }, stability: 10, lastAccessedAt: t0 };
    expect(effectiveConfidence(item, t0)).toEqual({ alpha: 11, beta: 3 });

    const later = effectiveConfidence(item, at(10));
    expect(later.alpha).toBeCloseTo(1 + 10 * Math.exp(-1));
    expect(later.beta).toBeCloseTo(1 + 2 * Math.exp(-1));

    const far = effectiveConfidence(item, at(10_000));
    expect(far.alpha).toBeCloseTo(1);
    expect(far.beta).toBeCloseTo(1);
  });

  it('higher stability forgets slower', () => {
    const fragile = { stability: 2, lastAccessedAt: t0 };
    const durable = { stability: 60, lastAccessedAt: t0 };
    expect(freshness(durable, at(14))).toBeGreaterThan(freshness(fragile, at(14)));
    expect(freshness(fragile, t0)).toBe(1);
  });

  it('survives zero stability without dividing by zero', () => {
    expect(Number.isFinite(freshness({ stability: 0, lastAccessedAt: t0 }, at(1)))).toBe(true);
  });

  it('reactivation grows stability more after a longer gap (spacing effect)', () => {
    const item = { stability: 7, lastAccessedAt: t0, accessCount: 2 };
    const soon = reactivate(item, at(1));
    const late = reactivate(item, at(30));
    expect(soon.accessCount).toBe(3);
    expect(soon.lastAccessedAt).toEqual(at(1));
    expect(soon.stability).toBeCloseTo(7 * (1 + Math.log(2)));
    expect(late.stability).toBeGreaterThan(soon.stability);
    expect(reactivate(item, t0).stability).toBe(7);
  });
});
