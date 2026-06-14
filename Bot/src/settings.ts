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
