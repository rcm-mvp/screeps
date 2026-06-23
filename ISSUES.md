# Bot Code Review — Issues Found (2026-06-23)

Professional review of the Bot codebase before deploy. Organized by severity.
RCL 3-4 gaps are called out specifically (user is at RCL 5, one room).

---

## 🔴 Critical (fix before deploy)

### C1. Storage not added as a pickup when only links need filling
- **Where:** `managers/logistics.ts` — the storage-as-pickup block.
- **Problem:** Storage is only added as a pickup when `fillsCore.length || fillsTower.length`.
  But haulers can also deliver to **sender links** (checked separately in
  `roles/hauler.ts#resolveFill`). When all spawns/extensions/towers are full but
  sender links need energy, storage is **not** added as a pickup → haulers
  rally idle instead of moving storage→link. The link network can starve during
  high upgrade activity (spawns full, controller link draining fast).
- **Fix:** Also add storage as a pickup when sender links have free capacity, or
  always add storage as a pickup when any delivery target exists (incl. links).

### C2. Room name regex in `directives.ts` is too restrictive
- **Where:** `directives.ts` — `ROOM_NAME_RE = /^[WE]\d{1,2}[NS]\d{1,2}$/`.
- **Problem:** Only allows 1-2 digit coordinates (0-99). The official Screeps
  world has rooms with coordinates beyond 99. `lib/movement.ts` uses a more
  permissive regex (`/^[EW]\d+[NS]\d+$/`). The inconsistency means the directive
  parser could reject valid room names that the movement system accepts.
- **Fix:** Change to `\d{1,3}` or `\d+` to match `movement.ts`.

### C3. Rampart repair threshold is dangerously low
- **Where:** `managers/defense.ts` and `roles/builder.ts` — both gate rampart
  repair on `s.hits < 10000`.
- **Problem:** Ramparts have 1M-3M max hits. At 10,000 hits, a rampart can be
  destroyed by a single attack tick. Fine at RCL 3-4 when nobody attacks you,
  but the moment you hit RCL 5-6 and become a target, this is a **defense
  vulnerability**.
- **Fix:** Scale the repair threshold with RCL — e.g. 50,000 at RCL 5,
  100,000+ at RCL 6-7. Make it a `SETTINGS` constant.

---

## 🟡 Important (fix soon — RCL 3-4 gaps & economy)

### I1. No remote mining — the single biggest economic gap
- **Where:** No remote miner / remote hauler role exists. `strategy/index.ts`
  only counts sources in the owned room.
- **Problem:** At RCL 3-4, remote mining (harvesting sources in unowned adjacent
  rooms with a miner + hauler, optionally a reserver) is the **standard way** to
  double or triple income before having GCL for a second room. A single room
  with 2 sources caps at ~20 energy/tick. With 2-4 remote mining sites, you
  could be at 40-60 energy/tick — dramatically speeding up the RCL 5→6 push.
- **Needed:** New `remoteMiner` role (static miner on a remote source, drops to
  a container), `remoteHauler` role (container → home storage, multi-room
  pathing), and strategy logic to pick remote rooms from `Memory.rooms[*].intel`
  (scout data). Optionally a `reserver` to claim the controller for exclusive
  source access.
- **Effort:** Large feature — new roles + strategy + multi-room logistics.

### I2. No pre-spawn / creep renewal
- **Where:** `managers/spawn.ts` + `strategy/index.ts#computeQuotas`.
- **Problem:** When a creep dies of old age, the spawn manager only notices when
  `census.byHome[role]` drops below quota. There's a gap between death and the
  replacement reaching the work site — for a miner, this can be 20-50 ticks of
  lost income.
- **Fix:** In `computeQuotas` or `runSpawn`, count creeps with
  `ticksToLive < CREEP_LIFE_TIME * 0.1` as "dying" and add them to the effective
  quota so a replacement spawns before the old one dies.

### I3. Hauler quota is tight at RCL 3-4
- **Where:** `strategy/index.ts#computeQuotas` —
  `q.hauler = sourceContainers > 0 ? Math.max(1, sourceContainers) : 0`.
- **Problem:** 1 hauler per source container (2 for a standard room). At RCL 3-4,
  hauler bodies are small (4-6 segments = 400-600 carry). Two haulers move enough
  for steady-state, but **filling extensions is bursty** — after a spawn, you
  need 1000+ energy quickly. If both haulers are at remote containers when the
  spawn completes, the refill is delayed.
- **Fix:** `Math.max(2, sourceContainers)` at RCL 3-4, or scale hauler count
  with extension count.

