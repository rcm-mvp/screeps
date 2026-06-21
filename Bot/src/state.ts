/**
 * State + ack writer — the executor's half of the contract. Runs every tick
 * (small object; Memory is serialized every tick anyway) so the bridge/UI
 * heartbeat stays fresh.
 */
import type { ColonyState, ExecutorState } from './contract';
import type { BasePlanSummary } from './lib/planner/types';
import { ensureBridgeMemory } from './memory';
import { roomHeap } from './heap';
import { ownedRooms, bucket } from './lib/game';
import { SETTINGS } from './settings';

/**
 * Executor-side extension of the per-colony state: base-build progress from the
 * planner, and the room's mineral stockpile (item A2). Like `cpuBySubsystem`,
 * these are extra fields contract-unaware readers simply ignore — the canonical
 * contract stays frozen (no CONTRACT_VERSION bump). `mineral` reports the room's
 * native mineral type and how much of it sits in storage (the A2 pipeline's
 * sink); absent until the room actually has a mineral deposit.
 */
type ExecutorColonyState = ColonyState['colonies'][string] & {
  basePlan?: BasePlanSummary;
  mineral?: { type: MineralConstant; amount: number };
};

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

/** Carry a prior error forward only while it's within ERROR_TTL of now. */
function freshError(prev: ColonyState['lastError'] | undefined): ColonyState['lastError'] {
  if (!prev) return null;
  return Game.time - prev.tick <= SETTINGS.ERROR_TTL ? prev : null;
}

export function writeState(census: Census, tickErrors: string[], cpuBySubsystem: Record<string, number>): void {
  const bridge = ensureBridgeMemory();

  const colonies: Record<string, ExecutorColonyState> = {};
  for (const room of ownedRooms()) {
    const rh = roomHeap(room.name); // defense already populated it this tick
    const colony: ExecutorColonyState = {
      rcl: room.controller?.level ?? 0,
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
      creeps: census.byHome[room.name] ?? {},
      constructionSites: room.find(FIND_MY_CONSTRUCTION_SITES).length,
      threats: { hostiles: rh.hostiles, safeMode: (room.controller?.safeMode ?? 0) > 0 },
    };
    if (room.storage) colony.storageEnergy = room.storage.store[RESOURCE_ENERGY];
    if (room.memory.plan) colony.basePlan = room.memory.plan.summary;
    const mineral = room.find(FIND_MINERALS)[0];
    if (mineral) {
      colony.mineral = { type: mineral.mineralType, amount: room.storage?.store[mineral.mineralType] ?? 0 };
    }
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
    // Stamp this tick's error if any; otherwise carry the previous one only while
    // it's still fresh, so a single transient throw doesn't stick around forever.
    lastError: tickErrors.length
      ? { tick: Game.time, message: tickErrors[tickErrors.length - 1].slice(0, 500) }
      : freshError(bridge.state.lastError),
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
