import type { BridgeMemory, StrategyPlan } from './contract';
import type { PlanPointer } from './lib/planner/types';

declare global {
  // Sandbox globals not covered by @types/screeps (no DOM/Node libs in play).
  const console: { log(...args: unknown[]): void };
  var global: Record<string, unknown>;

  interface Memory {
    /** Shared contract channel — see contract.ts. Bootstrapped by ensureBridgeMemory(). */
    bridge?: BridgeMemory;
    /** Cached strategic plan (written every STRATEGY_INTERVAL ticks or on directive change). */
    plan?: StrategyPlan;
  }

  interface CreepMemory {
    role: string;
    home: string;
    working: boolean;
    /** Assigned source (harvester/miner). */
    src?: Id<Source>;
    /** Current pickup/withdraw target. */
    target?: string;
    /** Destination room (claimer, defender on war dispatch). */
    targetRoom?: string;
    /** Patrol route (scout). */
    route?: string[];
    routeIdx?: number;
    /** Stuck detection for travelTo. */
    _mv?: { x: number; y: number; r: string; n: number };
  }

  interface RoomMemory {
    lastNotifyAt?: number;
    /** Base-plan pointer: version + segment id + compact progress summary. The
     *  heavy plan (structures/ramparts/roads) lives in the RawMemory segment. */
    plan?: PlanPointer;
    intel?: { scoutedAt: number; sources: number; owner?: string; level?: number; hostiles: number };
  }
}

export {};
