/**
 * Strategic layer — runs every STRATEGY_INTERVAL ticks (or immediately when a
 * new directive revision arrives) and writes a cached plan to Memory. The
 * tactical layer follows that plan every tick without recomputing it.
 */
import type { ColonyPlan, Posture, StrategyPlan } from '../contract';
import type { SafeDirectives } from '../directives';
import { SETTINGS } from '../settings';
import { ownedRooms } from '../lib/game';
import { log } from '../lib/log';
import { isKnownRole } from '../roles';

const INTEL_TTL = 10000;

export function runStrategy(d: SafeDirectives): StrategyPlan {
  const verbose = Memory.plan?.rev !== d.rev; // log decisions once per directive change
  const owned = ownedRooms();
  const ownedNames = new Set(owned.map((r) => r.name));
  const notOwned = (r: string): boolean => !ownedNames.has(r);

  const orders = d.flagsAsOrders ? readFlagOrders() : { claim: [], attack: [], scout: [] };
  const claimTargets = dedupe([...(d.posture === 'expand' ? d.targetRooms : []), ...orders.claim]).filter(notOwned);
  const attackTargets = dedupe([...(d.posture === 'war' ? d.targetRooms : []), ...orders.attack]).filter(notOwned);
  const scoutTargets = dedupe([
    ...orders.scout,
    ...(d.posture === 'expand' || d.posture === 'war' ? d.targetRooms : []),
  ]).filter(notOwned);

  // Never try to claim beyond GCL headroom, no matter what the directive says.
  const headroom = Math.max(0, Game.gcl.level - owned.length);
  const claims = claimTargets.slice(0, Math.min(headroom, 2));
  if (verbose && claimTargets.length > claims.length) {
    log.warn(`strategy: ${claimTargets.length} claim targets but GCL headroom is ${headroom} — claiming [${claims.join(', ')}]`);
  }

  // The strongest colony hosts expansion/war/scouting duties.
  const capitals = owned
    .filter((r) => r.find(FIND_MY_SPAWNS).length > 0)
    .sort((a, b) => b.energyCapacityAvailable - a.energyCapacityAvailable);
  const capital = capitals[0];

  const colonies: Record<string, ColonyPlan> = {};
  for (const room of capitals) {
    const isCapital = room === capital;
    const quotas = computeQuotas(room, d.posture);
    if (isCapital) {
      if (claims.length) quotas.claimer = claims.length;
      if (scoutTargets.length && scoutTargets.some(needsIntel)) quotas.scout = 1;
      if (attackTargets.length) quotas.defender = Math.max(quotas.defender ?? 0, 2);
    }
    for (const [role, n] of Object.entries(d.roleQuotas)) {
      quotas[role] = n;
      if (verbose && !isKnownRole(role)) {
        log.warn(`strategy: directive quota for unknown role "${role}" — it will not be spawned`);
      }
    }
    colonies[room.name] = {
      quotas,
      claimTargets: isCapital ? claims : [],
      attackTargets: isCapital ? attackTargets : [],
      scoutTargets: isCapital ? scoutTargets : [],
    };
  }

  const plan: StrategyPlan = { tick: Game.time, rev: d.rev, posture: d.posture, colonies };
  Memory.plan = plan;

  if (verbose) {
    log.info(
      `strategy: rev=${d.rev} posture=${d.posture} colonies=${capitals.length}` +
        (claims.length ? ` claim=[${claims.join(', ')}]` : '') +
        (attackTargets.length ? ` attack=[${attackTargets.join(', ')}]` : '') +
        (d.note ? ` note="${d.note}"` : ''),
    );
  }
  return plan;
}

function computeQuotas(room: Room, posture: Posture): Record<string, number> {
  const sources = room.find(FIND_SOURCES);
  const rcl = room.controller?.level ?? 0;
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  const sourceContainers = sources.filter(
    (s) =>
      s.pos.findInRange(FIND_STRUCTURES, 1, { filter: (x) => x.structureType === STRUCTURE_CONTAINER }).length > 0,
  ).length;
  const minersViable = room.energyCapacityAvailable >= SETTINGS.MINER_CAPACITY_MIN && sourceContainers > 0;

  const q: Record<string, number> = {};
  q.miner = minersViable ? sources.length : 0;
  q.harvester = minersViable ? 0 : Math.min(sources.length * 2, 6);
  q.hauler = sourceContainers > 0 ? Math.max(1, sourceContainers) : 0;
  // Upgrader bodies now scale to room capacity (WORKER_MAX_SEGMENTS), so each
  // upgrader does much more per tick. Keep the count modest so a few big bodies
  // don't outrun energy income — bigger bodies already do the heavy lifting, and
  // the extra upgrader is gated on a large storage buffer that can sustain them.
  q.upgrader = rcl < 2 ? 1 : 2;
  if (room.storage && room.storage.store[RESOURCE_ENERGY] > 100000) q.upgrader += 1;
  q.builder = sites > 0 ? 2 : rcl >= 2 ? 1 : 0;
  q.defender = posture === 'defend' ? 1 : 0;
  // Mineral extraction (A2): one static miner on the mineral, but only once it can
  // actually work — RCL6 (extractor unlock), an extractor actually built on the
  // mineral, and the mineral not currently depleted (don't spawn into an empty
  // mineral; it regenerates slowly). Drops to 0 when the mineral runs dry so the
  // miner isn't replaced mid-depletion.
  const mineral = room.find(FIND_MINERALS)[0];
  const extractorBuilt =
    !!mineral && mineral.pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_EXTRACTOR);
  q.mineralMiner = rcl >= 6 && extractorBuilt && mineral.mineralAmount > 0 ? 1 : 0;
  return q;
}

function readFlagOrders(): { claim: string[]; attack: string[]; scout: string[] } {
  const out = { claim: [] as string[], attack: [] as string[], scout: [] as string[] };
  for (const name in Game.flags) {
    const verb = name.split(':')[0].toLowerCase();
    const roomName = Game.flags[name].pos.roomName;
    if (verb === 'claim') out.claim.push(roomName);
    else if (verb === 'attack') out.attack.push(roomName);
    else if (verb === 'scout') out.scout.push(roomName);
  }
  return out;
}

function needsIntel(roomName: string): boolean {
  const intel = (Memory.rooms ?? {})[roomName]?.intel;
  return !intel || Game.time - intel.scoutedAt > INTEL_TTL;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
