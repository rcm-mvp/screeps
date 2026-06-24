/**
 * Base-plan orchestrator: runs the planning pipeline ONCE per room, caches the
 * result to a RawMemory segment (mirrored on the heap), and exposes cheap
 * per-tick helpers — `getCachedPlan`, `nextSites`, `summarize` — for the
 * construction manager.
 *
 * The HEAVY planning pipeline (stamp-or-fitter → derived containers/links/
 * extractor → min-cut → roads → RoomPlan) lives in the PURE `core.ts#buildPlan`
 * so the SAME algorithm runs both in-game here and server-side in the Strategist
 * (STAMP.md §12). `computePlan` is a thin Room→input adapter around it; the
 * encode/decode wire format + the per-tick segment cache + placement helpers
 * (Room/RawMemory-coupled) stay here.
 */
import { SETTINGS } from '../../settings';
import { log } from '../log';
import { ensureHeap } from '../../heap';
import { buildPlan } from './core';
import type { RoomPlan, PackedPlan, PlannedStructure, BasePlanSummary } from './types';

/** Ramparts go up as soon as they unlock (defense); roads wait for surplus. */
const RAMPART_MIN_RCL = 2;
const ROAD_MIN_RCL = 3;

/** Placement priority. Ramparts and roads are appended after, in that order. */
const TYPE_PRIORITY: BuildableStructureConstant[] = [
  STRUCTURE_SPAWN,
  STRUCTURE_EXTENSION,
  STRUCTURE_TOWER,
  STRUCTURE_CONTAINER,
  STRUCTURE_STORAGE,
  STRUCTURE_LINK,
  STRUCTURE_TERMINAL,
  STRUCTURE_LAB,
  STRUCTURE_EXTRACTOR,
  STRUCTURE_FACTORY,
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_NUKER,
  STRUCTURE_OBSERVER,
];

/** Type ↔ index table for the packed wire format (order is the serialised id). */
const TYPES: BuildableStructureConstant[] = [
  STRUCTURE_SPAWN,
  STRUCTURE_EXTENSION,
  STRUCTURE_TOWER,
  STRUCTURE_CONTAINER,
  STRUCTURE_STORAGE,
  STRUCTURE_LINK,
  STRUCTURE_TERMINAL,
  STRUCTURE_LAB,
  STRUCTURE_FACTORY,
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_NUKER,
  STRUCTURE_OBSERVER,
  STRUCTURE_ROAD,
  STRUCTURE_RAMPART,
  STRUCTURE_EXTRACTOR, // appended (item A2) to keep existing serialized indices stable
];

/**
 * Role ↔ index table for the packed wire format (index 0 = no role). Only LINK
 * structures use a role today; the union mirrors PlannedStructure.role. A missing
 * 4th packed element decodes to index 0 → undefined role (backward-safe).
 */
const ROLES = ['core', 'controller', 'source', 'mineral', 'extractor'] as const;

const packCoord = (x: number, y: number): number => x * 50 + y;
const unX = (c: number): number => Math.floor(c / 50);
const unY = (c: number): number => c % 50;

// --- pipeline (thin Room adapter over the pure core) ------------------------

/**
 * Run the full pipeline for a Room: read its terrain + objects into the pure
 * `BuildPlanInput`, delegate to `core.ts#buildPlan` (the shared planner the
 * Strategist also runs), then stamp the live PLAN_VERSION + tick onto the result.
 * Returns null if no anchor satisfies the constraints. The heavy logic is in
 * `buildPlan` — this adapter is the ONLY Room-coupled part of the pipeline.
 */
export function computePlan(room: Room, opts: { allowFitter?: boolean } = {}): RoomPlan | null {
  const sources = room.find(FIND_SOURCES);
  const mineral = room.find(FIND_MINERALS)[0];
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  // Existing structures (ramparts coexist with structures — not occupancy).
  const existing = room
    .find(FIND_STRUCTURES)
    .filter((s) => s.structureType !== STRUCTURE_RAMPART)
    .map((s) => ({ x: s.pos.x, y: s.pos.y, type: s.structureType as BuildableStructureConstant }));

  const plan = buildPlan({
    terrain: room.getTerrain(),
    sources: sources.map((s) => ({ x: s.pos.x, y: s.pos.y })),
    controller: room.controller ? { x: room.controller.pos.x, y: room.controller.pos.y } : null,
    mineral: mineral ? { x: mineral.pos.x, y: mineral.pos.y } : null,
    spawn: spawn ? { x: spawn.pos.x, y: spawn.pos.y } : null,
    existing,
    storagePos: room.storage ? { x: room.storage.pos.x, y: room.storage.pos.y } : null,
    mincutMargin: SETTINGS.MINCUT_MARGIN,
    exitMargin: SETTINGS.EXIT_MARGIN,
    allowFitter: opts.allowFitter,
  });
  if (!plan) return null;

  plan.v = SETTINGS.PLAN_VERSION;
  plan.at = Game.time;
  return plan;
}

