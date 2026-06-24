/**
 * Road planner. Paths from the anchor to each source, the controller, the
 * mineral and the exits over the plan's cost matrix (planned structures are
 * impassable, already-planned roads cost 1), and returns the road tiles along
 * those paths. Later paths reuse earlier roads, so the network shares lanes.
 *
 * Two implementations share the same cost model and lane-reuse behaviour:
 *  - `planRoads` uses the in-game `PathFinder` (degrades to `[]` when it is
 *    unavailable, e.g. before SV2 wiring), and
 *  - `planRoadsPure` (SV2) runs a plain Dijkstra over the 50×50 grid so roads
 *    compute under Node (server-side / deterministic tests) with NO `PathFinder`
 *    or `RoomPosition`. `core.ts`#buildPlan uses the pure variant.
 *
 * Traffic-weighting is a later tuning knob — see lib/traffic.ts's CostMatrix
 * parameter.
 */
import type { TerrainLike } from './distanceTransform';

export interface RoadInput {
  anchor: { x: number; y: number };
  roomName: string;
  /** Sources, controller, mineral, and a representative exit per side. */
  destinations: Array<{ x: number; y: number }>;
  /** Structure tiles (packed x*50+y) — impassable for roads. */
  blocked: Set<number>;
  /** Already-planned road tiles (packed) — preferred (cost 1), not re-emitted. */
  existingRoads: Set<number>;
  terrain: TerrainLike;
}

export function planRoads(input: RoadInput): Array<{ x: number; y: number }> {
  const { anchor, roomName, destinations, blocked, existingRoads } = input;
  if (typeof PathFinder === 'undefined' || typeof RoomPosition === 'undefined') return [];

  const cm = new PathFinder.CostMatrix();
  for (const packed of blocked) cm.set(Math.floor(packed / 50), packed % 50, 255);
  for (const packed of existingRoads) cm.set(Math.floor(packed / 50), packed % 50, 1);

  const added = new Set<number>();
  const origin = new RoomPosition(anchor.x, anchor.y, roomName);
  for (const d of destinations) {
    const res = PathFinder.search(
      origin,
      { pos: new RoomPosition(d.x, d.y, roomName), range: 1 },
      {
        plainCost: 2,
        swampCost: 10,
        maxOps: 4000,
        roomCallback: (rn: string) => (rn === roomName ? cm : false),
      },
    );
    if (res.incomplete) continue; // unreachable target → skip its road, not fatal
    for (const step of res.path) {
      const key = step.x * 50 + step.y;
      if (blocked.has(key) || existingRoads.has(key) || added.has(key)) continue;
      added.add(key);
      cm.set(step.x, step.y, 1); // subsequent paths reuse this road
    }
  }

  return [...added].map((key) => ({ x: Math.floor(key / 50), y: key % 50 }));
}

// --- pure pathfinder (SV2) --------------------------------------------------
//
// A plain Dijkstra (uniform-cost search) over the 50×50 grid with the SAME cost
// model as the in-game PathFinder above: plain=2, swamp=10, planned road=1,
// planned structure tile (`blocked`)=impassable; 8-directional movement; the
// cost paid is the cost of ENTERING a tile (the origin tile is free), so the
// behaviour matches `PathFinder.search` for road planning. No `PathFinder`,
// `RoomPosition`, `Game` or any Screeps runtime — only the `TERRAIN_MASK_WALL`
// and `TERRAIN_MASK_SWAMP` constants. Deterministic: ties broken by lower packed
// coord, so the same inputs always yield the same path.

const SIZE = 50;
const ROAD_COST = 1;
const PLAIN_COST = 2;
const SWAMP_COST = 10;
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const inBounds = (x: number, y: number): boolean => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

/**
 * Cost to ENTER (x, y): a planned road is 1, swamp 10, plain 2; a blocked
 * (planned-structure) or natural-wall tile is impassable (returns null).
 */
function enterCost(
  x: number,
  y: number,
  terrain: TerrainLike,
  blocked: Set<number>,
  roads: Set<number>,
): number | null {
  const key = x * SIZE + y;
  if (roads.has(key)) return ROAD_COST;
  if (blocked.has(key)) return null;
  const t = terrain.get(x, y);
  if (t === TERRAIN_MASK_WALL) return null;
  return t === TERRAIN_MASK_SWAMP ? SWAMP_COST : PLAIN_COST;
}

