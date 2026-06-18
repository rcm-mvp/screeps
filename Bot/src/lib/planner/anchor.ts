/**
 * Anchor selection. Pick the tile that best hosts the bunker: maximum openness
 * (so the stamp + rampart ring fit), at least `minClearance` from any wall/exit,
 * with the whole stamp landing on buildable terrain and every key position
 * (sources, controller, mineral) reachable from it. Ties broken toward the key
 * positions so roads stay short.
 *
 * Standard approach (distance-transform peak + constraint filter); our own code.
 */
import { idx, type TerrainLike } from './distanceTransform';
import { STAMP_RADIUS, stampFits } from './stamp';

export interface AnchorInput {
  /** Chebyshev openness map from distanceTransform(). */
  openness: Uint8Array;
  terrain: TerrainLike;
  /** Sources + controller (+ mineral) — used for scoring and the blocked zone. */
  keyPositions: Array<{ x: number; y: number }>;
  /** True iff every key position is reachable from (x, y). Inject PathFinder here. */
  reachable: (x: number, y: number) => boolean;
}

export interface AnchorOpts {
  /** Min openness (== min Chebyshev distance to any wall/exit). */
  minClearance: number;
  /** Cap on candidates whose stamp-fit + reachability we fully validate. */
  maxCandidates?: number;
}

/** Block the key positions and their 8-neighbours so the bunker can't bury them. */
function blockedZone(keyPositions: Array<{ x: number; y: number }>): Set<number> {
  const set = new Set<number>();
  for (const p of keyPositions) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set.add((p.x + dx) * 50 + (p.y + dy));
  }
  return set;
}

export function selectAnchor(input: AnchorInput, opts: AnchorOpts): { x: number; y: number } | null {
  const { openness, terrain, keyPositions, reachable } = input;
  const maxCandidates = opts.maxCandidates ?? 80;

  // Centroid of the key positions — closer anchors mean shorter roads.
  let cx = 25;
  let cy = 25;
  if (keyPositions.length) {
    cx = keyPositions.reduce((s, p) => s + p.x, 0) / keyPositions.length;
    cy = keyPositions.reduce((s, p) => s + p.y, 0) / keyPositions.length;
  }

  const lo = STAMP_RADIUS + 1;
  const hi = 48 - STAMP_RADIUS;
  const candidates: Array<{ x: number; y: number; score: number }> = [];
  for (let x = lo; x <= hi; x++) {
    for (let y = lo; y <= hi; y++) {
      const open = openness[idx(x, y)];
      if (open < opts.minClearance) continue;
      const distToCentroid = Math.abs(x - cx) + Math.abs(y - cy);
      // Openness dominates; centroid proximity (≤100) is the tie-breaker.
      candidates.push({ x, y, score: open * 100 - distToCentroid });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const blocked = blockedZone(keyPositions);
  const isBlocked = (x: number, y: number): boolean => blocked.has(x * 50 + y);

  let examined = 0;
  for (const c of candidates) {
    if (examined++ >= maxCandidates) break;
    if (!stampFits(c.x, c.y, terrain, isBlocked)) continue;
    if (!reachable(c.x, c.y)) continue;
    return { x: c.x, y: c.y };
  }
  return null;
}