// --- (de)serialize ----------------------------------------------------------

export function encodePlan(plan: RoomPlan): PackedPlan {
  return {
    v: plan.v,
    at: plan.at,
    a: packCoord(plan.anchor.x, plan.anchor.y),
    s: plan.structures.map((s) => {
      // Drop the role element entirely when there isn't one, so unrolled plans
      // stay 3-tuples and the segment stays small.
      const ri = s.role ? ROLES.indexOf(s.role) + 1 : 0;
      return ri ? [packCoord(s.x, s.y), TYPES.indexOf(s.type), s.rcl, ri] : [packCoord(s.x, s.y), TYPES.indexOf(s.type), s.rcl];
    }),
    r: plan.ramparts.map((p) => packCoord(p.x, p.y)),
    d: plan.roads.map((p) => packCoord(p.x, p.y)),
  };
}

export function decodePlan(p: PackedPlan): RoomPlan {
  return {
    v: p.v,
    at: p.at,
    anchor: { x: unX(p.a), y: unY(p.a) },
    structures: p.s.map(([c, ti, rcl, ri]) => {
      const s: PlannedStructure = { x: unX(c), y: unY(c), type: TYPES[ti], rcl };
      // A missing/zero 4th element means no role (backward-safe for 3-tuples).
      if (ri) s.role = ROLES[ri - 1];
      return s;
    }),
    ramparts: p.r.map((c) => ({ x: unX(c), y: unY(c) })),
    roads: p.d.map((c) => ({ x: unX(c), y: unY(c) })),
  };
}

// --- segment cache ----------------------------------------------------------

/** Request the plan segment active (data lands next tick) and load it once. */
function ensureSegment(): Record<string, PackedPlan> | undefined {
  if (typeof RawMemory === 'undefined') return undefined;
  RawMemory.setActiveSegments([SETTINGS.PLAN_SEGMENT]);
  const heap = ensureHeap();
  if (heap.planMap) return heap.planMap;
  const raw = RawMemory.segments[SETTINGS.PLAN_SEGMENT];
  if (typeof raw !== 'string') return undefined; // not loaded yet this global
  try {
    heap.planMap = raw ? (JSON.parse(raw) as Record<string, PackedPlan>) : {};
  } catch {
    heap.planMap = {};
  }
  return heap.planMap;
}

/** Decoded plan for a room, or undefined if none cached / segment not yet loaded. */
export function getCachedPlan(room: Room): RoomPlan | undefined {
  const heap = ensureHeap();
  const cached = heap.plans[room.name];
  if (cached && cached.v === SETTINGS.PLAN_VERSION) return cached.decoded;

  const map = ensureSegment();
  const packed = map?.[room.name];
  if (!packed || packed.v !== SETTINGS.PLAN_VERSION) return undefined;
  const decoded = decodePlan(packed);
  heap.plans[room.name] = { v: decoded.v, decoded };
  return decoded;
}

/** True once the segment has been loaded this global (safe to merge-write). */
export function segmentReady(): boolean {
  return ensureSegment() !== undefined;
}

function writeSegment(map: Record<string, PackedPlan>): void {
  if (typeof RawMemory === 'undefined') return;
  RawMemory.segments[SETTINGS.PLAN_SEGMENT] = JSON.stringify(map);
}

/**
 * Compute, cache (segment + heap), and stamp the RoomMemory pointer.
 *
 * Two-tier policy (STAMP.md §12, SV3): the rigid bunker stamp is computed cheaply
 * in-game; rooms too closed for it are DEFERRED to the server-side planner (the
 * Strategist computes the adaptive fit on the box's CPU and writes segment 90,
 * which `getCachedPlan` then picks up). The in-game fitter is kept only as a
 * grace-window fallback so a down/unreachable server can't stall a base forever.
 */
