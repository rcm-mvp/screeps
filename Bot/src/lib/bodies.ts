/**
 * Body generation: scale a per-role segment to the energy budget. Parts are
 * ordered so the cheap/sacrificial ones take damage first and MOVE survives
 * longest. Returns [] when the role is unaffordable at this budget.
 */
const PART_ORDER: BodyPartConstant[] = [TOUGH, WORK, CARRY, ATTACK, RANGED_ATTACK, HEAL, CLAIM, MOVE];

export function bodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function repeat(segment: BodyPartConstant[], energy: number, maxSegments: number): BodyPartConstant[] {
  const segCost = bodyCost(segment);
  if (energy < segCost) return [];
  const count = Math.min(maxSegments, Math.floor(energy / segCost), Math.floor(50 / segment.length));
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < count; i++) body.push(...segment);
  return sortBody(body);
}

function sortBody(body: BodyPartConstant[]): BodyPartConstant[] {
  return body.sort((a, b) => PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b));
}

export function bodyFor(role: string, energy: number): BodyPartConstant[] {
  switch (role) {
    case 'harvester':
    case 'upgrader':
    case 'builder':
      return repeat([WORK, CARRY, MOVE], energy, 6);
    case 'hauler':
      return repeat([CARRY, CARRY, MOVE], energy, 8);
    case 'miner': {
      // Static container miner: 5 WORK saturates a source; one MOVE is enough
      // for a creep that walks once and parks.
      const works = Math.min(5, Math.floor((energy - BODYPART_COST[MOVE]) / BODYPART_COST[WORK]));
      if (works < 2) return [];
      const body: BodyPartConstant[] = [];
      for (let i = 0; i < works; i++) body.push(WORK);
      body.push(MOVE);
      return body;
    }
    case 'defender':
      return repeat([ATTACK, MOVE], energy, 8);
    case 'claimer':
      return energy >= BODYPART_COST[CLAIM] + BODYPART_COST[MOVE] ? [CLAIM, MOVE] : [];
    case 'scout':
      return [MOVE];
    default:
      // Unknown roles aren't spawned (spawn manager checks the registry); this
      // generic worker is only a safety net.
      return repeat([WORK, CARRY, MOVE], energy, 4);
  }
}
