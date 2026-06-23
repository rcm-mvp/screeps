/**
 * Builder: works construction sites by structure priority, falls back to
 * repairing worn structures, then to upgrading — never idles with energy.
 */
import type { RoleContext } from './context';
import { travelTo } from '../lib/movement';
import { setWorkingArea } from '../lib/traffic';
import { acquireEnergy, updateWorkingFlag } from '../lib/energy';
import { atHome } from './common';
import { rampartRepairThreshold } from '../managers/defense';

// Mirrors TYPE_PRIORITY in lib/planner/plan.ts so builders and the planner agree
// on the economic ordering. Anything unlisted falls through to the default (14),
// the lowest tier, just below roads.
const BUILD_PRIORITY: Partial<Record<StructureConstant, number>> = {
  [STRUCTURE_SPAWN]: 0,
  [STRUCTURE_EXTENSION]: 1,
  [STRUCTURE_TOWER]: 2,
  [STRUCTURE_CONTAINER]: 3,
  [STRUCTURE_STORAGE]: 4,
  [STRUCTURE_LINK]: 5,
  [STRUCTURE_TERMINAL]: 6,
  [STRUCTURE_LAB]: 7,
  [STRUCTURE_EXTRACTOR]: 8, // in the planner as of A2 (mineral extractor on the mineral tile), ranked with the standalone economy structures
  [STRUCTURE_FACTORY]: 9,
  [STRUCTURE_POWER_SPAWN]: 10,
  [STRUCTURE_NUKER]: 11,
  [STRUCTURE_OBSERVER]: 12,
  [STRUCTURE_ROAD]: 13, // lowest tier, just above the implicit default
};

export function runBuilder(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;

  if (!updateWorkingFlag(creep)) {
    acquireEnergy(creep, true);
    return;
  }

  const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
  if (sites.length) {
    const best = Math.min(...sites.map((s) => BUILD_PRIORITY[s.structureType] ?? 14));
    const target = creep.pos.findClosestByRange(
      sites.filter((s) => (BUILD_PRIORITY[s.structureType] ?? 14) === best),
    );
    if (target) {
      setWorkingArea(creep, target.pos, 3); // hold near the site, yield lanes when idle in range
      if (creep.build(target) === ERR_NOT_IN_RANGE) travelTo(creep, target, 3);
      return;
    }
  }

  const rampartThreshold = rampartRepairThreshold(creep.room.controller?.level ?? 0);
  const broken = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.hits < s.hitsMax * 0.6 &&
      s.structureType !== STRUCTURE_WALL &&
      (s.structureType !== STRUCTURE_RAMPART || s.hits < rampartThreshold),
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
