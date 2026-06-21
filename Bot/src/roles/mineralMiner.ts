/**
 * Static mineral miner: parks on the container next to the room's mineral and
 * harvests it through the extractor forever — overflow drops straight into the
 * container under it. Harvest is gated to spawn time (RCL6 + extractor built +
 * mineral not depleted), so here we just harvest every tick: ERR_TIRED during
 * the extractor cooldown and ERR_NOT_ENOUGH_RESOURCES on an empty mineral are
 * both harmless.
 */
import type { RoleContext } from './context';
import { travelTo } from '../lib/movement';
import { setWorkingArea } from '../lib/traffic';
import { atHome, rally } from './common';

export function runMineralMiner(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;

  const mineral = creep.room.find(FIND_MINERALS)[0];
  if (!mineral) {
    rally(creep);
    return;
  }

  const container = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  })[0] as StructureContainer | undefined;

  if (container && !creep.pos.isEqualTo(container.pos)) {
    // Keep mining from an adjacent tile while working toward the parking spot.
    if (creep.pos.isNearTo(mineral)) creep.harvest(mineral);
    travelTo(creep, container.pos, 0);
    return;
  }
  if (!container && !creep.pos.isNearTo(mineral)) {
    travelTo(creep, mineral);
    return;
  }
  // Parked on its mining tile: pin it so haulers can never push it off the mineral.
  setWorkingArea(creep, creep.pos, 0);
  creep.harvest(mineral);
}
