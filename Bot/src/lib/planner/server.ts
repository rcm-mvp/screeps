/**
 * Pure server-side planner entry (STAMP.md §12, SV4).
 *
 * The Strategist bundles THIS module with esbuild — Screeps constants injected
 * via `define` (Node has no game globals) — and calls `planForServer` to compute
 * a base plan on the box's CPU, then writes the packed result to RawMemory
 * segment 90. The in-game bot decodes that exact wire format via `getCachedPlan`.
 *
 * Everything reachable from here is PURE: `buildPlan` (no Game/Room/PathFinder/
 * RawMemory) + `encodePlan` (the shared wire format) + the PLAN_VERSION constant.
 * The Room-coupled functions in plan.ts (computePlan/getCachedPlan/planRoom) are
 * NOT reachable from this entry, so esbuild tree-shakes them out of the bundle.
 */
import { buildPlan, type BuildPlanInput } from './core';
import { encodePlan } from './plan';
import { SETTINGS } from '../../settings';
import type { PackedPlan } from './types';

export type { BuildPlanInput } from './core';
export type { PackedPlan, RoomPlan } from './types';

/** The plan schema version the in-game bot expects; the server stamps the same. */
export const PLAN_VERSION = SETTINGS.PLAN_VERSION;

/**
 * Compute + pack a base plan for ONE room, server-side. The fitter is always on
 * (the server owns the heavy adaptive fit — that's the whole point). `at` stamps
 * the plan's provenance tick (the server has no Game.time; pass the colony's
 * current tick). Returns null only when the room admits no plan at all (no anchor
 * even with the fitter) — caller should leave the room unflagged-as-done.
 */
export function planForServer(input: BuildPlanInput, at = 0): PackedPlan | null {
  const plan = buildPlan(input);
  if (!plan) return null;
  plan.v = PLAN_VERSION;
  plan.at = at;
  return encodePlan(plan);
}
