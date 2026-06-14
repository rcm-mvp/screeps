# Screeps Web API Bridge

A single, fully-typed TypeScript library + thin service that exposes **every
capability of the Screeps external Web API** (HTTP + WebSocket) behind one clean
interface. Built so an AI agent or a frontend can reach everything the API
offers — no hidden endpoints, no missing capabilities.

This is a **pure transport + access layer**. It reads state, writes data/code,
issues discrete world commands, and streams live updates. It contains **zero
game/bot logic** — creep/spawn/per-tick decision-making belongs in code you
upload to the game, not here.

> ⚠️ The Screeps Web API is officially undocumented but tolerated. Every
> endpoint here is community-reverse-engineered and may change. All raw paths
> live in one file ([`src/endpoints.ts`](src/endpoints.ts)) so updates are a
> one-file change.

---

## Install & build

```bash
cd API
npm install
npm run build      # compile to dist/
npm test           # run the mocked-server test suite
```

Requires **Node.js 18+** (uses native `fetch`).

## Generating an auth token

1. Log in at <https://screeps.com>.
2. Go to **Account → Auth Tokens** (<https://screeps.com/a/#!/account/auth-tokens>).
3. Create a token (full access, or scope it). Tokens have **no expiration**.
4. Provide it as `SCREEPS_TOKEN` (env) or `new ScreepsBridge({ token })`.

Private servers without tokens can use `bridge.auth.signin(email, password)`.

## Configuration

Pass config to the constructor or via environment variables (see
[`.env.example`](.env.example)). The constructor wins over env.

| Option       | Env                 | Default     | Notes |
|--------------|---------------------|-------------|-------|
| `server`     | `SCREEPS_SERVER`    | `official`  | `official` \| `ptr` \| `private` |
| `token`      | `SCREEPS_TOKEN`     | —           | Persistent auth token |
| `shard`      | `SCREEPS_SHARD`     | `shard3`    | Default shard for shard-scoped calls |
| `host`       | `SCREEPS_HOST`      | —           | Required for `private`, e.g. `http://localhost:21025` |
| `username`   | `SCREEPS_USERNAME`  | —           | Private-server signin |
| `password`   | `SCREEPS_PASSWORD`  | —           | Private-server signin |
| `log`        | `SCREEPS_LOG`       | `false`     | Structured request/response logging |
| `maxRetries` | —                   | `3`         | Transient-failure retries |

**Presets**

- `official` → `https://screeps.com` (rotates token via `X-Token` header)
- `ptr` → `https://screeps.com/ptr` (rotates token)
- `private` → your `host`; persistent-token rotation off by default; SockJS WS derived from host.
  **`auth.signin()` enables `X-Token` rotation automatically** — a signin session
  token rotates each response and would otherwise expire mid-run (a long-running
  session would start 401ing). A persistent token you pass in stays non-rotating.

## Quick start

```ts
import { ScreepsBridge } from 'screeps-web-api-bridge';

const bridge = new ScreepsBridge({ token: process.env.SCREEPS_TOKEN, shard: 'shard3' });

// Account + game state
const me = await bridge.auth.me();
const { time } = await bridge.map.time();
const memory = await bridge.memory.get('');          // gz auto-decoded
const terrain = await bridge.rooms.terrain('W1N1');  // raw string + grid[y][x]

// Issue a world command
await bridge.world.createFlag({ room: 'W1N1', x: 25, y: 25, name: 'rally', color: 3 });

// Run a console expression (output streams over the WS console channel)
await bridge.console.run('Game.cpu.bucket');

// Push code to a branch
await bridge.code.push('main', { main: 'module.exports.loop = () => {};' });
```

### Live WebSocket

```ts
await bridge.connectSocket();                 // SockJS + auth + auto-reconnect

await bridge.subscribeConsole((m) => console.log(m.data));
bridge.subscribeRoom('W1N1', (m) => {
  // m.data is a *merged* snapshot — deltas are applied for you
  console.log(m.data.gameTime, Object.keys(m.data.objects).length, 'objects');
});
await bridge.subscribeCpu((m) => console.log('cpu', m.data));
```

Room updates are incremental: the first frame is the full room, later frames
contain only changes (`null` = deleted). The bridge maintains a merged
current-state cache per room and emits clean snapshots, while raw deltas remain
available via the socket's `delta` event.

Run the end-to-end demo:

```bash
SCREEPS_TOKEN=... npm run example -- W1N1
```

## Control Channel (shared Memory contract)

The bridge talks to an in-game **executor** through a small contract stored under
`Memory.bridge`. The exact types live in [`src/contract.ts`](src/contract.ts) and
are exported from the package root so the executor, the AI strategist, and the UI
all import identical definitions.

```
Memory.bridge.directives   bridge WRITES · executor READS    (Directives)
Memory.bridge.state        executor WRITES · everyone READS  (ColonyState)
Memory.bridge.ack          executor confirms applied rev     ({ directiveVersion, appliedTick })
```

`bridge.control` is ergonomic, typed access to that contract. It sits **on top
of** the raw memory + WS methods (it never bypasses them or the rate limiter):

```ts
// Read (decoded; null if the executor isn't deployed yet)
const state = await bridge.control.getState();
const directives = await bridge.control.getDirectives();

// Write a directive (auto-increments `rev`, returns the new rev)
const rev = await bridge.control.setDirectives({ posture: 'defend', targetRooms: ['W5N8'] });

// Write + wait for the executor to confirm it applied that rev
const applied = await bridge.control.pushAndConfirm({ paused: true }); // boolean

// Ergonomic wrappers
await bridge.control.pause();
await bridge.control.resume();
await bridge.control.setPosture('war');
await bridge.control.setTargetRooms(['W1N1', 'W2N2']);
await bridge.control.setQuota('harvester', 6);

// Live state over WebSocket — the cheap, real-time path (do NOT poll getState)
const stop = bridge.control.watchState((s) => console.log('tick', s.tick, s.cpu.bucket));
// ... later: stop();
```

### Budget rule (important)

- **Directive writes** ride the `POST memory` budget (~240/day) — fine for a
  strategic cadence (a write every few minutes).
- **Live state reads** go through the WS `memory/bridge.state` channel
  (`control.watchState`), **never** a polling loop of `GET memory` (~1440/day).
- `awaitAck` prefers the WS `memory/bridge.ack` subscription; it only falls back
  to low-frequency polling when the socket is unavailable.

### Commander (for the AI strategist)

`bridge.commander` is the minimal, strategy-free surface an AI agent or the UI
uses without touching raw endpoints:

```ts
const { state, directives, ack } = await bridge.commander.snapshot(); // everything to decide
const { rev, applied } = await bridge.commander.propose({ posture: 'expand' });
```

It only reads the contract and writes directives — **no** decision-making lives
here; that is out of scope for the bridge.

All control/commander capabilities are also in the manifest (e.g.
`control.setDirectives`, `commander.propose`), so they are callable via
`bridge.invoke(...)` and over MCP.

### Smoke test

```bash
SCREEPS_TOKEN=... npm run smoke
```

Runs: `auth/me` → `control.getState` (null is expected pre-deploy) →
`setDirectives` + confirm persisted rev → WS subscribe (`cpu`/`console`/state) →
`console Game.time` → `code.get`, printing PASS/FAIL per step.

## Rate limiting

Token-authed requests are rate-limited. The bridge runs a central, per-endpoint
**rate-limit manager** that tracks remaining budget per class, queues requests,
and backs off automatically rather than blindly retrying.

- Global cap: **120 req/min**, applied on top of per-endpoint classes.
- Per-endpoint caps (see [`src/endpoints.ts`](src/endpoints.ts)): e.g.
  `GET user/code` 60/hr, `POST user/code` 240/day, `GET user/memory` 1440/day,
  `POST user/console` 360/hr, `GET game/room-terrain` 360/hr,
  `POST game/map-stats` 60/hr, market endpoints 60/hr each, …
- On **429** the manager parses `Retry-After` / `X-RateLimit-*` headers, zeroes
  the offending class until its timer elapses, and **never** retries before the
  server's timer is honoured.
- Inspect live budgets for a UI:

```ts
bridge.getRateLimitBudgets(); // [{ label, max, remaining, windowMs, resetAt }, ...]
```

## Errors

All failures are typed (`import { ... } from 'screeps-web-api-bridge'`):

- `AuthError` — missing/invalid token, bad credentials, `auth failed`
- `RateLimitError` — carries `retryAfterSec`, `resetAt`, `rateLimitClass`
- `NotFoundError` — HTTP 404
- `ServerError` — HTTP 5xx or `{ ok: 0 }`
- `BridgeError` — base class (also unexpected statuses)

Successful `{ ok: 1, ... }` envelopes are unwrapped automatically.

## Capability manifest & AI-agent use

Every capability is also a discrete, self-describing function with a JSON schema
for its params and result, so an agent can introspect and call any one of them:

```ts
bridge.getManifest();                 // [{ name, description, params, returns, rateLimitClass }, ...]
await bridge.invoke('memory.get', { path: 'stats' });
await bridge.invoke('world.createFlag', { room: 'W1N1', x: 10, y: 10, name: 'f1' });
```

### MCP server (optional)

A thin, **dependency-free** MCP wrapper registers every capability as a tool
over stdio. The core library stays MCP-agnostic.

```bash
SCREEPS_TOKEN=... npm run mcp        # or: node dist/mcp/server.js
```

Example MCP client config:

```json
{
  "mcpServers": {
    "screeps": {
      "command": "node",
      "args": ["/path/to/API/dist/mcp/server.js"],
      "env": { "SCREEPS_TOKEN": "your-token", "SCREEPS_SHARD": "shard3" }
    }
  }
}
```

## Escape hatch

Anything not wrapped as a typed method is still reachable:

```ts
await bridge.http.request('GET', '/api/some/new/endpoint', { query: { foo: 1 } });
await bridge.invoke('http.request', { method: 'GET', path: '/api/...' });
```

## Capability coverage

**Auth / account** — `auth/signin`, `auth/me`, `auth/query-token`, `user/name`,
`user/find`, `user/world-status`, `user/world-start-room`, `user/world-size`,
`user/respawn-prohibited-rooms`, `user/rooms`, `user/stats`, `user/overview`,
`user/badge`, `user/notify-prefs`

**Code / branches** — GET/POST `user/code`, `user/branches`, `set-active-branch`,
`clone-branch`, `delete-branch`

**Memory** — GET/POST `user/memory` (gz auto-decode), GET/POST
`user/memory-segment` (0–99)

**Console** — POST `user/console`

**Room data** — `room-overview`, `room-terrain` (+encoded grid), `room-status`,
`room-objects`, `experimental/pvp`, `experimental/nukes`, `room-history`

**World** — `gen-unique-object-name`, `check-unique-object-name`,
`gen-unique-flag-name`, `create-flag`, `change-flag`, `change-flag-color`,
`remove-flag`, `create-construction`, `place-spawn`, `set-notify-when-attacked`,
and `add-object-intent` split into ergonomic methods: `suicideCreep`,
`unclaimController`, `destroyStructures`, `removeConstructionSite`, `removeFlag`

**Market** — `orders-index`, `orders`, `my-orders`, `stats`, `money-history`

**Map / meta** — `map-stats`, `game/time`, `shards/info`, `version`, `servers/list`

**Messaging** — `index`, `list`, `send`, `unread-count`, `mark-read`

**Misc** — decorations, leaderboard, scoreboard, `activate-ptr`

**WebSocket channels** — `user:<id>/cpu`, `/console` (+ error variant),
`/memory/<path>`, `/newMessage`, `/message:<user2>`, `/set-active-branch`,
`roomMap2:<shard>/<room>`, `room:<shard>/<room>` (+ `err@…` variant),
`server-message`

## Project layout

```
src/
  bridge.ts        ScreepsBridge facade (composes everything)
  config.ts        presets + env resolution
  endpoints.ts     ← all raw paths + rate-limit classes (single source of truth)
  errors.ts        typed error classes
  contract.ts      ← shared Memory contract types (executor/AI/UI import these)
  control.ts       ControlChannel — typed contract access over memory + WS
  commander.ts     thin read-contract / write-directive surface for an AI
  manifest.ts      capability catalogue (metadata + handlers)
  dispatch.ts      name → handler table for invoke()
  core/            httpClient, rateLimiter, gz codec, logger
  modules/         auth, code, memory, console, rooms, world, market, map, messaging, misc
  socket/          sockjs shim, socketClient, channels, room merge
  mcp/server.ts    optional dependency-free MCP wrapper
  cli/example.ts   end-to-end demo
  cli/smoke.ts     control-channel PASS/FAIL smoke test
test/              mocked-server tests (rate limiter, gz, room merge, http, control)
```

## Scope

Read/write data + code, discrete world commands, live streams — **yes**.
Bot behaviour (creep/spawn/tick logic) — **no**; that belongs in the code you
upload to the game.

## License

MIT
