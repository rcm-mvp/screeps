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
  /** Max [WORK,CARRY,MOVE] segments for harvester/upgrader/builder bodies.
   *  Raised from 6 (1200e) to 12 so bodies fill RCL5/6 capacity (1800/2300e);
   *  12 segments cost 2400e, enough to consume RCL6's 2300. Still bounded by the
   *  energy budget and the 50-part game limit. Revisit at RCL7/8 (capacity
   *  5600/10000) where much larger bodies become affordable. */
  WORKER_MAX_SEGMENTS: 12,
  /** Max [CARRY,CARRY,MOVE] segments for hauler bodies. Raised from 8 (1200e) to
   *  10 (1500e) so haulers fill RCL5/6 capacity (1800/2300e). Revisit at RCL7/8. */
  HAULER_MAX_SEGMENTS: 10,
  /** Max WORK parts on a mineral (extractor) miner. More WORK = a bigger batch per
   *  EXTRACTOR_COOLDOWN (5t), but minerals aren't time-critical and the container
   *  holds 2000, so it's capped. 8 WORK harvests 8/5≈1.6 mineral/tick. */
  MINERAL_MINER_MAX_WORK: 8,

  // Links (energy network — see managers/links.ts)
  /** A sender link (core/source) only forwards to the controller link once it
   *  holds at least this much energy. A link's capacity is 800; sending costs a
   *  flat 3% (24e on a full 800 send) and starts a 1-tick/range cooldown, so
   *  batching matters. 400 (half capacity) balances throughput against waste:
   *  large enough that the loss is a small fraction and we don't burn a cooldown
   *  on a trickle, small enough to keep the controller link — the upgrade
   *  bottleneck — fed promptly. The API caps the transfer at the receiver's free
   *  space, so a partially-full controller link still gets topped without spill. */
  LINK_MIN_SEND: 400,

  // Construction
  MAX_SITES_PER_ROOM: 12,

  // Base planner (see lib/planner/). Planning is heavy (distance transform +
  // min-cut), so it runs ONCE per room, cached to a RawMemory segment, and is
  // gated behind a healthy bucket. Per-tick work is just cheap site placement.
  /** Only compute a new plan when the bucket is at least this — never defense. */
  PLAN_BUCKET: 9000,
  /** RawMemory segment holding the roomName→plan map. 0–99; pick one nobody else uses. */
  PLAN_SEGMENT: 90,
  /** Layout/schema version. Bump to invalidate every cached plan and force a replan.
   *  v2 (A1): packed structures gained a 4th role element and the planner now
   *  derives role-tagged links (controller/source endpoints + a core hub), so
   *  every v1 plan must be recomputed.
   *  v3 (A2): the planner now places a mineral extractor (on the mineral tile) +
   *  an adjacent mineral container, so v2 plans must be recomputed. */
  PLAN_VERSION: 3,
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
  /** Ramparts are only repaired below this fraction of their max hits. Scales
   *  with RCL via rampartRepairThreshold() — at low RCL ramparts are cheap and
   *  rarely attacked, so the threshold stays low; at RCL5+ it rises so a single
   *  attack tick can't destroy a rampart that's been deemed "fine". */
  RAMPART_REPAIR_RCL_THRESHOLDS: { 1: 10000, 2: 10000, 3: 10000, 4: 25000, 5: 50000, 6: 100000, 7: 200000, 8: 300000 } as Record<number, number>,
  /** Safe mode triggers when a spawn drops below this hits fraction with hostiles present. */
  SAFE_MODE_SPAWN_HP: 0.5,
  /** Min ticks between Game.notify mails per room. */
  NOTIFY_COOLDOWN: 500,
} as const;
