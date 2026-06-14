/**
 * Observational shapes for executor-owned Memory the scenarios inspect
 * (`Memory.plan`, `Memory.creeps`). These are NOT contract types — the
 * contract lives in the bridge's contract.ts and is imported from there.
 * The executor's plan/creep memory is internal to Bot/; the harness only
 * reads a few fields of it to verify observable behaviour, so it keeps
 * minimal structural copies here instead of importing Bot internals (which
 * would defeat the "test the artifact, not the source" rule).
 */

/** Shape of the strategy plan the executor caches at `Memory.plan`. */
export interface StrategyPlanLike {
  tick: number;
  rev: number;
  posture: string;
  colonies: Record<
    string,
    {
      quotas: Record<string, number>;
      claimTargets: string[];
      attackTargets: string[];
      scoutTargets: string[];
    }
  >;
}

/** Shape of one entry in `Memory.creeps` (only fields the harness reads). */
export interface CreepMemoryLike {
  role?: string;
  home?: string;
  targetRoom?: string;
  route?: string[];
}
