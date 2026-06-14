/**
 * Energy acquisition for worker creeps (upgrader/builder): dropped piles,
 * tombstones/ruins, containers, storage — harvesting a source only as the
 * last resort so workers don't crowd out miners.
 */
import { travelTo } from './movement';

type PickupTarget = Resource | Tombstone | Ruin | StructureContainer | StructureStorage;

/** Flips the gather/deliver flag at empty/full and clears the cached target. */
export function updateWorkingFlag(creep: Creep): boolean {
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    delete creep.memory.target;
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    delete creep.memory.target;
  }
  return creep.memory.working;
}

function usable(obj: PickupTarget | null): obj is PickupTarget {
  if (!obj) return false;
  if (obj instanceof Resource) return obj.resourceType === RESOURCE_ENERGY && obj.amount >= 20;
  return obj.store[RESOURCE_ENERGY] > 0;
}

export function acquireEnergy(creep: Creep, allowHarvest: boolean): void {
  let target = creep.memory.target
    ? Game.getObjectById(creep.memory.target as Id<PickupTarget>)
    : null;
  if (!usable(target)) {
    delete creep.memory.target;
    target = findPickup(creep);
    if (target) creep.memory.target = target.id;
  }

  if (target) {
    const result = target instanceof Resource ? creep.pickup(target) : creep.withdraw(target, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
      travelTo(creep, target);
      return;
    }
    delete creep.memory.target; // done (or failed) — re-resolve next tick
    return;
  }

  if (allowHarvest) {
    const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (source && creep.harvest(source) === ERR_NOT_IN_RANGE) travelTo(creep, source);
  }
}

function findPickup(creep: Creep): PickupTarget | null {
  const room = creep.room;
  const candidates: PickupTarget[] = [];
  for (const res of room.find(FIND_DROPPED_RESOURCES)) {
    if (res.resourceType === RESOURCE_ENERGY && res.amount >= 50) candidates.push(res);
  }
  for (const tomb of room.find(FIND_TOMBSTONES)) {
    if (tomb.store[RESOURCE_ENERGY] > 0) candidates.push(tomb);
  }
  for (const ruin of room.find(FIND_RUINS)) {
    if (ruin.store[RESOURCE_ENERGY] > 0) candidates.push(ruin);
  }
  for (const s of room.find(FIND_STRUCTURES)) {
    if (s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] >= 50) candidates.push(s);
    else if (s.structureType === STRUCTURE_STORAGE && s.store[RESOURCE_ENERGY] > 0) candidates.push(s);
  }
  return creep.pos.findClosestByRange(candidates);
}
