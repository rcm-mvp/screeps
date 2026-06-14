/**
 * Builder: works construction sites by structure priority, falls back to
 * repairing worn structures, then to upgrading — never idles with energy.
 */
import type { RoleContext } from './context';
import { travelTo } from '../lib/movement';
import { setWorkingArea } from '../lib/traffic';
import { acquireEnergy, updateWorkingFlag } from '../lib/energy';
import { atHome } from './common';

const BUILD_PRIORITY: Partial<Record<StructureConstant, number>> = {
  [STRUCTURE_SPAWN]: 0,
  [STRUCTURE_EXTENSION]: 1,
  [STRUCTURE_TOWER]: 2,
  [STRUCTURE_CONTAINER]: 3,
  [STRUCTURE_STORAGE]: 4,
  [STRUCTURE_ROAD]: 5,
};

export function runBuilder(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;

  if (!updateWorkingFlag(creep)) {
    acquireEnergy(creep, true);
    return;
  }

  const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
  if (sites.length) {
    const best = Math.min(...sites.map((s) => BUILD_PRIORITY[s.structureType] ?? 9));
    const target = creep.pos.findClosestByRange(
      sites.filter((s) => (BUILD_PRIORITY[s.structureType] ?? 9) === best),
    );
    if (target) {
      setWorkingArea(creep, target.pos, 3); // hold near the site, yield lanes when idle in range
      if (creep.build(target) === ERR_NOT_IN_RANGE) travelTo(creep, target, 3);
      return;
    }
  }

  const broken = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.hits < s.hitsMax * 0.6 &&
      s.structureType !== STRUCTURE_WALL &&
      (s.structureType !== STRUCTURE_RAMPART || s.hits < 10000),
  });
  const repairTarget = creep.pos.findClosestByRange(broken);
  if (repairTarget) {
    if (creep.repair(repairTarget) === ERR_NOT_IN_RANGE) travelTo(creep, repairTarget, 3);
    return;
  }

  const controller = creep.room.controller;
  if (controller?.my && creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller, 3);
  }
}
