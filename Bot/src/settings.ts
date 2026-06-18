/** All tunables in one place. */
export const SETTINGS = {
  /** Bumped on breaking contract change; must match the bridge's expectation. */
  CONTRACT_VERSION: 1,

  // Cadence (primes, so the gated jobs don't all land on the same tick)
  STRATEGY_INTERVAL: 23,
  CONSTRUCTION_INTERVAL: 47,
  ROAD_REPLAN_INTERVAL: 5003,
  HEARTBEAT_EVERY: 10,

  // CPU bucket policy
  /** Below this: defense/spawn/creeps only — skip logistics, strategy refresh, construction. */
  BUCKET_CRITICAL: 500,
  /** Below this: skip the periodic strategy refresh and construction planning. */
  BUCKET_LOW: 2000,
  GENERATE_PIXEL: true,

  /** Drop state.lastError after this many ticks with no recurrence, so a one-off
   *  throw doesn't haunt the UI/strategist digest forever. */
  ERROR_TTL: 500,

  // Directive validation clamps
  MAX_QUOTA: 20,
  MAX_TARGET_ROOMS: 10,
  MAX_ROLE_NAME_LEN: 32,

  // Economy
  /** energyCapacityAvailable needed before static miners replace harvesters. */
  MINER_CAPACITY_MIN: 550,
  EMERGENCY_BODY_MIN: 200,

  // Construction
  MAX_SITES_PER_ROOM: 12,

  // Base planner (see lib/planner/). Planning is heavy (distance transform +
  // min-cut), so it runs ONCE per room, cached to a RawMemory segment, and is
  // gated behind a healthy bucket. Per-tick work is just cheap site placement.
  /** Only compute a new plan when the bucket is at least this — never defense. */
  PLAN_BUCKET: 9000,
  /** RawMemory segment holding the roomName→plan map. 0–99; pick one nobody else uses. */
  PLAN_SEGMENT: 90,
  /** Layout/schema version. Bump to invalidate every cached plan and force a replan. */
  PLAN_VERSION: 1,
  /** Max construction sites the planner places per room per construction tick. */
  PLACE_PER_TICK: 5,
  /** Hard ceiling on total construction sites the game allows account-wide. */
  MAX_SITES_GLOBAL: 100,
  /** Tiles of slack added around the stamp footprint before the min-cut. */
  MINCUT_MARGIN: 2,
  /** Anchor must sit at least this many tiles from the nearest room exit. */
  EXIT_MARGIN: 5,
  /** Toggle the RoomVisual plan overlay (debug only — costs a little CPU). */
  PLAN_OVERLAY: false,

  // Defense
  /** Towers keep this much energy in reserve before spending on repairs. */
  TOWER_REPAIR_RESERVE: 500,
  /** Towers don't top structures up beyond this (walls/ramparts excluded anyway). */
  TOWER_REPAIR_MAX_HITS: 100000,
  /** Safe mode triggers when a spawn drops below this hits fraction with hostiles present. */
  SAFE_MODE_SPAWN_HP: 0.5,
  /** Min ticks between Game.notify mails per room. */
  NOTIFY_COOLDOWN: 500,
} as const;
