# Server Migration & Operations

## Context

The whole system used to run on a single developer PC — the long-running
support services (the UI bridge host, the web dashboard, the AI Strategist) and
the Bot deploy pipeline all lived locally, which tied "the colony's brain" to
one machine being on. This migrates everything that needs to *keep running* onto
a dedicated Linux server so it is **machine-independent**: log in from a laptop
or a PC, and the services are already up on the server. The in-game Bot itself
always runs on Screeps' own servers; what moved here is everything *around* it.

**Server:** AlmaLinux 10, Node 24, Docker + Compose, reached via the SSH host
alias `Screeps` (`~/.ssh/config`). Code lives in **`/home/screeps/src`** (a clone
of this repo). Only SSH (port 22) is open to the internet.

## What runs on the server

| Component | What it is | Port (loopback) | How it runs |
|---|---|---|---|
| **UI bridge host** (`UI/server`) | Holds the Screeps token, owns the live bridge connection, serves `/api/*` + `/bridge-ws` | `127.0.0.1:4000` | tmux (`npm run dev`) |
| **UI web** (`UI/`, Vite) | The React dashboard | `127.0.0.1:5173` | tmux (same `npm run dev`) |
| **Strategist** (`Strategist/`) | External AI strategic layer (dry-run by default) | `127.0.0.1:4100` | tmux (`npm start`, built) |
| **Bot** (`Bot/`) | In-game executor — **runs on Screeps' servers**, deployed from here | — | `npm run deploy` (on demand) |
| **API** (`API/`) | The `screeps-web-api-bridge` library all of the above depend on | — | built once (`npm run build`) |
| **Integration** (`Integration/`) | Docker-based contract test harness | 21025/21026 (suite-local) | `npm run itest` (see deferred) |

All three services **bind to `127.0.0.1` only** — they are *not* reachable from
the internet. The bridge host can invoke any Screeps capability with the account
token, so exposing it publicly would hand control of the account to anyone; keep
it loopback-only and reach it through SSH (below). Override per-service with
`BRIDGE_UI_HOST` / `STRATEGIST_HOST` / Vite's `server.host` only if you really
mean to expose them.

## Accessing the dashboard from any machine

Services listen on the server's loopback; you reach them by **forwarding the
ports over SSH** — nothing is exposed publicly.

**VS Code Remote-SSH (easiest):** connect to the `Screeps` host, open
`/home/screeps/src`, and VS Code auto-forwards 4000/5173/4100. Open
`http://localhost:5173` in your local browser.

