import { describe, expect, it } from 'vitest';
import { Conf } from '../core/confidence.js';

describe('Conf', () => {
  it('starts from a uniform prior', () => {
    const c = Conf.uninformative();
    expect(c).toEqual({ alpha: 1, beta: 1 });
    expect(Conf.mean(c)).toBe(0.5);
    expect(Conf.strength(c)).toBe(0);
  });

  it('separates equal means by sample size through variance', () => {
    const weak = { alpha: 4, beta: 2 };
    const strong = { alpha: 40, beta: 20 };
    expect(Conf.mean(weak)).toBeCloseTo(Conf.mean(strong));
    expect(Conf.variance(strong)).toBeLessThan(Conf.variance(weak));
    expect(Conf.stddev(strong)).toBeCloseTo(Math.sqrt(Conf.variance(strong)));
  });

  it('reinforce and contradict are immutable and move the mean', () => {
    const c = Conf.uninformative();
    const up = Conf.reinforce(c, 3);
    const down = Conf.contradict(c, 3);
    expect(c).toEqual({ alpha: 1, beta: 1 });
    expect(Conf.mean(up)).toBeGreaterThan(0.5);
    expect(Conf.mean(down)).toBeLessThan(0.5);
  });

  it('never drops below the prior on negative weight', () => {
    const c = Conf.reinforce(Conf.uninformative(), -5);
    expect(c.alpha).toBe(1);
    expect(Conf.contradict(c, -5).beta).toBe(1);
  });

  it('merges two posteriors without double-counting the prior', () => {
    const merged = Conf.merge({ alpha: 3, beta: 2 }, { alpha: 5, beta: 1 });
    expect(merged).toEqual({ alpha: 7, beta: 2 });
    expect(Conf.strength(merged)).toBe(Conf.strength({ alpha: 3, beta: 2 }) + Conf.strength({ alpha: 5, beta: 1 }));
  });

  it('optimistic prior leans positive', () => {
    expect(Conf.mean(Conf.optimistic())).toBeCloseTo(0.75);
  });

  it('normalize clamps float creep', () => {
    expect(Conf.normalize({ alpha: 0.9999, beta: 0.5 })).toEqual({ alpha: 1, beta: 1 });
  });
});
