/**
 * Scenario G — flag command channel.
 *
 * Flags are the spatial steering wheel (`flagsAsOrders` defaults to on): a
 * `claim:*` flag placed via the real `game/create-flag` endpoint must make
 * the strategy plan target that room AND a claimer creep get dispatched with
 * that target room in its memory. A `scout:*` flag must likewise enter the
 * plan's scout targets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreepMemoryLike, StrategyPlanLike } from '../src/types';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitFor, waitForCreepCount } from '../src/poll';
import { half } from '../src/report';

describe('G. flag command channel', () => {
  let s: Scenario;
  let watcher: StateWatcher;
  let claimRoom: string;
  let scoutRoom: string;

  beforeAll(async () => {
    s = await startScenario();
    if (s.ctx.targetRooms.length === 0) {
      throw new Error(
        'scenario G needs at least one unowned controller room as a flag target — the bootstrap found none',
      );
    }
    claimRoom = s.ctx.targetRooms[0];
    scoutRoom = s.ctx.targetRooms[1] ?? s.ctx.targetRooms[0];
    watcher = new StateWatcher(s.bridge);
    // The claimer needs the 800-energy base up; wait for a working economy.
    await waitForCreepCount(watcher, 'harvester', 1, ticksMs(150));
  });

  afterAll(async () => {
    await s.bridge.world.removeFlag('claim:itest', claimRoom).catch(() => {});
    await s.bridge.world.removeFlag('scout:itest', scoutRoom).catch(() => {});
    watcher?.stop();
    await stopScenario(s);
  });

  it('claim:* flag → plan targets the room → a claimer is dispatched', async () => {
    await s.bridge.world.createFlag({ room: claimRoom, x: 25, y: 25, name: 'claim:itest' });

    // The strategy layer picks the flag up on its next run.
    const plan = await waitFor(
      async () => {
        const p = (await s.bridge.memory.get('plan')) as StrategyPlanLike | null;
        const capital = p?.colonies[s.ctx.room];
        return capital && capital.claimTargets.includes(claimRoom) ? p : null;
      },
      {
        timeoutMs: ticksMs(60),
        intervalMs: 2000,
        what: `Memory.plan claimTargets to include the flagged room ${claimRoom} (flags-as-orders)`,
      },
    );
    expect(plan.colonies[s.ctx.room].quotas['claimer'] ?? 0, 'plan must budget a claimer for the flagged room').toBeGreaterThanOrEqual(1);

    // The actual dispatch: a claimer creep whose memory carries the target.
    await waitFor(
      async () => {
        const creeps = ((await s.bridge.memory.get('creeps')) ?? {}) as Record<string, CreepMemoryLike>;
        return Object.values(creeps).some((c) => c.role === 'claimer' && c.targetRoom === claimRoom);
      },
      {
        timeoutMs: ticksMs(600),
        intervalMs: 3000,
        what: `a claimer creep with targetRoom=${claimRoom} (needs 650 energy capacity — bootstrapped base has 800)`,
      },
    );
  }, 300_000);

  it('scout:* flag → plan scouts the room', async () => {
    await s.bridge.world.createFlag({ room: scoutRoom, x: 25, y: 25, name: 'scout:itest' });

    const plan = await waitFor(
      async () => {
        const p = (await s.bridge.memory.get('plan')) as StrategyPlanLike | null;
        const capital = p?.colonies[s.ctx.room];
        return capital && capital.scoutTargets.includes(scoutRoom) ? p : null;
      },
      {
        timeoutMs: ticksMs(60),
        intervalMs: 2000,
        what: `Memory.plan scoutTargets to include the flagged room ${scoutRoom}`,
      },
    );
    expect(
      plan.colonies[s.ctx.room].quotas['scout'] ?? 0,
      'plan must budget a scout for an unscouted flagged room',
    ).toBeGreaterThanOrEqual(1);
  });
});
