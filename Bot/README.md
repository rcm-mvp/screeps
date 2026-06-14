# Screeps Executor

The **in-game half** of the system: a server-side bot that runs
`module.exports.loop` every tick, forever, whether or not anyone is connected.
It reads high-level *directives* out of `Memory.bridge`, runs the colony
(spawning, building, defending, hauling, upgrading), and writes a *state*
block back so the [bridge](../API/README.md) / AI / [UI](../UI/README.md) can
see what's happening.

This is the only layer that can act at tick resolution. The external AI never
micros creeps — it sets intent through the Memory contract, and this executor
carries it out. With **no directives at all it runs fine on safe defaults**
and boots a fresh spawn to a self-sustaining ~RCL 3 colony.

## Build, test, deploy

```bash
cd Bot
npm install
npm run build        # esbuild → dist/main.js (single uploadable module)
npm run typecheck    # tsc --noEmit (needs ../API built once for contract types)
npm run smoke        # build + run the bundled loop against a mocked empty world
npm run push         # push dist/main.js via the bridge (POST user/code)
npm run deploy       # build + push
```

`push` uses the bridge's env config: `SCREEPS_TOKEN`, optionally
`SCREEPS_SERVER` / `SCREEPS_HOST` / `SCREEPS_BRANCH` (default branch:
`default`), or pass the branch explicitly: `node scripts/push.mjs my-branch`.
Code pushes ride the `POST user/code` budget (~240/day) — deploy deliberately.

For repeatable deploys, drop those vars in a **gitignored `Bot/.env`** —
`scripts/push.mjs` loads it (dependency-free) on every push, and a shell var
(e.g. `$env:SCREEPS_BRANCH=...`) still overrides the file for one-offs.

## The Memory contract

The canonical types live in [`API/src/contract.ts`](../API/src/contract.ts)
and are re-exported here **type-only** through [`src/contract.ts`](src/contract.ts)
(the bridge is a Node library — a runtime import would drag `ws`/`zlib` into
the game bundle; esbuild erases `export type`, so nothing of it ships).

```
Memory.bridge.directives   bridge WRITES · executor READS    (Directives)
Memory.bridge.state        executor WRITES · everyone READS  (ColonyState)
Memory.bridge.ack          executor confirms applied rev     ({ directiveVersion, appliedTick })
```

- **State + ack are written every tick**, `state.heartbeat` is the liveness
  signal the UI watches. They are written in a `finally` block — even a tick
  that blew up still reports, with the failure in `state.lastError`.
- `state.cpuBySubsystem` is an executor-side **extension** of `ColonyState`
  (per-subsystem CPU cost); contract readers that don't know it ignore it.
- The bridge auto-increments `directives.rev` on every write
  (`control.setDirectives`); the executor acks whatever rev it last parsed.

### Directive handling (defensive by design)

Directives come from an external AI and may be malformed or partial.
[`src/directives.ts`](src/directives.ts) validates everything into a
`SafeDirectives` before any other code sees it:

| Field | Validation |
|---|---|
| `paused` | boolean, else ignored. Halts economy + offense; **defense always runs** (towers, safe mode, defenders — and defender spawning while under attack) |
| `posture` | one of `economy · expand · defend · war`, else `economy` |
| `targetRooms` | valid room names only, capped at 10 |
| `roleQuotas` | integers clamped to 0–20; non-numbers dropped; unknown roles planned but never spawned |
| `flagsAsOrders` | boolean, **default true** (flags are the only steering wheel with no AI attached) |
| `rev` | finite number, floored; acked even if the rest was garbage so the bridge's `pushAndConfirm` never hangs |

Validation warnings are logged once per new revision (plus a low-rate
reminder), never every tick. A bad directive can *never* crash the loop or do
something absurd — worst case it is ignored.

**Flag orders** (when `flagsAsOrders`): a flag named `claim:anything` /
`attack:*` / `scout:*` turns the room it stands in into a claim/attack/scout
target. The bridge can place flags via the API, giving the AI (or you,
manually in the game client) a spatial command channel.

