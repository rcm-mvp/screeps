/**
 * Hauler: moves energy from the logistics snapshot's pickups (source
 * containers, dropped piles, tombstones) into spawn/extensions, then towers,
 * then storage. Claims pickups on the heap so haulers spread out.
 *
 * Also moves minerals (mineral container → storage) as a low-priority
 * secondary: a hauler only touches minerals when it is NOT already carrying
 * energy AND no energy pickup is viable. Energy always wins; a trip never mixes
 * energy + minerals.
 */
import type { RoleContext } from './context';
import { roomHeap, type RoomHeapEntry, type LogisticsPickup } from '../heap';
import { travelTo } from '../lib/movement';
import { atHome, rally } from './common';

/** Haulers carry the economy — they push idle workers out of shared lanes. */
const HAULER_PRIORITY = 2;

type Pickup = Resource | Tombstone | Ruin | StructureContainer | StructureStorage;

export function runHauler(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;
  const rh = roomHeap(creep.memory.home);

  // Empty → collect; full → deliver. Generalized from energy-only to total used
  // capacity so a mineral load isn't mistaken for "empty" (which would loop).
  if (creep.memory.working && creep.store.getUsedCapacity() === 0) {
    creep.memory.working = false;
    delete creep.memory.target;
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    delete creep.memory.target;
  }

  if (!creep.memory.working) {
    const pick = resolvePickup(creep, rh);
    if (!pick) {
      if (creep.store.getUsedCapacity() > 0) creep.memory.working = true; // deliver the partial load
      else rally(creep);
      return;
    }
    const result =
      pick.target instanceof Resource ? creep.pickup(pick.target) : creep.withdraw(pick.target, pick.resourceType);
    if (result === ERR_NOT_IN_RANGE) travelTo(creep, pick.target, 1, HAULER_PRIORITY);
    else delete creep.memory.target;
    return;
  }

  // Delivering. Energy uses the full ladder (unchanged); a mineral load goes to
  // storage only (spawn/extensions/towers/links don't accept non-energy).
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    const sink = resolveFill(creep, rh);
    if (!sink) {
      rally(creep);
      return;
    }
    if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) travelTo(creep, sink, 1, HAULER_PRIORITY);
    return;
  }

  const mineralType = (Object.keys(creep.store) as ResourceConstant[]).find((r) => creep.store.getUsedCapacity(r) > 0);
  if (!mineralType) {
    rally(creep);
    return;
  }
  const storage = rh.sink ? Game.getObjectById(rh.sink as Id<StructureStorage>) : null;
  if (!storage || storage.store.getFreeCapacity() <= 0) {
    // Nowhere to store it (no storage, or storage full). Drop the mineral so the
    // hauler frees up and resumes energy hauling instead of deadlocking. Pickup is
    // gated on a sink existing (below), so it won't immediately re-grab the pile.
    creep.drop(mineralType);
    return;
  }
  if (creep.transfer(storage, mineralType) === ERR_NOT_IN_RANGE) travelTo(creep, storage, 1, HAULER_PRIORITY);
}

function resolvePickup(creep: Creep, rh: RoomHeapEntry): { target: Pickup; resourceType: ResourceConstant } | null {
  const free = creep.store.getFreeCapacity();
  const holdingEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
  const holdingMineral = !holdingEnergy && creep.store.getUsedCapacity() > 0;
  // Energy always first; minerals only when not already carrying energy. A trip
  // never mixes resources: a mineral-laden hauler stays on minerals.
  const mineralsHaulable = rh.sink !== null;
  const lists: LogisticsPickup[][] = holdingEnergy
    ? [rh.pickups]
    : holdingMineral
      ? (mineralsHaulable ? [rh.mineralPickups] : [])
      : (mineralsHaulable ? [rh.pickups, rh.mineralPickups] : [rh.pickups]);

  if (creep.memory.target) {
    for (const list of lists) {
      const entry = list.find((p) => p.id === creep.memory.target);
      if (!entry) continue;
      const obj = Game.getObjectById(entry.id as Id<Pickup>);
      if (obj) {
        rh.claimed[entry.id] = (rh.claimed[entry.id] ?? 0) + free;
        return { target: obj, resourceType: entry.resourceType };
      }
    }
    delete creep.memory.target;
  }

  for (const list of lists) {
    const viable: Array<{ target: Pickup; resourceType: ResourceConstant }> = [];
    for (const p of list) {
      if (p.amount - (rh.claimed[p.id] ?? 0) < Math.min(free, 50)) continue; // already spoken for
      const obj = Game.getObjectById(p.id as Id<Pickup>);
      if (obj) viable.push({ target: obj, resourceType: p.resourceType });
    }
    const closest = creep.pos.findClosestByRange(viable.map((v) => v.target));
    if (closest) {
      const match = viable.find((v) => v.target === closest)!;
      creep.memory.target = closest.id;
      rh.claimed[closest.id] = (rh.claimed[closest.id] ?? 0) + free;
      return match;
    }
  }
  return null;
}

function resolveFill(creep: Creep, rh: RoomHeapEntry): AnyStoreStructure | null {
  // Delivery ladder: spawn/extensions → towers → sender links → storage. The
  // first two MUST win so links never starve spawning.
  for (const group of [rh.fillsCore, rh.fillsTower]) {
    const targets: AnyStoreStructure[] = [];
    for (const id of group) {
      const s = Game.getObjectById(id as Id<AnyStoreStructure>);
      if (s && (s.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0) targets.push(s);
    }
    const closest = creep.pos.findClosestByRange(targets);
    if (closest) return closest;
  }

  // Sender links (core/source), filled only after spawn/extensions/towers — this
  // routes true surplus toward upgrading instead of banking it. Self-regulating:
  // when the controller link + upgraders are saturated the senders fill up and
  // stop accepting, so haulers fall through to storage on their own.
  const linkTargets: StructureLink[] = [];
  for (const id of rh.senderLinks) {
    const link = Game.getObjectById(id as Id<StructureLink>);
    if (link && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) linkTargets.push(link);
  }
  const link = creep.pos.findClosestByRange(linkTargets);
  if (link) return link;

  if (rh.sink) {
    const storage = Game.getObjectById(rh.sink as Id<StructureStorage>);
    if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return storage;
  }
  return null;
}