export function planRoom(room: Room): boolean {
  const map = ensureSegment();
  if (!map) return false; // segment not loaded yet — try again next tick

  // 1. Stamp-only (cheap). Most rooms fit the rigid bunker and never pay for the
  //    fitter or wait on the server.
  let plan = computePlan(room, { allowFitter: false });

  if (!plan) {
    // 2. Stamp doesn't fit → defer to the server (it owns the heavy fit). Record
    //    the wait and hold off; only fall back to the in-game fitter once the
    //    grace window lapses (server down / unreachable).
    const req = room.memory.planRequest ?? (room.memory.planRequest = { since: Game.time });
    const waited = Game.time - req.since;
    if (waited < SETTINGS.PLAN_SERVER_GRACE) {
      log.info(`planner: ${room.name} too closed for the stamp — awaiting server plan (${waited}/${SETTINGS.PLAN_SERVER_GRACE}t)`);
      return false;
    }
    log.warn(`planner: ${room.name} no server plan after ${SETTINGS.PLAN_SERVER_GRACE}t — falling back to the in-game fitter`);
    plan = computePlan(room, { allowFitter: true });
    if (!plan) {
      log.warn(`planner: no valid anchor in ${room.name} even with the fitter`);
      return false;
    }
  }

  // Success (stamp or fallback fitter): cache + clear any pending server request.
  map[room.name] = encodePlan(plan);
  writeSegment(map);
  const heap = ensureHeap();
  heap.plans[room.name] = { v: plan.v, decoded: plan };
  room.memory.plan = { v: plan.v, seg: SETTINGS.PLAN_SEGMENT, summary: summarize(room, plan) };
  delete room.memory.planRequest;
  log.info(
    `planner: plan for ${room.name} — anchor (${plan.anchor.x},${plan.anchor.y}), ` +
      `${plan.structures.length} structures, ${plan.ramparts.length} ramparts, ${plan.roads.length} roads`,
  );
  return true;
}

/** Forget a room's plan everywhere (triggers a replan when the bucket allows). */
export function invalidate(room: Room): void {
  const heap = ensureHeap();
  delete heap.plans[room.name];
  const map = ensureSegment();
  if (map && map[room.name]) {
    delete map[room.name];
    writeSegment(map);
  }
  delete room.memory.plan;
  log.info(`planner: invalidated plan for ${room.name}`);
}

// --- placement + summary (pure-ish, testable) -------------------------------

export interface PlaceCtx {
  rcl: number;
  /** A structure or construction site of `type` already occupies (x, y). */
  has: (x: number, y: number, type: BuildableStructureConstant) => boolean;
  /** Built + queued count of `type` in the room (for the per-RCL cap). */
  countOf: (type: BuildableStructureConstant) => number;
  /** Max allowed of `type` at the current RCL (CONTROLLER_STRUCTURES). */
  limitOf: (type: BuildableStructureConstant, rcl: number) => number;
  /** Max sites to return this call. */
  budget: number;
}

/** Which sites to place this tick, RCL- and cap-gated, in priority order. */
export function nextSites(plan: RoomPlan, ctx: PlaceCtx): Array<{ x: number; y: number; type: BuildableStructureConstant }> {
  const out: Array<{ x: number; y: number; type: BuildableStructureConstant }> = [];
  const queued: Record<string, number> = {};
  for (const type of TYPE_PRIORITY) {
    const limit = ctx.limitOf(type, ctx.rcl);
    for (const s of plan.structures) {
      if (out.length >= ctx.budget) return out;
      if (s.type !== type || s.rcl > ctx.rcl) continue;
      if (ctx.has(s.x, s.y, type)) continue;
      if (ctx.countOf(type) + (queued[type] ?? 0) >= limit) break;
      out.push({ x: s.x, y: s.y, type });
      queued[type] = (queued[type] ?? 0) + 1;
    }
  }
  if (ctx.rcl >= RAMPART_MIN_RCL) {
    for (const r of plan.ramparts) {
      if (out.length >= ctx.budget) return out;
      if (ctx.has(r.x, r.y, STRUCTURE_RAMPART)) continue;
      out.push({ x: r.x, y: r.y, type: STRUCTURE_RAMPART });
    }
  }
  if (ctx.rcl >= ROAD_MIN_RCL) {
    for (const r of plan.roads) {
      if (out.length >= ctx.budget) return out;
      if (ctx.has(r.x, r.y, STRUCTURE_ROAD)) continue;
      out.push({ x: r.x, y: r.y, type: STRUCTURE_ROAD });
    }
  }
  return out;
}

/** Count how much of the plan is already standing → progress summary. */
export function summarize(room: Room, plan: RoomPlan): BasePlanSummary {
  const built = new Set<string>();
  for (const s of room.find(FIND_STRUCTURES)) built.add(`${s.pos.x},${s.pos.y},${s.structureType}`);
  const exists = (x: number, y: number, t: string): boolean => built.has(`${x},${y},${t}`);

  let done = 0;
  for (const s of plan.structures) if (exists(s.x, s.y, s.type)) done++;
  for (const r of plan.ramparts) if (exists(r.x, r.y, STRUCTURE_RAMPART)) done++;
  for (const r of plan.roads) if (exists(r.x, r.y, STRUCTURE_ROAD)) done++;
  const planned = plan.structures.length + plan.ramparts.length + plan.roads.length;

  return {
    anchor: [plan.anchor.x, plan.anchor.y],
    rcl: room.controller?.level ?? 0,
    built: done,
    planned,
    ramparts: plan.ramparts.length,
    roads: plan.roads.length,
    pct: planned ? Math.round((done / planned) * 100) : 0,
  };
}
