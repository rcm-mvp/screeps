/** Upgrader: gather energy, pump the home controller. */
import type { RoleContext } from './context';
import { travelTo } from '../lib/movement';
import { setWorkingArea } from '../lib/traffic';
import { acquireEnergy, updateWorkingFlag } from '../lib/energy';
import { atHome, rally } from './common';

export function runUpgrader(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;

  if (!updateWorkingFlag(creep)) {
    acquireEnergy(creep, true);
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