**Plain SSH tunnel (any terminal):**
```bash
ssh -N -L 5173:127.0.0.1:5173 -L 4000:127.0.0.1:4000 -L 4100:127.0.0.1:4100 Screeps
# then open http://localhost:5173 in your browser
```
Only `5173` is strictly needed for the dashboard (the page talks to 4000/4100
through Vite's server-side proxy); forward 4000/4100 too if you want to hit the
APIs directly.

**Per-machine requirement (the one unavoidable bit):** each computer you use
needs your SSH key and a `Host Screeps` entry in its `~/.ssh/config`. That key is
the credential to the server — copy it to each trusted machine; do not commit it.

## Operating the services

```bash
ssh Screeps
cd /home/screeps/src
bash ops/start.sh     # start UI + Strategist in tmux session "screeps"
bash ops/status.sh    # show tmux session + listening ports
bash ops/stop.sh      # stop everything
tmux attach -t screeps  # watch live logs (Ctrl-b d to detach)
tail -f logs/ui.log logs/strategist.log
```

The bridge host **auto-connects** on boot using `UI/.env`'s `SCREEPS_TOKEN`
(verified: connects as account `raco`). The Strategist starts in **dry-run**
(`decider=rules`), so it computes and logs decisions but never writes directives
until you flip it live from the dashboard or set `DRY_RUN=false` in
`Strategist/.env`.

## Updating the code

This repo is the single source of truth (`origin` = GitHub `rcm-mvp/screeps`).
Edit from any machine, push, then update the server:

```bash
# on the server
cd /home/screeps/src
bash ops/stop.sh
git pull
# if API changed:        (cd API && npm run build)
# if Strategist changed: (cd Strategist && npm run build)   # it runs from dist/
# the UI server + web run from source via tsx/vite — no build step
bash ops/start.sh
```
You can also edit directly on the server through VS Code Remote-SSH and commit
from there — same repo, no machine-specific state.

## Deploying the Bot to the game

The in-game executor is pushed from the server (uses `Bot/.env`'s token):
```bash
cd /home/screeps/src/Bot
npm run smoke     # optional: build + mocked-loop + traffic + planner checks
npm run deploy    # esbuild → dist/main.js, then push to branch $SCREEPS_BRANCH
```
Code pushes ride the ~240/day budget — deploy deliberately. This was **not**
auto-run during migration (the live colony is already running the deployed
code); run it yourself when you have a new build to ship.

## Files that are NOT in the repo (recreate on a fresh server)

- **`.env` files** (`Bot/.env`, `UI/.env`, `Strategist/.env`) — hold
  `SCREEPS_TOKEN` (+ Strategist tuning / optional `OLLAMA_API_KEY`). Gitignored;
  copied to the server during migration. Templates: each `*.env.example`.
- **`node_modules/`, `dist/`** — never copied; reinstalled/rebuilt on the server
  (`npm install` per package; Windows-native binaries would not run on Linux
  anyway). Install order: **`API` first** (`npm install && npm run build`,
  because Bot/UI/Strategist depend on its built `dist/` via `file:../API`), then
  `Bot`, `UI`, `Strategist`, `Integration`.

---

## Deferred / known issues

### 1. Integration suite needs Docker group membership (one sudo step) — ACTION REQUIRED
The harness is fully set up (deps installed, `docker-compose.yml` validates,
`server/config.yml` present) but the `screeps` user cannot reach the Docker
daemon, and this server has **no passwordless sudo**, so it could not be granted
automatically. Run once, as a user with sudo:
```bash
sudo usermod -aG docker screeps
# then fully log out and back in (new SSH session) for the group to take effect
```
Verify and run:
```bash
docker ps                       # should work without sudo now
cd /home/screeps/src/Integration
npm run itest                   # builds API+Bot, boots private server, runs A–I, tears down
                                # first boot pulls images + installs mods (~2–3 min); full run ~5–10 min
```
Everything else for Integration is ready; this is the only blocker. (I can run
the full suite for you once the group change is in place.)

### 2. Services do not survive a reboot (by design — tmux)
We use tmux, so a server **reboot** (or `tmux kill-server`) stops the services;
just `bash ops/start.sh` again afterward. Also, tmux processes end if the boot
session's lingering is disabled — they persist across *your* SSH disconnects
(tmux detaches fine) but not across reboots. If you later want
reboot-survival/auto-restart, promote to **systemd user services** + `loginctl
enable-linger screeps` (needs one sudo step); the start commands in `ops/` map
directly onto unit `ExecStart`s.

### 3. `Strategist/.env` has a stale `SCREEPS_HOST=http://localhost:21025`
Harmless today — `SCREEPS_SERVER=official` takes precedence so the strategist
correctly talks to screeps.com (verified: it reads live state, heartbeat
advancing). But it's a foot-gun if the server preset ever changes. Tidy: comment
that line out in `Strategist/.env`. (The `.env.example` already warns about it.)

### 4. Cosmetic: `npm install` re-resolved some `package-lock.json` files
On the server, installing with npm 11 produced lockfile churn in
`Bot/UI/package-lock.json`; this was discarded (repo versions are canonical) and
does not affect the installed, verified-green `node_modules`.

---

## Verification performed during migration (all green)

- `API` build, `Bot` `npm run smoke` (build + mocked loop + traffic + planner —
  all checks pass) and `npm run typecheck`, `UI` typecheck (client + server),
  `Strategist` `npm test` (39/39) + build — **all pass on the server**.
- Services start via `ops/start.sh`; bridge **auto-connects as `raco`**,
  Strategist healthy in dry-run.
- **Public exposure check:** ports 4000/4100/5173 are **unreachable** from the
  server's public IP (loopback-bound); reachable only via SSH tunnel, where the
  bridge reports `connected:true`, Strategist `/health` 200, and the dashboard
  loads.
