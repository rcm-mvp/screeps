/**
 * Movement with path reuse + stuck detection, routed through the traffic
 * manager. `moveTo` still does all the (multi-room, cached) pathfinding, but
 * its `.move` is intercepted by lib/traffic so the step is *registered* rather
 * than executed — `runTraffic(room)` at loop end resolves collisions and
 * issues the real moves. `priority` lets haulers/defenders push idle workers
 * out of shared lanes (see lib/traffic).
 */
import { setMovePriority } from './traffic';

const STUCK_TICKS = 3;

export function travelTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  range = 1,
  priority = 1,
): ScreepsReturnCode {
  const pos = target instanceof RoomPosition ? target : target.pos;
  if (creep.pos.roomName === pos.roomName && creep.pos.inRangeTo(pos, range)) return OK;

  const prev = creep.memory._mv;
  const moved = !prev || prev.x !== creep.pos.x || prev.y !== creep.pos.y || prev.r !== creep.pos.roomName;
  const stuck = moved || creep.fatigue > 0 ? 0 : prev.n + 1;
  creep.memory._mv = { x: creep.pos.x, y: creep.pos.y, r: creep.pos.roomName, n: stuck };

  setMovePriority(creep, priority);
  const opts: MoveToOpts = { reusePath: 20, range };
  if (stuck >= STUCK_TICKS) opts.reusePath = 0; // fresh path around whatever is blocking
  return creep.moveTo(pos, opts);
}

export function travelToRoom(creep: Creep, roomName: string, priority = 1): ScreepsReturnCode {
  if (creep.room.name === roomName && !onExit(creep.pos)) return OK;
  return travelTo(creep, new RoomPosition(25, 25, roomName), 22, priority);
}

function onExit(pos: RoomPosition): boolean {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}
