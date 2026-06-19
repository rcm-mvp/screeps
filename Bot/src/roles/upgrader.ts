/** Upgrader: gather energy, pump the home controller. */
import type { RoleContext } from './context';
import { travelTo } from '../lib/movement';
import { setWorkingArea } from '../lib/traffic';
import { acquireEnergy, updateWorkingFlag } from '../lib/energy';
import { roomHeap } from '../heap';
import { atHome, rally } from './common';

export function runUpgrader(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;

  if (!updateWorkingFlag(creep)) {
    // Prefer the controller link if it exists and holds energy: it sits beside
    // the controller, so a parked upgrader barely moves to refill. Falls back to
    // the general pickup path when the link is absent/empty.
    if (!withdrawFromControllerLink(creep)) acquireEnergy(creep, true);
    return;
  }

  const controller = creep.room.controller;
  if (!controller?.my) {
    rally(creep);
    return;
  }
  // Hold within upgrade range of the controller — when a hauler needs the lane,
  // traffic can shuffle the upgrader to another in-range tile rather than off it.
  setWorkingArea(creep, controller.pos, 3);
  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) travelTo(creep, controller, 3);
}

/**
 * Try to refill from the controller link (published on the heap by runLinks).
 * Returns true once it has handled gathering this tick (a withdraw, an approach,
 * or a still-usable link with no energy yet) so the caller skips acquireEnergy;
 * false when there is no controller link to use, deferring to the normal path.
 */
function withdrawFromControllerLink(creep: Creep): boolean {
  const id = roomHeap(creep.memory.home).controllerLink;
  if (!id) return false;
  const link = Game.getObjectById(id as Id<StructureLink>);
  if (!link || link.store[RESOURCE_ENERGY] === 0) return false;
  if (creep.withdraw(link, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) travelTo(creep, link, 1);
  return true;
}
