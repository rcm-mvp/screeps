/**
 * Logistics manager — builds one per-room snapshot of energy supply (pickups)
 * and demand (fills) per tick on the heap, so every hauler shares the same
 * finds instead of running its own. Haulers claim against `claimed` to avoid
 * piling onto one container.
 */
import { roomHeap, type LogisticsPickup } from '../heap';

export function runLogistics(room: Room): void {
  const rh = roomHeap(room.name);

  const fillsCore = room.find(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  const fillsTower = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 100,
  });
  rh.fillsCore = fillsCore.map((s) => s.id);
  rh.fillsTower = fillsTower.map((s) => s.id);
  rh.sink =
    room.storage && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? room.storage.id : null;

  const pickups: LogisticsPickup[] = [];
  for (const s of room.find(FIND_STRUCTURES)) {
    if (s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] >= 50) {
      pickups.push({ id: s.id, amount: s.store[RESOURCE_ENERGY], resourceType: RESOURCE_ENERGY });
    }
  }
  for (const res of room.find(FIND_DROPPED_RESOURCES)) {
    if (res.resourceType === RESOURCE_ENERGY && res.amount >= 50) {
      pickups.push({ id: res.id, amount: res.amount, resourceType: RESOURCE_ENERGY });
    }
  }
  for (const tomb of room.find(FIND_TOMBSTONES)) {
    if (tomb.store[RESOURCE_ENERGY] > 0)
      pickups.push({ id: tomb.id, amount: tomb.store[RESOURCE_ENERGY], resourceType: RESOURCE_ENERGY });
  }
  for (const ruin of room.find(FIND_RUINS)) {
    if (ruin.store[RESOURCE_ENERGY] > 0)
      pickups.push({ id: ruin.id, amount: ruin.store[RESOURCE_ENERGY], resourceType: RESOURCE_ENERGY });
  }
  // Storage doubles as a pickup, but only while something actually needs
  // filling — otherwise haulers would loop storage → storage.
  if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0 && (fillsCore.length || fillsTower.length)) {
    pickups.push({ id: room.storage.id, amount: room.storage.store[RESOURCE_ENERGY], resourceType: RESOURCE_ENERGY });
  }
  rh.pickups = pickups;
  rh.claimed = {};

  // Non-energy pickups (the mineral container A2.1 places + any dropped minerals
  // from the brief window before that container is built). Hauled to storage only
  // when no energy pickup is viable — see roles/hauler.ts. Tagged with the actual
  // resource so the hauler withdraws/transfers the right type.
  const mineralPickups: LogisticsPickup[] = [];
  for (const s of room.find(FIND_STRUCTURES)) {
    if (s.structureType !== STRUCTURE_CONTAINER) continue;
    if (s.store[RESOURCE_ENERGY] >= 50) continue; // already an energy pickup; one container, one list
    for (const r in s.store) {
      if (r === RESOURCE_ENERGY) continue;
      const amount = s.store[r as ResourceConstant];
      if (amount >= 50) mineralPickups.push({ id: s.id, amount, resourceType: r as ResourceConstant });
    }
  }
  for (const res of room.find(FIND_DROPPED_RESOURCES)) {
    if (res.resourceType !== RESOURCE_ENERGY && res.amount >= 50) {
      mineralPickups.push({ id: res.id, amount: res.amount, resourceType: res.resourceType });
    }
  }
  rh.mineralPickups = mineralPickups;
}

/**
 * MULTI-ROOM LOGISTICS — extension point (deferred until single-room eco is
 * stable; see UPDATE prompt §3). When the colony spans multiple rooms, balance
 * resources across terminals/storages here — the cross-room resource-
 * distribution approach from sy-harabi's "Logistics" writeup (pull from rooms
 * in surplus toward rooms in deficit, mind terminal energy cost / cooldown).
 *
 * Wire it into main.ts AFTER the per-room logistics loop, gated like strategy
 * (interval + BUCKET_LOW), e.g. `runInterColonyLogistics(ownedRooms())`. Kept a
 * no-op for now so the seam exists without changing current behaviour.
 */
export function runInterColonyLogistics(_rooms: Room[]): void {
  // intentionally empty — implement terminal/storage balancing here
}
