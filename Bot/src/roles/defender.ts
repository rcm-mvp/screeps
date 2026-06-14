/**
 * Defender: engages hostiles wherever it stands, returns home when home is
 * under attack, and (war posture, never while paused) pushes into the plan's
 * attack targets.
 */
import type { RoleContext } from './context';
import { roomHeap } from '../heap';
import { travelTo, travelToRoom } from '../lib/movement';
import { rally } from './common';

/** Defenders outrank the whole economy in shared lanes. */
const DEFENDER_PRIORITY = 3;

export function runDefender(creep: Creep, ctx: RoleContext): void {
  const hostile = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
  if (hostile) {
    if (creep.attack(hostile) === ERR_NOT_IN_RANGE) travelTo(creep, hostile, 1, DEFENDER_PRIORITY);
    return;
  }

  if (creep.room.name !== creep.memory.home && roomHeap(creep.memory.home).hostiles > 0) {
    travelToRoom(creep, creep.memory.home, DEFENDER_PRIORITY);
    return;
  }

  const targets = ctx.plan.colonies[creep.memory.home]?.attackTargets ?? [];
  if (targets.length && !ctx.d.paused) {
    const targetRoom =
      creep.memory.targetRoom && targets.includes(creep.memory.targetRoom)
        ? creep.memory.targetRoom
        : targets[0];
    creep.memory.targetRoom = targetRoom;
    if (creep.room.name !== targetRoom) {
      travelToRoom(creep, targetRoom, DEFENDER_PRIORITY);
      return;
    }
    // No hostile creeps here (handled above) — take down structures.
    const structure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType !== STRUCTURE_CONTROLLER,
    });
    if (structure) {
      if (creep.attack(structure) === ERR_NOT_IN_RANGE) travelTo(creep, structure, 1, DEFENDER_PRIORITY);
      return;
    }
  }

  rally(creep);
}
