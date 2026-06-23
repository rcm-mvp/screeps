# Bot DONE — completed work

## A. Blocking / high-value for RCL5→6

### A1. Link energy network ✅ DONE
*(Implemented: `PlannedStructure.role` tags links 'core'/'controller'/'source';
planner derives a controller-adjacent link + per-source links; `managers/links.ts`
classifies built links onto the heap and forwards sender→controller; haulers fill
sender links below spawn/tower priority; upgraders drain the controller link.
`PLAN_VERSION` bumped to 2 → one bucket-gated replan on first deploy.)*

Original analysis (kept for reference):
- **Where:** `lib/planner/stamp.ts:42` reserves link tiles tagged `{5:2, 6:3,
  7:4, 8:6}` and `construction.ts` will happily place them once RCL5/6 unlock
  them. There is **no `managers/links.ts`** — grep for `STRUCTURE_LINK` outside
  `lib/planner/` returns nothing.
- **Problem:** as soon as RCL5 lands, the planner places 2 links and they sit
  full/empty forever — wasted extension-equivalent energy and CPU on placement
  bookkeeping for structures that do nothing.
- **Needed:** a tiny manager (`managers/links.ts`, called from `main.ts`
  per-room per-tick, cheap — link checks are just `store` reads) that:
  1. Identifies which planned link is the "source" link (nearest a source) vs
     the "controller" link (nearest the controller) — the stamp only tags
     unlock RCL today, not a role, so this needs either a runtime
     nearest-neighbour lookup or a new field on `PlannedStructure`
     (`lib/planner/types.ts`).
  2. Transfers source-link → controller-link via `StructureLink#transferEnergy`
     once the source link has a worthwhile amount and is off cooldown.
  3. Optionally feeds the controller link's energy to nearby upgraders via the
     existing `findDeliveryTarget`/`resolveFill` paths (or let upgraders just
     withdraw from the controller-link directly).
- **Why now:** this is the single highest-value RCL5 unlock and currently 100%
  dead weight.

### A2. Mineral extraction pipeline ✅ DONE
*(Implemented across A2.1–A2.4: planner extractor + mineral container; a
`mineralMiner` role gated on RCL6 + extractor + non-empty deposit; hauler/
logistics generalized to move minerals (container → storage) with energy always
winning; and `colony.mineral` surfaced in state as a non-breaking executor-side
extension. A review-caught mineral-load deadlock was fixed. Validated by 91 smoke
checks + `scenario-k`; live `itest`/deploy still pending.)*

Original analysis (kept for reference):

> **Seams A1 left for this:** `PlannedStructure.role` (in `lib/planner/types.ts`)
> is a deliberately-extendable union — add `'mineral'`/`'extractor'` roles and
> tag the extractor + mineral container the same way A1 tags links. The planner's
> special-positioning pattern (derive a structure adjacent to a key tile, mark it
> `occupied`, append to `structures`) in `lib/planner/plan.ts#computePlan` is the
> template. The heap-publish pattern in `managers/links.ts` (classify → write ids
> to `RoomHeapEntry` → consumers read) is the template for a mineral hauler tier.

- **Where:** RCL6 unlocks `STRUCTURE_EXTRACTOR`. Grepping the whole `Bot/src`
  tree for `extractor`/`mineral` only turns up *pathing* references (the
  planner makes sure the mineral is reachable) — there is no extractor in the
  stamp's shopping list (`lib/planner/stamp.ts`), no mineral-harvesting role,
  and `roles/hauler.ts` / `managers/logistics.ts` are hardcoded to
  `RESOURCE_ENERGY` only, so even a manually-placed extractor would be useless.
