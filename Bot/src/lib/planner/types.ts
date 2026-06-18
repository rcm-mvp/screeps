/**
 * Shared base-planner types. Kept in one tiny module so both the global
 * `RoomMemory` augmentation (types.d.ts) and the state writer (state.ts) can
 * import the summary shape without pulling in the planner's runtime code.
 */

/** A structure the planner wants built, with the RCL at which it unlocks. */
export interface PlannedStructure {
  x: number;
  y: number;
  type: BuildableStructureConstant;
  /** Minimum controller level at which this structure may be placed. */
  rcl: number;
}

/** The full, decoded plan for one room (lives in a RawMemory segment). */
export interface RoomPlan {
  /** PLAN_VERSION this plan was computed under (for invalidation). */
  v: number;
  /** Tick the plan was computed. */
  at: number;
  anchor: { x: number; y: number };
  structures: PlannedStructure[];
  ramparts: Array<{ x: number; y: number }>;
  roads: Array<{ x: number; y: number }>;
}

/**
 * Compact progress summary mirrored into `RoomMemory.plan` and surfaced into
 * `state` for the UI. Small enough to keep in Memory (serialized every tick).
 */
export interface BasePlanSummary {
  anchor: [number, number];
  /** Controller level the summary was last refreshed at. */
  rcl: number;
  /** Structures already standing that the plan called for. */
  built: number;
  /** Total structures + ramparts + roads in the plan. */
  planned: number;
  ramparts: number;
  roads: number;
  /** Completion percent (0–100), built / planned. */
  pct: number;
}

/** Pointer stored in RoomMemory; the heavy plan itself lives in the segment. */
export interface PlanPointer {
  /** PLAN_VERSION of the cached plan. */
  v: number;
  /** RawMemory segment id holding the plan. */
  seg: number;
  summary: BasePlanSummary;
}

/**
 * Wire format stored in the RawMemory segment (a roomName→PackedPlan map).
 * Coords are packed `x*50+y`; structure type is an index into the planner's
 * TYPES table. Keeps the segment small.
 */
export interface PackedPlan {
  v: number;
  at: number;
  /** Anchor, packed. */
  a: number;
  /** Structures: [packedCoord, typeIndex, unlockRcl][]. */
  s: Array<[number, number, number]>;
  /** Rampart coords, packed. */
  r: number[];
  /** Road coords, packed. */
  d: number[];
}
