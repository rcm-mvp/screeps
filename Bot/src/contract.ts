/**
 * Shared Memory contract — re-exported from the bridge package.
 *
 * The single source of truth lives in API/src/contract.ts (published locally
 * as `screeps-web-api-bridge`); the bridge, the UI, and this executor all
 * import the exact same types.
 *
 * TYPE-ONLY on purpose: the bridge is a Node library (ws, zlib). Importing any
 * runtime value from it would pull Node-only code into the game bundle.
 * `export type` / `import type` are erased by esbuild, so nothing of the
 * bridge ships to the server. Never add a runtime import of that package here.
 */
export type { BridgeMemory, ColonyState, Directives, DirectiveAck } from 'screeps-web-api-bridge';

import type { ColonyState, Directives } from 'screeps-web-api-bridge';

export type Posture = NonNullable<Directives['posture']>;

/** Built-in roles this executor knows how to spawn and run. */
export type RoleName =
  | 'harvester'
  | 'hauler'
  | 'upgrader'
  | 'builder'
  | 'miner'
  | 'defender'
  | 'claimer'
  | 'scout';

/**
 * Executor-side extension of the contract state: per-subsystem CPU cost.
 * Extra field — contract readers that don't know it simply ignore it.
 */
export type ExecutorState = ColonyState & { cpuBySubsystem?: Record<string, number> };

/** Per-colony output of the strategic layer. */
export interface ColonyPlan {
  quotas: Record<string, number>;
  claimTargets: string[];
  attackTargets: string[];
  scoutTargets: string[];
}

/**
 * Cached strategic plan, written to Memory by runStrategy() and followed by
 * the tactical layer every tick (plan periodically, execute every tick).
 */
export interface StrategyPlan {
  tick: number;
  /** Directive revision this plan was computed from. */
  rev: number;
  posture: Posture;
  colonies: Record<string, ColonyPlan>;
}
