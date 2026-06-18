/**
 * Construction manager — interval- and bucket-gated by the caller. Reads the
 * cached base plan (lib/planner) and each tick places only the construction
 * sites the current RCL unlocks, in priority order, respecting the per-room and
 * account-wide (100) site caps and a per-tick cap.
 *
 * The plan itself is computed ONCE per room by the planner (distance transform
 * → anchor → bunker stamp → min-cut ramparts → roads), cached to a RawMemory
 * segment, and only recomputed on invalidation — never per tick.
 */
import { SETTINGS } from '../settings';
import { bucket } from '../lib/game';
import { log } from '../lib/log';
import { getCachedPlan, planRoom, invalidate, nextSites, summarize, drawPlan, type PlaceCtx } from '../lib/planner';
import type { RoomPlan } from '../lib/planner/types';

export function runConstruction(room: Room): void {
  const controller = room.controller;
  if (!controller?.my) return;
  if (!room.find(FIND_MY_SPAWNS).length) return; // a roomless of spawns can't build (expand seeds it externally)

  const plan = getCachedPlan(room);
  if (!plan) {
    // No cached plan (or a stale version). Planning is heavy (min-cut), so it's
    // gated behind a healthy bucket and runs at most once per room — defense is
    // never affected. Placement resumes next tick once the plan is cached.
    if (bucket() >= SETTINGS.PLAN_BUCKET) planRoom(room);
    return;
  }

  if (anchorBroken(room, plan)) {
    invalidate(room);
    return;
  }

  placeFromPlan(room, controller.level, plan);
  if (SETTINGS.PLAN_OVERLAY) drawPlan(room, plan);
}

/**
 * Replan only when the anchor is permanently unusable — a foreign/incompatible
 * structure sits on it. A *destroyed* anchor spawn just leaves the tile empty,
 * which `placeFromPlan` happily re-queues, so it isn't a replan trigger. (A
 * full replan is otherwise triggered by bumping SETTINGS.PLAN_VERSION.)
 */
function anchorBroken(room: Room, plan: RoomPlan): boolean {
  for (const s of room.lookForAt(LOOK_STRUCTURES, plan.anchor.x, plan.anchor.y)) {
    if (s.structureType === STRUCTURE_SPAWN) return false; // our anchor spawn — fine
    if (s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_ROAD) continue;
    return true; // something else claimed the anchor tile
  }
  return false;
}

function placeFromPlan(room: Room, rcl: number, plan: RoomPlan): void {
  const roomSites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  const globalSites = Object.keys(Game.constructionSites).length;
  const budget = Math.min(
    SETTINGS.PLACE_PER_TICK,
    SETTINGS.MAX_SITES_PER_ROOM - roomSites,
    SETTINGS.MAX_SITES_GLOBAL - globalSites,
  );

  // Refresh the progress summary even when the budget is spent (cheap; this
  // runs only every CONSTRUCTION_INTERVAL ticks).
  if (room.memory.plan) room.memory.plan.summary = summarize(room, plan);
  if (budget <= 0) return;

  // Index existing structures + sites once for O(1) presence/count lookups.
  const present = new Set<string>();
  const countByType: Record<string, number> = {};
  const tally = (x: number, y: number, t: string): void => {
    present.add(`${x},${y},${t}`);
    countByType[t] = (countByType[t] ?? 0) + 1;
  };
  for (const s of room.find(FIND_STRUCTURES)) tally(s.pos.x, s.pos.y, s.structureType);
  for (const cs of room.find(FIND_MY_CONSTRUCTION_SITES)) tally(cs.pos.x, cs.pos.y, cs.structureType);

  const ctx: PlaceCtx = {
    rcl,
    has: (x, y, t) => present.has(`${x},${y},${t}`),
    countOf: (t) => countByType[t] ?? 0,
    limitOf: (t, r) => CONTROLLER_STRUCTURES[t]?.[r] ?? 0,
    budget,
  };

  let placed = 0;
  for (const site of nextSites(plan, ctx)) {
    if (room.createConstructionSite(site.x, site.y, site.type) === OK) placed++;
  }
  if (placed) log.info(`construction: ${placed} site(s) from plan in ${room.name}`);
}
