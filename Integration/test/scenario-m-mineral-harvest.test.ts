/**
 * Scenario M — A2.2 mineral harvesting through a real extractor (live server).
 *
 * WHAT THIS GUARDS
 * ----------------
 * That the bundled `mineralMiner` role (A2.2), running on a real server, harvests
 * the deposit through a STRUCTURE_EXTRACTOR and the harvested mineral lands in
 * the adjacent mineral container — the core extraction mechanic the Bot smoke
 * tests can only MOCK. We seed the RCL6 structures (extractor on the mineral, a
 * container on a walkable neighbour) and inject a pre-parked `mineralMiner` creep
 * standing on that container, so the assertion doesn't depend on the spawn queue
 * or fatigue-limited movement (which would be flaky in a scenario budget).
 *
 * Setup notes:
 *  - NO storage is seeded, so the generalized hauler never touches the container
 *    (mineral pickup is sink-gated — A2.3), leaving the container store to grow
 *    monotonically from the miner's harvest: a clean signal.
 *  - At RCL6 with the extractor + a non-empty deposit, `computeQuotas` ALSO wants
 *    its own `mineralMiner` (A2.2's quota gate), so the injected creep additionally
 *    confirms the census/role wiring recognises the role; the bot may spawn a
 *    second one later (not relied upon).
 *
 * The injected creep is given memory `{ role: 'mineralMiner', home, working:false }`
 * during a paused tick; the executor's adoptCreeps won't override an explicit
 * role, so it runs runMineralMiner on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitFor, waitForCreepCount } from '../src/poll';
import { half } from '../src/report';
import {
  ensureRoomMineral,
  seedExtractor,
  seedMineralContainer,
  injectMineralMiner,
  getContainerResource,
  removeStorage,
  setControllerLevel,
  type SeededMineral,
} from '../src/mineralSeed';

describe('M. mineral harvesting (mineralMiner harvests through the extractor into the container)', () => {
  let s: Scenario;
  let watcher: StateWatcher;
  let mineral: SeededMineral;
  let container: { x: number; y: number };

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before seeding the extractor pipeline'),
    });

    // No mineral sink, so the container is never drained by haulers.
    await removeStorage(s.cli, s.ctx.room);
    await setControllerLevel(s.cli, s.ctx.room, 6);
    mineral = await ensureRoomMineral(s.cli, s.ctx.room, s.ctx.layout.spawn);
    await seedExtractor(s.cli, s.ctx.userId, mineral, s.ctx.room);
    container = await seedMineralContainer(s.cli, s.ctx.room, mineral);
    await injectMineralMiner(s.cli, s.ctx.userId, s.ctx.room, container);
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('recognises the mineralMiner role in the live census', async () => {
    // The injected creep carries memory.role = 'mineralMiner'; the census counts
    // it, proving the role is registered + run on the real bundle (A2.2).
    const state = await waitForCreepCount(watcher, 'mineralMiner', 1, ticksMs(40));
    expect(
      state.creeps.byRole.mineralMiner ?? 0,
      half('bot-write', 'state.creeps.byRole.mineralMiner must be >= 1 (the running mineralMiner)'),
    ).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('harvests the deposit through the extractor into the mineral container', async () => {
    // The parked miner (0 CARRY) drops harvested mineral onto its tile, which —
    // standing on the container — fills the container. With no sink, nothing
    // removes it, so the store strictly grows from 0.
    const amount = await waitFor(
      async () => {
        const n = await getContainerResource(s.cli, s.ctx.room, container, mineral.mineralType);
        return n > 0 ? n : null;
      },
      {
        timeoutMs: ticksMs(80),
        intervalMs: 1000,
        what: `mineral container at (${container.x},${container.y}) to accumulate ${mineral.mineralType} via the extractor`,
      },
    );
    expect(
      amount,
      half('bot-write', `container ${mineral.mineralType} must be > 0 after harvesting (got ${amount})`),
    ).toBeGreaterThan(0);

    // The new RCL6 + extractor + mineralMiner code kept the loop healthy.
    expect(
      watcher.latest?.lastError ?? null,
      half('bot-write', `state.lastError must stay null while mining (got ${JSON.stringify(watcher.latest?.lastError ?? null)})`),
    ).toBeNull();
  }, 150_000);
});
