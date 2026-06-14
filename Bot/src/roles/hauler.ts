/**
 * Hauler: moves energy from the logistics snapshot's pickups (source
 * containers, dropped piles, tombstones) into spawn/extensions, then towers,
 * then storage. Claims pickups on the heap so haulers spread out.
 */
import type { RoleContext } from './context';
import { roomHeap, type RoomHeapEntry } from '../heap';
import { travelTo } from '../lib/movement';
import { atHome, rally } from './common';

/** Haulers carry the economy — they push idle workers out of shared lanes. */
const HAULER_PRIORITY = 2;

type Pickup = Resource | Tombstone | Ruin | StructureContainer | StructureStorage;

export function runHauler(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;
  const rh = roomHeap(creep.memory.home);

  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    delete creep.memory.target;
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    delete creep.memory.target;
  }

  if (!creep.memory.working) {
    const target = resolvePickup(creep, rh);
    if (!target) {
      if (creep.store[RESOURCE_ENERGY] > 0) creep.memory.working = true; // deliver the partial load
      else rally(creep);
      return;
    }
    const result = target instanceof Resource ? creep.pickup(target) : creep.withdraw(target, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) travelTo(creep, target, 1, HAULER_PRIORITY);
    else delete creep.memory.target;
    return;
  }

  const sink = resolveFill(creep, rh);
  if (!sink) {
    rally(creep);
    return;
  }
  if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) travelTo(creep, sink, 1, HAULER_PRIORITY);
}

function resolvePickup(creep: Creep, rh: RoomHeapEntry): Pickup | null {
  const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);

  if (creep.memory.target) {
    const entry = rh.pickups.find((p) => p.id === creep.memory.target);
    const obj = entry ? Game.getObjectById(entry.id as Id<Pickup>) : null;
    if (entry && obj) {
      rh.claimed[entry.id] = (rh.claimed[entry.id] ?? 0) + free;
      return obj;
    }
    delete creep.memory.target;
  }

  const viable: Pickup[] = [];
  for (const p of rh.pickups) {
    if (p.amount - (rh.claimed[p.id] ?? 0) < Math.min(free, 50)) continue; // already spoken for
    const obj = Game.getObjectById(p.id as Id<Pickup>);
    if (obj) viable.push(obj);
  }
  const target = creep.pos.findClosestByRange(viable);
  if (target) {
    creep.memory.target = target.id;
    rh.claimed[target.id] = (rh.claimed[target.id] ?? 0) + free;
  }
  return target;
}

function resolveFill(creep: Creep, rh: RoomHeapEntry): AnyStoreStructure | null {
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
