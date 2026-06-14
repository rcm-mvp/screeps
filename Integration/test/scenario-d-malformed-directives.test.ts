/**
 * Scenario D — malformed-directive survival.
 *
 * Object-garbage is written DIRECTLY to `Memory.bridge.directives` (bypassing
 * Commander/ControlChannel validation) to simulate a buggy AI strategist. It
 * is written with a single correct encoding (`writeRawDirectiveObject`) so the
 * executor actually receives an OBJECT to validate — the bridge's own
 * `memory.set` would double-encode it into a string the executor discards
 * outright (bug #2, scenario C), never exercising the field-level defences.
 *
 * The executor must: clamp the absurd quota (≤20), ignore the unknown posture
 * and bad room names, STILL ack the rev (so a caller never hangs), keep
 * running, and warn once per rev rather than spamming every tick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StrategyPlanLike } from '../src/types';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, collectConsole, ticksMs, waitFor, waitForAck } from '../src/poll';
import { writeRawDirectiveObject } from '../src/directives';
import { half } from '../src/report';

describe('D. malformed-directive survival', () => {
  let s: Scenario;
  let watcher: StateWatcher;
  let consoleFeed: { lines: string[]; stop: () => void };
  let rev: number;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    consoleFeed = await collectConsole(s.bridge);
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before injecting garbage'),
    });

    // The buggy-AI write: an OBJECT of garbage straight onto the directives
    // path, no validation. Correctly encoded so the executor actually receives
    // it (the bridge's own set() would double-encode into a discarded string).
    const current = await s.bridge.control.getDirectives();
    rev = (typeof current.rev === 'number' ? current.rev : 0) + 1;
    await writeRawDirectiveObject(
      s.bridge,
      {
        rev,
        paused: 'yes',
        posture: 'zerg-rush',
        targetRooms: ['NOT_A_ROOM', 42, 'W999N999'],
        roleQuotas: { upgrader: 999, harvester: 'many', ['x'.repeat(64)]: 3 },
        flagsAsOrders: 'sure',
        note: 'x'.repeat(2000),
      },
      s.ctx.shard,
    );
  });

  afterAll(async () => {
    consoleFeed?.stop();
    watcher?.stop();
    await stopScenario(s);
  });

  it('still acks the rev — the executor never hangs on garbage', async () => {
    // Ground-truth ack over HTTP (the bridge's WS awaitAck shares the
    // object-path limitation documented in scenario C).
    const ack = await waitForAck(s.bridge, rev, ticksMs(60));
    expect(
      ack.directiveVersion,
      half('ack', `executor must ack even a malformed directive rev ${rev}; a missing ack hangs every AI caller`),
    ).toBeGreaterThanOrEqual(rev);
  });

  it('clamps the quota, ignores bad posture/rooms, and keeps running', async () => {
    const plan = await waitFor(
      async () => {
        const p = (await s.bridge.memory.get('plan')) as StrategyPlanLike | null;
        return p && p.rev === rev ? p : null;
      },
      { timeoutMs: ticksMs(40), intervalMs: 1500, what: `Memory.plan recomputed for garbage rev ${rev}` },
    );

    expect(plan.posture, 'unknown posture "zerg-rush" must fall back to the default').toBe('economy');

    const colony = plan.colonies[s.ctx.room];
    expect(colony, `plan must still contain the home colony ${s.ctx.room}`).toBeDefined();
    expect(colony.quotas['upgrader'], 'quota 999 must be clamped to MAX_QUOTA (20)').toBe(20);
    expect(
      typeof colony.quotas['harvester'],
      'non-numeric quota must be ignored, leaving the strategy-computed number in place',
    ).toBe('number');

    const allTargets = [...colony.claimTargets, ...colony.scoutTargets, ...colony.attackTargets];
    expect(allTargets, 'invalid room names must be dropped').not.toContain('NOT_A_ROOM');
    expect(allTargets, 'out-of-range room names must be dropped').not.toContain('W999N999');

    // Liveness: heartbeat keeps advancing after digesting garbage.
    const beat = watcher.latest?.heartbeat ?? 0;
    await watcher.next((st) => st.heartbeat > beat + 3, {
      timeoutMs: ticksMs(30),
      what: half('bot-write', 'heartbeat to keep advancing after the malformed directive'),
    });
  });

  it('warns once per rev instead of spamming every tick', async () => {
    // Give the executor a window in which a spamming bug would be obvious.
    const beat = watcher.latest?.heartbeat ?? 0;
    await watcher.next((st) => st.heartbeat > beat + 30, {
      timeoutMs: ticksMs(80),
      what: '30 further ticks of console output to inspect',
    });

    const warnings = consoleFeed.lines.filter((l) => l.includes('[wrn]') && l.includes('directives:'));
    expect(
      warnings.length,
      'the executor must log a validation warning for the malformed directive',
    ).toBeGreaterThanOrEqual(1);

    // One rev produces several warning lines in the SAME tick (one per bad
    // field) — that is fine. Spamming would be warnings across many ticks.
    const ticksWithWarnings = new Set(
      warnings.map((l) => /t=(\d+)/.exec(l)?.[1] ?? 'unknown'),
    );
    expect(
      ticksWithWarnings.size,
      `directive warnings must be once-per-rev, not per-tick (saw warnings on ticks ` +
        `${[...ticksWithWarnings].join(', ')} over a ~30-tick window):\n` +
        warnings.slice(0, 5).join('\n'),
    ).toBeLessThanOrEqual(2);
  });
});
