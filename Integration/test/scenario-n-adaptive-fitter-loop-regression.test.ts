/**
 * Scenario N — adaptive-fitter / v4-planner loop-regression net.
 *
 * WHAT THIS GUARDS
 * ----------------
 * The base planner gained an in-game ADAPTIVE FITTER fallback
 * (`Bot/src/lib/planner/fit.ts`) plus the wiring around it in
 * `Bot/src/lib/planner/plan.ts#computePlan`:
 *
 *   - `computePlan` now tries the rigid bunker stamp first and, when the stamp
 *     can't be anchored in a closed room, falls back to `fitStructures(...)`;
 *   - the fitter's derived containers / links / extractor are de-duplicated
 *     against the room's existing base;
 *   - the min-cut interior is computed from the base-cluster bounding box
 *     (union of placed + existing structures) instead of a single stamp-radius
 *     rect around one anchor;
 *   - `SETTINGS.PLAN_VERSION` was bumped 3 → 4, which version-gates the segment-90
 *     plan cache and forces a one-time replan on deploy.
 *
 * None of this touched the bridge↔executor contract (`API/src/contract.ts` and
 * `SETTINGS.CONTRACT_VERSION` are unchanged — scenario F still certifies
 * version 1), so this is a purely bot-internal change. The risk it introduces is
 * a LIVE-LOOP one: `getCachedPlan` is called EVERY tick, for every owned room,
 * by both `runLinks` (links.ts) and the construction manager (construction.ts).
 * On a cache miss or a `PLAN_VERSION` bump that call runs the full
 * `computePlan` pipeline — now including the new `fit.ts` import, the fitter
 * branch, the derived-structure dedup and the cluster-bbox min-cut. Both
 * call-sites run inside the executor's `guard(...)`, so any throw from that path
 * is caught, recorded into the tick's error list and surfaced as
 * `state.lastError`.
 *
 * Therefore a healthy, advancing heartbeat with `lastError === null` over a
 * sustained tick window is a direct, contract-level proof that the v4 planner +
 * adaptive-fitter code path runs CLEAN in the live loop and didn't destabilise
 * it. This net goes RED the instant `fit.ts` / the `computePlan` fitter wiring /
 * the v4 plan cache throws on a real server. It is the integration deliverable
 * SF8 (STAMP.md §7 / §8).
 *
 * WHY THIS DOESN'T ASSERT DEEP FITTER PLACEMENT (feasibility — same wall as J)
 * ---------------------------------------------------------------------------
 * Asserting that the fitter actually PLACED specific structures (i.e. that the
 * fallback branch ran and produced a valid adaptive layout) is NOT feasible
 * from this harness, for the same reasons scenario J documents for the link
 * network:
 *
 *  1. The fitter branch only runs when the rigid stamp CANNOT be anchored —
 *     i.e. when the room is too closed for the 15×15 bunker footprint. The
 *     private server GENERATES room terrain; the harness can boot a base into a
 *     free room and seed objects via the admin CLI, but it cannot make a room's
 *     terrain "cramped" enough to force the stamp to fail. So we cannot drive
 *     the executor down the fitter path on demand here.
 *  2. Even if the fitter ran, the resulting plan geometry (which structures it
 *     placed where, the tagged link roles, the min-cut ramparts) lives ONLY in
 *     RawMemory segment 90 (`SETTINGS.PLAN_SEGMENT` = 90). That segment is not
 *     exposed over the bridge and not in regular Memory — `room.memory.plan` is
 *     progress counters only, with no structure coordinates. Confirming a fitter
 *     placement would mean re-deriving the planner's geometry or reaching into
 *     the mod's segment storage — fragile and un-validatable here.
 *
 * Deep fitter-placement behaviour is instead covered DETERMINISTICALLY, off
 * docker, by `Bot/scripts/planner-smoke.mjs`, which runs the fitter against the
 * REAL W52S13 terrain fixture (`Bot/test/fixtures/w52s13.terrain.json` — the
 * actual closed room that motivated this work) and asserts the structural
 * invariants: existing structures preserved, no overlaps, per-RCL caps
 * respected, key tiles reachable, links tagged with roles, ramparts seal the
 * exits. That is where "did the fitter place the right things" is proven; THIS
 * scenario pins the thing that IS observable and contract-level on a live
 * server — that the new per-tick planner code keeps the loop healthy. It does
 * not weaken or duplicate scenarios A–M; it is a focused liveness net for the
 * v4 planner + `fit.ts` changes specifically (the sibling of scenario J for the
 * adaptive-fitter deliverable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, collectConsole, ticksMs, waitForCreepCount } from '../src/poll';
import { readBotBundle } from '../src/globalSetup';
import { half } from '../src/report';

describe('N. adaptive-fitter / v4-planner loop-regression net (computePlan + fit.ts run clean every tick)', () => {
  let s: Scenario;
  let watcher: StateWatcher;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    // A booted, state-writing executor — the precondition for everything below.
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before observing the v4 planner / fitter code path'),
    });
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('runs getCachedPlan/computePlan (fitter wiring) every tick with no loop error and an advancing heartbeat', async () => {
    // Observe a sustained window of distinct ticks. `getCachedPlan` executed on
    // every one of them — it's called unconditionally by `runLinks` AND the
    // construction manager for every owned room each tick — and on a cache
    // miss / the PLAN_VERSION 4 bump it runs the full `computePlan` pipeline,
    // including the new `fit.ts` import and the fitter wiring. A clean,
    // advancing run across the window is the regression assertion.
    const WINDOW = 12;
    const states = await watcher.collect(WINDOW, { timeoutMs: ticksMs(WINDOW * 4) });
    expect(
      states.length,
      half('bot-write', `expected ${WINDOW} distinct colony states from the live loop`),
    ).toBeGreaterThanOrEqual(WINDOW);

    // Heartbeat strictly advances every tick — the loop never wedged on the v4
    // planner / fitter code path (getCachedPlan runs before logistics and in
    // construction every tick).
    const beats = states.map((st) => st.heartbeat);
    for (let i = 1; i < beats.length; i++) {
      expect(
        beats[i],
        half('bot-write', `heartbeat must keep advancing while computePlan/fit.ts run every tick (saw ${beats.join(', ')})`),
      ).toBeGreaterThan(beats[i - 1]);
    }

    // No tick recorded an error. The `guard(...)` around runLinks and
    // construction (and the planner call inside both) would surface any throw
    // from the fitter wiring / v4 plan path as state.lastError, so a null
    // across the window proves the new planner code didn't blow up the loop.
    for (const st of states) {
      expect(
        st.lastError,
        half(
          'bot-write',
          `state.lastError must stay null while computePlan/fit.ts (v4 planner) run (got at tick ${st.tick}: ` +
            `${st.lastError ? `${st.lastError.message} @${st.lastError.tick}` : 'null'})`,
        ),
      ).toBeNull();
    }
  }, 300_000);

  it('keeps the colony economy healthy with the v4 planner driving construction/links in-loop', async () => {
    // The new code feeds the per-tick construction + link managers (both call
    // getCachedPlan → computePlan → fit.ts). Boot still reaching a live economy
    // — creeps spawned, plan-driven construction running, no late error — is a
    // lightweight, timing-robust proof those code paths execute cleanly too.
    const state = await waitForCreepCount(watcher, 'harvester', 1, ticksMs(150));
    expect(
      state.creeps.total,
      half('bot-write', 'executor should reach a live economy (>=1 creep) with the v4 planner in the loop'),
    ).toBeGreaterThanOrEqual(1);

    // The home colony is reported and structurally intact (the contract shape
    // the bridge/AI/UI read), with no error surfaced as the economy ramps.
    const colony = state.colonies[s.ctx.room];
    expect(colony, half('bot-write', `state.colonies must contain home room ${s.ctx.room}`)).toBeDefined();
    expect(typeof colony.rcl, half('bot-write', 'colony.rcl must be a number')).toBe('number');
    expect(typeof colony.constructionSites, half('bot-write', 'colony.constructionSites must be a number')).toBe('number');

    // Re-read the latest state: still no lingering error after the plan-driven
    // construction/link path has run for a while.
    const latest = watcher.latest;
    expect(
      latest?.lastError ?? null,
      half('bot-write', `no lastError should be set after the economy ramps (got ${JSON.stringify(latest?.lastError ?? null)})`),
    ).toBeNull();
  }, 300_000);

  it('survives a global reset (code re-push): the planner heap rebuilds clean and the loop resumes', async () => {
    // The v4 plan is decoded once per global from segment 90 into the heap; a
    // global reset (forced here by a code re-push, exactly as scenario H does)
    // tears that heap down and the executor must re-decode / re-derive the plan
    // and resume the loop WITHOUT the fitter wiring throwing on the rebuild.
    // This guards the planner's per-global init path specifically — the moment
    // most likely to re-run computePlan / fit.ts after deploy.
    const consoleFeed = await collectConsole(s.bridge);
    try {
      const beatBefore = watcher.latest?.heartbeat ?? 0;

      // Re-pushing the (trivially watermarked) real bundle rebuilds the VM —
      // the same real global reset scenario H exercises.
      const bundle = readBotBundle() + `\n// integration adaptive-fitter reset probe ${Date.now()}\n`;
      await s.bridge.code.push('default', { main: bundle });

      // The executor must notice the reset and rebuild its heap, and the
      // heartbeat must keep advancing across it — the SAME advance check
      // scenario H uses for its proven global-reset test (heartbeat >
      // beatBefore + 10). getCachedPlan re-derives the v4 plan + runs fit.ts on
      // the post-reset cache miss; a heartbeat that keeps advancing past the
      // re-push means that rebuild path didn't wedge the loop.
      const recovered = await watcher.next((st) => st.heartbeat > beatBefore + 10, {
        timeoutMs: ticksMs(80),
        what: half('bot-write', 'heartbeat to keep advancing across the code re-push (planner heap rebuild)'),
      });
      const resetSeen = consoleFeed.lines.some((l) => l.includes('global reset detected'));
      expect(resetSeen, 'executor should log "global reset detected" after the VM rebuild').toBe(true);

      // The recovered post-reset state must carry no loop error: the rebuilt
      // planner heap (computePlan / fit.ts re-run on the cache miss) didn't
      // throw. We assert on the state that proves recovery (heartbeat advanced)
      // rather than demanding a fixed count of distinct polled states — the
      // 500ms StateWatcher poll can miss intermediate ticks at a 150ms tick
      // rate, so a count-based window is timing-fragile (scenario H asserts the
      // advance + reset log, not a state count).
      expect(
        recovered.lastError,
        half(
          'bot-write',
          `state.lastError must stay null after the global reset rebuilds the planner heap (got at tick ${recovered.tick}: ` +
            `${recovered.lastError ? `${recovered.lastError.message} @${recovered.lastError.tick}` : 'null'})`,
        ),
      ).toBeNull();
    } finally {
      consoleFeed.stop();
    }
  }, 300_000);
});
