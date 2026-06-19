/**
 * Scenario J — per-tick subsystem loop-regression net (A1 links / A3 builder /
 * A4 body scaling + the PLAN_VERSION bump).
 *
 * WHAT THIS GUARDS
 * ----------------
 * Three Bot changes landed without touching the bridge↔executor contract
 * (`API/src/contract.ts` is unchanged): a new per-tick `runLinks` manager (A1),
 * a builder construction-site reordering (A3), and energy-capacity-scaled
 * worker/hauler bodies (A4); the planner's `SETTINGS.PLAN_VERSION` bumped 1→2.
 *
 * `runLinks` runs every tick, for every owned room, BEFORE logistics — wrapped
 * in the executor's `guard('links', …)`. Any throw it raises (or a planner
 * regression behind `getCachedPlan`, since `runLinks` calls it every tick) is
 * caught, recorded into the tick's error list, and surfaced as
 * `state.lastError`. So a healthy, advancing heartbeat with `lastError === null`
 * over a sustained window is a direct, contract-level proof that the new
 * subsystems run clean in the live loop and didn't destabilise it. This is the
 * regression net the user asked for: it goes RED the instant `runLinks` /
 * planner v2 / the body-scaling code throws on a real server.
 *
 * WHY THIS DOESN'T ASSERT DEEP LINK BEHAVIOUR (seeding feasibility)
 * ----------------------------------------------------------------
 * Asserting the *energy-moving* behaviour of the link network (core link →
 * controller link) would require seeding an owned room to ≥ RCL5 with links the
 * executor will actually operate. That is NOT feasible from this harness:
 *
 *  1. The server CLI CAN insert arbitrary `rooms.objects` and set a controller's
 *     `level` (proven by bootstrap's `createTestUser`, which inserts spawn /
 *     tower / extensions, and `spawnHostiles`). So a bare RCL5 + link structures
 *     could be written at the db level.
 *  2. BUT `runLinks` only classifies/operates links whose (x,y) EXACTLY match
 *     the bot's plan entries — the controller-adjacent and core-near-storage
 *     tiles chosen at runtime by the planner's `bestNeighbour` geometry from the
 *     room's terrain + anchor. Those exact tiles are computed in-game and stored
 *     ONLY in a RawMemory segment (`SETTINGS.PLAN_SEGMENT` = 90), which is not
 *     exposed over the bridge and not in regular Memory (the `room.memory.plan`
 *     summary is progress counters only — no link coordinates/roles). Seeding a
 *     link the bot would adopt therefore means re-deriving the planner's
 *     geometry or reaching into the mod's segment storage — fragile, and
 *     un-validatable here without a live server.
 *  3. Even with links placed at the right tiles, the link energy flow is NOT in
 *     `ColonyState`: the classification lives on the heap (`controllerLink` /
 *     `senderLinks`) and the energy lives in raw structure stores. It could only
 *     be confirmed via direct CLI structure-store reads, adding another brittle
 *     layer.
 *
 * So deep link-transfer assertions need MANUAL RCL/link seeding on a live
 * server and are deliberately out of scope here. This scenario instead pins the
 * thing that IS observable and contract-level: the new per-tick code keeps the
 * loop healthy. It does not weaken or duplicate scenarios A–I; it is a focused
 * liveness net for the A1/A3/A4 changes specifically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitForCreepCount } from '../src/poll';
import { half } from '../src/report';

describe('J. link/planner loop-regression net (runLinks runs clean every tick)', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    // A booted, state-writing executor — the precondition for everything below.
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before observing the per-tick subsystems'),
    });
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('runs runLinks/planner every tick with no loop error and an advancing heartbeat', async () => {
    // Observe a sustained window of distinct ticks. `runLinks` executed on every
    // one of them (it's unconditional for owned rooms while not paused) — so a
    // clean, advancing run across the window is the regression assertion.
    const WINDOW = 12;
    const states = await watcher.collect(WINDOW, { timeoutMs: ticksMs(WINDOW * 4) });
    expect(
      states.length,
      half('bot-write', `expected ${WINDOW} distinct colony states from the live loop`),
    ).toBeGreaterThanOrEqual(WINDOW);

    // Heartbeat strictly advances every tick — the loop never wedged on the new
    // per-tick managers (A1 runLinks runs before logistics every tick).
    const beats = states.map((st) => st.heartbeat);
    for (let i = 1; i < beats.length; i++) {
      expect(
        beats[i],
        half('bot-write', `heartbeat must keep advancing while runLinks runs every tick (saw ${beats.join(', ')})`),
      ).toBeGreaterThan(beats[i - 1]);
    }

    // No tick recorded an error. `guard('links', …)` (and the planner call
    // inside runLinks) would surface any throw here as state.lastError, so a
    // null across the window proves the new subsystems didn't blow up the loop.
    for (const st of states) {
      expect(
        st.lastError,
        half(
          'bot-write',
          `state.lastError must stay null while runLinks/planner v2 run (got at tick ${st.tick}: ` +
            `${st.lastError ? `${st.lastError.message} @${st.lastError.tick}` : 'null'})`,
        ),
      ).toBeNull();
    }
  }, 300_000);

  it('keeps the colony economy healthy (A3 builder + A4 body scaling stay in-loop)', async () => {
    // The new code touches the spawn/build path indirectly (A4 scales worker /
    // hauler bodies by energy capacity; A3 reorders construction-site priority).
    // Boot still reaching a live economy — workers spawned, no late error — is a
    // lightweight, timing-robust proof those code paths execute cleanly too.
    const state = await waitForCreepCount(watcher, 'harvester', 1, ticksMs(150));
    expect(
      state.creeps.total,
      half('bot-write', 'executor should reach a live economy (>=1 creep) with the A3/A4 changes in the loop'),
    ).toBeGreaterThanOrEqual(1);

    // The home colony is reported and structurally intact (the contract shape
    // the bridge/AI/UI read), with no error surfaced as the economy ramps.
    const colony = state.colonies[s.ctx.room];
    expect(colony, half('bot-write', `state.colonies must contain home room ${s.ctx.room}`)).toBeDefined();
    expect(typeof colony.rcl, half('bot-write', 'colony.rcl must be a number')).toBe('number');
    expect(typeof colony.energyCapacity, half('bot-write', 'colony.energyCapacity must be a number')).toBe('number');

    // Re-read the latest state: still no lingering error after the spawn/build
    // path has run for a while.
    const latest = watcher.latest;
    expect(
      latest?.lastError ?? null,
      half('bot-write', `no lastError should be set after the economy ramps (got ${JSON.stringify(latest?.lastError ?? null)})`),
    ).toBeNull();
  }, 300_000);
});
