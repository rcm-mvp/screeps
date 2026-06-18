#!/usr/bin/env bash
# Start the long-running Screeps services (UI bridge host + web, Strategist)
# in a detached tmux session named "screeps". To restart, run ops/stop.sh first.
#
# Services bind to 127.0.0.1 only — reach them via an SSH tunnel or VS Code
# port forwarding (see MIGRATE.md), never directly from the internet.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$SRC/logs"

if tmux has-session -t screeps 2>/dev/null; then
  echo "tmux session 'screeps' already running — run ops/stop.sh first to restart."
  exit 0
fi

tmux new-session -d -s screeps -n ui \
  "cd '$SRC/UI' && npm run dev 2>&1 | tee '$SRC/logs/ui.log'; exec bash"
tmux new-window -t screeps -n strategist \
  "cd '$SRC/Strategist' && npm start 2>&1 | tee '$SRC/logs/strategist.log'; exec bash"

echo "started tmux session 'screeps':"
echo "  - ui:         bridge host on 127.0.0.1:4000, web on 127.0.0.1:5173"
echo "  - strategist: control API on 127.0.0.1:4100 (dry-run by default)"
echo "logs: $SRC/logs/{ui,strategist}.log   attach: tmux attach -t screeps"
tmux ls
