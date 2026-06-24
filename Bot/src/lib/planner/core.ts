/**
 * PURE planner core (STAMP.md §12, SV1+SV2).
 *
 * `buildPlan` runs the EXACT pipeline `plan.ts#computePlan` does — stamp-or-fitter
 * structure placement → derived source/controller/mineral containers + role links
 * + extractor → min-cut ramparts over the cluster bbox → roads → a `RoomPlan` —
 * but as a PURE function over a plain `BuildPlanInput`. It runs unchanged in BOTH
 * the bot (in-game, via the `computePlan` adapter) and the server-side Strategist
 * (under Node, with unlimited CPU).
 *
 * PURITY CONTRACT: this module references NO Screeps runtime — no `Game`, `Room`,
 * `RawMemory`, `PathFinder`, `RoomPosition`, `room.find(...)` or `FIND_*`. The
 * only Screeps globals it touches are `STRUCTURE_*` and `TERRAIN_MASK_*`
 * constants, which the Strategist injects via esbuild `define` when bundling for
 * Node (in-game they are real globals). Roads + the anchor reachability check use
 * the pure Dijkstra pathfinder in `roads.ts` (SV2), NOT the in-game `PathFinder`.
 * Deterministic: identical input → identical plan.
 */
import { distanceTransform, type TerrainLike } from './distanceTransform';
import { selectAnchor } from './anchor';
import { STAMP_RADIUS, bunkerStructures, bunkerRoads, stampFits } from './stamp';
import { minCutRamparts } from './mincut';
import { planRoadsPure, isReachable } from './roads';
import { fitStructures } from './fit';
import type { RoomPlan, PlannedStructure } from './types';

/** Default tuning (mirrors the bot's SETTINGS; overridable per call). */
const DEFAULT_MINCUT_MARGIN = 2;
const DEFAULT_EXIT_MARGIN = 5;

export interface BuildPlanInput {
  /** Terrain mask reader: get(x, y) → 0 | TERRAIN_MASK_WALL | TERRAIN_MASK_SWAMP. */
  terrain: TerrainLike;
  sources: Array<{ x: number; y: number }>;
  controller: { x: number; y: number } | null;
  mineral: { x: number; y: number; mineralType?: string } | null;
  spawn: { x: number; y: number } | null;
  /** Existing structures (excluding ramparts) — fixed, occupied, incorporated. */
  existing: Array<{ x: number; y: number; type: BuildableStructureConstant }>;
  storagePos?: { x: number; y: number } | null;
  /** Tiles of slack around the cluster bbox before the min-cut (default 2). */
  mincutMargin?: number;
  /** Anchor must sit at least this far from the nearest exit (default 5). */
  exitMargin?: number;
}

const packCoord = (x: number, y: number): number => x * 50 + y;

// --- pipeline helpers (pure; lifted verbatim from plan.ts) ------------------

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

/**
 * Tag the bunker link nearest the planned storage as the 'core' hub. See the
 * companion doc in plan.ts (this is the same logic, moved into the pure core).
 */
function promoteCoreLink(structures: PlannedStructure[], anchor: { x: number; y: number }): void {
  const storage = structures.find((s) => s.type === STRUCTURE_STORAGE);
  const ref = storage ?? anchor;
  let best: PlannedStructure | null = null;
  let bestD = Infinity;
  for (const s of structures) {
    if (s.type !== STRUCTURE_LINK || s.role) continue; // only untagged stamp links
    const d = Math.max(Math.abs(s.x - ref.x), Math.abs(s.y - ref.y));
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best) {
    best.role = 'core';
    best.rcl = 5; // pin to the RCL links unlock so the sender is never gated behind a higher one
  }
}

/**
 * Reorder the LINK entries to [core, controller, source(s), …untagged surplus]
 * while leaving every non-link entry where it is (so nextSites budgets the
 * role-tagged links first). Same logic as plan.ts.
 */
