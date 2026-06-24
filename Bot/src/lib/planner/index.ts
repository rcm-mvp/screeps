/**
 * Public surface of the automated base planner. The construction manager uses
 * the cache + placement helpers; the rest is exported for the smoke harness.
 */
export { planRoom, getCachedPlan, invalidate, segmentReady, nextSites, summarize, computePlan, encodePlan, decodePlan } from './plan';
export type { PlaceCtx } from './plan';
export { drawPlan } from './overlay';

// Pipeline pieces (exported for tests):
export { distanceTransform, idx } from './distanceTransform';
export { selectAnchor } from './anchor';
export { STAMP_RADIUS, STAMP_STRUCTURE_COUNT, bunkerStructures, bunkerRoads, stampFits, tileFits, bunkerFragments } from './stamp';
export type { CouplingTier, Fragment } from './stamp';
export { minCutRamparts } from './mincut';
export { planRoads, planRoadsPure, findPath, isReachable } from './roads';
export { fitStructures } from './fit';
export type { FitInput, FitResult } from './fit';
export { buildPlan } from './core';
export type { BuildPlanInput } from './core';
export type { RoomPlan, PlannedStructure, BasePlanSummary, PlanPointer, PackedPlan } from './types';
