import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColonyState } from 'screeps-web-api-bridge';
import { Planner, PLAN_SEGMENT, type PlannerPort } from '../src/planner';
import { planForServer, PLAN_VERSION } from '../vendor/planner';
import { state, colony } from './helpers';

// Real W52S13 room data — the closed, legacy-built room the whole server-side
// planner exists for (too cramped for the rigid bunker stamp).
const FX = join(__dirname, '..', '..', 'Bot', 'test', 'fixtures');
const terrainFx = JSON.parse(readFileSync(join(FX, 'w52s13.terrain.json'), 'utf8'));
const objFx = JSON.parse(readFileSync(join(FX, 'w52s13.objects.json'), 'utf8'));
const SPAWN = objFx.spawns[0];

/** The room-objects API response shape, assembled from the fixture. */
function fixtureObjects() {
  const objects: Array<{ type: string; x: number; y: number; [k: string]: unknown }> = [];
  for (const s of objFx.sources) objects.push({ type: 'source', x: s.x, y: s.y });
  if (objFx.controller) objects.push({ type: 'controller', x: objFx.controller.x, y: objFx.controller.y });
  if (objFx.mineral) objects.push({ type: 'mineral', x: objFx.mineral.x, y: objFx.mineral.y, mineralType: objFx.mineral.mineralType });
  for (const s of objFx.spawns) objects.push({ type: 'spawn', x: s.x, y: s.y });
  for (const s of objFx.structures) objects.push({ type: s.type, x: s.x, y: s.y });
  return { objects };
}

interface MockPort extends PlannerPort {
  segments: Record<number, string>;
  setCalls: number;
}

function mockPort(over: Partial<Record<keyof PlannerPort, unknown>> = {}): MockPort {
  const segments: Record<number, string> = {};
  const port: MockPort = {
    segments,
    setCalls: 0,
    terrain: vi.fn(async () => ({ grid: terrainFx.grid })),
    objects: vi.fn(async () => fixtureObjects()),
    getSegment: vi.fn(async (seg: number) => ({ data: segments[seg] ?? '' })),
    setSegment: vi.fn(async (seg: number, data: string) => {
      segments[seg] = data;
      port.setCalls++;
    }),
    ...(over as object),
  } as MockPort;
  return port;
}

/** ColonyState with W52S13 flagged needsPlan (executor-side extension field). */
function flaggedState(over: Record<string, unknown> = {}): ColonyState {
  return state({
    colonies: { W52S13: { ...colony({ rcl: 5 }), needsPlan: true, ...over } as never },
  });
}

const cfg = (over: Partial<{ enabled: boolean; recomputeCooldownMs: number }> = {}) => ({
  enabled: true,
  recomputeCooldownMs: 120_000,
  ...over,
});

describe('vendored planForServer on the W52S13 fixture (SV1/SV2 under Node)', () => {
  const grid = terrainFx.grid;
  const terrain = {
    get: (x: number, y: number) => {
      if (x < 0 || x > 49 || y < 0 || y > 49) return 1;
      const t = grid[y][x];
      return t === 'wall' ? 1 : t === 'swamp' ? 2 : 0;
    },
  };
  const storage = objFx.structures.find((s: { type: string }) => s.type === 'storage');
  const input = {
    terrain,
    sources: objFx.sources.map((s: { x: number; y: number }) => ({ x: s.x, y: s.y })),
    controller: { x: objFx.controller.x, y: objFx.controller.y },
    mineral: { x: objFx.mineral.x, y: objFx.mineral.y, mineralType: objFx.mineral.mineralType },
    spawn: { x: SPAWN.x, y: SPAWN.y },
    existing: objFx.structures
      .filter((s: { type: string }) => s.type !== 'rampart')
      .map((s: { x: number; y: number; type: string }) => ({ x: s.x, y: s.y, type: s.type })),
    storagePos: storage ? { x: storage.x, y: storage.y } : null,
  };

  it('produces a packed plan stamped with the bot PLAN_VERSION', () => {
    const packed = planForServer(input, 4242);
    expect(packed).not.toBeNull();
    expect(packed!.v).toBe(PLAN_VERSION);
    expect(packed!.at).toBe(4242);
  });

  it('anchors on the existing spawn and emits structures/ramparts/roads', () => {
    const packed = planForServer(input)!;
    expect(packed.a).toBe(SPAWN.x * 50 + SPAWN.y); // anchor packs to the spawn tile
    expect(packed.s.length).toBeGreaterThan(50);
    expect(packed.r.length).toBeGreaterThan(0);
    expect(packed.d.length).toBeGreaterThan(0);
  });

  it('is deterministic (identical packed plan on re-run)', () => {
    expect(JSON.stringify(planForServer(input, 1))).toBe(JSON.stringify(planForServer(input, 1)));
  });
});