/**
 * Cheapest path (inclusive of origin and the reached goal tile) from `origin` to
 * within Chebyshev `range` of `goal`, or `null` if unreachable. Pure Dijkstra
 * with a binary-heap-free sorted frontier (the grid is small). The origin tile
 * is always walkable as a start even if it holds a structure (mirrors the
 * in-game PathFinder, which starts ON the anchor's spawn tile).
 */
export function findPath(
  origin: { x: number; y: number },
  goal: { x: number; y: number },
  terrain: TerrainLike,
  blocked: Set<number>,
  roads: Set<number>,
  range = 1,
): Array<{ x: number; y: number }> | null {
  const reachesGoal = (x: number, y: number): boolean =>
    Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y)) <= range;

  const dist = new Float64Array(SIZE * SIZE).fill(Infinity);
  const prev = new Int32Array(SIZE * SIZE).fill(-1);
  const visited = new Uint8Array(SIZE * SIZE);
  const start = origin.x * SIZE + origin.y;
  dist[start] = 0;

  // Frontier as a simple array scanned for the min — fine for a 2500-node grid
  // and fully deterministic (ties resolve to the lower packed coord).
  const frontier = new Set<number>([start]);

  let goalNode = -1;
  while (frontier.size) {
    // Pop the min-distance node (lowest packed coord breaks ties → deterministic).
    let u = -1;
    let best = Infinity;
    for (const n of frontier) {
      if (dist[n] < best || (dist[n] === best && n < u)) {
        best = dist[n];
        u = n;
      }
    }
    frontier.delete(u);
    if (visited[u]) continue;
    visited[u] = 1;

    const ux = Math.floor(u / SIZE);
    const uy = u % SIZE;
    if (reachesGoal(ux, uy)) {
      goalNode = u;
      break;
    }

    for (const [dx, dy] of NEIGHBOURS) {
      const nx = ux + dx;
      const ny = uy + dy;
      if (!inBounds(nx, ny)) continue;
      const nk = nx * SIZE + ny;
      if (visited[nk]) continue;
      const c = enterCost(nx, ny, terrain, blocked, roads);
      if (c === null) continue;
      const nd = dist[u] + c;
      if (nd < dist[nk]) {
        dist[nk] = nd;
        prev[nk] = u;
        frontier.add(nk);
      }
    }
  }

  if (goalNode < 0) return null;

  const path: Array<{ x: number; y: number }> = [];
  for (let n = goalNode; n !== -1; n = prev[n]) {
    path.push({ x: Math.floor(n / SIZE), y: n % SIZE });
  }
  path.reverse();
  return path;
}

/** True iff `goal` is reachable from `origin` over the cost model (pure). */
export function isReachable(
  origin: { x: number; y: number },
  goal: { x: number; y: number },
  terrain: TerrainLike,
  blocked: Set<number>,
  roads: Set<number>,
  range = 1,
): boolean {
  return findPath(origin, goal, terrain, blocked, roads, range) !== null;
}

/**
 * Pure variant of `planRoads` (SV2): Dijkstra instead of the in-game PathFinder.
 * Same lane-reuse behaviour — each routed path's new tiles become cost-1 roads
 * for subsequent paths, so the network shares lanes. The origin (anchor) tile
 * and any `blocked`/`existingRoads` tiles along a path are never emitted.
 */
export function planRoadsPure(input: RoadInput): Array<{ x: number; y: number }> {
  const { anchor, destinations, blocked, existingRoads, terrain } = input;
  // Working road set grows as lanes are committed (so later paths reuse them).
  const roads = new Set<number>(existingRoads);
  const added = new Set<number>();
  for (const d of destinations) {
    const path = findPath(anchor, d, terrain, blocked, roads);
    if (!path) continue; // unreachable target → skip its road, not fatal
    for (const step of path) {
      const key = step.x * SIZE + step.y;
      if (blocked.has(key) || existingRoads.has(key)) continue;
      if (!added.has(key)) added.add(key);
      roads.add(key); // subsequent paths reuse this lane (cost 1)
    }
  }
  return [...added].map((key) => ({ x: Math.floor(key / SIZE), y: key % SIZE }));
}
