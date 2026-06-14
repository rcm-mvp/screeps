/**
 * Scenario B — live read path (no accidental poller) + the WS object-path
 * limitation this harness exists to surface.
 *
 * Two things are asserted directly against the bridge's WS `watchState`:
 *
 *  1. While watching, the `GET user/memory` budget MUST NOT move. This is the
 *     single most important guard: if it decrements, something is polling HTTP
 *     instead of riding the socket, and on the public server that silently
 *     drains 1440 reads/day. (PASSES — watchState is genuinely WS-based.)
 *
 *  2. watchState SHOULD deliver usable ColonyState matching a one-off
 *     getState(). It does NOT, against a real server: the screeps memory
 *     pubsub coerces object paths with `result = "" + value`, so the
 *     subscription to the object path `bridge.state` streams the literal
 *     string "[object Object]". Primitive leaf paths (e.g.
 *     `bridge.state.heartbeat`) stream fine. This is the exact mock-vs-reality
 *     gap the integration harness is built to catch — invisible to every
 *     per-component test that mocked the channel with the full object.
 *
 * Assertion 2 is encoded with `it.fails`: it PASSES while the limitation
 * exists (documenting it) and turns RED the moment someone makes watchState
 * stream usable state (e.g. by mirroring it through a primitive/JSON-string
 * path) — a prompt to delete the HTTP workaround in src/poll.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Channels } from 'screeps-web-api-bridge';
import type { ColonyState, RateLimitBudget } from 'screeps-web-api-bridge';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitFor } from '../src/poll';
import { half } from '../src/report';

const GET_MEMORY = 'GET user/memory';

function getMemoryBudget(budgets: RateLimitBudget[]): RateLimitBudget {
  const b = budgets.find((x) => x.label === GET_MEMORY);
  if (!b) throw new Error(`rate-limit budget "${GET_MEMORY}" not tracked by the bridge`);
  return b;
}

describe('B. live read path over WS', () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await startScenario();
    // Ensure the executor is actually writing state before we watch.
    const w = new StateWatcher(s.bridge);
    try {
      await w.next((st) => st.heartbeat > 0, {
        timeoutMs: ticksMs(60),
        what: half('bot-write', 'executor heartbeat before exercising the WS read path'),
      });
    } finally {
      w.stop();
    }
  });

  afterAll(async () => {
    await stopScenario(s);
  });

  it('watchState does NOT spend GET-memory budget (no accidental poller)', async () => {
    const before = getMemoryBudget(s.bridge.getRateLimitBudgets()).remaining;

    const frames: unknown[] = [];
    const unsubscribe = s.bridge.control.watchState((st) => frames.push(st));
    try {
      // Watch across several ticks.
      await waitFor(async () => frames.length >= 5, {
        timeoutMs: ticksMs(60),
        intervalMs: 250,
        what: `at least 5 live WS frames on the memory channel (got ${frames.length})`,
      });
    } finally {
      unsubscribe();
    }

    const after = getMemoryBudget(s.bridge.getRateLimitBudgets()).remaining;
    expect(
      after,
      half(
        'bridge-read',
        `the GET user/memory budget decremented from ${before} to ${after} while watchState was ` +
          'active — the live read path is POLLING HTTP instead of using the WS memory channel',
      ),
    ).toBe(before);
  });

  it('primitive memory leaf paths DO stream over WS (heartbeat pulse)', async () => {
    // The working half of the channel: a primitive leaf streams its value
    // verbatim. (This is what a corrected live-read path would ride.)
    await s.bridge.connectSocket();
    const channel = Channels.memory(await s.bridge.getUserId(), 'bridge.state.heartbeat');
    const values: string[] = [];
    const unsubscribe = s.bridge.subscribeChannel(channel, (m) => values.push(String(m.data)));
    try {
      await waitFor(async () => values.length >= 3, {
        timeoutMs: ticksMs(40),
        intervalMs: 250,
        what: `3 heartbeat pulses on the primitive path bridge.state.heartbeat (got ${values.length})`,
      });
    } finally {
      unsubscribe();
    }
    // Every pulse is a numeric tick string — proof the primitive channel works.
    for (const v of values) {
      expect(v, `heartbeat pulse "${v}" should be a numeric string`).toMatch(/^\d+$/);
    }
  });

  it(
    'watchState delivers usable ColonyState matching getState() (via the bridge.stateJson ' +
      'string mirror — the object path bridge.state would String()-coerce to "[object Object]")',
    async () => {
      const viaHttp = await s.bridge.control.getState();
      expect(viaHttp, 'getState() must return the full ColonyState over HTTP').not.toBeNull();

      const frames: ColonyState[] = [];
      const unsubscribe = s.bridge.control.watchState((st) => frames.push(st));
      try {
        await waitFor(async () => frames.length >= 2, {
          timeoutMs: ticksMs(40),
          intervalMs: 250,
          what: 'WS state frames',
        });
      } finally {
        unsubscribe();
      }

      // DESIRED behaviour (currently false against a real server): the WS frame
      // is a real ColonyState with a numeric heartbeat, matching HTTP.
      const live = frames[frames.length - 1];
      expect(typeof live.heartbeat, 'WS-delivered state must carry a numeric heartbeat').toBe('number');
      expect(live.colonies, 'WS-delivered state must carry the colonies object').toBeTypeOf('object');
      expect(Object.keys(live.colonies)).toContain(s.ctx.room);
    },
  );
});
