# STAMP.md — Adaptive base planner (working plan)

> **Temporary working doc.** This is the plan we execute against for the adaptive
> base-fitter. Delete (or fold into DONE.md) once shipped. Companion files:
> `TODO.md`, `Bot/README.md` (planner architecture), `ISSUES.md`.

## 0. Status

- **Created:** 2026-06-23
- **Trigger:** the live colony `W52S13` is RCL5 and **has no base plan** —
  `computePlan` returns `null` ("no valid anchor … room too closed?"), which
  disables construction *and* the link manager for the room. The base there was
  build by legacy builder; the new planner has never been able to fit its bunker in it.
- **Phase 0 (one-off plan injection) was considered and SKIPPED** — the colony
  runs fine without a plan for the few hours/days until this lands.

## 1. Problem

The planner only knows one layout: a fixed **15×15 "bunker" stamp** (91
structures on a checkerboard, `STAMP_RADIUS = 7`). Anchoring is **all-or-nothing**
(`stamp.ts#stampFits`): a single wall tile, room edge, or source/controller/
mineral tile anywhere inside the footprint rejects the whole anchor. Closed rooms
(and rooms with a pre-existing hand-placed base) can't host it → `computePlan`
returns `null` → no plan → no construction, no links, no ramparts.

## 2. Locked decisions (from design Q&A)

| Decision | Choice |
|---|---|
| **Where the fallback runs** | **SERVER-SIDE (Strategist).** The whole point is to offload the heavy adaptive computation to the dedicated box's CPU, NOT the in-game sandbox. The bot keeps the cheap stamp in-game; when it fails the bot **signals** (surfaces "needs plan" in ColonyState) and waits. The Strategist computes the adaptive plan with unlimited CPU and writes it to RawMemory **segment 90** via `memory.setSegment`; the bot just **reads** segment 90 (cached forever, survives resets). The pure `fit.ts` algorithm we built is REUSED as the shared core the server runs — it was written pure (no `Game`/`PathFinder`) for exactly this. _(Superseded the earlier "in-game now" decision: in-game execution saves no in-game CPU, defeating the goal.)_ |
| **Default stamp** | **Stays the primary path.** The adaptive fitter is a **fallback only when the stamp doesn't fit.** Easy/open rooms keep getting the clean bunker. |
| **Fit strategy** | **Hybrid of "flexible fill" + "fragmented stamp"** (see §4). Fragment only along low-coupling seams; never split interdependent structures across the room. Must **incorporate existing buildings**. |
| **Roads** | **"Close enough", not optimal.** Reuse/share lanes, no redundant parallel roads (`roads.ts` already lane-shares — build on it). |
| **Ramparts** | Focus on **natural chokepoints.** We already have a **min-cut solver** (`mincut.ts`) — that *is* the chokepoint-optimal approach; floodfill is the heuristic version of the same idea. Keep min-cut; the work is feeding it the right interior to protect (§4f). |
| **Testing** | **Smoke (deterministic) + one itest scenario** (cramped room, place+build end-to-end). |
| **Persistence** | Compute **once**, cache in RawMemory segment 90 **forever**; recompute only on invalidation / `PLAN_VERSION` bump (already how the segment cache works). |

## 3. Design overview — in-game stamp, server-side fitter

```
BOT (in-game, cheap — stamp only):
  computePlan(room):
    try the DEFAULT bunker stamp (anchor at spawn / openness peak)
      fits? ──> use it; encodePlan → segment 90 (open rooms, unchanged)
      else  ──> DO NOT run the fitter in-game. Flag the room "needs server
                plan" (surface in ColonyState) and stop attempting. Wait.

SERVER (Strategist, unlimited CPU — the adaptive fitter):
  observe ColonyState over WS → room flagged "needs plan" (and segment 90
    has no current-version plan for it)?
      pull rooms.terrain + rooms.objects via the API bridge
      run the SHARED planner core (fit.ts placement + derived containers/links/
        extractor + min-cut ramparts + roads + encodePlan)  ← unlimited CPU
      memory.setSegment(90, { ...existing, [room]: encodedPlan })

BOT: getCachedPlan reads segment 90 (UNCHANGED) → construction + links proceed.
```

