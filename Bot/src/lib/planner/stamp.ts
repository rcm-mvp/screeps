/**
 * Fixed "bunker" stamp — one compact all-in-one layout anchored at a single
 * tile. Standard community concept (a packed core sealed by a small rampart
 * ring); the exact layout here is our own, generated deterministically.
 *
 * Layout strategy: a checkerboard. Structures sit on tiles whose (dx+dy) is
 * even (the anchor's parity); the complementary tiles stay walkable, so every
 * structure is orthogonally adjacent to an open gap and the interior is always
 * reachable (a fully-packed block would trap creeps — spawns/extensions/towers
 * are obstacles). Build tiles are filled spiralling out from the anchor in
 * priority order, so the core (spawns, storage, towers, labs) lands centrally
 * and extensions ring the outside.
 *
 * Each structure is tagged with the controller level that unlocks it, matching
 * `CONTROLLER_STRUCTURES`, so the construction manager places only what the
 * current RCL allows.
 */
import type { TerrainLike } from './distanceTransform';
import type { PlannedStructure } from './types';

interface Spec {
  type: BuildableStructureConstant;
  rcl: number;
}

/**
 * Per-instance shopping list in placement priority (central → outer). Unlock
 * RCLs mirror CONTROLLER_STRUCTURES; source/controller containers and the early
 * tower live here so the core is self-sufficient. Source/controller *links* are
 * intentionally deferred (a later optimisation) so the 6-link budget stays
 * entirely inside the bunker and the per-RCL count test is simple.
 */
function shoppingList(): Spec[] {
  const list: Spec[] = [];
  const add = (type: BuildableStructureConstant, rcls: number[]): void => {
    for (const r of rcls) list.push({ type, rcl: r });
  };
  add(STRUCTURE_SPAWN, [1, 7, 8]); //                 {1:1, 7:2, 8:3}
  add(STRUCTURE_STORAGE, [4]); //                      {4:1}
  add(STRUCTURE_TERMINAL, [6]); //                     {6:1}
  add(STRUCTURE_TOWER, [3, 5, 7, 8, 8, 8]); //         {3:1, 5:2, 7:3, 8:6}
  add(STRUCTURE_LINK, [5, 5, 6, 7, 8, 8]); //          {5:2, 6:3, 7:4, 8:6}
  add(STRUCTURE_POWER_SPAWN, [8]); //                  {8:1}
  add(STRUCTURE_FACTORY, [7]); //                      {7:1}
  add(STRUCTURE_NUKER, [8]); //                        {8:1}
  add(STRUCTURE_OBSERVER, [8]); //                     {8:1}
  add(STRUCTURE_LAB, [6, 6, 6, 7, 7, 7, 8, 8, 8, 8]); // {6:3, 7:6, 8:10}
  // extensions: {2:5,3:10,4:20,5:30,6:40,7:50,8:60} — i.e. +5,+5,+10,+10,+10,+10,+10
  for (const [rcl, n] of [[2, 5], [3, 5], [4, 10], [5, 10], [6, 10], [7, 10], [8, 10]] as const) {
    for (let i = 0; i < n; i++) list.push({ type: STRUCTURE_EXTENSION, rcl });
  }
  return list;
}

/** Even-parity (anchor parity) offsets, ordered by Chebyshev ring then scan. */
function evenParityOffsets(maxRing: number): Array<{ dx: number; dy: number }> {
  const offs: Array<{ dx: number; dy: number }> = [];
  for (let r = 0; r <= maxRing; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // exactly ring r
        if (((dx + dy) & 1) !== 0) continue; // even parity only
        offs.push({ dx, dy });
      }
    }
  }
  return offs;
}

const SHOPPING = shoppingList();
const BUILD_OFFSETS = evenParityOffsets(12).slice(0, SHOPPING.length);

/** Max Chebyshev offset any stamp tile reaches — the clearance an anchor needs. */
export const STAMP_RADIUS = BUILD_OFFSETS.reduce((m, o) => Math.max(m, Math.abs(o.dx), Math.abs(o.dy)), 0);

/** Total structures the bunker places (excludes derived containers + roads). */
export const STAMP_STRUCTURE_COUNT = SHOPPING.length;

/** Bunker structures anchored at (ax, ay), each with its unlock RCL. */
export function bunkerStructures(ax: number, ay: number): PlannedStructure[] {
  return SHOPPING.map((spec, i) => ({
    x: ax + BUILD_OFFSETS[i].dx,
    y: ay + BUILD_OFFSETS[i].dy,
    type: spec.type,
    rcl: spec.rcl,
  }));
}

/**
 * Internal connective roads: odd-parity gap tiles inside the footprint that
 * border at least two structures (the movement spine). Walkability doesn't
 * depend on them — the checkerboard gaps are already open — they just speed
 * creeps up, so they're placed late and capped by the manager.
 */
export function bunkerRoads(ax: number, ay: number, structures: PlannedStructure[]): Array<{ x: number; y: number }> {
  const occ = new Set(structures.map((s) => s.x * 50 + s.y));
  const roads: Array<{ x: number; y: number }> = [];
  const ortho = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let dx = -STAMP_RADIUS; dx <= STAMP_RADIUS; dx++) {
    for (let dy = -STAMP_RADIUS; dy <= STAMP_RADIUS; dy++) {
      if (((dx + dy) & 1) === 0) continue; // structures sit on even tiles
      const x = ax + dx;
      const y = ay + dy;
      let neighbours = 0;
      for (const [ox, oy] of ortho) if (occ.has((x + ox) * 50 + (y + oy))) neighbours++;
      if (neighbours >= 2) roads.push({ x, y });
    }
  }
  return roads;
}

/**
 * True if the whole bunker can be placed at (ax, ay): every tile in bounds
 * (with a 2-tile margin for the rampart ring + the room edge), off natural
 * walls, and clear of `blocked` tiles (sources/controller/mineral + adjacency).
 */
export function stampFits(
  ax: number,
  ay: number,
  terrain: TerrainLike,
  blocked: (x: number, y: number) => boolean,
): boolean {
  for (const s of bunkerStructures(ax, ay)) {
    if (s.x < 2 || s.x > 47 || s.y < 2 || s.y > 47) return false;
    if (terrain.get(s.x, s.y) === TERRAIN_MASK_WALL) return false;
    if (blocked(s.x, s.y)) return false;
  }
  return true;
}
