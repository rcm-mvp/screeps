/**
 * Road planner. Paths from the anchor to each source, the controller, the
 * mineral and the exits over the plan's cost matrix (planned structures are
 * impassable, already-planned roads cost 1), and returns the road tiles along
 * those paths. Later paths reuse earlier roads, so the network shares lanes.
 *
 * Uses the in-game `PathFinder`; degrades to `[]` when it is unavailable (e.g.
 * the unit harness), so callers needn't mock it. Traffic-weighting is a later
 * tuning knob — see lib/traffic.ts's CostMatrix parameter.
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
