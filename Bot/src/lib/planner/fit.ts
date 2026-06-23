/**
 * Adaptive base fitter (STAMP.md §4) — the fallback that places the full bunker
 * structure set around an EXISTING (often legacy-built) base in a room too closed
 * for the rigid `bunkerStructures` stamp.
 *
 * This is the adaptive replacement for the `bunkerStructures(anchor)` step ONLY.
 * It does NOT do roads, min-cut ramparts, or derived source/controller/mineral
 * links/containers/extractors — `plan.ts` wires those in afterward, exactly as it
 * does for the stamp path. The fitter's job is: incorporate what's already built,
 * then place the MISSING core/labs/extensions compactly around it.
 *
 * Forward-compat (STAMP.md §11): a PURE, DETERMINISTIC, re-runnable function — no
 * `Game`, `PathFinder`, `RoomPosition`, `RoomVisual` or hidden global state. Same
 * inputs → identical output, so the future server-side port and on-demand replan
 * are drop-in.
 */
import type { TerrainLike } from './distanceTransform';
import { idx } from './distanceTransform';
import { tileFits, bunkerFragments, type Fragment } from './stamp';
import type { PlannedStructure } from './types';

/** Structure types that, when they already exist, anchor the build-mass centroid. */
const CORE_TYPES = new Set<BuildableStructureConstant>([
  STRUCTURE_SPAWN,
  STRUCTURE_STORAGE,
  STRUCTURE_TOWER,
  STRUCTURE_TERMINAL,
]);

/**
 * Types the fitter EMITS into `plan.structures` (everything the plan tracks and
 * `encodePlan` can serialize). Roads live in `plan.roads`, ramparts in
 * `plan.ramparts`, and constructed walls aren't in the plan's TYPES table — all
 * three are kept OCCUPIED (so nothing is built on top of them) but must NOT land
 * in `plan.structures` or `encodePlan` would emit a `-1` type index. Containers
 * and the extractor ARE emitted so existing ones are preserved; `plan.ts` dedups
 * its derived containers/extractor against them.
 */
const EMITTABLE = new Set<BuildableStructureConstant>([
  STRUCTURE_SPAWN,
  STRUCTURE_STORAGE,
  STRUCTURE_TERMINAL,
  STRUCTURE_TOWER,
  STRUCTURE_LINK,
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_FACTORY,
  STRUCTURE_NUKER,
  STRUCTURE_OBSERVER,
  STRUCTURE_LAB,
  STRUCTURE_EXTENSION,
  STRUCTURE_CONTAINER,
  STRUCTURE_EXTRACTOR,
]);

/** RCL fallback for emittable types not present in any bunker fragment. */
const DEFAULT_RCL: Partial<Record<BuildableStructureConstant, number>> = {
  [STRUCTURE_CONTAINER]: 2,
  [STRUCTURE_EXTRACTOR]: 6,
};

export interface FitInput {
  terrain: TerrainLike;
  /** distanceTransform(terrain) — the Chebyshev openness map. */
  openness: Uint8Array;
  /** Existing spawn = anchor seed. Null → fall back to core centroid / openness peak. */
  spawn: { x: number; y: number } | null;
  /** Existing structures (ours + blocking) — fixed, occupied, counted toward targets. */
  existing: Array<{ x: number; y: number; type: BuildableStructureConstant }>;
  sources: Array<{ x: number; y: number }>;
  controller: { x: number; y: number } | null;
  mineral: { x: number; y: number } | null;
  /** Existing storage if present (for tagging the nearest 'core' link). */
  storagePos?: { x: number; y: number } | null;
}

export interface FitResult {
  anchor: { x: number; y: number };
  structures: PlannedStructure[];
}

const pack = (x: number, y: number): number => x * 50 + y;
const cheb = (ax: number, ay: number, bx: number, by: number): number =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const clampBound = (v: number): number => (v < 2 ? 2 : v > 47 ? 47 : v);

/**
 * Pick the anchor seed (STAMP.md §4b):
 * 1. the existing spawn; else
 * 2. the centroid of existing core-type structures (spawn/storage/tower/terminal); else
 * 3. the openness peak (largest distance-transform value, ties broken by x then y).
 * The chosen tile is clamped into the placeable interior [2,47].
 */
