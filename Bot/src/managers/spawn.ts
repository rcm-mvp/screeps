/**
 * Spawn manager — fills the plan's role quotas in priority order with the
 * best body the room can afford. Waits for energy rather than spawning a
 * weak body, except in emergencies (no energy income at all).
 */
import type { ColonyPlan } from '../contract';
import type { SafeDirectives } from '../directives';
import type { Census } from '../state';
import { SETTINGS } from '../settings';
import { roomHeap } from '../heap';
import { bodyFor, bodyCost } from '../lib/bodies';
import { log } from '../lib/log';
import { isKnownRole } from '../roles';

const BASE_PRIORITY = ['harvester', 'miner', 'hauler', 'upgrader', 'builder', 'claimer', 'scout', 'defender'];

export function runSpawn(room: Room, cplan: ColonyPlan, d: SafeDirectives, census: Census): void {
  const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
  if (!spawn) return;

  const have = census.byHome[room.name] ?? {};
  const rh = roomHeap(room.name);

  // Emergency bootstrap: zero energy income means the colony is stalling.
  // Spawn the best harvester the current energy buys, ignoring quotas.
  const income = (have.harvester ?? 0) + (have.miner ?? 0);
  if (!d.paused && income === 0) {
    if (room.energyAvailable >= SETTINGS.EMERGENCY_BODY_MIN) {
      trySpawn(spawn, 'harvester', bodyFor('harvester', room.energyAvailable), room.name);
    }
    return;
  }

  const quotas: Record<string, number> = { ...cplan.quotas };
  // Live reaction to an attack between strategy runs: towerless rooms raise
  // defenders immediately instead of waiting for the next plan.
  if (rh.hostiles > 0 && rh.towers === 0) {
    quotas.defender = Math.max(quotas.defender ?? 0, Math.min(3, rh.hostiles));
  }

  if (d.paused) {
    // Paused halts the economy but never defense.
    if (rh.hostiles > 0 && (have.defender ?? 0) < (quotas.defender ?? 0)) {
      attemptRole(spawn, room, 'defender', cplan, have);
    }
    return;
  }

  let order = [...BASE_PRIORITY];
  if (rh.hostiles > 0) order = ['defender', ...order.filter((r) => r !== 'defender')];
  for (const role of Object.keys(quotas)) if (!order.includes(role)) order.push(role);

  for (const role of order) {
    if ((have[role] ?? 0) >= (quotas[role] ?? 0)) continue;
    if (!isKnownRole(role)) continue; // warned at strategy time
    const result = attemptRole(spawn, room, role, cplan, have);
    // 'wait' blocks lower priorities so they can't starve this role of energy;
    // 'skip' (role impossible here regardless of energy) must not.
    if (result === 'spawned' || result === 'wait') return;
  }
}

type SpawnAttempt = 'spawned' | 'wait' | 'skip';

function attemptRole(
  spawn: StructureSpawn,
  room: Room,
  role: string,
  cplan: ColonyPlan,
  have: Record<string, number>,
): SpawnAttempt {
  // Spawn at full capacity normally; with the critical workforce missing,
  // settle for what's in the bank right now.
  const workforceLow = (have.harvester ?? 0) + (have.miner ?? 0) === 0 || (role === 'hauler' && (have.hauler ?? 0) === 0);
  const budget = workforceLow ? room.energyAvailable : room.energyCapacityAvailable;
  const body = bodyFor(role, budget);
  if (!body.length) return 'skip'; // unaffordable even at full capacity (e.g. claimer < 650)

  const extra: Partial<CreepMemory> = {};
  if (role === 'claimer') {
    const target = pickClaimTarget(cplan);
    if (!target) return 'skip';
    extra.targetRoom = target;
  }
  if (role === 'scout') {
    if (!cplan.scoutTargets.length) return 'skip';
    extra.route = [...cplan.scoutTargets];
    extra.routeIdx = 0;
  }

  if (bodyCost(body) > room.energyAvailable) return 'wait'; // extensions still filling
  return trySpawn(spawn, role, body, room.name, extra) ? 'spawned' : 'skip';
}

function pickClaimTarget(cplan: ColonyPlan): string | undefined {
  const taken = new Set<string>();
  for (const name in Game.creeps) {
    const c = Game.creeps[name];
    if (c.memory.role === 'claimer' && c.memory.targetRoom) taken.add(c.memory.targetRoom);
  }
  return cplan.claimTargets.find((r) => !taken.has(r));
}

function trySpawn(
  spawn: StructureSpawn,
  role: string,
  body: BodyPartConstant[],
  home: string,
  extra: Partial<CreepMemory> = {},
): boolean {
  if (!body.length) return false;
  const name = `${role}_${spawn.name}_${Game.time}`;
  const result = spawn.spawnCreep(body, name, {
    memory: { role, home, working: false, ...extra },
  });
  if (result === OK) {
    log.info(`spawn: ${name} (${body.length} parts, ${bodyCost(body)}e) in ${home}`);
    return true;
  }
  if (result !== ERR_NOT_ENOUGH_ENERGY && result !== ERR_BUSY) {
    log.warn(`spawn: ${role} in ${home} failed with ${result}`);
  }
  return false;
}
