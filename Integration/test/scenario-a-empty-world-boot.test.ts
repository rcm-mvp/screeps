/**
 * Scenario A — empty-world boot.
 *
 * The bot is deployed with NO directives (Memory wiped by the scenario
 * reset). It must self-boot: write `Memory.bridge.state` on the exact paths
 * the bridge reads, advance the heartbeat every tick, spawn creeps, and make
 * controller (RCL) progress — all observed through the real bridge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitFor, waitForCreepCount } from '../src/poll';
import { getControllerProgress } from '../src/bootstrap';
import { half } from '../src/report';

describe('A. empty-world boot', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('writes ColonyState to Memory.bridge.state without any directive', async () => {
    const state = await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'a non-null ColonyState with a heartbeat on memory/bridge.state'),
    });
    expect(state.colonies[s.ctx.room], half('bot-write', `state.colonies must contain home room ${s.ctx.room}`)).toBeDefined();

    // One-off HTTP read must agree with the live WS view (same memory path).
    const viaHttp = await s.bridge.control.getState();
    expect(viaHttp, half('bridge-read', 'control.getState() returned null although the WS channel delivers state')).not.toBeNull();
  });

  it('advances the heartbeat every tick', async () => {
    const states = await watcher.collect(8, { timeoutMs: ticksMs(40) });
    const beats = states.map((st) => st.heartbeat);
    for (let i = 1; i < beats.length; i++) {
      expect(
        beats[i],
        half('bot-write', `heartbeat must increase monotonically every tick (saw ${beats.join(', ')})`),
      ).toBeGreaterThan(beats[i - 1]);
    }
  });

  it('spawns creeps from a cold start', async () => {
    const state = await waitForCreepCount(watcher, 'harvester', 1, ticksMs(150));
    expect(state.creeps.total).toBeGreaterThanOrEqual(1);
    // The census the bot reports must mirror what it spawned.
    expect(Object.keys(state.creeps.byRole).length).toBeGreaterThanOrEqual(1);
  });

  it('makes RCL (controller) progress', async () => {
    // Wait until an upgrader exists, then expect controller progress to move.
    await waitForCreepCount(watcher, 'upgrader', 1, ticksMs(400));
    const before = await getControllerProgress(s.cli, s.ctx.room);
    await waitFor(
      async () => (await getControllerProgress(s.cli, s.ctx.room)) > before,
      {
        timeoutMs: ticksMs(200),
        intervalMs: 2000,
        what: `controller progress in ${s.ctx.room} to rise above ${before} (upgraders working)`,
      },
    );
  }, 300_000);
});