describe('Planner loop (SV4)', () => {
  it('plans a flagged room and writes it to segment 90', async () => {
    const port = mockPort();
    const planner = new Planner({ bridge: port, config: cfg() });
    await planner.planFlagged(flaggedState());

    expect(port.setSegment).toHaveBeenCalledTimes(1);
    expect((port.setSegment as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PLAN_SEGMENT);
    const map = JSON.parse(port.segments[PLAN_SEGMENT]);
    expect(map.W52S13.v).toBe(PLAN_VERSION);
    expect(map.W52S13.a).toBe(SPAWN.x * 50 + SPAWN.y);
    expect(map.W52S13.s.length).toBeGreaterThan(50);
  });

  it('is idempotent — skips a room already planned at the current version', async () => {
    const port = mockPort();
    port.segments[PLAN_SEGMENT] = JSON.stringify({ W52S13: { v: PLAN_VERSION, at: 1, a: 0, s: [], r: [], d: [] } });
    const planner = new Planner({ bridge: port, config: cfg() });
    await planner.planFlagged(flaggedState());
    expect(port.setSegment).not.toHaveBeenCalled();
  });

  it('replans when the segment holds a STALE-version plan', async () => {
    const port = mockPort();
    port.segments[PLAN_SEGMENT] = JSON.stringify({ W52S13: { v: PLAN_VERSION - 1, at: 1, a: 0, s: [], r: [], d: [] } });
    const planner = new Planner({ bridge: port, config: cfg() });
    await planner.planFlagged(flaggedState());
    expect(port.setSegment).toHaveBeenCalledTimes(1);
    expect(JSON.parse(port.segments[PLAN_SEGMENT]).W52S13.v).toBe(PLAN_VERSION);
  });

  it('debounces — does not recompute the same room within the cooldown', async () => {
    let t = 1_000_000;
    const port = mockPort();
    const planner = new Planner({ bridge: port, config: cfg({ recomputeCooldownMs: 60_000 }), now: () => t });
    await planner.planFlagged(flaggedState());
    // Simulate the flag lingering (bot hasn't picked the plan up yet) but pretend
    // the segment write hasn't landed, so only the cooldown can suppress a redo.
    port.segments[PLAN_SEGMENT] = '';
    t += 10_000; // within cooldown
    await planner.planFlagged(flaggedState());
    expect(port.setSegment).toHaveBeenCalledTimes(1);
    t += 60_000; // cooldown elapsed
    await planner.planFlagged(flaggedState());
    expect(port.setSegment).toHaveBeenCalledTimes(2);
  });

  it('MERGES — preserves other rooms’ plans in the segment', async () => {
    const port = mockPort();
    port.segments[PLAN_SEGMENT] = JSON.stringify({ W1N1: { v: PLAN_VERSION, at: 1, a: 5, s: [[5, 0, 1]], r: [], d: [] } });
    const planner = new Planner({ bridge: port, config: cfg() });
    await planner.planFlagged(flaggedState());
    const map = JSON.parse(port.segments[PLAN_SEGMENT]);
    expect(map.W1N1).toBeDefined(); // untouched
    expect(map.W52S13).toBeDefined(); // newly written
  });

  it('aborts the write on a failed segment read (never clobbers)', async () => {
    const setSegment = vi.fn(async () => {});
    const port = mockPort({ getSegment: vi.fn(async () => { throw new Error('network'); }), setSegment });
    const planner = new Planner({ bridge: port, config: cfg() });
    await planner.planFlagged(flaggedState());
    expect(setSegment).not.toHaveBeenCalled();
  });

  it('writes nothing when the kill switch is engaged', async () => {
    const port = mockPort();
    const planner = new Planner({ bridge: port, config: cfg(), killSwitch: () => true });
    await planner.planFlagged(flaggedState());
    expect(port.setSegment).not.toHaveBeenCalled();
    expect(port.terrain).not.toHaveBeenCalled();
  });

  it('is inert when disabled', async () => {
    const port = mockPort();
    const planner = new Planner({ bridge: port, config: cfg({ enabled: false }) });
    await planner.planFlagged(flaggedState());
    expect(port.terrain).not.toHaveBeenCalled();
    expect(port.setSegment).not.toHaveBeenCalled();
  });

  it('ignores rooms that are not flagged', async () => {
    const port = mockPort();
    const planner = new Planner({ bridge: port, config: cfg() });
    await planner.planFlagged(state({ colonies: { W52S13: colony({ rcl: 5 }) } })); // no needsPlan
    expect(port.setSegment).not.toHaveBeenCalled();
  });
});
