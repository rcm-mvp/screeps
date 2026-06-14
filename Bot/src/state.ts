/**
 * State + ack writer — the executor's half of the contract. Runs every tick
 * (small object; Memory is serialized every tick anyway) so the bridge/UI
 * heartbeat stays fresh.
 */
import type { ColonyState, ExecutorState } from './contract';
import { ensureBridgeMemory } from './memory';
import { roomHeap } from './heap';
import { ownedRooms, bucket } from './lib/game';

export interface Census {
  total: number;
  byRole: Record<string, number>;
  byHome: Record<string, Record<string, number>>;
}

/** One pass over Game.creeps, shared by spawn manager and state writer. */
export function buildCensus(): Census {
  const census: Census = { total: 0, byRole: {}, byHome: {} };
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const role = creep.memory.role ?? 'unknown';
    const home = creep.memory.home ?? creep.room.name;
    census.total++;
    census.byRole[role] = (census.byRole[role] ?? 0) + 1;
    const homeRoles = (census.byHome[home] = census.byHome[home] ?? {});
    homeRoles[role] = (homeRoles[role] ?? 0) + 1;
  }
  return census;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function writeState(census: Census, tickErrors: string[], cpuBySubsystem: Record<string, number>): void {
  const bridge = ensureBridgeMemory();

  const colonies: ColonyState['colonies'] = {};
  for (const room of ownedRooms()) {
    const rh = roomHeap(room.name); // defense already populated it this tick
    const colony: ColonyState['colonies'][string] = {
      rcl: room.controller?.level ?? 0,
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
      creeps: census.byHome[room.name] ?? {},
      constructionSites: room.find(FIND_MY_CONSTRUCTION_SITES).length,
      threats: { hostiles: rh.hostiles, safeMode: (room.controller?.safeMode ?? 0) > 0 },
    };
    if (room.storage) colony.storageEnergy = room.storage.store[RESOURCE_ENERGY];
    colonies[room.name] = colony;
  }

  const cpuRounded: Record<string, number> = {};
  for (const key of Object.keys(cpuBySubsystem)) cpuRounded[key] = round2(cpuBySubsystem[key]);

  const state: ExecutorState = {
    tick: Game.time,
    cpu: { used: round2(Game.cpu.getUsed()), limit: Game.cpu.limit ?? 0, bucket: bucket() },
    gcl: {
      level: Game.gcl.level,
      progress: Math.round(Game.gcl.progress),
      progressTotal: Game.gcl.progressTotal,
    },
    credits: typeof Game.market !== 'undefined' && typeof Game.market.credits === 'number' ? Game.market.credits : 0,
    colonies,
    creeps: { total: census.total, byRole: census.byRole },
    lastError: tickErrors.length
      ? { tick: Game.time, message: tickErrors[tickErrors.length - 1].slice(0, 500) }
      : bridge.state.lastError ?? null,
    heartbeat: Game.time,
    cpuBySubsystem: cpuRounded,
  };
  bridge.state = state;
  // WS-safe mirror: the screeps memory pubsub coerces object paths to
  // "[object Object]", so the bridge's watchState() subscribes to this string.
  bridge.stateJson = JSON.stringify(state);
}

export function writeAck(rev: number): void {
  const bridge = ensureBridgeMemory();
  if (bridge.ack.directiveVersion !== rev || typeof bridge.ack.appliedTick !== 'number') {
    bridge.ack = { directiveVersion: rev, appliedTick: Game.time };
  }
  // WS-safe mirror for the bridge's awaitAck() (see writeState).
  bridge.ackJson = JSON.stringify(bridge.ack);
}
