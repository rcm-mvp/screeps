/**
 * Scenario E — pause kill-switch.
 *
 * `propose({ paused: true })` is the stop button any AI driver relies on.
 * While paused, the economy must halt (no new economic creeps) but DEFENSE
 * MUST PERSIST: the bootstrap tower keeps firing and kills NPC invaders.
 * Both sides are asserted across the wire — the pause through the bridge,
 * the kill through the server db (tower energy spent, hostiles gone).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitFor, waitForAck, waitForCreepCount } from '../src/poll';
import { countHostiles, getTowerEnergy, spawnHostiles } from '../src/bootstrap';
import { writeDirectivesRaw } from '../src/directives';
import { half } from '../src/report';

const ECONOMIC_ROLES = ['harvester', 'miner', 'hauler', 'upgrader', 'builder', 'claimer', 'scout'];

describe('E. pause kill-switch (economy halts, defense persists)', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    // A live economy first, so "the economy stopped" is meaningful.
    await waitForCreepCount(watcher, 'harvester', 1, ticksMs(150));
  });

  afterAll(async () => {
    // Leave the world unpaused for whoever inspects it; the next scenario
    // resets Memory anyway.
    await writeDirectivesRaw(s.bridge, { paused: false }, s.ctx.shard).catch(() => {});
    watcher?.stop();
    await stopScenario(s);
  });

  it('halts the economy but keeps shooting while paused', async () => {
    const towerBefore = await getTowerEnergy(s.cli, s.ctx.room);
    expect(towerBefore, 'bootstrap should have placed a charged tower').toBeGreaterThan(0);

    // Pause through the contract — THE kill-switch under test. (Correctly
    // encoded write per bug #2; confirm the ack over HTTP ground truth.)
    const rev = await writeDirectivesRaw(s.bridge, { paused: true }, s.ctx.shard);
    const ack = await waitForAck(s.bridge, rev, ticksMs(60));
    expect(
      ack.directiveVersion,
      half('ack', `executor never acked the pause directive rev ${rev}`),
    ).toBeGreaterThanOrEqual(rev);

    // Baseline well after the ack so a creep already mid-spawn at pause time
    // (the engine finishes in-flight spawns regardless) has been born and
    // counted — otherwise it would look like the paused colony spawned anew.
    const settle = (watcher.latest?.heartbeat ?? 0) + 50;
    const baselineState = await watcher.next((st) => st.heartbeat >= settle, {
      timeoutMs: ticksMs(70),
      what: 'post-pause settling window (lets any in-flight spawn finish)',
    });
    const baseline: Record<string, number> = {};
    for (const role of ECONOMIC_ROLES) baseline[role] = baselineState.creeps.byRole[role] ?? 0;

    // Hostiles arrive while the colony is paused.
    await spawnHostiles(s.cli, s.ctx.room, {
      x: s.ctx.layout.spawn.x - 2,
      y: s.ctx.layout.spawn.y - 2,
    });

    // Defense persists: the executor sees the threat...
    await watcher.next((st) => (st.colonies[s.ctx.room]?.threats.hostiles ?? 0) >= 1, {
      timeoutMs: ticksMs(40),
      what: half('bot-write', 'state.threats.hostiles to reflect the spawned invaders while paused'),
    });

    // ...and the tower kills it (observed in the server db, not in our hopes).
    await waitFor(async () => (await countHostiles(s.cli, s.ctx.room)) === 0, {
      timeoutMs: ticksMs(120),
      intervalMs: 1000,
      what: 'the tower to kill all invaders while the colony is paused (defense must persist)',
    });
    const towerAfter = await getTowerEnergy(s.cli, s.ctx.room);
    expect(
      towerAfter,
      'tower energy must have been spent on shots — otherwise the invaders died of something else',
    ).toBeLessThan(towerBefore);

    // Economy halted: across the paused window, no economic role grew.
    const finalState = await watcher.next((st) => st.heartbeat >= settle + 60, {
      timeoutMs: ticksMs(120),
      what: 'a 60-tick paused observation window',
    });
    for (const role of ECONOMIC_ROLES) {
      const now = finalState.creeps.byRole[role] ?? 0;
      expect(
        now,
        `paused colony spawned new economic creeps: ${role} went ${baseline[role]} → ${now}`,
      ).toBeLessThanOrEqual(baseline[role]);
    }

    // Liveness under pause: state/heartbeat keep flowing (the contract's
    // guarantee that a paused bot is still observable and resumable).
    expect(finalState.heartbeat).toBeGreaterThan(baselineState.heartbeat);
  }, 300_000);

  it('resumes on paused:false', async () => {
    const rev = await writeDirectivesRaw(s.bridge, { paused: false }, s.ctx.shard);
    const ack = await waitForAck(s.bridge, rev, ticksMs(60));
    expect(
      ack.directiveVersion,
      half('ack', `executor never acked the resume directive rev ${rev}`),
    ).toBeGreaterThanOrEqual(rev);
  });
});