function reorderLinks(structures: PlannedStructure[]): void {
  const links = structures.filter((s) => s.type === STRUCTURE_LINK);
  if (!links.length) return;
  const rank = (s: PlannedStructure): number =>
    s.role === 'core' ? 0 : s.role === 'controller' ? 1 : s.role === 'source' ? 2 : 3;
  links.sort((a, b) => rank(a) - rank(b)); // stable in V8 → source links keep room order
  let i = 0;
  for (let j = 0; j < structures.length; j++) {
    if (structures[j].type === STRUCTURE_LINK) structures[j] = links[i++];
  }
}

/**
 * One representative exit tile per open side (top, bottom, left, right), derived
 * PURELY from the terrain mask (an exit tile is a non-wall tile on the room
 * frame x∈{0,49} or y∈{0,49}). Order + mid-tile selection mirror the in-game
 * `room.find(FIND_EXIT_TOP|BOTTOM|LEFT|RIGHT)` path in plan.ts so road
 * destinations are identical.
 */
function exitWaypoints(terrain: TerrainLike): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const mid = (tiles: Array<{ x: number; y: number }>): void => {
    if (tiles.length) out.push(tiles[Math.floor(tiles.length / 2)]);
  };
  const top: Array<{ x: number; y: number }> = [];
  const bottom: Array<{ x: number; y: number }> = [];
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 50; i++) {
    if (terrain.get(i, 0) !== TERRAIN_MASK_WALL) top.push({ x: i, y: 0 });
    if (terrain.get(i, 49) !== TERRAIN_MASK_WALL) bottom.push({ x: i, y: 49 });
    if (terrain.get(0, i) !== TERRAIN_MASK_WALL) left.push({ x: 0, y: i });
    if (terrain.get(49, i) !== TERRAIN_MASK_WALL) right.push({ x: 49, y: i });
  }
  mid(top);
  mid(bottom);
  mid(left);
  mid(right);
  return out;
}

// --- the pure orchestrator --------------------------------------------------

/**
 * Run the full planning pipeline PURELY. Returns a `RoomPlan` (with `v`/`at` set
 * to 0 — the caller stamps the real PLAN_VERSION / tick) or `null` if no anchor
 * satisfies the constraints. Equivalent to `plan.ts#computePlan`, minus the
 * Room/Game coupling.
 */