- **This is a multi-part feature — split into its own follow-on prompts:**
  1. **Placement:** add `STRUCTURE_EXTRACTOR` to the plan, placed directly on
     the mineral tile (it's a single fixed-position structure, not part of the
     checkerboard stamp — same special-case treatment as the source/controller
     containers in `lib/planner/plan.ts`).
  2. **Harvesting role:** a creep (new role, or a `miner` variant) parked on
     the mineral with enough `WORK` to use the extractor when
     `mineral.mineralAmount > 0` (it regenerates slowly after depletion —
     don't spawn into an empty mineral).
  3. **Hauling:** generalize `roles/hauler.ts` / `managers/logistics.ts` (today
     `Pickup`/`LogisticsPickup` types and every find/withdraw/transfer call
     assume `RESOURCE_ENERGY`) to move arbitrary resources from a mineral
     container into storage.
  4. **Visibility:** report the mineral stockpile in `ColonyState`
     (`API/src/contract.ts`) the same way `storageEnergy` is today — this is a
     contract change, bump `CONTRACT_VERSION` (see `Bot/README.md`'s "Contract
     changes" note).
- **Why now:** extractor unlocks exactly at RCL6; if this waits, that's fine
  (minerals aren't economy-critical), but it should be tracked as a known gap
  rather than rediscovered later.

### A3. Builder site priority ✅ DONE
*(Implemented: `BUILD_PRIORITY` now mirrors the planner's `TYPE_PRIORITY` —
link/terminal/lab/extractor rank above roads.)*

Original analysis (kept for reference):
- **Where:** `roles/builder.ts`'s `BUILD_PRIORITY` table only ranks
  spawn/extension/tower/container/storage/road; anything else (link, terminal,
  lab, extractor) falls through to the default priority `9` — the *same* as
  roads, the lowest tier. Compare to `lib/planner/plan.ts`'s `TYPE_PRIORITY`,
  which already orders these correctly (link/terminal/lab ranked above roads).
- **Problem:** if a builder has both a half-built road and a link site open at
  once, it picks whichever is closer rather than the economically important
  one.
- **Fix:** extend `BUILD_PRIORITY` to mirror `TYPE_PRIORITY`'s ordering
  (link/terminal/lab before road). Small, mechanical, low-risk — good
  first/warm-up prompt.

### A4. Worker body sizes ✅ DONE
*(Implemented: `SETTINGS.WORKER_MAX_SEGMENTS=12` / `HAULER_MAX_SEGMENTS=10` so
bodies fill RCL5/6 capacity; upgrader quota left conservative with a rationale
comment. A WORK-heavy upgrader parked at the controller link is the next refinement
— see the seam comment in `lib/bodies.ts`.)*

Original analysis (kept for reference):
- **Where:** `lib/bodies.ts#bodyFor` → `repeat()` caps `harvester`/`upgrader`/
  `builder` at `maxSegments = 6` → max 900 energy spent on body, and `hauler`
  at 8 segments → max 1200 energy — regardless of `energyCapacityAvailable`,
  which is **1800 at RCL5 and 2300 at RCL6**.
- **Problem:** `Controller#upgradeController` has **no per-tick energy cap
  below RCL8** — more `WORK` parts on upgraders directly means faster RCL
  progress. Capping upgrader bodies at 6×`WORK` leaves RCL5/6 extension
  capacity unused exactly during the RCL5→6 push, where upgrade speed is the
  bottleneck.
- **Needed:** revisit `maxSegments` (or switch to a cap derived from
  `room.energyCapacityAvailable` / a `SETTINGS` constant) specifically for
  `upgrader`, and re-check `upgrader` quota math in
  `strategy/index.ts#computeQuotas` (currently flat 2, +1 only past 100k
  storage energy) against the bigger body size. Validate CPU cost doesn't
  regress (bigger creeps run cheaper per energy delivered, but confirm via
  `cpuBySubsystem`).
- **Why now:** directly speeds up the thing the user is actively doing
  (pushing RCL5→6).

---

## Status notes

**Validated by** `Bot/ npm run typecheck` + `npm run smoke` (91 checks incl. new
mineral planner/hauler/logistics scenarios, all green) and `Integration/ npm run
typecheck` + `npm run test:hermetic`.

**STILL TO RUN BEFORE DEPLOY (could not run here — no docker access for this
user):** `cd Integration && npm run itest` (full A–K suite against the dockerised
server). End-to-end gate for BOTH the A1/A3/A4 and the A2 waves. Then `cd Bot &&
npm run deploy`. After deploy: at RCL6, confirm the extractor gets built, a
`mineralMiner` spawns, and `colony.mineral.amount` starts climbing as minerals
reach storage.

---

## Code review fixes (2026-06-23)

### CR1. Storage not added as a pickup when only links need filling ✅ DONE
*(Implemented: `managers/logistics.ts` now checks for sender links with free
capacity and includes them in the "any delivery needs" gate. Storage is
advertised as a pickup when spawns/towers are full but links need energy, so
haulers feed the link network instead of rallying idle.)*

### CR2. Room name regex in `directives.ts` is too restrictive ✅ DONE
*(Implemented: `ROOM_NAME_RE` changed from `/^[WE]\d{1,2}[NS]\d{1,2}$/` to
`/^[WE]\d+[NS]\d+$/` to match `lib/movement.ts` and accept coordinates beyond
99.)*

### CR3. Rampart repair threshold is dangerously low ✅ DONE
*(Implemented: added `RAMPART_REPAIR_RCL_THRESHOLDS` to `SETTINGS` (10k at
RCL1-3, 25k at RCL4, 50k at RCL5, 100k at RCL6, 200k at RCL7, 300k at RCL8).
Exported `rampartRepairThreshold(rcl)` from `managers/defense.ts`; both
`defense.ts` and `roles/builder.ts` now use it instead of the hardcoded
10000.)*

### Q1. Defender body is too simple ✅ DONE
*(Implemented: `lib/bodies.ts` defender body changed from `[ATTACK, MOVE]×8` to
`[TOUGH, ATTACK, MOVE, MOVE]` scaled to capacity (max 4 segments). TOUGH tanks
first, 2 MOVE per segment for roadless movement. Falls back to `[ATTACK, MOVE]`
at low energy.)*

### Q2. Mineral miner doesn't recycle when mineral depletes ✅ DONE
*(Implemented: `roles/mineralMiner.ts` now calls `creep.suicide()` when
`mineral.mineralAmount === 0`, freeing the creep immediately instead of idling
for ~30,000 ticks until regeneration. The strategy layer already drops the
quota to 0 so no replacement spawns.)*

### Q3. Adopted creeps get `upgrader` regardless of body ✅ DONE
*(Implemented: `memory.ts#adoptCreeps` now checks body composition: ATTACK/
RANGED_ATTACK → defender, CARRY without WORK → hauler, WORK+CARRY → upgrader.
Prevents silently-failing role assignments.)*

### Q4. `findDeliveryTarget` duplicates logistics logic ✅ DONE
*(Implemented: `roles/common.ts#findDeliveryTarget` now reads from the heap
snapshot (`fillsCore`, `fillsTower`, `sink`) when it's fresh for the current
tick, avoiding duplicate `room.find()` calls. Falls back to direct find when
logistics was skipped (bucket critical).)*

### Q5. Builder count might be low for large base plans ✅ DONE
*(Implemented: `strategy/index.ts#computeQuotas` builder quota changed from
flat `2` to `Math.min(4, Math.max(2, Math.ceil(sites / 10)))` — scales with the
construction backlog, capped at 4.)*

### RCL2. No pre-spawn / creep renewal ✅ DONE
*(Implemented: `managers/spawn.ts` now counts creeps with
`ticksToLive < 150` (10% of CREEP_LIFE_TIME) as "dying" per role. The quota
check uses `liveCount - dyingCount >= quota` so a replacement spawns before the
old creep dies, avoiding income gaps.)*

### RCL3. Hauler quota is tight at RCL 3-4 ✅ DONE
*(Implemented: `strategy/index.ts#computeQuotas` hauler quota changed from
`Math.max(1, sourceContainers)` to `Math.max(2, sourceContainers)` — at least
2 haulers per room once containers exist, so extension refills aren't delayed
when both haulers are at remote containers.)*

**Validated by** `Bot/ npm run typecheck` + `npm run smoke` (112 checks, all
green — 21 new tests for CR1-CR3, Q1-Q5, RCL2-RCL3) and `Integration/ npm run
typecheck` + `npm run test:hermetic`.