/**
 * Base-plan orchestrator: runs the planning pipeline ONCE per room, caches the
 * result to a RawMemory segment (mirrored on the heap), and exposes cheap
 * per-tick helpers — `getCachedPlan`, `nextSites`, `summarize` — for the
 * construction manager.
 *
 * Pipeline: terrain cost matrix → distance transform → anchor → bunker stamp
 * (+ derived source/controller containers) → roads → min-cut ramparts →
 * serialize with a version. See the sibling modules for each step.
 */
import { SETTINGS } from '../../settings';
import { log } from '../log';
import { ensureHeap } from '../../heap';
import { distanceTransform, type TerrainLike } from './distanceTransform';
import { selectAnchor } from './anchor';
import { STAMP_RADIUS, bunkerStructures, bunkerRoads, stampFits } from './stamp';
import { minCutRamparts } from './mincut';
import { planRoads } from './roads';
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
];

const packCoord = (x: number, y: number): number => x * 50 + y;
const unX = (c: number): number => Math.floor(c / 50);
const unY = (c: number): number => c % 50;

// --- pipeline ---------------------------------------------------------------

/** Best non-wall 8-neighbour of `pos`, nearest to the anchor and not occupied. */
function bestNeighbour(
  pos: { x: number; y: number },
  anchor: { x: number; y: number },
  terrain: TerrainLike,
  occupied: Set<number>,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = pos.x + dx;
      const y = pos.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (occupied.has(packCoord(x, y))) continue;
      const d = Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y));
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/** Run the full pipeline. Returns null if no anchor satisfies the constraints. */
export function computePlan(room: Room): RoomPlan | null {
  const terrain = room.getTerrain();
  const openness = distanceTransform(terrain);

  const sources = room.find(FIND_SOURCES);
  const mineral = room.find(FIND_MINERALS)[0];
  const keyPositions: Array<{ x: number; y: number }> = sources.map((s) => ({ x: s.pos.x, y: s.pos.y }));
  if (room.controller) keyPositions.push({ x: room.controller.pos.x, y: room.controller.pos.y });
  if (mineral) keyPositions.push({ x: mineral.pos.x, y: mineral.pos.y });

  const reachable = (x: number, y: number): boolean => {
    if (typeof PathFinder === 'undefined' || typeof RoomPosition === 'undefined') return true;
    const from = new RoomPosition(x, y, room.name);
    for (const p of keyPositions) {
      const res = PathFinder.search(from, { pos: new RoomPosition(p.x, p.y, room.name), range: 1 }, { maxOps: 3000 });
      if (res.incomplete) return false;
    }
    return true;
  };

  // Block the key positions (+ adjacency) so the bunker never buries them.
  const blocked = new Set<number>();
  for (const p of keyPositions) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) blocked.add(packCoord(p.x + dx, p.y + dy));
  }
  const isBlocked = (x: number, y: number): boolean => blocked.has(packCoord(x, y));

  // Prefer anchoring on an existing spawn so the base grows around the live
  // colony; otherwise pick the openness peak. (A fresh expand room gets its
  // first spawn from the AI's place-spawn endpoint before we plan it.)
  let anchor: { x: number; y: number } | null = null;
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (spawn) {
    const { x, y } = spawn.pos;
    const inBounds = x >= STAMP_RADIUS + 1 && x <= 48 - STAMP_RADIUS && y >= STAMP_RADIUS + 1 && y <= 48 - STAMP_RADIUS;
    if (inBounds && stampFits(x, y, terrain, isBlocked) && reachable(x, y)) anchor = { x, y };
  }
  if (!anchor) {
    anchor = selectAnchor({ openness, terrain, keyPositions, reachable }, { minClearance: Math.max(3, SETTINGS.EXIT_MARGIN) });
  }
  if (!anchor) return null;

  // Stamp + derived containers.
  const structures = bunkerStructures(anchor.x, anchor.y);
  const occupied = new Set(structures.map((s) => packCoord(s.x, s.y)));
  for (const src of sources) {
    const tile = bestNeighbour(src.pos, anchor, terrain, occupied);
    if (tile) {
      structures.push({ x: tile.x, y: tile.y, type: STRUCTURE_CONTAINER, rcl: 2 });
      occupied.add(packCoord(tile.x, tile.y));
    }
  }
  if (room.controller) {
    const tile = bestNeighbour(room.controller.pos, anchor, terrain, occupied);
    if (tile) {
      structures.push({ x: tile.x, y: tile.y, type: STRUCTURE_CONTAINER, rcl: 3 });
      occupied.add(packCoord(tile.x, tile.y));
    }
  }

  // Min-cut ramparts around the footprint dilated by the margin.
  const m = STAMP_RADIUS + SETTINGS.MINCUT_MARGIN;
  const rect = {
    x1: Math.max(1, anchor.x - m),
    y1: Math.max(1, anchor.y - m),
    x2: Math.min(48, anchor.x + m),
    y2: Math.min(48, anchor.y + m),
  };
  const ramparts = minCutRamparts(terrain, rect);

  // Roads: internal bunker spine + paths to sources/controller/mineral/exits.
  const internalRoads = bunkerRoads(anchor.x, anchor.y, structures);
  const existingRoads = new Set(internalRoads.map((r) => packCoord(r.x, r.y)));
  const destinations: Array<{ x: number; y: number }> = [...keyPositions, ...exitWaypoints(room)];
  const externalRoads = planRoads({
    anchor,
    roomName: room.name,
    destinations,
    blocked: occupied,
    existingRoads,
    terrain,
  });
  const roads = [...internalRoads, ...externalRoads].filter((r) => !occupied.has(packCoord(r.x, r.y)));

  return { v: SETTINGS.PLAN_VERSION, at: Game.time, anchor, structures, ramparts, roads };
}

