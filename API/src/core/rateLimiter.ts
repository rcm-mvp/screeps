/**
 * Central, per-endpoint rate-limit manager.
 *
 * The official Screeps server enforces a global cap (120 req/min) plus a
 * separate budget per endpoint class (see {@link RATE_LIMITS}). This manager:
 *
 *  - tracks the remaining budget of every class with fixed reset windows;
 *  - serialises `acquire()` so concurrent callers can't oversubscribe;
 *  - delays (rather than fails) when a budget is exhausted, honouring the
 *    window reset;
 *  - syncs its view from `X-RateLimit-*` response headers; and
 *  - applies an explicit penalty on `429` using the parsed retry-after.
 *
 * It never *blindly* retries: a 429 sets the budget to zero until its reset, so
 * the next `acquire()` waits out the server's own timer.
 */

import { RATE_LIMITS, GLOBAL_CLASS, RateLimitClass } from '../endpoints';
import type { RateLimitBudget } from '../types/common';
import type { Logger } from './logger';

interface BudgetState {
  label: string;
  max: number;
  windowMs: number;
  remaining: number;
  /** Epoch-ms when `remaining` refills to `max`. */
  resetAt: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export class RateLimiter {
  private states = new Map<string, BudgetState>();
  /** Serialises acquisition so budgets are decremented atomically. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private logger?: Logger) {
    const now = Date.now();
    for (const [name, def] of Object.entries(RATE_LIMITS)) {
      this.states.set(name, {
        label: def.label,
        max: def.max,
        windowMs: def.windowMs,
        remaining: def.max,
        resetAt: now + def.windowMs,
      });
    }
  }

  /** Refill a class if its window has elapsed. */
  private refresh(state: BudgetState, now: number): void {
    if (now >= state.resetAt) {
      state.remaining = state.max;
      state.resetAt = now + state.windowMs;
    }
  }

  /**
   * Wait until both the endpoint class and the global class have capacity, then
   * consume one unit from each. Resolves when the request may proceed.
   */
  async acquire(endpointClass: RateLimitClass): Promise<void> {
    // Queue behind any in-flight acquisition to keep decrements atomic.
    const run = this.chain.then(() => this.acquireNow(endpointClass));
    // Swallow errors on the chain so one failure doesn't wedge the queue.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async acquireNow(endpointClass: RateLimitClass): Promise<void> {
    const classes = endpointClass === GLOBAL_CLASS ? [GLOBAL_CLASS] : [endpointClass, GLOBAL_CLASS];

    // Loop until every relevant class has a free slot.
    // (A long wait on one class may let another's window lapse; re-check.)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      let waitMs = 0;
      for (const c of classes) {
        const state = this.states.get(c)!;
        this.refresh(state, now);
        if (state.remaining <= 0) {
          waitMs = Math.max(waitMs, state.resetAt - now);
        }
      }
      if (waitMs <= 0) break;
      this.logger?.debug('rate-limit: waiting for budget', {
        endpointClass,
        waitMs,
      });
      await sleep(waitMs + 1);
    }

    for (const c of classes) {
      const state = this.states.get(c)!;
      state.remaining -= 1;
    }
  }

  /**
   * Reconcile a class's budget with the server's authoritative headers.
   * Header names follow the `X-RateLimit-Limit` / `-Remaining` / `-Reset`
   * convention (`Reset` is a unix-seconds timestamp).
   */
  syncFromHeaders(endpointClass: RateLimitClass, headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const limit = headers.get('x-ratelimit-limit');
    const state = this.states.get(endpointClass);
    if (!state) return;
    if (limit != null) state.max = Number(limit) || state.max;
    if (remaining != null) {
      const r = Number(remaining);
      if (!Number.isNaN(r)) state.remaining = Math.min(state.remaining, r);
    }
    if (reset != null) {
      const resetSec = Number(reset);
      if (!Number.isNaN(resetSec)) {
        // Heuristic: values that look like epoch seconds vs. a delta.
        state.resetAt = resetSec > 1e6 ? resetSec * 1000 : Date.now() + resetSec * 1000;
      }
    }
  }

  /**
   * Apply a hard penalty after a 429: zero the offending class's budget and set
   * its reset to exactly `retryAfterSec` from now, so the next `acquire()` waits
   * out the server's own timer (and no longer). Only the offending class is
   * penalised — a per-endpoint 429 must not freeze the global bucket.
   */
  penalize(endpointClass: RateLimitClass, retryAfterSec: number): void {
    const state = this.states.get(endpointClass);
    if (!state) return;
    state.remaining = 0;
    state.resetAt = Date.now() + retryAfterSec * 1000;
    this.logger?.warn('rate-limit: penalised after 429', { endpointClass, retryAfterSec });
  }

  /** Snapshot of one class's current budget (for UI / introspection). */
  getBudget(endpointClass: RateLimitClass): RateLimitBudget {
    const state = this.states.get(endpointClass)!;
    this.refresh(state, Date.now());
    return {
      label: state.label,
      max: state.max,
      remaining: state.remaining,
      windowMs: state.windowMs,
      resetAt: state.resetAt,
    };
  }

  /** Snapshot of every tracked budget. */
  getAllBudgets(): RateLimitBudget[] {
    return [...this.states.keys()].map((k) => this.getBudget(k as RateLimitClass));
  }
}
