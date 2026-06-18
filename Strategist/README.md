# AI Strategist

The **external strategic layer** for the Screeps colony — the top box of the command
hierarchy. It observes `ColonyState` and issues high-level `Directives` through the
bridge's Memory contract. It is **strategy only**: it never touches creeps, spawns,
movement, or per-tick logic, and never bypasses the contract.

The colony runs fine with no strategist attached (the executor is autonomous by
default). The strategist makes it *better* and is built to degrade to "do nothing"
rather than ever making it worse.

```
ColonyState (executor writes) ──► Strategist ──► Directives (executor reads)
        ▲                              │
        └──────── observe (WS) ────────┘   propose (rare, budgeted)
```

## Why it can't micro

Rate limits and latency make per-tick external control impossible. Directive writes
ride the `POST memory` budget (~240/day ≈ one write every few minutes), so the
strategist runs an **observe → decide → propose → await-ack → observe-outcome** loop
at *strategic cadence*. It only ever writes `Directives`; it only ever reads
`ColonyState`/`ack`.

## How it attaches to a running bridge

The strategist owns its **own** `ScreepsBridge` instance (it is an independent
process — the external commander). Point it at the same account the executor runs on:

```bash
cd Strategist
npm install
cp .env.example .env     # set SCREEPS_TOKEN (and OLLAMA_API_KEY if using the LLM)
npm run dev              # starts the loop + HTTP API on :4100
```

- **State reads** come over the WebSocket `memory/bridge.state` channel
  (`control.watchState`) — cheap and real-time. It never polls `GET memory`.
- **Directive writes** go through `commander.propose()` (auto-incremented `rev`,
  then await the executor's ack).
- One `commander.snapshot()` seeds state + directives + ack at startup; thereafter
  state is streamed and directives are cached locally (the strategist is the only
  writer).

## The loop & cadence

Event/threshold-driven, never a tight timer. Each live-state push runs a throttled
`evaluate()`:

1. **Observe** — latest `ColonyState` (+ cached directives/ack).
2. **Gate** — proceed only when the *material* state digest changed, or a slow
   fallback interval elapsed; never more often than `MIN_EVAL_INTERVAL_MS`.
3. **Decide** — `decide(snapshot) → DirectivePatch | null` (`null` = no change, the
   common case).
4. **Clamp + preconditions** — `validateAndClamp` (postures/rooms/quotas) then
   guardrail preconditions for big moves.
5. **Diff-gate** — skip if the patch already matches current directives.
6. **Budget cap** — skip if the per-hour write ceiling is reached.
7. **Propose** — write + await ack (unless dry-run).
8. **Record** — every cycle lands in the decision history.

## Deciders

A pluggable `Decider` (`decide(s) → DirectivePatch | null`):

- **Rule-based** (default, `DECIDER=rules`) — no API cost, deterministic, and the
  always-on fallback. Hostiles → `defend`; stable economy + GCL headroom + a viable
  target → `expand`; storage surplus at an RCL plateau → bump `upgrader`; CPU bucket
  pressure → trim non-essential quotas.
- **LLM-backed** (`DECIDER=ollama`) — Ollama `kimi-k2.6:cloud`. Builds a compact
  digest + the directive schema into the prompt, requests `format: 'json'`, then
  **validates the result with Zod on our side** (Ollama Cloud does *not* enforce
  schemas). Bounded retry feeds validation errors back; repeated failure falls back
  to the rule-based decider. The model's `thinking` trace is captured into the
  directive `note` as the audit trail. **No model call is made when the state digest
  is unchanged.**

## Budget math (respect both)

- **Screeps writes** — directive writes use `POST memory` (~240/day). `MAX_WRITES_PER_HOUR`
  defaults to **6** (≈144/day worst case, well under the cap). The diff-gate prevents
  redundant writes.
- **Ollama calls** — only on a material digest change, only when `DECIDER=ollama`,
  and never when the digest is unchanged. A quiet colony makes ~0 calls.

## Safety model

- **Dry-run (default ON)** — decisions are computed, logged, and shown in the UI, but
  **never written**. Flip `DRY_RUN=false` (or toggle live) to go live.
- **Kill switch** — `KILL_SWITCH=true` halts all writing; the colony stays autonomous.
- **Guardrails** — postures whitelisted, room names regex-checked, quotas clamped to
  0–20, and `expand`/`war` blocked unless preconditions hold (stored energy, no active
  home threat, GCL headroom). The bot clamps too — this is a second net.
- **Stale/empty state** — `state === null` (executor not deployed) and a non-advancing
  `heartbeat` (executor stalled) both back off without writing.

## HTTP API (consumed by the UI commander panel)

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/health`   | liveness |
| GET    | `/state`    | status, flags, budget usage, Ollama call count, current directives, digest, steering, full decision history |
| POST   | `/control`  | `{ dryRun?, killSwitch?, decider? }` — live toggles |
| POST   | `/steer`    | `{ shortTerm?, longTerm? }` — human guidance for the AI's next iteration(s) |

All endpoints are local and cheap (no Screeps traffic); the UI may poll `/state`.

## Configuration

See [`.env.example`](.env.example). Key values (all optional, safe defaults):

| Var | Default | Meaning |
|-----|---------|---------|
| `SCREEPS_TOKEN` | — | account token (required for a live connection) |
| `DECIDER` | `rules` | `rules` \| `ollama` |
| `DRY_RUN` | `true` | log decisions without writing |
| `KILL_SWITCH` | `false` | halt all writing |
| `MAX_WRITES_PER_HOUR` | `6` | directive write ceiling |
| `MIN_EVAL_INTERVAL_MS` | `60000` | throttle floor |
| `SLOW_TICK_MS` | `300000` | fallback re-evaluation interval |
| `EXPAND_CANDIDATES` | — | rooms the rule decider may target |
| `OLLAMA_API_KEY` / `OLLAMA_HOST` / `OLLAMA_MODEL` | — / `https://ollama.com` / `kimi-k2.6:cloud` | LLM access |

## Tests

```bash
npm test
```

Mocks the Ollama client and the bridge. Covers: rule-based behaviour on representative
snapshots; off-schema LLM output is rejected and triggers the rule-based fallback; the
`thinking` trace lands in `note` (not in the parsed directive); no model call when the
digest is unchanged; the loop skips redundant writes; and stale/null/stalled/budget
back-off.

## Scope

Reads `ColonyState`, writes `Directives` — nothing else. No per-tick anything, no
creep/spawn/movement control, no raw endpoints, no strategy logic in the bridge or the
bot. Gated on a green integration harness (a contract-correct loop beneath it).
