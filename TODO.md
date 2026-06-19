# Bot TODO — closing the RCL5→6(→8) gap

## Status (2026-06-19)

**Done this session (branch `rcl6-economy`, merged to `main`, NOT yet deployed):**
- ✅ **A1** — link energy network (planner role-tagging + runtime `managers/links.ts`
  + hauler/upgrader integration). A review caught and fixed an inverted
  `senderLinks` publish filter that would have left the network inert.
- ✅ **A3** — builder site-priority mirrors the planner.
- ✅ **A4** — worker/hauler bodies scale to RCL5/6 energy capacity.
- ✅ Integration harness fixed (auth mod pin + `setPassword` dual-path) and a
  loop-regression scenario (`scenario-j`) added.

**Validated by** `Bot/ npm run typecheck` + `npm run smoke` (link, planner, traffic,
and a spawn-priority regression guard all green) and `Integration/ npm run typecheck`
+ `npm run test:hermetic`.

**STILL TO RUN BEFORE DEPLOY (could not run here — no docker access for this
user):** `cd Integration && npm run itest` (full A–J suite against the dockerised
server). This is the end-to-end gate. Then `cd Bot && npm run deploy`.

**Not started (next waves):** A2 (minerals), B1–B3, C1–C5 below — unchanged.

## Context

`Bot/README.md` says the bot's baseline (zero directives) self-sustains to
**~RCL3**, and most of the existing economy code (`roles/miner.ts`,
`roles/hauler.ts`, `managers/logistics.ts`, `managers/spawn.ts`,
`lib/bodies.ts`, `managers/construction.ts`) predates the base planner and was
written/tuned for an RCL1–4 colony. The base planner (`lib/planner/`) plans
the *full* RCL1–8 bunker layout (it tags every structure with its unlock RCL),
but several RCL5/6 structures it places have **no operational code behind
them** — they get built and then sit there doing nothing.

We're at RCL5 now, ~2 days from RCL6. This file is the gap list: each numbered
item below is meant to be scoped tightly enough to hand to a fresh session as
its own self-contained prompt later, one problem at a time. Don't batch
several items into one prompt — they're split for a reason (separate files,
separate testing, separate review).

Sections are priority-ordered: **A = needed for/around the RCL6 push, B = RCL6
polish (soon after), C = explicitly parked for RCL7/8 (long way off, do not
start)**.

---

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

### A2. Mineral extraction pipeline is entirely missing
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

## B. RCL6 polish (after A lands, before pushing toward RCL7)

### B1. No lab / mineral-reaction / boosting logic
- **Where:** `lib/planner/stamp.ts:47` reserves 3 lab tiles at RCL6; zero
  runtime code touches `STRUCTURE_LAB`.
- **Needed:** depends on A2 (minerals) landing first — a minimal reaction
  pipeline (run a compound, boost a role) is a sizeable feature on its own.
  Don't start until there's a mineral economy to feed it.

### B2. Terminal exists only as a placed structure
- **Where:** `managers/logistics.ts#runInterColonyLogistics` is an
  intentional no-op stub (already documented in the file and in
  `Bot/README.md`'s "Evolving it" section).
- **Status:** correctly deferred — fine while there's one owned room. Revisit
  once a second colony exists, or once A2's mined minerals need
  market/terminal offloading.

### B3. Defender is melee-only
- **Where:** `roles/defender.ts` + `lib/bodies.ts` only ever build
  `[ATTACK, MOVE]`. No ranged/heal variant.
- **Status:** acceptable for now (current threats are weak NPC invaders); flag
  for hardening once attacks get more serious, no urgency at RCL5/6.

---

## C. Parked — RCL7/8, do not start yet

- **C1. Multi-spawn coordination (RCL7 2nd spawn, RCL8 3rd):**
  `managers/spawn.ts#runSpawn` grabs the *first* free spawn in the room and
  returns after one attempt; with 2–3 spawns it'll only ever drive one of them
  per tick. Needs a per-spawn (not per-room) dispatch loop. RCL7 is far off —
  just noting so it isn't a surprise later.
- **C2. PowerSpawn / power creeps (RCL8).**
- **C3. Observer (RCL8)** — would let scouting run without physical scout
  creeps; low value until multi-room expansion is real.
- **C4. Nuker (RCL8).**
- **C5. Roles → task queue system** — already called out in
  `Bot/README.md`'s "Evolving it" section as a deliberate architecture seam
  (`roles/index.ts`'s runner table → a claim-and-execute scheduler). Not
  RCL-gated, no urgency; tracked here only for completeness.

---

## How to use this file

Each item (A1…C5) is scoped to be its own implementation prompt: it names the
files involved, the current behavior, and what's missing. When picking one up
in a fresh session, hand over just that item's text plus a pointer to this
file and `Bot/README.md`'s architecture section — don't bundle multiple items
into one prompt, they're independently testable (`npm run smoke` /
`npm run typecheck` in `Bot/`).
