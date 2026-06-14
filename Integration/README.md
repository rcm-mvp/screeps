# Integration Harness — contract round-trip

This is the cross-repo gate. Each of the three components is already green in
isolation, but every one of those checks ran against a **mock**. This harness
exercises the seam where they actually meet:

```
Bot writes Memory.bridge.state  →  bridge reads it over WS
        ↑                                     ↓
   bridge.ack  ← Bot validates + acks ← bridge writes Memory.bridge.directives
```

It deploys the **real built executor** (`Bot/dist/main.js`), drives it through
the **real bridge library** (`screeps-web-api-bridge`, the `API/` package), and
asserts the shared `contract.ts` round-trips end to end against a **private
Screeps server**. It changes none of the three repos — it only observes and
drives their built artifacts. When a scenario fails it names which half of the
contract broke (bot write / bridge read / directive write / ack), so a red run
points straight at the repo to fix.

## What it tests the artifacts, not reimplementations

- The bridge is consumed as a workspace dependency (`file:../API`) — the same
  package the UI and the executor's push script use.
- The executor is the bundle `Bot/dist/main.js`, pushed via the bridge's
  `code.push` to branch `default`. Drift is only caught if the real artifact
  runs.
- The contract version/shape is asserted at runtime against a copy pinned here
  (`src/contractVersion.ts`), so a one-sided bump in any repo fails loudly.

## Prerequisites

- **Node ≥ 18**, **Docker + Docker Compose** (for the private server).
- The two upstream packages build cleanly (`npm run build` in `API/` and
  `Bot/`). The one-command runner does this for you.

## Run it locally (one command)

```bash
cd Integration
npm install
npm run itest          # builds API + Bot, starts the server, runs A–I, tears down
```

Variants:

```bash
npm run itest:keep                       # leave the server running afterwards
node scripts/run-local.mjs --skip-build  # reuse existing dist/ artifacts
node scripts/run-local.mjs --grep "E\."  # run a subset of scenarios
```

Or drive the pieces yourself:

```bash
npm run server:up      # docker compose up -d  (first boot installs server mods; ~2-3 min)
npm test               # vitest run  (globalSetup provisions the world + pushes the bot)
npm run server:down    # docker compose down -v
```

A hermetic subset needs no server or Docker:

```bash
npm run test:hermetic  # scenario I only (simulated 429s against an in-process mock)
```

## Pointing at a private server

All configuration is environment variables (`.env.example` documents them;
`scripts/run-local.mjs` fills in the docker defaults). The two that matter:

| Variable               | Purpose                                                        | Default                  |
| ---------------------- | ------------------------------------------------------------- | ------------------------ |
| `SCREEPS_PRIVATE_HOST` | **Required.** HTTP origin of the private server.              | *(none — must be set)*   |
| `SCREEPS_CLI_PORT`     | Server admin CLI port (god-mode bootstrap).                   | `21026`                  |
| `SCREEPS_TICK_MS`      | Tick duration the harness configures (faster = quicker run).  | `150`                    |
| `SCREEPS_RESTART_CMD`  | How to restart the server (scenario H part 2; unset = skip).  | `docker compose restart` |
| `SCREEPS_ALLOW_REMOTE` | Set `true` to permit a non-local host.                        | unset                    |

### Safety — private server only

The suite is destructive (it resets world data). Two layers refuse to run
against the public MMO:

1. **Static guard** (`src/env.ts`): `SCREEPS_PRIVATE_HOST` is mandatory with no
   default; any `*.screeps.com` host is rejected; a non-local host needs
   `SCREEPS_ALLOW_REMOTE=true`.
2. **Runtime probe** (`src/bootstrap.ts`): `/api/version` is fingerprinted and
   a multi-shard / high-user-count server (the official-server signature) is
   refused.

Auth uses the private-server signin path (`POST /api/auth/signin` via the
bridge), never a hand-rolled client or a pre-issued public token.

## How a run is provisioned