**Posture semantics:** `expand` → claim `targetRooms` (GCL-capped; the
executor claims the controller, placing the new spawn is the AI's job via the
bridge's `place-spawn` endpoint). `war` → defenders dispatch to
`targetRooms`. `defend` → +1 standing defender per colony. `economy` → none
of the above.

## Architecture

```
src/
  main.ts            loop: guard-wrapped subsystems, per-creep try/catch,
                     state/ack/heartbeat in finally — the loop never hard-crashes
  contract.ts        type-only re-export of the shared contract + executor types
  directives.ts      validate/clamp raw directives → SafeDirectives
  memory.ts          contract bootstrap (never clobbers bridge writes), dead-creep GC
  state.ts           census (one pass over Game.creeps), state + ack writers
  heap.ts            global-heap cache w/ reset detection; per-tick room scratch
  settings.ts        every tunable in one place
  strategy/index.ts  STRATEGIC  — every 23 ticks or on new rev: quotas per colony,
                     claim/attack/scout targets, flag orders → Memory.plan
  managers/          TACTICAL   — every tick, cheap, follows the cached plan:
    defense.ts         towers (healers first), safe mode, Game.notify (throttled)
    spawn.ts           fills quotas by priority, best affordable body, emergency
                       bootstrap when income hits zero
    logistics.ts       one shared supply/demand snapshot per room per tick
    construction.ts    source containers → tower → extension ring → roads
                       (interval- and bucket-gated; ring = base-plan stub)
  roles/             OPERATIONAL — each creep finishes its task autonomously:
    harvester hauler upgrader builder miner defender claimer scout
    index.ts           registry + paused gate; common.ts; context.ts
  lib/               log, movement (path reuse + stuck detection), bodies,
                     energy acquisition, game helpers
    traffic.ts         flow-based traffic manager (collision/deadlock resolver),
                       run once per room at loop end — see "Adopted techniques"
```

The three layers only touch through `Memory.plan` (strategy → tactics) and
the role registry (tactics → operations), so roles can become a full task/job
system later by swapping `roles/index.ts` for a task queue — `main.ts` and the
managers don't change.

### CPU & bucket policy

- **Plan periodically, execute every tick.** Strategy runs every 23 ticks (or
  immediately on a new directive rev); construction every 47; both skip below
  `BUCKET_LOW` (2000). Primes, so gated jobs don't pile on one tick.
- Below `BUCKET_CRITICAL` (500): defense, spawning, creeps, and the state
  write still run; logistics snapshots, strategy refresh, and construction
  are shed. **Defense is never skipped.**
- Movement reuses cached paths (`reusePath: 20`) and only repaths after 3
  stationary ticks; logistics does room `find`s once per room per tick and
  haulers share the snapshot.
- **Traffic resolution** runs once per active room at the *end* of the loop
  (`lib/traffic.ts#runTraffic`), after every role has registered its intended
  move. It costs near-zero CPU (a bounded DFS over ≤9 tiles per creep) and its
  cost is reported under `cpuBySubsystem.traffic`.
- Full bucket → `generatePixel()` (official MMO only, guarded by `typeof`).
- Per-subsystem cost is measured every tick and exposed in
  `state.cpuBySubsystem` for the UI.

### Global resets & Memory hygiene

The `global` heap may survive ticks but resets unpredictably: everything on
it (per-tick room scratch) is rebuilt on demand, detected by a sentinel in
[`src/heap.ts`](src/heap.ts) — a reset costs one log line, nothing else.
Dead creeps' memory is GC'd every tick, and creeps the executor didn't spawn
(e.g. left over from previous code when you deploy into an already-running
room) are **adopted** every tick — `memory.home` is backfilled to the creep's
current room and a missing `memory.role` defaults to `upgrader`, so they do
useful work instead of crashing the movement helpers on an `undefined` room
name (`memory.ts#adoptCreeps`). `Memory` stays lean: the contract block, the
cached plan, small per-room metadata. If bridge-read data ever
grows (room intel, stats history), move it to a `RawMemory` segment and point
the bridge at `memory-segment` instead — the contract itself stays in
`Memory.bridge`.

### Observability

Greppable console prefixes (the bridge streams these over its WS console
channel):

```
[hb]  {"tick":1234,"cpu":3.2,"bucket":9870,"creeps":12,"rev":4,"posture":"economy"}   every 10 ticks
[err] t=1234 creep:hauler_Spawn1_1200(hauler): <message + first stack frame>
[wrn] t=1234 directives: quota harvester=9999 clamped to 20
[inf] t=1234 spawn: miner_Spawn1_1234 (6 parts, 550e) in W8N3
```

Every `[err]` is also mirrored into `state.lastError`.

## Adopted techniques & attribution

The operational/tactical layers learn from **sy-harabi ("Harabi")**, a
high-level Screeps player. Per our license gate, *code* is only copied from a
permissively-licensed source; otherwise we **reimplement the documented
technique** in our own TypeScript and attribute it. The contract, directives,
state/ack and three-layer architecture are unchanged by any of this.

| Technique | Source | License | What we did |
|---|---|---|---|
| Flow-based traffic management ([`lib/traffic.ts`](src/lib/traffic.ts)) | [Screeps-Traffic-Manager](https://github.com/sy-harabi/Screeps-Traffic-Manager) + [writeup](https://sy-harabi.github.io/Journey-to-Solving-the-Traffic-Management-Problem/) | **None** (repo has no license file → all-rights-reserved) | **Reimplemented** from the documented approach. No source copied. |
| Early-economy patterns (static container miners + haulers, energy-scaled body sizing, RCL/construction order) | [screeps-harabi-bot-sample](https://github.com/sy-harabi/screeps-harabi-bot-sample) (reference) | n/a (patterns/ideas) | **Ported as patterns** into our TS roles/managers — these largely predate this update and were already present (`roles/miner.ts`, `roles/hauler.ts`, `managers/logistics.ts`, `managers/spawn.ts`, `lib/bodies.ts`, `managers/construction.ts`). |
| Cross-room logistics (terminal/storage balancing) | Harabi "Logistics" writeup | n/a (ideas) | **Deferred** — clean extension point left at `managers/logistics.ts#runInterColonyLogistics` (see §3). |

**Nothing is vendored verbatim** — there is no third-party code in this bundle.

### Traffic manager

The #1 day-to-day efficiency killer is congestion: naive `creep.moveTo`
deadlocks around sources, controllers and spawns. `lib/traffic.ts` resolves
every creep's desired next tile into a collision-free assignment each tick,
using a Ford-Fulkerson / DFS **augmenting-path** search over a bipartite graph
of creeps ↔ tiles (the technique Harabi documents). Higher-priority and idle
creeps yield: a hauler pushes an idle worker out of its lane; a defender
outranks the whole economy; a parked miner is pinned to its source.

How it plugs into the existing movement, with **zero churn to the contract**:

- `installTraffic()` (loop start) patches `Creep.prototype.move` once per global
  so `travelTo`'s `moveTo` call *registers* the intended step instead of
  executing it — all of `moveTo`'s multi-room, cached pathfinding is preserved.
- Roles keep calling `travelTo(creep, target, range, priority)`; haulers pass
  priority `2`, defenders `3`, everyone else the default `1`.
- Roughly-stationary roles call `setWorkingArea(creep, pos, range)` (upgraders
  near the controller, builders near a site, miners pinned at range 0) so they
  hold position but can still be shuffled *within* their zone rather than block
  a lane.
- `runTraffic(room, costs?, threshold?)` (loop end) does the resolution and
  issues the real moves. An optional `CostMatrix` + `threshold` keeps displaced
  creeps off costly tiles (e.g. source/controller approaches) — supported but
  not yet fed a matrix; that's the next tuning knob.

Validated by [`scripts/traffic-smoke.mjs`](scripts/traffic-smoke.mjs)
(corridor swap, idle displacement, priority contest, pinned-miner), wired into
`npm run smoke`.

## Baseline behaviour (zero directives)

RCL 1: harvesters (mine → deliver → fallback upgrade) + one upgrader bring
the room to RCL 2. Construction places a container at each source, then the
extension ring; once capacity ≥ 550 **and** a source container exists,
static miners (5×WORK parked on the container) + haulers replace harvesters.
Builders keep sites moving and repair; a tower goes up at RCL 3 and takes
over defense from emergency-spawned defenders. If income ever hits zero, the
spawn manager ignores quotas and bootstraps a harvester with whatever energy
is available.

## Evolving it

- **Roles → tasks:** introduce a `Task { type, target, priority }` queue per
  colony, let `logistics.ts`/`construction.ts` emit tasks, and replace the
  runner table in `roles/index.ts` with a claim-and-execute scheduler. The
  contract, managers, and main loop are already agnostic to it.
- **Real base planning:** `construction.ts`'s ring placement is the stub —
  have strategy write a layout into the plan and let construction execute it.
- **Multi-room logistics:** `logistics.ts#runInterColonyLogistics` is a no-op
  extension point — implement terminal/storage balancing there once the colony
  spans rooms, and call it (interval+bucket-gated) after the per-room loop.
- **New role:** one file in `roles/`, register it in `ROLE_RUNNERS`, give it
  a body in `lib/bodies.ts`, and a quota in `strategy/computeQuotas` (or just
  drive it via `directives.roleQuotas`).
- **Contract changes:** edit `API/src/contract.ts` (the single source of
  truth), rebuild the API package, bump `CONTRACT_VERSION` here on breaking
  changes.