export function buildPlan(input: BuildPlanInput): RoomPlan | null {
  const { terrain } = input;
  const mincutMargin = input.mincutMargin ?? DEFAULT_MINCUT_MARGIN;
  const exitMargin = input.exitMargin ?? DEFAULT_EXIT_MARGIN;
  const openness = distanceTransform(terrain);

  const keyPositions: Array<{ x: number; y: number }> = input.sources.map((s) => ({ x: s.x, y: s.y }));
  if (input.controller) keyPositions.push({ x: input.controller.x, y: input.controller.y });
  if (input.mineral) keyPositions.push({ x: input.mineral.x, y: input.mineral.y });

  // Block the key positions (+ adjacency) so the bunker never buries them, and
  // so the pure pathfinder treats them as impassable structure tiles.
  const blocked = new Set<number>();
  for (const p of keyPositions) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) blocked.add(packCoord(p.x + dx, p.y + dy));
  }
  const isBlocked = (x: number, y: number): boolean => blocked.has(packCoord(x, y));

  // Reachability via the PURE pathfinder (SV2): every key position must be
  // reachable from the candidate anchor over the cost model (planned structures
  // / key rings impassable). Replaces the in-game PathFinder check.
  const reachable = (x: number, y: number): boolean => {
    const from = { x, y };
    const noRoads = new Set<number>();
    for (const p of keyPositions) {
      if (!isReachable(from, p, terrain, blocked, noRoads, 1)) return false;
    }
    return true;
  };

  // Prefer anchoring on an existing spawn so the base grows around the live
  // colony; otherwise pick the openness peak.
  let anchor: { x: number; y: number } | null = null;
  if (input.spawn) {
    const { x, y } = input.spawn;
    const inBounds = x >= STAMP_RADIUS + 1 && x <= 48 - STAMP_RADIUS && y >= STAMP_RADIUS + 1 && y <= 48 - STAMP_RADIUS;
    if (inBounds && stampFits(x, y, terrain, isBlocked) && reachable(x, y)) anchor = { x, y };
  }
  if (!anchor) {
    anchor = selectAnchor({ openness, terrain, keyPositions, reachable }, { minClearance: Math.max(3, exitMargin) });
  }

  // Structure placement (two-tier): the rigid bunker stamp when it fits; else
  // the adaptive fitter. Both produce the same shape downstream.
  let structures: PlannedStructure[];
  let usedStamp = false;
  if (anchor) {
    structures = bunkerStructures(anchor.x, anchor.y);
    usedStamp = true;
  } else {
    const fit = fitStructures({
      terrain,
      openness,
      spawn: input.spawn,
      existing: input.existing,
      sources: input.sources,
      controller: input.controller,
      mineral: input.mineral ? { x: input.mineral.x, y: input.mineral.y } : null,
      storagePos: input.storagePos ?? null,
    });
    if (!fit) return null;
    anchor = fit.anchor;
    structures = fit.structures;
  }
  if (!anchor) return null; // set in both branches above — narrows for the type checker
  const occupied = new Set(structures.map((s) => packCoord(s.x, s.y)));

  // Don't derive a structure the (legacy-built) base already provides.
  const hasNear = (type: BuildableStructureConstant, pos: { x: number; y: number }, range: number): boolean =>
    structures.some((s) => s.type === type && Math.max(Math.abs(s.x - pos.x), Math.abs(s.y - pos.y)) <= range);

  // Derived source/controller containers (skip where one already exists).
  for (const src of input.sources) {
    if (hasNear(STRUCTURE_CONTAINER, src, 1)) continue;
    const tile = bestNeighbour(src, anchor, terrain, occupied);
    if (tile) {
      structures.push({ x: tile.x, y: tile.y, type: STRUCTURE_CONTAINER, rcl: 2 });
      occupied.add(packCoord(tile.x, tile.y));
    }
  }
  if (input.controller && !hasNear(STRUCTURE_CONTAINER, input.controller, 1)) {
    const tile = bestNeighbour(input.controller, anchor, terrain, occupied);
    if (tile) {
      structures.push({ x: tile.x, y: tile.y, type: STRUCTURE_CONTAINER, rcl: 3 });
      occupied.add(packCoord(tile.x, tile.y));
    }
  }

  // Role-tagged links for the energy network (item A1).
  if (input.controller && !hasNear(STRUCTURE_LINK, input.controller, 1)) {
    const tile = bestNeighbour(input.controller, anchor, terrain, occupied);
    if (tile) {
      structures.push({ x: tile.x, y: tile.y, type: STRUCTURE_LINK, rcl: 5, role: 'controller' });
      occupied.add(packCoord(tile.x, tile.y));
    }
  }
  for (const src of input.sources) {
    if (hasNear(STRUCTURE_LINK, src, 1)) continue;
    const tile = bestNeighbour(src, anchor, terrain, occupied);
    if (tile) {
      structures.push({ x: tile.x, y: tile.y, type: STRUCTURE_LINK, rcl: 5, role: 'source' });
      occupied.add(packCoord(tile.x, tile.y));
    }
  }
  promoteCoreLink(structures, anchor);
  reorderLinks(structures);

  // Mineral extraction (item A2): the extractor sits ON the mineral tile, with a
  // container on the best adjacent tile.
  if (input.mineral) {
    const mineral = input.mineral;
    if (!hasNear(STRUCTURE_EXTRACTOR, mineral, 0)) {
      structures.push({ x: mineral.x, y: mineral.y, type: STRUCTURE_EXTRACTOR, rcl: 6, role: 'extractor' });
      occupied.add(packCoord(mineral.x, mineral.y));
    }
    if (!hasNear(STRUCTURE_CONTAINER, mineral, 1)) {
      const tile = bestNeighbour(mineral, anchor, terrain, occupied);
      if (tile) {
        structures.push({ x: tile.x, y: tile.y, type: STRUCTURE_CONTAINER, rcl: 6, role: 'mineral' });
        occupied.add(packCoord(tile.x, tile.y));
      }
    }
  }

  // Min-cut ramparts over the dense base cluster bbox (dilated by the margin).
  const CLUSTER_RADIUS = STAMP_RADIUS + 5;
  let bx1 = anchor.x;
  let by1 = anchor.y;
  let bx2 = anchor.x;
  let by2 = anchor.y;
  for (const s of structures) {
    if (Math.max(Math.abs(s.x - anchor.x), Math.abs(s.y - anchor.y)) > CLUSTER_RADIUS) continue;
    if (s.x < bx1) bx1 = s.x;
    if (s.x > bx2) bx2 = s.x;
    if (s.y < by1) by1 = s.y;
    if (s.y > by2) by2 = s.y;
  }
  const rect = {
    x1: Math.max(1, bx1 - mincutMargin),
    y1: Math.max(1, by1 - mincutMargin),
    x2: Math.min(48, bx2 + mincutMargin),
    y2: Math.min(48, by2 + mincutMargin),
  };
  const ramparts = minCutRamparts(terrain, rect);

  // Roads. The internal spine comes from `bunkerRoads` ONLY when the rigid stamp
  // was placed — its ≥2-orthogonal-neighbour rule assumes the stamp's even-parity
  // grid and degenerates into a scattered, disconnected mess on the fitter's
  // free-form layout. For the fitter we let the pure pathfinder build the whole
  // network from the anchor, which is inherently connected (every routed path is
  // rooted at the anchor and later paths reuse earlier lanes).
  const internalRoads = usedStamp ? bunkerRoads(anchor.x, anchor.y, structures) : [];
  const existingRoads = new Set(internalRoads.map((r) => packCoord(r.x, r.y)));

  // Route to each key position's PICKUP tile (its derived container/link) rather
  // than the raw source/controller: in cramped rooms the only walkable neighbour
  // of a source is taken by its own container, so "within range 1 of the source"
  // is unreachable — but "within range 1 of the container" lands on the road tile
  // a hauler actually stands on. Falls back to the raw position when no pickup was
  // derived (e.g. a source the legacy base already services off-grid).
  const pickupFor = (pos: { x: number; y: number }): { x: number; y: number } => {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const s of structures) {
      if (s.type !== STRUCTURE_CONTAINER && s.type !== STRUCTURE_LINK) continue;
      const d = Math.max(Math.abs(s.x - pos.x), Math.abs(s.y - pos.y));
      if (d <= 1 && d < bestD) {
        bestD = d;
        best = { x: s.x, y: s.y };
      }
    }
    return best ?? pos;
  };
  const roadTargets: Array<{ x: number; y: number }> = input.sources.map(pickupFor);
  if (input.controller) roadTargets.push(pickupFor(input.controller));
  if (input.mineral) roadTargets.push(pickupFor(input.mineral));

  const destinations: Array<{ x: number; y: number }> = [...roadTargets, ...exitWaypoints(terrain)];
  const externalRoads = planRoadsPure({
    anchor,
    roomName: '', // unused by the pure pathfinder; kept for the shared RoadInput shape
    destinations,
    blocked: occupied,
    existingRoads,
    terrain,
  });
  const roads = [...internalRoads, ...externalRoads].filter((r) => !occupied.has(packCoord(r.x, r.y)));

  return { v: 0, at: 0, anchor, structures, ramparts, roads };
}