The plan the server writes is the **same `RoomPlan`/`PackedPlan` wire format**
the bot already decodes (`decodePlan`, version-gated on `PLAN_VERSION`), so
everything downstream — `getCachedPlan`, `nextSites`, `construction.ts`,
`links.ts`, `summarize`, the overlay — works unchanged. **The bot stays
autonomous for open rooms (stamp in-game) and needs the server only ONCE to
generate a closed-room plan, which then persists in segment 90 forever.**

> **Shared planner core.** The pure modules (`fit`, `stamp`, `distanceTransform`,
> `mincut`, `types`, the derived-structure logic + `encodePlan`/`decodePlan` +
> TYPES/ROLES tables, and a **pure roads pathfinder** replacing the in-game
> `PathFinder`) must run in BOTH the bot (stamp path) and the Strategist (fitter).
> They reference Screeps global constants (`STRUCTURE_*`, `TERRAIN_MASK_WALL`) —
> the shared core must define these as plain values so it runs under Node.

## 4. Adaptive fitter — algorithm

New module: **`Bot/src/lib/planner/fit.ts`**, called from `computePlan` when the
stamp fails. Pure-ish (terrain + room snapshot in → `RoomPlan` out) so it's unit-
testable. PathFinder-dependent steps (roads) degrade to `[]` in the unit harness,
like `roads.ts` already does.

### 4a. Read room state (inputs)
- Terrain → `distanceTransform` openness map (reuse `distanceTransform.ts`).
- `FIND_SOURCES`, `FIND_MINERALS`, `room.controller` → key/fixed positions.
- **Existing structures** `FIND_STRUCTURES` (ours + any blocking) → fixed,
  occupied tiles. **This is the main new input the current planner ignores.**
- `FIND_MY_SPAWNS` → anchor seed + the existing build-mass centroid.

### 4b. Anchor / seed
- Seed at the existing spawn (or the centroid of existing core structures if a
  spawn exists). For a hand-placed base, the plan must **grow around what's
  already there**, not relocate it.
- No full-footprint clearance requirement (that's what `stampFits` enforced and
  what fails). Bounds-check only enough that placed tiles stay in `[1,48]`.

### 4c. Incorporate existing buildings (hard requirement)
- Mark every existing structure tile as **occupied & fixed**.
- Emit them into the plan as already-satisfied (so `summarize`/`nextSites` count
  them and never double-place — `nextSites` already skips `ctx.has(...)`, and
  per-RCL caps include existing counts).
- **Tag existing links by role** (controller-adjacent → `controller`, source-
  adjacent → `source`, near storage → `core`) so `links.ts` (which matches links
  to plan entries **by position**) classifies the *real* built links. Without
  this, hand-placed links never get a role and the network won't forward.
  - ⚠️ Open seam: `links.ts` matches strictly on `x===pos.x && y===pos.y`. The
    fitter must emit link plan entries **at the existing link coordinates**.
    (Alt: add a proximity fallback in `links.ts` — see §9.)

### 4d. Place what's missing — fragmented + flexible (the core)
Place the remaining (not-yet-built) structures by **dependency-aware fragments**,
preferring compactness, splitting only when forced:

- **Coupling tiers** (what may/may not be split):
  - **Labs** — must stay within reaction range (≤2 tiles) of each other → **one
    tight cluster, never split.** Highest coupling.
  - **Core hub** — spawns + storage + terminal + factory + power spawn + towers +
    core link → keep compact/together (logistics + tower coverage). Prefer not to
    split; split only as a last resort.
  - **Extensions** — most splittable. Distribute in **blocks** near the core /
    along open pockets (haulers fill them; mild spread is fine). This is where
    "drag it out a bit" happens.
  - **Fixed-position** — extractor (on mineral), containers (at sources/
    controller/mineral), role links (derived adjacency). Already special-cased
    in `plan.ts`; reuse.