function pickAnchor(input: FitInput): { x: number; y: number } {
  if (input.spawn) return { x: clampBound(input.spawn.x), y: clampBound(input.spawn.y) };

  const cores = input.existing.filter((s) => CORE_TYPES.has(s.type));
  if (cores.length) {
    let sx = 0;
    let sy = 0;
    for (const c of cores) {
      sx += c.x;
      sy += c.y;
    }
    return { x: clampBound(Math.round(sx / cores.length)), y: clampBound(Math.round(sy / cores.length)) };
  }

  // Openness peak.
  let best = { x: 25, y: 25 };
  let bestV = -1;
  for (let x = 2; x <= 47; x++) {
    for (let y = 2; y <= 47; y++) {
      const v = input.openness[idx(x, y)];
      if (v > bestV) {
        bestV = v;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * Build the blocked-tile predicate: each key position (source, controller,
 * mineral) plus its 8-neighbours, so the base never buries them. The terrain
 * UNDER these reads as wall (Screeps quirk) — that's why they come from `input`,
 * not the terrain mask.
 */
function makeIsBlocked(input: FitInput): (x: number, y: number) => boolean {
  const blocked = new Set<number>();
  const addRing = (p: { x: number; y: number }): void => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) blocked.add(pack(p.x + dx, p.y + dy));
  };
  for (const s of input.sources) addRing(s);
  if (input.controller) addRing(input.controller);
  if (input.mineral) addRing(input.mineral);
  return (x: number, y: number): boolean => blocked.has(pack(x, y));
}

/**
 * Tag an existing LINK by role from its adjacency (STAMP.md §4c):
 *   controller-adjacent → 'controller', source-adjacent → 'source',
 *   else the nearest storage (or anchor) → 'core'.
 * The 'core' tag goes only to the single link closest to storage/anchor so we
 * don't promote every otherwise-untagged link. Mutates `links` in place.
 */
function tagExistingLinks(links: PlannedStructure[], input: FitInput, anchor: { x: number; y: number }): void {
  if (!links.length) return;
  const ref = input.storagePos ?? anchor;
  let coreLink: PlannedStructure | null = null;
  let coreD = Infinity;
  for (const l of links) {
    if (input.controller && cheb(l.x, l.y, input.controller.x, input.controller.y) === 1) {
      l.role = 'controller';
      continue;
    }
    if (input.sources.some((src) => cheb(l.x, l.y, src.x, src.y) === 1)) {
      l.role = 'source';
      continue;
    }
    const d = cheb(l.x, l.y, ref.x, ref.y);
    if (d < coreD) {
      coreD = d;
      coreLink = l;
    }
  }
  if (coreLink && !coreLink.role) coreLink.role = 'core';
}

/**
 * Place `count` tiles of `spec` near `center`, scanning the room and ranking
 * candidates deterministically by (parity match, openness desc, Chebyshev to the
 * anchor asc, x asc, y asc). For non-splittable fragments, candidates are limited
 * to a Chebyshev `maxSpread` window around `center` so the cluster stays compact.
 *
 * Returns the placed structures; mutates `occupied` so later placements avoid
 * these tiles. May return fewer than `count` if the room can't host them.
 */
function placeNear(
  specs: Array<{ type: BuildableStructureConstant; rcl: number }>,
  center: { x: number; y: number },
  anchor: { x: number; y: number },
  parity: number,
  spread: number | null, // null = whole room (splittable spill)
  terrain: TerrainLike,
  openness: Uint8Array,
  occupied: Set<number>,
  isBlocked: (x: number, y: number) => boolean,
): PlannedStructure[] {
  if (!specs.length) return [];

  const x1 = spread === null ? 2 : clampBound(center.x - spread);
  const x2 = spread === null ? 47 : clampBound(center.x + spread);
  const y1 = spread === null ? 2 : clampBound(center.y - spread);
  const y2 = spread === null ? 47 : clampBound(center.y + spread);

  // Gather every usable tile in the window, then rank once (stable/deterministic).
  const cands: Array<{ x: number; y: number; open: number; d: number; par: number }> = [];
  for (let x = x1; x <= x2; x++) {
    for (let y = y1; y <= y2; y++) {
      if (occupied.has(pack(x, y))) continue;
      if (!tileFits(x, y, terrain, isBlocked)) continue;
      cands.push({
        x,
        y,
        open: openness[idx(x, y)],
        d: cheb(x, y, anchor.x, anchor.y),
        par: ((x + y) & 1) === parity ? 0 : 1, // 0 = preferred (anchor) parity
      });
    }
  }
  cands.sort(
    (a, b) =>
      a.par - b.par || // anchor-parity (walkable checkerboard) first
      b.open - a.open || // most open next
      a.d - b.d || // closest to the anchor
      a.x - b.x ||
      a.y - b.y,
  );

  const placed: PlannedStructure[] = [];
  let ci = 0;
  for (const spec of specs) {
    while (ci < cands.length && occupied.has(pack(cands[ci].x, cands[ci].y))) ci++;
    if (ci >= cands.length) break; // window exhausted
    const c = cands[ci++];
    occupied.add(pack(c.x, c.y));
    placed.push({ x: c.x, y: c.y, type: spec.type, rcl: spec.rcl });
  }
  return placed;
}

/**
 * Choose the best compact pocket centre for a non-splittable fragment. Scans
 * candidate centres in a Chebyshev `searchRadius` ring around the anchor and, for
 * each, counts the usable (free, fitting, anchor-parity) tiles within `maxSpread`.
 * Picks the centre that can host the MOST of the fragment (capped at `need`),
 * breaking ties by proximity to the anchor then x/y, so labs/core slide to a free
 * adjacent pocket instead of stacking on the same anchor-centred window the core
 * already drained. Deterministic. Returns the anchor itself if nothing is freer.
 */
function bestPocketCenter(
  need: number,
  maxSpread: number,
  anchor: { x: number; y: number },
  parity: number,
  terrain: TerrainLike,
  occupied: Set<number>,
  isBlocked: (x: number, y: number) => boolean,
): { x: number; y: number } {
  const searchRadius = maxSpread + 2; // how far the pocket centre may drift
  let best = { x: anchor.x, y: anchor.y };
  let bestCapacity = -1;
  let bestD = Infinity;
  for (let cx = clampBound(anchor.x - searchRadius); cx <= clampBound(anchor.x + searchRadius); cx++) {
    for (let cy = clampBound(anchor.y - searchRadius); cy <= clampBound(anchor.y + searchRadius); cy++) {
      let capacity = 0;
      for (let x = clampBound(cx - maxSpread); x <= clampBound(cx + maxSpread); x++) {
        for (let y = clampBound(cy - maxSpread); y <= clampBound(cy + maxSpread); y++) {
          if (((x + y) & 1) !== parity) continue; // count only walkable-checkerboard tiles
          if (occupied.has(pack(x, y))) continue;
          if (!tileFits(x, y, terrain, isBlocked)) continue;
          capacity++;
          if (capacity >= need) break;
        }
        if (capacity >= need) break;
      }
      const d = cheb(cx, cy, anchor.x, anchor.y);
      // Prefer more capacity; tie-break by closeness to the anchor then x/y.
      if (capacity > bestCapacity || (capacity === bestCapacity && (d < bestD || (d === bestD && (cx < best.x || (cx === best.x && cy < best.y)))))) {
        bestCapacity = capacity;
        bestD = d;
        best = { x: cx, y: cy };
      }
    }
  }
  return best;
}

/**
 * Place the missing tiles for one fragment. Existing structures of the
 * fragment's types already count toward the target (subtracted before we get
 * here), so `specs` is only the remainder. Non-splittable fragments pick the best
 * compact pocket near the anchor (so labs/core don't stack on the same drained
 * window) and stay inside one `maxSpread` cluster; splittable fragments try a
 * `maxSpread` window then spill into the whole room for any remainder.
 */
function placeFragment(
  fragment: Fragment,
  specs: Array<{ type: BuildableStructureConstant; rcl: number }>,
  anchor: { x: number; y: number },
  parity: number,
  terrain: TerrainLike,
  openness: Uint8Array,
  occupied: Set<number>,
  isBlocked: (x: number, y: number) => boolean,
): PlannedStructure[] {
  if (!specs.length) return [];

  // For coupled (non-splittable) fragments, find the freest compact pocket near
  // the anchor so the cluster doesn't collide with an earlier tier's placements.
  const center = fragment.splittable
    ? anchor
    : bestPocketCenter(specs.length, fragment.maxSpread, anchor, parity, terrain, occupied, isBlocked);

  const placed = placeNear(
    specs,
    center,
    anchor,
    parity,
    fragment.maxSpread,
    terrain,
    openness,
    occupied,
    isBlocked,
  );

  // Splittable fragments (extensions) may spill beyond the compact window into
  // nearby pockets for whatever didn't fit. Coupled fragments (labs/core) never
  // spill — staying clustered is a hard invariant.
  if (fragment.splittable && placed.length < specs.length) {
    const rest = specs.slice(placed.length);
    placed.push(...placeNear(rest, anchor, anchor, parity, null, terrain, openness, occupied, isBlocked));
  }
  return placed;
}

/**
 * Adaptively place the full bunker structure set around the existing base.
 * Returns `{ anchor, structures }`, where `structures` is the existing builds
 * (emitted as-is, links role-tagged) followed by the newly-placed missing core,
 * labs and extensions. Returns `null` only if the essential core can't be placed
 * (e.g. no room for even one spawn) — rare.
 */
export function fitStructures(input: FitInput): FitResult | null {
  const { terrain, openness } = input;
  const anchor = pickAnchor(input);
  const parity = (anchor.x + anchor.y) & 1;
  const isBlocked = makeIsBlocked(input);

  // 1. Occupied map + existing per-type counts (every existing tile is fixed).
  const occupied = new Set<number>();
  const existingCount: Partial<Record<BuildableStructureConstant, number>> = {};
  const out: PlannedStructure[] = [];
  for (const s of input.existing) {
    occupied.add(pack(s.x, s.y));
    existingCount[s.type] = (existingCount[s.type] ?? 0) + 1;
  }

  // 2. Emit existing structures first, as-is. Pick a sensible rcl from each
  //    type's spec (so re-encoding/summaries stay sane); links get role tags.
  const fragments = bunkerFragments();
  const rclForType = new Map<BuildableStructureConstant, number>();
  for (const f of fragments) for (const spec of f.specs) if (!rclForType.has(spec.type)) rclForType.set(spec.type, spec.rcl);
  for (const s of input.existing) {
    if (!EMITTABLE.has(s.type)) continue; // roads/ramparts/walls: occupied (step 1), not emitted
    out.push({ x: s.x, y: s.y, type: s.type, rcl: rclForType.get(s.type) ?? DEFAULT_RCL[s.type] ?? 1 });
  }
  tagExistingLinks(out.filter((s) => s.type === STRUCTURE_LINK), input, anchor);

  // 3. Place the MISSING structures per fragment, in tier order labs already
  //    clustered tight → core → extensions (the fragment list order is
  //    labs, core, extensions; we walk core first so the hub lands centrally,
  //    then labs beside it, then extensions spill out).
  const order: Fragment['tier'][] = ['core', 'labs', 'extensions'];
  const byTier = new Map(fragments.map((f) => [f.tier, f]));

  // Per-type "already satisfied by an existing build" budget, consumed as we walk
  // fragment specs. Each type lives in exactly one fragment, so a single shared
  // budget can't be over-spent across tiers.
  const skip: Partial<Record<BuildableStructureConstant, number>> = { ...existingCount };

  let placedSpawn = false;
  for (const tier of order) {
    const fragment = byTier.get(tier);
    if (!fragment) continue;

    // Missing specs = fragment target minus what's already built of that type.
    const missing: Array<{ type: BuildableStructureConstant; rcl: number }> = [];
    for (const spec of fragment.specs) {
      if ((skip[spec.type] ?? 0) > 0) {
        skip[spec.type] = (skip[spec.type] ?? 0) - 1; // this target already built
        continue;
      }
      missing.push(spec);
    }

    const placed = placeFragment(fragment, missing, anchor, parity, terrain, openness, occupied, isBlocked);
    out.push(...placed);
    if (placed.some((s) => s.type === STRUCTURE_SPAWN)) placedSpawn = true;
  }

  // Essential core check: at least one spawn must exist or have been placed.
  const haveSpawn = placedSpawn || (input.existing.some((s) => s.type === STRUCTURE_SPAWN));
  if (!haveSpawn) return null;

  return { anchor, structures: out };
}