`src/globalSetup.ts` runs once per suite, all through the server's admin CLI
(god mode — no rate-limit budget consumed):

1. safety guards → wait for HTTP API + CLI
2. `system.resetAllData()` + `utils.removeBots()` — clean seeded world, demo
   bots gone, Invader/Source-Keeper NPCs kept
3. fast tick duration
4. find a free room with sources + an open base area; bootstrap a RCL-3 base
   (spawn + 10 extensions + a tower = 800 energy capacity, enough for claimers
   and a real defending tower) and a password login
5. sign in **through the bridge** and push the **real** `Bot/dist/main.js`

Between scenarios, only the test user's slice is reset (`src/scenario.ts` →
`resetScenario`): creeps (incl. NPC hostiles), flags, sites and the user's
whole Memory are wiped and base energy refilled, so no scenario poisons the
next. Waits are condition-based and expressed in "ticks worth of wall-clock"
(`src/poll.ts`), never fixed sleeps.

## What each scenario guarantees

| # | Scenario | Guarantees |
|---|----------|-----------|
| **A** | Empty-world boot | The executor self-boots with no directives: writes `ColonyState` on the exact path the bridge reads, advances the heartbeat every tick, spawns creeps, and makes RCL progress. |
| **B** | Live read path | `watchState()` streams live state over WS and matches a one-off `getState()` — **without decrementing the `GET memory` budget**. The key guard against a poller silently draining the read budget. |
| **C** | Directive round-trip + ack | `commander.propose()` returns a `rev`, the executor acks it (`pushAndConfirm` → true), **and** an observable behaviour change follows (posture flips the plan; `setQuota` raises the live creep count). THE contract handshake. |
| **D** | Malformed-directive survival | Garbage written **directly** (bypassing `Commander`) is clamped (quota ≤ 20), bad posture/rooms ignored, the rev **still acked** (no hang), the bot keeps running, and it warns once-per-rev not per-tick. |
| **E** | Pause kill-switch | `propose({paused:true})` halts the economy (no new economic creeps) while **defense persists** — the tower keeps firing and kills NPC invaders. The stop button, proven across the wire. |
| **F** | Contract-version drift | `Memory.bridge.version` equals the version this suite certifies; the full `BridgeMemory` block matches the contract shape. A one-sided bump screams here instead of failing silently in production. |
| **G** | Flag command channel | A `claim:*` flag placed via the real API makes the plan target that room **and** dispatches a claimer carrying it; `scout:*` enters the plan's scout targets. The spatial command channel, end to end. |
| **H** | Resilience | A forced global reset (code re-push) → the bot rebuilds its heap and resumes writing state, keeping its creeps. With `SCREEPS_RESTART_CMD` set, a full server restart → the bridge WS **auto-reconnects and re-subscribes** with no manual rewiring. |
| **I** *(opt)* | Rate-limit behaviour | Simulated 429s against an in-process mock (private servers impose no token budget): the bridge backs off honouring `Retry-After`, queues concurrent callers instead of stampeding, and surfaces a typed `RateLimitError` only once retries are exhausted. The one pre-deploy rehearsal of that code. |

## Headline findings — three real bridge bugs the mocks hid (all now fixed)

The harness immediately earned its keep, surfacing **three** contract-breaking
bridge bugs that every per-component (mocked) test missed. All reproduce
against the official server too — they are not private-server quirks. Each has
since been fixed in the bridge/contract/executor and is now **regression-guarded
by a passing scenario** (no `it.fails` remain).

### Bug #2 — directive writes were double-encoded (the write path)

`POST /api/user/memory` on the screeps backend does
`JSON.stringify(request.body.value)` server-side, but the bridge's
`memory.set()` also sent `value: JSON.stringify(value)`. The directive landed
in `Memory.bridge.directives` as a **string**, the executor's `readDirectives`
rejected the non-object and fell back to defaults, and the directive never took
effect — `control.setDirectives` / `commander.propose` silently no-op'd.

