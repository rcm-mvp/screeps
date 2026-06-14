/**
 * Claimer: walks to its target room and claims the controller. Falls back to
 * reserving when GCL doesn't allow another claim. Building out the new colony
 * (spawn placement) is the AI/bridge's job via the place-spawn endpoint.
 */
import type { RoleContext } from './context';
import { travelTo, travelToRoom } from '../lib/movement';
import { log } from '../lib/log';
import { rally } from './common';

export function runClaimer(creep: Creep, _ctx: RoleContext): void {
  const target = creep.memory.targetRoom;
  if (!target) {
    rally(creep);
    return;
  }
  if (creep.room.name !== target) {
    travelToRoom(creep, target);
    return;
  }

  const controller = creep.room.controller;
  if (!controller || controller.my) return; // done (or nothing to claim) — let TTL expire

  const result = creep.claimController(controller);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller);
  } else if (result === OK) {
    log.info(`claimer: claimed ${target}`);
    Game.notify(`Claimed ${target} at tick ${Game.time}`);
  } else if (result === ERR_GCL_NOT_ENOUGH) {
    if (creep.reserveController(controller) === ERR_NOT_IN_RANGE) travelTo(creep, controller);
  } else {
    log.warn(`claimer: claimController(${target}) returned ${result}`);
  }
}