### I4. No storage before RCL 4 — surplus energy has no sink
- **Where:** `roles/hauler.ts` — haulers with full energy and nothing to fill
  rally idle.
- **Problem:** Before RCL 4 (storage unlock), source containers fill up, miners
  waste harvest ticks, and energy is lost. Upgraders help (they pull from
  containers via `acquireEnergy`), but there's no dedicated "surplus →
  controller" path.
- **Fix:** Have haulers dump energy at the controller container, or boost
  upgrader count when storage is absent.

---

## 🟠 Code quality (fix soon)

### Q1. Defender body is too simple
- **Where:** `lib/bodies.ts` — `return repeat([ATTACK, MOVE], energy, 8)`.
- **Problem:** Pure `[ATTACK, MOVE]` is weak against ranged attackers (they kite
  you) and offers no tanking. With 8 segments max, a defender costs 1040 energy
  — at RCL 5 (1800 capacity) you could afford a much tougher body.
- **Fix:** `[TOUGH, TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE]` or include
  `RANGED_ATTACK` for flexibility. Scale to capacity.

### Q2. Mineral miner doesn't recycle when mineral depletes
- **Where:** `roles/mineralMiner.ts` — keeps harvesting an empty mineral.
- **Problem:** Sits idle for ~30,000 ticks until regeneration, doing nothing.
- **Fix:** Recycle (`creep.suicide()`) when `mineral.mineralAmount === 0`, or
  switch to a fallback role (e.g. upgrade) during depletion.

### Q3. Adopted creeps get `upgrader` regardless of body
- **Where:** `memory.ts#adoptCreeps` — `if (!mem.role) mem.role = 'upgrader'`.
- **Problem:** If an adopted creep has no `WORK` parts (e.g. a pure hauler from
  old code), it will try to upgrade and silently fail.
- **Fix:** Check body composition and assign a compatible role (e.g. `hauler`
  if it has `CARRY`/`MOVE` but no `WORK`).

### Q4. `findDeliveryTarget` in `common.ts` duplicates logistics logic
- **Where:** `roles/common.ts#findDeliveryTarget`.
- **Problem:** The harvester's `findDeliveryTarget` runs its own `room.find()`
  calls every tick, duplicating what `runLogistics` already computed. Wastes CPU.
- **Fix:** Harvesters should read from the heap snapshot like haulers do.

### Q5. Builder count might be low for large base plans
- **Where:** `strategy/index.ts#computeQuotas` —
  `q.builder = sites > 0 ? 2 : rcl >= 2 ? 1 : 0`.
- **Problem:** At RCL 5-6, the base plan has 50+ structures + ramparts + roads.
  Two builders with 12-segment bodies build ~24 energy/tick each. A single
  extension (300 hits) takes ~6 ticks. With 30+ sites queued, this is slow.
- **Fix:** `Math.min(4, Math.ceil(sites / 10))`.

---

## 🔵 Minor (track, low priority)

### M1. `acquireEnergy` can compete with miners for source access
- **Where:** `lib/energy.ts#acquireEnergy` — `allowHarvest` lets upgraders/builders
  harvest from sources as a last resort.
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

## Summary table

| Priority | ID  | Issue                                    | Effort   |DONE|
|----------|-----|------------------------------------------|----------|-----|
| 🔴 Crit  | C1  | Storage not pickup when only links fill | Small    | |
| 🔴 Crit  | C2  | Room name regex too restrictive          | One-line | |
| 🔴 Crit  | C3  | Rampart repair threshold too low         | Small    | |
| 🟡 Imp   | I1  | No remote mining (RCL 3-4 gap)           | Large    | |
| 🟡 Imp   | I2  | No pre-spawn before creep death          | Medium   | |
| 🟡 Imp   | I3  | Hauler quota tight at RCL 3-4            | One-line | |
| 🟡 Imp   | I4  | No surplus sink before RCL 4             | Medium   | |
| 🟠 Qual  | Q1  | Defender body too simple                 | Small    | |
| 🟠 Qual  | Q2  | Mineral miner doesn't recycle             | Small    | |
| 🟠 Qual  | Q3  | Adopted creeps get wrong role             | Small    | |
| 🟠 Qual  | Q4  | findDeliveryTarget duplicates logistics  | Medium   | |
| 🟠 Qual  | Q5  | Builder count low for large plans        | One-line | |
| 🔵 Minor | M1  | acquireEnergy competes with miners       | Small    | |
| 🔵 Minor | M2  | No market trading                         | Large    | |
| 🔵 Minor | M3  | GENERATE_PIXEL threshold too high         | One-line | |