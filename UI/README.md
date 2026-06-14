# Screeps Bridge Panel

A visualization + manual-control dashboard for the [Screeps Web API Bridge](../API/README.md).
Everything the bridge can do, visible and operable — and observable when an AI agent is
driving the same bridge. **No bot logic lives here**: the UI only reads state, streams live
channels, and issues the bridge's discrete commands.

## Architecture

The bridge is a Node library (it needs `ws` + Node `zlib`), so the browser can't load it
directly. A thin **host process** ([server/index.ts](server/index.ts)) owns the single
`ScreepsBridge` instance and relays it 1:1:

```
Browser (React)  ──HTTP──>  /api/invoke · /api/manifest · /api/rate-limits · /api/connect
                 ──WS────>  /bridge-ws  (subscribe/unsubscribe + channel frames + budget pushes)
Host (Node)      ──bridge──>  ScreepsBridge  ──>  screeps.com / PTR / private server
```

- Every Screeps call goes through `bridge.invoke(<capability>)`, so the bridge's central
  rate-limit manager, typed errors, and gz decoding all apply unchanged.
- WS channel subscriptions are refcounted across browser tabs; room snapshots arrive
  pre-merged by the bridge (first frame full, then deltas applied server-side).
- The capability manifest is served verbatim — new bridge capabilities automatically appear
  in the Raw API console (and the World Actions forms are generated from the same schemas).
- The auth token lives only in the host process (or `SCREEPS_TOKEN` env); it is never sent
  to the browser or persisted by the UI.

## Setup

```bash
cd API && npm install && npm run build    # build the bridge once
cd ../UI && npm install
npm run dev                               # host on :4000 + Vite on :5173
```

Open <http://localhost:5173>. Optional env for the host (set before `npm run dev`):

| Env | Effect |
|---|---|
| `SCREEPS_TOKEN` | auto-connect on boot; the connect form's token field can stay empty |
| `SCREEPS_SERVER` / `SCREEPS_SHARD` / `SCREEPS_HOST` | default server preset / shard / private host |
| `BRIDGE_UI_PORT` | host port (default 4000; the Vite proxy follows it) |

`npm run server` and `npm run web` run the two halves separately; `npm run typecheck`
checks both the app and the host.

## Panels

- **Connection** — server preset (official / PTR / private host), token, shard; account card
  (username, GCL/GPL, credits, CPU limit) and the three link states (bridge, game socket, host link).
- **Colony** — all rooms a user owns (defaults to your account; any username can be looked up),
  as summary cards (RCL + progress, spawn energy, storage, creep/hostile/site counts). Selecting
  a room opens a live detail view: controller progress + downgrade warning, creep table with
  working/moving/**idle** status (from each creep's actionLog + movement between ticks), body
  summary, HP/TTL/store, hostiles, structure inventory with min-HP, and construction progress.
  After connecting, your strongest room is auto-detected and becomes the **default** for the
  Room Viewer and World Map (persisted in localStorage).
- **CPU & Memory** — live chart from the WS `user/cpu` channel: CPU used vs limit, serialized
  Memory bytes; overrun ticks counted and flagged. Bucket/tick/GCL come from
  `Memory.bridge.state` (the executor contract) — *the cpu channel itself doesn't carry the
  bucket; without the in-game executor the bucket shows `n/a`.*
- **Console** — streaming log/result feed from `user/console` with runtime errors styled
  distinctly; input runs expressions via `console.run` (budget 360/hr shown, button disables
  when exhausted; ↑/↓ for input history).
- **Room Viewer** — 50×50 canvas: terrain background (`rooms.terrain`) + live merged room
  snapshots (`room:<shard>/<room>`), colored by ownership. Click a tile to inspect raw object
  JSON, destroy structures / suicide creeps / remove sites (confirmed), or place a flag.
  Shows the `err@room` rate-limited state when the server throttles the subscription.
- **World Map** — pannable room grid via one batched `map.mapStats` call per refresh
  (60/hr — manual only): ownership/RCL/reserved/novice; optional PvP + nuke overlays
  (experimental endpoints). Click a room to open it in the Room Viewer.
- **Memory** — tree view of decoded Memory (manual loads; GET is 1440/day), path-scoped
  writes with confirm (✎ on any node prefills path+value), raw segments 0–99 tab.
- **Code / Branches** — branch list with active-world/sim markers, read/edit module viewer,
  set-active-branch (confirmed), clone/delete, and a double-guarded push (type the branch
  name, then confirm — it overwrites the live bot, 240/day).
- **Market** — order book per resource, my open orders, avg-price/volume history chart,
  paginated credit history. All market endpoints share one 60/hr class, shown on the panel.
- **World Actions** — curated manifest-generated forms: flags, construction/spawn placement,
  destructive intents (two-step confirm), and executor directives (`control.*`).
- **Raw API** — the capability manifest rendered live: every callable function with its
  schema, a generated param form, live budget for its rate-limit class, and the raw typed
  response. Includes the `http.request` escape hatch.
- **Rate Limits** — every budget class with remaining/max, window, reset countdown, and the
  global 120/min cap. The same budgets gate buttons across the UI.

The persistent header shows connection + shard, last tick (with staleness), a live CPU
sparkline, and the global request budget.

## Notes / known gaps

- **Bucket over WS**: no public push channel carries `Game.cpu.bucket`; the bridge's
  `Memory.bridge.state` contract is the supported live path (deploy the executor to get it).
  This is a Screeps API gap, not a bridge gap.
- **Server wall-clock time**: there is no push channel for it; the header shows the last tick
  received and how long ago it arrived instead of polling `game/time`.
- Room snapshots re-render per tick (no sub-tick tweening) — deltas are already merged by
  the bridge.