- **Rule:** never place interdependent structures on opposite sides of the room.
  Fragmentation seams only at low-coupling boundaries (i.e., between extension
  blocks), and each fragment is internally compact.
- **Placement primitive:** for each fragment, find the best open pocket
  (checkerboard parity preserved for walkability, like the stamp) by openness +
  proximity to the existing core, avoiding occupied/wall/blocked tiles. A greedy
  best-fit over ranked pockets (flexible fill) within each fragment.

### 4e. Roads — "close enough"
- Reuse `roads.ts#planRoads` — it already pathfinds over a cost matrix and
  **reuses earlier road lanes** (later paths prefer existing roads, cost 1), so
  the network shares lanes and avoids redundant parallels by construction.
- Route from the build-mass centroid → each source, controller, mineral, exits,
  **plus connect fragments** to the core.
- Accept near-optimal paths; do **not** add a road tile adjacent to an existing
  road serving the same lane (dedupe parallels — small filter on top of
  `planRoads` output if needed).

### 4f. Ramparts — natural chokepoints
- Keep **`mincut.ts`** (min-cut = the optimal "seal the chokepoints" solver).
- The real work: compute the **interior to protect** = the bounding region of
  *all* placed + existing structures (union of fragments), dilated by
  `MINCUT_MARGIN`, instead of a single stamp-radius rect around one anchor.
- Use the openness map / floodfill to **bound the protected region to the room's
  natural chokepoints** so we don't rampart a huge perimeter (let min-cut find
  the narrow barriers within that region).
