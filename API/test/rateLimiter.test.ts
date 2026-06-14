import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../src/core/rateLimiter';
import { RATE_LIMITS } from '../src/endpoints';

describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('initialises every class to its max', () => {
    const rl = new RateLimiter();
    expect(rl.getBudget('global').remaining).toBe(RATE_LIMITS.global.max);
    expect(rl.getBudget('market').remaining).toBe(RATE_LIMITS.market.max);
  });

  it('decrements both the endpoint class and global on acquire', async () => {
    const rl = new RateLimiter();
    await rl.acquire('market');
    expect(rl.getBudget('market').remaining).toBe(RATE_LIMITS.market.max - 1);
    expect(rl.getBudget('global').remaining).toBe(RATE_LIMITS.global.max - 1);
  });

  it('penalize zeroes the budget and blocks until reset', async () => {
    const rl = new RateLimiter();
    rl.penalize('market', 5);
    expect(rl.getBudget('market').remaining).toBe(0);

    let resolved = false;
    const p = rl.acquire('market').then(() => {
      resolved = true;
    });

    // Should be blocked while the penalty window is open.
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    // After the 5s penalty elapses the window refills and acquire proceeds.
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(resolved).toBe(true);
  });

  it('syncFromHeaders clamps remaining down to the server value', () => {
    const rl = new RateLimiter();
    const headers = new Headers({
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '3',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    });
    rl.syncFromHeaders('market', headers);
    expect(rl.getBudget('market').remaining).toBe(3);
  });

  it('exposes every budget for introspection', () => {
    const rl = new RateLimiter();
    const all = rl.getAllBudgets();
    expect(all.length).toBe(Object.keys(RATE_LIMITS).length);
    expect(all.every((b) => b.max > 0)).toBe(true);
  });
});