/** One representative exit tile per open side (for road planning). */
function exitWaypoints(room: Room): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const find of [FIND_EXIT_TOP, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT, FIND_EXIT_RIGHT] as const) {
    const tiles = room.find(find);
    if (tiles.length) {
      const mid = tiles[Math.floor(tiles.length / 2)];
      out.push({ x: mid.x, y: mid.y });
    }
  }
  return out;
}

// --- (de)serialize ----------------------------------------------------------

export function encodePlan(plan: RoomPlan): PackedPlan {
  return {
    v: plan.v,
    at: plan.at,
    a: packCoord(plan.anchor.x, plan.anchor.y),
    s: plan.structures.map((s) => [packCoord(s.x, s.y), TYPES.indexOf(s.type), s.rcl] as [number, number, number]),
    r: plan.ramparts.map((p) => packCoord(p.x, p.y)),
    d: plan.roads.map((p) => packCoord(p.x, p.y)),
  };
}

export function decodePlan(p: PackedPlan): RoomPlan {
  return {
    v: p.v,
    at: p.at,
    anchor: { x: unX(p.a), y: unY(p.a) },
    structures: p.s.map(([c, ti, rcl]) => ({ x: unX(c), y: unY(c), type: TYPES[ti], rcl })),
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

/** Compute, cache (segment + heap), and stamp the RoomMemory pointer. */
export function planRoom(room: Room): boolean {
  const map = ensureSegment();
  if (!map) return false; // segment not loaded yet — try again next tick
  const plan = computePlan(room);
  if (!plan) {
    log.warn(`planner: no valid anchor in ${room.name} (room too closed?)`);
    return false;
  }
  map[room.name] = encodePlan(plan);
  writeSegment(map);
  const heap = ensureHeap();
  heap.plans[room.name] = { v: plan.v, decoded: plan };
  room.memory.plan = { v: plan.v, seg: SETTINGS.PLAN_SEGMENT, summary: summarize(room, plan) };
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
