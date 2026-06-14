/**
 * Bootstrap economy: mine a source, deliver to spawn/extensions. Falls back
 * to upgrading so energy (and the creep) never idles. Phased out once static
 * miners + haulers take over.
 */
import type { RoleContext } from './context';
import { travelTo } from '../lib/movement';
import { updateWorkingFlag } from '../lib/energy';
import { atHome, assignedSource, findDeliveryTarget } from './common';

export function runHarvester(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;

  if (!updateWorkingFlag(creep)) {
    const source = assignedSource(creep, false);
    if (!source) return;
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) travelTo(creep, source);
    return;
  }

  const sink = findDeliveryTarget(creep);
  if (sink) {
    if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) travelTo(creep, sink);
    return;
  }
  const controller = creep.room.controller;
  if (controller?.my && creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller, 3);
  }
}
