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
  /**
   * Role tag for the energy-link network (item A1) and mineral extraction (A2).
   * LINK structures carry one of 'core' (hub near storage), 'controller' (beside
   * the controller), 'source' (beside a source); this drives both placement order
   * — role-tagged links come first so they win the per-RCL link cap — and the A1b
   * runtime manager, which maps a built link back to its role via its plan entry.
   * A2 adds 'extractor' (the extractor, which sits ON the mineral tile) and
   * 'mineral' (the mineral container, adjacent to the mineral); these drive the
   * future harvest/haul managers (A2.2/A2.3). Left undefined on every other
   * structure. The union is a forward seam — keep it easy to extend.
   */
  role?: 'core' | 'controller' | 'source' | 'mineral' | 'extractor';
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
  /**
   * Structures: [packedCoord, typeIndex, unlockRcl, roleIndex?][]. The optional
   * 4th element indexes the planner's ROLE table (0 = no role); a missing 4th
   * element decodes as no role, so older 3-tuple plans stay readable.
   */
  s: Array<[number, number, number, number?]>;
  /** Rampart coords, packed. */
  r: number[];
  /** Road coords, packed. */
  d: number[];
}
