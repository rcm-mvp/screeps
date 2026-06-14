/**
 * Scout: loops its route of target rooms, recording cheap intel into
 * Memory.rooms[*].intel for the strategy layer (and the bridge) to read.
 */
import type { RoleContext } from './context';
import { travelToRoom } from '../lib/movement';
import { log } from '../lib/log';
import { rally } from './common';

export function runScout(creep: Creep, _ctx: RoleContext): void {
  const route = creep.memory.route ?? [];
  if (!route.length) {
    rally(creep);
    return;
  }
  const idx = (creep.memory.routeIdx ?? 0) % route.length;
  const target = route[idx];

  if (creep.room.name === target) {
    recordIntel(creep.room);
    creep.memory.routeIdx = idx + 1;
    return;
  }
  travelToRoom(creep, target);
}

function recordIntel(room: Room): void {
  if (!Memory.rooms) Memory.rooms = {};
  const mem = (Memory.rooms[room.name] = Memory.rooms[room.name] ?? ({} as RoomMemory));
  mem.intel = {
    scoutedAt: Game.time,
    sources: room.find(FIND_SOURCES).length,
    owner: room.controller?.owner?.username,
    level: room.controller?.level,
    hostiles: room.find(FIND_HOSTILE_CREEPS).length,
  };
  log.info(`scout: ${room.name} sources=${mem.intel.sources} owner=${mem.intel.owner ?? '-'} hostiles=${mem.intel.hostiles}`);
}
