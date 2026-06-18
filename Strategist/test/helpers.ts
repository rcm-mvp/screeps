/** Shared factories for building ColonyState snapshots in tests. */

import type { ColonyState, CommanderSnapshot, Directives } from 'screeps-web-api-bridge';

type Colony = ColonyState['colonies'][string];

export function colony(over: Partial<Colony> = {}): Colony {
  return {
    rcl: 4,
    energyAvailable: 300,
    energyCapacity: 300,
    storageEnergy: 0,
    creeps: {},
    constructionSites: 0,
    threats: { hostiles: 0, safeMode: false },
    ...over,
  };
}

export function state(over: Partial<ColonyState> = {}): ColonyState {
  return {
    tick: 1000,
    cpu: { used: 10, limit: 20, bucket: 10_000 },
    gcl: { level: 1, progress: 0, progressTotal: 1000 },
    credits: 0,
    colonies: { W1N1: colony() },
    creeps: { total: 3, byRole: { harvester: 1, upgrader: 1, hauler: 1 } },
    lastError: null,
    heartbeat: 1000,
    ...over,
  };
}

export function snap(s: ColonyState | null, directives: Directives = {}): CommanderSnapshot {
  return { state: s, directives, ack: null };
}