- (Floodfill from exits is an alternative/validation for chokepoint detection —
  decide in SF5 whether it's needed or min-cut alone suffices.)

## 5. Persistence & invalidation
- Output cached in **RawMemory segment 90** (`planRoom` → `encodePlan` →
  `writeSegment`), decoded once per global into the heap. **No per-tick recompute.**
- `getCachedPlan` already version-gates on `PLAN_VERSION`. **Bump `PLAN_VERSION`**
  when this ships → one bucket-gated replan on deploy regenerates W52S13 with the
  fitter.
- Invalidation triggers stay as-is (anchor broken / version bump).

## 6. Code seams (files to touch)
- **NEW** `Bot/src/lib/planner/fit.ts` — the adaptive fitter (§4).
- `Bot/src/lib/planner/plan.ts#computePlan` — add the fallback branch (try stamp →
  else fit). Reuse the existing derived-link / container / extractor / road /
  min-cut steps; only the *structure placement* differs.
- `Bot/src/lib/planner/stamp.ts` — expose fragments/clusters + a per-tile
  `tileFits` helper (factor out of `stampFits`) for the fitter to reuse.
- `Bot/src/lib/planner/index.ts` — export new helpers as needed.
- `Bot/src/managers/links.ts` — verify existing links get a role (see §4c / §9).
- `Bot/src/managers/construction.ts` — already tolerant (invalid
  `createConstructionSite` calls are skipped); just confirm partial placement.
- `Bot/src/settings.ts` — `PLAN_VERSION` bump (+ any new tuning constants).

## 7. Testing plan
- **Smoke (`Bot/scripts/planner-smoke.mjs` or new):** deterministic, no docker.
  - Pull **W52S13's real terrain** via the API (`rooms.terrain`) and commit it as
    a fixture → tests run against the actual problem room.
  - Open-room fixture → asserts the **default stamp** is still used (no regression).
  - Closed-room fixture (W52S13) → fitter produces a **valid plan**: no
    overlapping structures, existing structures preserved, per-RCL caps
    respected, sources/controller/mineral reachable, links tagged with roles,
    ramparts seal all exits (interior can't reach an edge), roads connect
    fragments. (Road steps degrade to `[]` without PathFinder — assert the
    structural invariants; cover roads in itest.)
- **Integration (one new `Integration` scenario, e.g. scenario-N):** a cramped
  room against the dockerised server → deploy → assert the fitter's plan gets
  **placed and built** (link + rampart sites appear and complete), heartbeat
  keeps advancing (loop-regression style, like scenarios J/K).

## 8. Deliverables checklist (build order)

> Each item is independently testable (`Bot/ npm run typecheck && npm run smoke`).

- [ ] **SF0 — Terrain fixture.** Pull `W52S13` terrain (+ objects) via the API,
      commit as a test fixture. Unblocks all deterministic tests.
- [ ] **SF1 — Factor `tileFits` + fragments out of `stamp.ts`.** Per-tile
      validity helper + dependency-aware fragment definitions (labs / core /
      extension-blocks). Pure, unit-tested.
- [ ] **SF2 — `fit.ts`: read state + incorporate existing structures.** Occupied
      map from existing builds; emit existing structures as satisfied; tag
      existing links by role. Smoke: existing builds preserved + links tagged.
- [ ] **SF3 — `fit.ts`: fragmented + flexible placement of missing structures**
      (§4d). Smoke: no overlaps, caps respected, no split of coupled clusters,
      key tiles reachable.
- [ ] **SF4 — Roads (close-enough) for the adaptive layout** (§4e). Reuse
      `planRoads`; connect fragments; dedupe parallels.
- [ ] **SF5 — Ramparts over the adaptive interior** (§4f). Min-cut on the union
      bounding region; smoke: interior sealed from exits.
- [ ] **SF6 — Wire fallback into `computePlan`** + `PLAN_VERSION` bump. Open room
      → stamp (regression check); closed room → fitter.
- [ ] **SF7 — Smoke suite** (open + closed fixtures, all invariants from §7).
- [ ] **SF8 — Integration scenario** (cramped room place+build end-to-end).
- [ ] **SF9 — Deploy + verify on `W52S13`** (plan generates, links/ramparts/roads
      build, `colony` progresses). Update `DONE.md`; retire this file.

## 9. Open questions / risks
- **Link classification for off-plan links.** `links.ts` matches strictly by
  position. fitter emits link entries at the *existing* link coords
   
- **Flexible-fill quality.** A greedy best-fit may leave a cramped room short of
  the full extension count. Acceptable (better than nothing); revisit with the
  server-side optimizer later if a room can't reach its caps.
- **Min-cut interior bounds.** Too large → ramparts a huge perimeter (expensive);
  too small → leaves structures outside the wall. Floodfill-from-exits may help
  bound it — evaluate in SF5; don't add it if min-cut alone is fine.
- **Determinism in tests.** Roads/PathFinder unavailable in the unit harness —
  keep road assertions in itest; smoke covers structures/ramparts/reachability.
- **Existing-structure conflicts.** If a hand-placed structure sits where the
  fitter wants a *different* structure type, the existing one wins (it's fixed);
  the fitter places the missing type elsewhere.

## 10. Roadmap / related

- **F1 — Server-side (Strategist) plan computation. ← NOW THE ARCHITECTURE (§3, §12).**
  Unlimited CPU + the shared planner core + `setSegment(90)` injection. The bot's
  consume path is unchanged (it already reads segment 90).
- **F2 — Manual per-room recalculation trigger.** Force a replan for a room on
  demand from outside the bot (after the legacy base changes, after manual edits,
  or to re-fit at a new RCL). The bot already has `invalidate(room)` →
  bucket-gated replan; the future trigger just drives it via the bridge/Memory
  contract (e.g. a `replanRooms` directive field) or a `global.replan('W52S13')`
  console command. Requires the fitter to be **safe to re-run** (re-reads current
  structures, refines around them, never destroys/duplicates existing builds) and
  **deterministic** given the same inputs (so visuals/builds don't flicker).
- **F3 — UI visuals of the proposed build.** Show what the planner *wants* to
  build (structures + roads + ramparts), not just a summary, in the external UI.
  In-game we already have `overlay.ts` (RoomVisual, `PLAN_OVERLAY`); the UI needs
  the **decoded plan exposed externally** — read segment 90 via the API
  (`memory.getSegment(90)`) and decode it (shares the versioned-format need with
  F1), or surface a decoded structure list in `ColonyState`/`room.memory.plan`
  (today only a summary lands there). `overlay.ts`'s type→colour map is the
  template for the UI renderer.

> **Convergence:** F1 and F3 both need the **plan format lifted into a shared,
> versioned contract** that something outside the bot can decode. When either is
> picked up, do that work once.

## 11. Forward-compat hooks (keep in mind while building §8)

Build the fitter so these future items stay cheap to add — without doing them now:

- **Keep the plan self-contained & externally decodable.** Everything needed to
  render (F3) or inject (F1) lives in the segment-90 encoded plan (structures with
  type+role+rcl, ramparts, roads, anchor). Don't stash plan data only on the heap
  or in closures.
- **Keep `encodePlan`/`decodePlan` + the TYPES/ROLES tables + `PLAN_VERSION` the
  single source of truth** for the wire format, append-only (A2 already did this
  for the extractor type/role) so an external decoder (UI/Strategist) can be
  ported from it.
- **Make the fitter a pure, re-runnable function** (terrain + room snapshot →
  `RoomPlan`, deterministic, no hidden global state) so F2's on-demand recompute
  and F1's server port are drop-in.
- **Route any future trigger through `invalidate()`**, not a bespoke path — it
  already does the right thing (drop cache → bucket-gated replan).
- **Reuse `overlay.ts`'s type→visual mapping** as the shared mapping for F3 so the
  in-game and UI visuals agree.

## 12. Server-side execution — deliverables (the correct architecture)

What's DONE (reusable): the pure `fit.ts` algorithm, `stamp.ts` fragments/tileFits,
`distanceTransform`, `mincut`, the `encodePlan`/`decodePlan` + TYPES/ROLES tables,
and the full smoke validation against the real W52S13 terrain. These become the
**shared planner core** the server runs.

- [ ] **SV1 — Shared planner core.** Make the pure planner runnable under Node:
      a `buildPlan(input)` orchestrator (terrain grid + objects → `PackedPlan`)
      that runs fit → derived containers/links/extractor → min-cut → roads →
      encode, with **no `Game`/`Room`/`RawMemory`/`PathFinder`**. Define the
      Screeps constants it uses as plain values (Node has no globals). Shared by
      the bot (stamp path) and the Strategist. Decide the share mechanism (new
      package vs vendor into API vs Bot-as-source + Strategist imports).
- [ ] **SV2 — Pure roads pathfinder.** Replace the in-game `PathFinder` in the
      roads step with a plain A*/Dijkstra over the 50×50 cost matrix, so roads
      compute server-side (and deterministically in tests).
- [ ] **SV3 — Bot: stamp-only + signal.** `computePlan` stops running the fitter
      in-game; on stamp failure it flags the room "needs server plan" in
      `ColonyState` (executor extension, like `colony.mineral`) and stops
      re-attempting. Consume path (segment 90) unchanged.
- [ ] **SV4 — Strategist planner loop.** Observe ColonyState → for a flagged room
      with no current-version segment-90 plan: `rooms.terrain` + `rooms.objects`
      → `buildPlan` → `memory.setSegment(90, merge)`. Idempotent, version-aware,
      respects the write budget (a plan is written once per room).
- [ ] **SV5 — Tests.** Unit: `buildPlan` on the W52S13 fixture under Node yields
      the same valid/walkable/encodable plan (port the smoke invariants).
      Strategist: a test that a flagged room → setSegment(90) with a decodable
      plan. Re-run the bot smoke + itest (no regression to the stamp path).
- [ ] **SV6 — Deploy + verify.** Strategist running, bot deployed; W52S13 gets a
      server-computed plan in segment 90 and builds from it.

**Resilience note:** the box isn't reboot-proof (tmux, see migration memory).
Once segment 90 holds a plan it persists, so the server is only needed to
GENERATE. Decide whether the bot keeps the in-game fitter as a *fallback* (server
preferred; in-game only if no server plan arrives) for robustness, or pure
server-side (bot waits).
