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
export { STAMP_RADIUS, STAMP_STRUCTURE_COUNT, bunkerStructures, bunkerRoads, stampFits } from './stamp';
export { minCutRamparts } from './mincut';
export { planRoads } from './roads';
export type { RoomPlan, PlannedStructure, BasePlanSummary, PlanPointer, PackedPlan } from './types';
