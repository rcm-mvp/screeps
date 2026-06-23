/**
 * Memory hygiene: bootstrap the contract block, repair partial/corrupt shapes
 * without clobbering data the bridge already wrote, and clean dead creeps.
 */
import type { BridgeMemory, ColonyState } from './contract';
import { SETTINGS } from './settings';
import { log } from './lib/log';

export function emptyState(): ColonyState {
  return {
    tick: 0,
    cpu: { used: 0, limit: 0, bucket: 0 },
    gcl: { level: 0, progress: 0, progressTotal: 0 },
    credits: 0,
    colonies: {},
    creeps: { total: 0, byRole: {} },
    lastError: null,
    heartbeat: 0,
  };
}

/**
 * Idempotent. Fills only missing/broken keys so a directive the bridge wrote
 * before the executor first ran is never lost.
 */
export function ensureBridgeMemory(): BridgeMemory {
  if (!Memory.creeps) Memory.creeps = {};
  if (!Memory.rooms) Memory.rooms = {};

  const existing = Memory.bridge;
  if (!existing || typeof existing !== 'object') {
    Memory.bridge = {
      version: SETTINGS.CONTRACT_VERSION,
      directives: {},
      state: emptyState(),
      ack: { directiveVersion: 0, appliedTick: 0 },
    };
    log.info(`bridge memory initialised (contract v${SETTINGS.CONTRACT_VERSION})`);
    return Memory.bridge;
  }

  if (typeof existing.version !== 'number') existing.version = SETTINGS.CONTRACT_VERSION;
  if (!existing.directives || typeof existing.directives !== 'object') existing.directives = {};
  if (!existing.state || typeof existing.state !== 'object') existing.state = emptyState();
  if (!existing.ack || typeof existing.ack !== 'object') {
    existing.ack = { directiveVersion: 0, appliedTick: 0 };
  }
  return existing;
}

export function cleanCreepMemory(): void {
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) delete Memory.creeps[name];
  }
}

/**
 * Adopt creeps the executor didn't spawn (e.g. left over from previous code in
 * an already-running room). Without a `home` the movement helpers feed an
 * `undefined` room name into `RoomPosition`, which throws `roomNameToXY` every
 * tick. Backfill `home` to wherever the creep currently is, and give it a
 * default role so it does useful work instead of idling.
 */
export function adoptCreeps(): void {
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const mem = creep.memory;
    if (!mem.home) mem.home = creep.room.name;
    if (!mem.role) {
      // Assign a role compatible with the creep's body so it does useful work
      // instead of silently failing (e.g. a pure hauler can't upgrade).
      const body = creep.body;
      const hasWork = body.some((p) => p.type === WORK);
      const hasCarry = body.some((p) => p.type === CARRY);
      const hasAttack = body.some((p) => p.type === ATTACK);
      const hasRanged = body.some((p) => p.type === RANGED_ATTACK);
      if (hasAttack || hasRanged) mem.role = 'defender';
      else if (hasCarry && !hasWork) mem.role = 'hauler';
      else if (hasWork && hasCarry) mem.role = 'upgrader';
      else mem.role = 'upgrader'; // safe default — WORK-only or unknown
    }
  }
}
