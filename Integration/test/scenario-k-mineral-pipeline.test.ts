/**
 * Scenario K — per-tick mineral-pipeline loop-regression net + the A2.4
 * visibility field (A2 mineral extraction: planner v3 / mineralMiner role /
 * generalized hauler-logistics / colony.mineral state extension).
 *
 * WHAT THIS GUARDS
 * ----------------
 * A2 ("mineral extraction") landed without touching the bridge↔executor
 * contract (`API/src/contract.ts` / `CONTRACT_VERSION` are unchanged). It is the
 * direct sibling of the A1/A3/A4 changes pinned by scenario J, and this scenario
 * is the same kind of net for it. A2 added four pieces, all on the per-tick or
 * per-strategy-tick paths the executor runs for every owned room:
 *
 *   A2.1 — the base planner now places a mineral extractor + mineral container,
 *          and `SETTINGS.PLAN_VERSION` bumped 2→3 (a one-time replan on deploy).
 *          The planner is consulted every tick (cached), so a v3 regression would
 *          throw on a real server immediately.
 *   A2.2 — a new `mineralMiner` role (registered in the role-runner table, with a
 *          body in `bodyFor`) plus a quota in `computeQuotas` that, every strategy
 *          tick, calls `room.find(FIND_MINERALS)` and `mineral.pos.lookFor(
 *          LOOK_STRUCTURES)`. Those live game lookups run on the strategy path.
 *   A2.3 — the hauler + logistics were generalized to move minerals (mineral
 *          container → storage) alongside energy. This runs in the per-tick
 *          logistics/hauler path for every owned room.
 *   A2.4 — a new EXECUTOR-SIDE state extension `colony.mineral = { type, amount }`
 *          (the room's native mineral type + how much sits in storage). Like
 *          `cpuBySubsystem` / `basePlan`, it is an extra field NOT declared on the
 *          contract `ColonyState` type, so contract-unaware readers ignore it.
 *
 * Each of A2.1–A2.3 runs inside the executor's per-tick / per-strategy-tick guard
 * machinery. Any throw it raises is caught, recorded into the tick's error list,
 * and surfaced as `state.lastError`. So — exactly as in scenario J — a healthy,
 * advancing heartbeat with `lastError === null` over a sustained window is a
 * direct, contract-level proof that the new A2 code runs clean in the live loop
 * and didn't destabilise it. Test 1 is that liveness net. Test 2 additionally
 * pins the A2.4 visibility field: every room has a mineral deposit from boot (the
 * deposit isn't RCL-gated; only the *extractor* is), so as soon as the executor
 * writes state the `colony.mineral` extension should be present and well-formed.
 *
 * WHY THIS DOESN'T ASSERT DEEP EXTRACTION BEHAVIOUR (seeding feasibility)
 * ----------------------------------------------------------------------
 * Asserting the *resource-moving* behaviour of the pipeline (an RCL6 extractor
 * actually harvesting the deposit → mineral container → storage, with a non-zero
 * `mineral.amount`) would require seeding an owned room to ≥ RCL6 with a working
 * extractor the executor will actually operate. That is NOT feasible from this
 * harness, for the same reasons spelled out at length in scenario J's header:
 *
 *  1. The server CLI CAN insert arbitrary `rooms.objects` and set a controller's
 *     `level` (proven by bootstrap's `createTestUser` / `spawnHostiles`), so a
 *     bare RCL6 + an extractor structure could be written at the db level.
 *  2. BUT the executor only operates a mineral container the bot's plan actually
 *     adopts — the exact (x,y) tile the planner's runtime geometry chooses for
 *     the mineral container (adjacent to the deposit, derived in-game from the
 *     room's terrain + anchor). Those tiles are computed in-game and stored ONLY
 *     in a RawMemory segment (`SETTINGS.PLAN_SEGMENT` = 90), which is not exposed
 *     over the bridge and not in regular Memory. Seeding a container the bot
 *     would adopt therefore means re-deriving the planner's geometry or reaching
 *     into the mod's segment storage — fragile, and un-validatable here without a
 *     live server. (Cf. scenario J point 2 — identical infeasibility.)
 *  3. Even with the extractor + container placed correctly, the in-flight mineral
 *     amounts live in raw structure stores (the mineral container's store, the
 *     mineralMiner's carry), which are NOT in `ColonyState`. Only the
 *     storage-resident total is summarised into `colony.mineral.amount`; the
 *     harvesting flow itself could only be confirmed via direct CLI structure
 *     store reads, adding another brittle layer. (Cf. scenario J point 3.)
 *
 * So deep extraction assertions need MANUAL RCL6 + extractor seeding on a live
 * server and are deliberately out of scope here. This scenario instead pins the
 * two things that ARE observable and contract-level: the new per-tick A2 code
 * keeps the loop healthy, and the A2.4 mineral field is present and well-formed.
 * It does not weaken or duplicate scenarios A–J; it is a focused net for the A2
 * changes specifically, modelled on scenario J.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs, waitForCreepCount } from '../src/poll';
import { half } from '../src/report';

describe('K. mineral pipeline loop-regression net (A2 mineral extraction runs clean every tick)', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    // A booted, state-writing executor — the precondition for everything below.
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before observing the A2 mineral subsystems'),
    });
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('runs the A2 mineral per-tick code clean every tick (no loop error, advancing heartbeat)', async () => {
    // Observe a sustained window of distinct ticks. Across every one of them the
    // executor ran: the generalized hauler/logistics that now move minerals
    // (A2.3, per-tick for every owned room), the cached planner consulted each
    // tick which now contains the v3 mineral extractor/container block (A2.1),
    // the `mineralMiner` runner registered in the role table (A2.2), and — on the
    // strategy ticks inside the window — the quota's `FIND_MINERALS` /
    // `mineral.pos.lookFor(LOOK_STRUCTURES)` live lookups (A2.2). A clean,
    // advancing run across the window is the regression assertion for all of them.
    const WINDOW = 12;
    const states = await watcher.collect(WINDOW, { timeoutMs: ticksMs(WINDOW * 4) });
    expect(
      states.length,
      half('bot-write', `expected ${WINDOW} distinct colony states from the live loop`),
    ).toBeGreaterThanOrEqual(WINDOW);

    // Heartbeat strictly advances every tick — the loop never wedged on the new
    // A2 mineral managers (logistics/hauler run every tick; the strategy quota
    // runs on strategy ticks; the planner is consulted every tick).
    const beats = states.map((st) => st.heartbeat);
    for (let i = 1; i < beats.length; i++) {
      expect(
        beats[i],
        half('bot-write', `heartbeat must keep advancing while the A2 mineral code runs every tick (saw ${beats.join(', ')})`),
      ).toBeGreaterThan(beats[i - 1]);
    }

    // No tick recorded an error. The executor's guard machinery would surface any
    // throw from the generalized logistics (A2.3), the mineralMiner runner /
    // strategy quota lookups (A2.2), or the planner v3 mineral block (A2.1) as
    // state.lastError, so a null across the window proves the new A2 subsystems
    // didn't blow up the loop.
    for (const st of states) {
      expect(
        st.lastError,
        half(
          'bot-write',
          `state.lastError must stay null while the A2 mineral code runs (got at tick ${st.tick}: ` +
            `${st.lastError ? `${st.lastError.message} @${st.lastError.tick}` : 'null'})`,
        ),
      ).toBeNull();
    }
  }, 300_000);

  it('surfaces the room mineral stockpile in colony state (A2.4 visibility)', async () => {
    // Let the economy/state ramp before reading the mineral summary, so the
    // executor has written several full state snapshots (same timing-robust gate
    // scenario J uses for its economy check).
    const state = await waitForCreepCount(watcher, 'harvester', 1, ticksMs(150));

    const colony = state.colonies[s.ctx.room];
    expect(colony, half('bot-write', `state.colonies must contain home room ${s.ctx.room}`)).toBeDefined();

    // `colony.mineral` is an EXECUTOR EXTENSION (A2.4), not declared on the
    // contract `ColonyState` type — so access it via a cast, exactly the way a
    // contract-unaware reader would have to opt in. Every owned room has a mineral
    // deposit from boot, so this field should be populated as soon as state is
    // written.
    const mineral = (colony as { mineral?: { type: string; amount: number } }).mineral;
    expect(
      mineral,
      half('bot-write', 'colony.mineral (A2.4 visibility extension) must be present in colony state'),
    ).toBeDefined();

    // The mineral type is the room's native deposit symbol (e.g. 'H', 'O', 'K',
    // …) — a non-empty string for every room, deposit-gated not RCL-gated.
    expect(
      typeof mineral!.type,
      half('bot-write', 'colony.mineral.type must be a string (the room deposit symbol)'),
    ).toBe('string');
    expect(
      mineral!.type.length,
      half('bot-write', 'colony.mineral.type must be non-empty (every room has a mineral deposit)'),
    ).toBeGreaterThan(0);

    // The stored amount is a non-negative number — 0 early (nothing mined/stored
    // yet at low RCL, no extractor operating), and only growing once an RCL6
    // extractor pipeline is running (out of scope here; see header).
    expect(
      typeof mineral!.amount,
      half('bot-write', 'colony.mineral.amount must be a number (storage-resident mineral total)'),
    ).toBe('number');
    expect(
      mineral!.amount,
      half('bot-write', 'colony.mineral.amount must be >= 0 (0 early — nothing mined/stored yet at low RCL)'),
    ).toBeGreaterThanOrEqual(0);

    // Re-read the latest state: still no lingering error after the economy /
    // mineral state has ramped (mirrors scenario J's second test).
    const latest = watcher.latest;
    expect(
      latest?.lastError ?? null,
      half('bot-write', `no lastError should be set after the economy ramps (got ${JSON.stringify(latest?.lastError ?? null)})`),
    ).toBeNull();
  }, 300_000);
});
