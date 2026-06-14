/**
 * Construction manager — interval- and bucket-gated by the caller. Minimal
 * base plan: a container at each source, a tower as soon as RCL allows, then
 * extensions in a checkerboard ring around the spawn, then roads along the
 * spawn→source/controller paths. The ring placement is the base-plan stub the
 * strategic layer can later replace with a real layout.
 */
import { SETTINGS } from '../settings';
import { log } from '../lib/log';

export function runConstruction(room: Room): void {
  const controller = room.controller;
  if (!controller?.my) return;
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;

  let budget = SETTINGS.MAX_SITES_PER_ROOM - room.find(FIND_MY_CONSTRUCTION_SITES).length;
  if (budget <= 0) return;

  budget -= placeSourceContainers(room, spawn, budget);
  if (budget > 0) budget -= placeRing(room, spawn, STRUCTURE_TOWER, controller.level, budget);
  if (budget > 0) budget -= placeRing(room, spawn, STRUCTURE_EXTENSION, controller.level, budget);
  if (budget > 0 && controller.level >= 2) placeRoads(room, spawn, budget);
}

function placeSourceContainers(room: Room, spawn: StructureSpawn, budget: number): number {
  let placed = 0;
  for (const source of room.find(FIND_SOURCES)) {
    if (placed >= budget) break;
    const existing =
      source.pos.findInRange(FIND_STRUCTURES, 1, { filter: (s) => s.structureType === STRUCTURE_CONTAINER })
        .length +
      source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      }).length;
    if (existing) continue;
    // Put the container on the spawn-side approach tile so haulers walk less.
    const path = spawn.pos.findPathTo(source.pos, { ignoreCreeps: true });
    const step = [...path]
      .reverse()
      .find((p) => Math.max(Math.abs(p.x - source.pos.x), Math.abs(p.y - source.pos.y)) === 1);
    if (!step) continue;
    if (room.createConstructionSite(step.x, step.y, STRUCTURE_CONTAINER) === OK) {
      placed++;
      log.info(`construction: container site at (${step.x},${step.y}) for source in ${room.name}`);
    }
  }
  return placed;
}

function placeRing(
  room: Room,
  spawn: StructureSpawn,
  type: typeof STRUCTURE_EXTENSION | typeof STRUCTURE_TOWER,
  rcl: number,
  budget: number,
): number {
  const allowed = CONTROLLER_STRUCTURES[type][rcl] ?? 0;
  const existing =
    room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === type }).length +
    room.find(FIND_MY_CONSTRUCTION_SITES, { filter: (s) => s.structureType === type }).length;
  let need = Math.min(allowed - existing, budget);
  if (need <= 0) return 0;

  const terrain = room.getTerrain();
  const avoid = room.find(FIND_SOURCES).map((s) => s.pos);
  if (room.controller) avoid.push(room.controller.pos);

  let placed = 0;
  for (let radius = 2; radius <= 6 && placed < need; radius++) {
    for (let dx = -radius; dx <= radius && placed < need; dx++) {
      for (let dy = -radius; dy <= radius && placed < need; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = spawn.pos.x + dx;
        const y = spawn.pos.y + dy;
        if ((x + y) % 2 !== 0) continue; // checkerboard keeps walking lanes open
        if (!isBuildable(room, x, y, terrain)) continue;
        if (avoid.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) <= 1)) continue;
        if (room.createConstructionSite(x, y, type) === OK) placed++;
      }
    }
  }
  if (placed) log.info(`construction: ${placed} ${type} site(s) in ${room.name}`);
  return placed;
}

function placeRoads(room: Room, spawn: StructureSpawn, budget: number): number {
  const mem = room.memory;
  const rcl = room.controller?.level ?? 0;
  if (
    mem.roadsPlannedAt &&
    mem.roadsPlannedRcl === rcl &&
    Game.time - mem.roadsPlannedAt < SETTINGS.ROAD_REPLAN_INTERVAL
  ) {
    return 0;
  }

  const targets: RoomPosition[] = room.find(FIND_SOURCES).map((s) => s.pos);
  if (room.controller) targets.push(room.controller.pos);

  let placed = 0;
  for (const target of targets) {
    const path = spawn.pos.findPathTo(target, { ignoreCreeps: true, range: 1 });
    for (const step of path) {
      if (placed >= budget) break;
      const occupied =
        room.lookForAt(LOOK_STRUCTURES, step.x, step.y).length > 0 ||
        room.lookForAt(LOOK_CONSTRUCTION_SITES, step.x, step.y).length > 0;
      if (occupied) continue;
      if (room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD) === OK) placed++;
    }
  }
  // Only mark the pass complete if the budget didn't cut it short.
  if (placed < budget) {
    mem.roadsPlannedAt = Game.time;
    mem.roadsPlannedRcl = rcl;
  }
  if (placed) log.info(`construction: ${placed} road site(s) in ${room.name}`);
  return placed;
}

function isBuildable(room: Room, x: number, y: number, terrain: RoomTerrain): boolean {
  if (x < 2 || x > 47 || y < 2 || y > 47) return false;
  if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  if (room.lookForAt(LOOK_STRUCTURES, x, y).length) return false;
  if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) return false;
  return true;
}
