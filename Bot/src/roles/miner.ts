/**
 * Static miner: parks on the container next to its exclusive source and
 * harvests forever — overflow drops straight into the container under it.
 */
import type { RoleContext } from './context';
import { travelTo } from '../lib/movement';
import { setWorkingArea } from '../lib/traffic';
import { atHome, assignedSource, rally } from './common';

export function runMiner(creep: Creep, _ctx: RoleContext): void {
  if (!atHome(creep)) return;

  const source = assignedSource(creep, true);
  if (!source) {
    rally(creep);
    return;
  }

  const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  })[0] as StructureContainer | undefined;

  if (container && !creep.pos.isEqualTo(container.pos)) {
    // Keep mining from an adjacent tile while working toward the parking spot.
    if (creep.pos.isNearTo(source)) creep.harvest(source);
    travelTo(creep, container.pos, 0);
    return;
  }
  if (!container && !creep.pos.isNearTo(source)) {
    travelTo(creep, source);
    return;
  }
  // Parked on its mining tile: pin it so haulers can never push it off the source.
  setWorkingArea(creep, creep.pos, 0);
  creep.harvest(source);
}
