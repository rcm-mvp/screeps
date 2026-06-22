/**
 * Scenario L — A2.4 mineral-visibility VALUE on a live server (creep-free).
 *
 * WHAT THIS GUARDS
 * ----------------
 * scenario-k proves `colony.mineral` is PRESENT and well-shaped on a real run.
 * This goes one level deeper without any creep timing: it seeds a known amount
 * of the room's native mineral straight into a user-owned storage (god mode),
 * then asserts the executor's state writer reports that EXACT type + amount —
 * and that it re-reads storage every tick (a live change is reflected). That
 * exercises the real A2.4 read path in `Bot/src/state.ts`
 * (`room.storage.store[mineral.mineralType]`) end to end against the bundled
 * executor, which scenario-k's `>= 0` shape check does not.
 *
 * It is deliberately creep-free: the hauler's "energy always wins" rule (and
 * spawn-queue / fatigue-movement timing) make creep-driven mineral assertions
 * flaky inside a scenario budget — that path is covered deterministically by the
 * Bot smoke scenarios (E–J) and the harvest mechanic by scenario-m. Here we pin
 * only what is observable and stable over the contract: the state field's value.
 *
 * The mineral amount in storage is never decremented by the bot (haulers only
 * deliver minerals TO storage, and `logistics` only scans CONTAINERS for mineral
 * pickups, never storage), so the seeded value is stable to assert against.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scenario, startScenario, stopScenario } from '../src/scenario';
import { StateWatcher, ticksMs } from '../src/poll';
import { half } from '../src/report';
import {
  ensureRoomMineral,
  seedUserStorage,
  setStorageStore,
  setControllerLevel,
  type SeededMineral,
} from '../src/mineralSeed';

describe('L. mineral visibility value (colony.mineral reflects real storage holdings)', () => {
  let s: Scenario;
  let watcher: StateWatcher;
  let mineral: SeededMineral;

  const SEEDED = 750;
  const UPDATED = 1500;

  beforeAll(async () => {
    s = await startScenario();
    watcher = new StateWatcher(s.bridge);
    await watcher.next((st) => st.heartbeat > 0, {
      timeoutMs: ticksMs(60),
      what: half('bot-write', 'executor heartbeat before seeding the mineral stockpile'),
    });

    // Storage unlocks at RCL4; the read path doesn't gate on level, but keep the
    // world coherent. Ensure the room has a mineral (real rooms do) and seed a
    // known amount of THAT type into a user-owned storage.
    await setControllerLevel(s.cli, s.ctx.room, 4);
    mineral = await ensureRoomMineral(s.cli, s.ctx.room, s.ctx.layout.spawn);
    await seedUserStorage(s.cli, s.ctx.userId, s.ctx.room, s.ctx.layout.spawn, {
      energy: 1000,
      [mineral.mineralType]: SEEDED,
    });
  });

  afterAll(async () => {
    watcher?.stop();
    await stopScenario(s);
  });

  it('reports the exact native mineral type + stockpiled amount from storage', async () => {
    // The next executor tick that reads the seeded storage must surface it.
    const state = await watcher.next(
      (st) => {
        const m = (st.colonies[s.ctx.room] as { mineral?: { type: string; amount: number } } | undefined)?.mineral;
        return !!m && m.type === mineral.mineralType && m.amount === SEEDED;
      },
      {
        timeoutMs: ticksMs(30),
        what: half('bot-write', `colony.mineral === { type: ${mineral.mineralType}, amount: ${SEEDED} } from seeded storage`),
      },
    );

    const m = (state.colonies[s.ctx.room] as { mineral?: { type: string; amount: number } }).mineral!;
    expect(m.type, half('bot-write', 'colony.mineral.type must equal the room deposit type')).toBe(mineral.mineralType);
    expect(m.amount, half('bot-write', `colony.mineral.amount must equal the seeded storage holding (${SEEDED})`)).toBe(
      SEEDED,
    );
  }, 120_000);

  it('re-reads storage every tick (a live change is reflected in colony.mineral.amount)', async () => {
    // Change the storage holding under the running executor; the field must
    // follow on a subsequent tick (proves it is read live, not cached once).
    await setStorageStore(s.cli, s.ctx.room, { energy: 1000, [mineral.mineralType]: UPDATED });

    const state = await watcher.next(
      (st) => {
        const m = (st.colonies[s.ctx.room] as { mineral?: { type: string; amount: number } } | undefined)?.mineral;
        return !!m && m.amount === UPDATED;
      },
      {
        timeoutMs: ticksMs(30),
        what: half('bot-write', `colony.mineral.amount tracks the live storage change to ${UPDATED}`),
      },
    );

    const m = (state.colonies[s.ctx.room] as { mineral?: { type: string; amount: number } }).mineral!;
    expect(m.amount, half('bot-write', `colony.mineral.amount must update to ${UPDATED}`)).toBe(UPDATED);
    // No loop error surfaced while seeding/observing.
    expect(
      state.lastError,
      half('bot-write', `state.lastError must stay null (got ${state.lastError ? state.lastError.message : 'null'})`),
    ).toBeNull();
  }, 120_000);
});
