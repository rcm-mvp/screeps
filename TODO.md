# Bot TODO — outstanding work

## Status (2026-06-23)

Completed items (A1–A4, CR1–CR3, Q1–Q5, RCL2–RCL3) moved to `DONE.md`.
This file now holds only outstanding work: the remaining RCL 3-4 gaps,
RCL6 polish items, architecture observations, and parked/minor items.

**Before deploy:** run `cd Integration && npm run itest` (full A–K suite
against the dockerised server), then `cd Bot && npm run deploy`.

---

## RCL. RCL 3-4 gaps (important for current level)

### RCL1. No remote mining — the single biggest economic gap
- **Where:** No remote miner / remote hauler role exists.
  `strategy/index.ts` only counts sources in the owned room.
- **Problem:** At RCL 3-4, remote mining (harvesting sources in unowned adjacent
  rooms with a miner + hauler, optionally a reserver) is the **standard way** to
  double or triple income before having GCL for a second room. A single room
  with 2 sources caps at ~20 energy/tick. With 2-4 remote mining sites, you
  could be at 40-60 energy/tick — dramatically speeding up the RCL 5→6 push.
- **Needed:** New `remoteMiner` role (static miner on a remote source, drops to
  a container), `remoteHauler` role (container → home storage, multi-room
  pathing), and strategy logic to pick remote rooms from
  `Memory.rooms[*].intel` (scout data). Optionally a `reserver` to claim the
  controller for exclusive source access.
- **Effort:** Large feature — new roles + strategy + multi-room logistics.
- **Note:** This is the natural first step toward the task system (see ARCH1)
  — remote mining as a "role" is painful; as a "job" it's clean. Consider
  doing ARCH1 first or together with this.

### RCL4. No storage before RCL 4 — surplus energy has no sink
- **Where:** `roles/hauler.ts` — haulers with full energy and nothing to fill
  rally idle.
- **Problem:** Before RCL 4 (storage unlock), source containers fill up, miners
  waste harvest ticks, and energy is lost. Upgraders help (they pull from
  containers via `acquireEnergy`), but there's no dedicated "surplus →
  controller" path.
- **Fix:** Have haulers dump energy at the controller container, or boost
  upgrader count when storage is absent.

---

## B. RCL6 polish (after RCL items land, before pushing toward RCL7)

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
- **Where:** `roles/defender.ts` + `lib/bodies.ts` — defender body now has
  TOUGH (Q1 fix) but still no ranged/heal variant.
- **Status:** acceptable for now (current threats are weak NPC invaders);
  flag for hardening once attacks get more serious.

---

## ARCH. Architecture observations (longer-term, not RCL-gated)

These are not bugs — they're structural notes from the code review. Tracked
here so they inform the order of future work, not as immediate action items.

### ARCH1. Roles → task system (do before remote mining)
- **Where:** `roles/index.ts` — `ROLE_RUNNERS` table maps role string →
  function. Quotas are role *counts*.
