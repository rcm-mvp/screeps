/** Helpers shared across roles. */
import { travelTo, travelToRoom } from '../lib/movement';
import { roomHeap } from '../heap';

/** True if the creep is in its home room; otherwise walks it home. */
export function atHome(creep: Creep): boolean {
  if (creep.room.name === creep.memory.home) return true;
  travelToRoom(creep, creep.memory.home);
  return false;
}

/**
 * Sticky source assignment, balanced across same-role colony mates.
 * `exclusive` (miners) refuses to share a source.
 */
export function assignedSource(creep: Creep, exclusive: boolean): Source | null {
  if (creep.memory.src) {
    const source = Game.getObjectById(creep.memory.src);
    if (source) return source;
    delete creep.memory.src;
  }

  const room = Game.rooms[creep.memory.home] ?? creep.room;
  const sources = room.find(FIND_SOURCES);
  if (!sources.length) return null;

  const counts: Record<string, number> = {};
  for (const name in Game.creeps) {
    const other = Game.creeps[name];
    if (other.name === creep.name) continue;
    if (other.memory.role !== creep.memory.role || other.memory.home !== creep.memory.home) continue;
    if (other.memory.src) counts[other.memory.src] = (counts[other.memory.src] ?? 0) + 1;
  }

  let best: Source | null = null;
  let bestCount = Infinity;
  for (const source of sources) {
    const n = counts[source.id] ?? 0;
    if (exclusive && n > 0) continue;
    if (n < bestCount) {
      best = source;
      bestCount = n;
    }
  }
  if (best) creep.memory.src = best.id;
  return best;
}

/** Where a harvester drops its load: spawn/extensions, then towers, then
 *  storage. Reads from the logistics heap snapshot (Q4 fix — avoids
 *  duplicating room.find() calls every tick that runLogistics already did). */
export function findDeliveryTarget(creep: Creep): AnyStoreStructure | null {
  const rh = roomHeap(creep.room.name);
  // The heap entry is valid for the current tick (logistics runs before
  // creeps). If it's stale (e.g. logistics was skipped due to bucket critical),
  // fall back to the direct find.
  if (rh.tick === Game.time) {
    for (const group of [rh.fillsCore, rh.fillsTower]) {
      const targets: AnyStoreStructure[] = [];
      for (const id of group) {
        const s = Game.getObjectById(id as Id<AnyStoreStructure>);
        if (s && (s.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0) targets.push(s);
      }
      const closest = creep.pos.findClosestByRange(targets);
      if (closest) return closest;
    }
    if (rh.sink) {
      const storage = Game.getObjectById(rh.sink as Id<StructureStorage>);
      if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return storage;
    }
    return null;
  }

  // Fallback: direct find (logistics didn't run this tick).
  const room = creep.room;
  const core = room.find(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  }) as AnyStoreStructure[];
  const closest = creep.pos.findClosestByRange(core);
  if (closest) return closest;

  const towers = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 100,
  }) as AnyStoreStructure[];
  const tower = creep.pos.findClosestByRange(towers);
  if (tower) return tower;

  if (room.storage && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
  return null;
}

/** Park near the home spawn without blocking it. */
export function rally(creep: Creep): void {
  const room = Game.rooms[creep.memory.home];
  const spawn = room?.find(FIND_MY_SPAWNS)[0];
  if (spawn && !creep.pos.inRangeTo(spawn, 3)) travelTo(creep, spawn, 3);
}