**Fix:** `memory.set()` now sends the raw value; the backend serialises it
exactly once (`API/src/modules/memory.ts`). **Guarded by** scenario C's
`control.setDirectives() reaches the executor and gets acked`.

### Bug #1 — the WS live-read path was broken against a real server

Every per-component test mocked the WebSocket memory channel by returning the
full state object, so `control.watchState()` and `control.awaitAck()` looked
correct. Against a real screeps server they were **not**: the backend's
memory-path pubsub serialises each update with `result = "" + value`
(`@screeps/backend .../socket/user.js`), so a subscription to an **object** path
streams the literal string `"[object Object]"`. Only **primitive leaf** paths
survive:

| WS subscription path            | delivered value     |
| ------------------------------- | ------------------- |
| `bridge.state` (object)         | `"[object Object]"` |
| `bridge.ack` (object)           | `"[object Object]"` |
| `bridge.state.heartbeat` (num)  | `"850"`             |
| `bridge.version` (num)          | `"1"`               |

So `watchState()` yielded unusable state and `awaitAck()` / `pushAndConfirm()`
could never confirm over WS even though the executor truly acked.

**Fix:** the executor mirrors state/ack through **JSON-string** leaf paths the
channel can carry — `bridge.stateJson = JSON.stringify(state)` and
`bridge.ackJson` (`Bot/src/state.ts`, `CONTRACT_PATHS` in `API/src/contract.ts`)
— and the bridge's `watchState`/`awaitAck` subscribe to those strings and
`JSON.parse` (`API/src/control.ts`). HTTP readers still use the object paths.
**Guarded by** scenario B's `watchState delivers usable ColonyState` and
scenario C's `pushAndConfirm() ... over WS`.

### Bug #3 — signin sessions expired mid-run (the auth path)

`auth.signin()` stores the returned **session token**, which the screeps
backend rotates on every response (a fresh `X-Token` with a refreshed expiry,
old one invalidated). But the bridge only adopted `X-Token` when the preset's
`rotatesToken` was true, and the **`private` preset defaults it off** — so the
bridge reused the original session token until the server expired it, then 401'd
mid-session. Only surfaced by the longest scenario (G), which outlives the token.

**Fix:** `signin()` calls `client.enableTokenRotation()`, so a signin session
adopts `X-Token` rotation even on the `private` preset; a deliberately-supplied
persistent token still stays non-rotating as documented
(`API/src/modules/auth.ts`, `API/src/core/httpClient.ts`). **Guarded by** the
two new `httpClient` unit tests plus scenario G running to completion.

### How the harness stays honest

The bug-documenting scenarios (B and C) were originally Vitest `it.fails`
markers — passing while the bug existed, turning RED the instant it was fixed.
Now that the bridge is fixed they are ordinary `it` assertions of the corrected
behaviour, and the whole suite (A–I, 25 tests) is green against the live server.

## CI

`.github/workflows/integration.yml` builds both real artifacts, brings the
private server up with `docker compose` (a step, not a `services:` block — so
scenario H can restart it), waits for the API, runs the suite headless, dumps
server logs on failure, and always tears the server down.

## Layout

```
Integration/
  docker-compose.yml         private server (mongo + redis + screeps-launcher)
  server/config.yml          launcher config (mods + CLI on 0.0.0.0:21026)
  scripts/run-local.mjs      one-command runner (build → up → test → down)
  src/
    env.ts                   config + public-server safety guard
    serverCli.ts             admin-CLI client (god-mode bootstrap)
    bootstrap.ts             reset, tick rate, user/base, hostiles, isolation
    context.ts               run context + bridge factory (private signin)
    poll.ts                  StateWatcher + condition-based waits (no fixed sleeps)
    directives.ts            correctly-encoded directive writer (bug #2 workaround)
    scenario.ts              per-scenario fixture (reset + bridge)
    report.ts                contract-half failure attribution
    contractVersion.ts       the version this suite certifies (drift anchor)
    globalSetup.ts           one-time provisioning + real bundle push
  test/                      scenarios A–I
```