- **Observation:** The role system is rigid. Adding remote mining means a new
  role, new quota logic, new body, new runner. A creep can only be one thing
  (a hauler with nothing to haul can't help build). "I need 3 creeps to harvest
  source X" and "I need someone to build the extractor" are fundamentally the
  same problem, but they're handled by completely different code paths.
- **Recommendation:** A task/job system — the strategy layer emits jobs
  ("harvest source A", "fill extensions", "build site at (23,17)"), creeps
  bid on or get assigned jobs based on body + location, and a job scheduler
  handles priority. This makes remote mining, boosting, market hauling, and
  multi-room all just new job types instead of new roles. The
  `roles/index.ts` comment already acknowledges this seam. **Do this before
  RCL1 (remote mining)** — remote mining as a "role" is painful; as a "job"
  it's clean.

### ARCH2. State machines for creep behavior
- **Where:** Every role uses `if (working) ... else ...` flags.
- **Observation:** Works for simple roles but breaks down fast. A mineral
  miner that should recycle when depleted needs states: `→MINE →RECYCLE`. A
  remote hauler that gets attacked needs: `→HAUL →FLEE →HAUL`. A defender that
  should retreat when low HP needs: `→ATTACK →HEAL →ATTACK`.
- **Recommendation:** A per-creep state machine (`creep.memory.state = 'mining'
  | 'recycling' | ...`) with a transition table. More readable, less
  bug-prone, easier to debug (log `creep.name + state`).

### ARCH3. Dynamic economic modeling in the strategy layer
- **Where:** `strategy/index.ts#computeQuotas` — mostly static rules.
- **Observation:** No ROI calculation ("is it worth spending 800 energy on a
  bigger upgrader body, or bank it for the next RCL?"). No dynamic adjustment
  (hauler count doesn't respond to "extensions empty for 10 ticks" or
  "containers overflowing"). No priority queues ("extractor site unbuilt for
  200 ticks → boost builder count temporarily").
- **Recommendation:** Track energy income rate, storage delta, construction
  backlog → adjust quotas dynamically. Make the strategy layer the brain, not
  a lookup table.

### ARCH4. CPU budgeting, not just measurement
- **Where:** `main.ts` — `cpuBySubsystem` is measured but not acted on. When
  bucket is low, entire subsystems are skipped with hard gates.
- **Observation:** More granular approach: allocate a CPU budget per tick,
  prioritize work (defense always, then haulers, then builders, then
  upgraders), skip the *lowest priority work* that tick if over budget — not
  a whole subsystem.
- **Recommendation:** Implement before multi-room (more rooms = more CPU
  pressure).

### ARCH5. Multi-room abstractions are single-room-shaped
- **Where:** `roomHeap`, `runLogistics`, `computeQuotas` — all per-owned-room.
- **Observation:** Every multi-room seam is stubbed. When you add a second
  room, you'll be refactoring these interfaces, not just adding code.
- **Recommendation:** Design interfaces around "rooms we operate in" (owned +
  remote + reserved) from the start. Do this alongside RCL1 (remote mining).

### ARCH6. No role unit tests
- **Where:** `Bot/scripts/smoke.mjs` has role-level smoke tests, but there's
  no structured unit test framework for roles.
- **Observation:** A hauler with a mocked heap entry, a mocked creep, and a
  mocked room would catch bugs like CR1 (storage not a pickup when only links
  need filling) without needing the full integration harness. Role functions
  are pure-ish (they take a creep + context and act) — very testable.
- **Recommendation:** Add a proper unit test framework (vitest) for roles
  before the next big feature, so regressions are caught early.

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

---

## M. Minor (track, low priority)

### M1. `acquireEnergy` can compete with miners for source access
- **Where:** `lib/energy.ts#acquireEnergy` — `allowHarvest` lets
  upgraders/builders harvest from sources as a last resort.
- **Problem:** Crowds the source and reduces miner efficiency. At RCL 3-4 with
  limited source access tiles, this can cause traffic jams.
- **Fix:** Only allow harvesting from sources with no assigned miner, or gate
  behind a "no containers have energy" check.

### M2. No market trading
- **Where:** No `Game.market` usage anywhere in `Bot/src`.
- **Problem:** At RCL 4+ with storage, selling excess minerals (once A2 lands)
  or buying cheap energy could help. Not critical at RCL 5, but worth tracking.

### M3. `GENERATE_PIXEL` fires at exactly `bucket === 10000`
- **Where:** `main.ts` — `Game.cpu.bucket === 10000`.
- **Problem:** On low-CPU subscriptions (20 CPU), reaching 10000 bucket is rare.
- **Fix:** Lower the threshold or make it configurable.

---

## UI. UI feature requests

### UI1. Room plan overlay + server-side recalculation in the map view
- **Where:** `UI/src/panels/MapPanel.tsx` (world map), `UI/src/components/RoomCanvas.tsx`
  (per-room renderer), `UI/src/panels/MemoryPanel.tsx` (raw memory browser).
  No plan-related code exists in the UI today.
- **Want:**
  1. **Read the room plan from memory.** The bot stores a `PlanPointer` at
     `Memory.rooms[roomName].plan` (`Bot/src/lib/planner/types.ts#PlanPointer`)
     — a `{ v, seg, summary }` where `summary` is a `BasePlanSummary`
     (`anchor`, `rcl`, `built`, `planned`, `ramparts`, `roads`, `pct`). The
     full decoded `RoomPlan` (`structures: PlannedStructure[]`,
     `ramparts`, `roads`, `anchor`) lives in the RawMemory segment id `seg`
     and is decoded by `decodePlan` (`Bot/src/lib/planner/plan.ts`). The UI
     should fetch this (via the existing memory bridge / a new read endpoint)
     for each owned room and hold it in the store.
  2. **Toggle the plan overlay in the map view.** Add a toggle in `MapPanel`
     (per-room or global) that, when on, overlays the plan's structures,
     ramparts, and roads on the `RoomCanvas` at their `(x,y)` tiles —
     semi-transparent so live objects still show through. Color by structure
     type (reuse `NEUTRAL_TYPES` in `RoomCanvas.tsx`), draw the anchor, and
     dim tiles not yet built (compare against live room objects to mark
     built vs pending). This is a pure render feature — no writes.
  3. **Recalculate the room server-side.** Add a button (in `MapPanel`'s
     room popover or `RoomPanel`) "Recalculate plan" that calls a new
     server-side endpoint which runs the planner (`computePlan` /
     `planRoom` in `Bot/src/lib/planner/plan.ts`) for that room and writes
     the result back to `Memory.rooms[roomName].plan` + the RawMemory
     segment. Today `planRoom` only runs in-game (`managers/construction.ts`);
     exposing it through the API bridge (`API/src/`) as an RPC method (e.g.
     `room.recalcPlan`) needs a new endpoint that invokes the planner against
     the live room snapshot and persists the result. Surface success/failure
     and the new `summary.pct` back to the UI.
- **Effort:** Medium-large. (1) is a memory read + a store slice; (2) is a
  `RoomCanvas` overlay layer + a `MapPanel` toggle; (3) is a new API bridge
  endpoint wrapping the planner + a UI button. Do (1)+(2) first as a
  read-only feature, then (3).
- **Notes:**
  - The plan is per-owned-room; remote/Intel rooms have no plan. Gate the
    toggle to rooms where `Memory.rooms[name].plan` exists.
  - `PLAN_VERSION` (`Bot/src/lib/planner/plan.ts`) bumps invalidate cached
    plans — the recalc endpoint should respect the same version check.
  - The planner needs terrain + structures for the room; the server-side
    endpoint must fetch a fresh room snapshot before running `computePlan`.
  - Consider reusing the existing memory-segment read path (the bridge
    already reads RawMemory segments for `MemoryPanel`) to fetch the packed
    plan, then `decodePlan` it client-side — avoids a new endpoint for (1).

---

## How to use this file

Each item is scoped to be its own implementation prompt: it names the files
involved, the current behavior, and what's missing. When picking one up in a
fresh session, hand over just that item's text plus a pointer to this file
and `Bot/README.md`'s architecture section — don't bundle multiple items into
one prompt, they're independently testable (`npm run smoke` /
`npm run typecheck` in `Bot/`).

**Suggested order:** RCL4 (quick win) → ARCH1 + RCL1 (remote mining, the big
feature) → ARCH3 (dynamic strategy) → B1 (labs) → ARCH4, ARCH5, ARCH6 (as
multi-room approaches).
