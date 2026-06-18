#!/usr/bin/env bash
# Stop all Screeps services (kills the tmux session and its child processes).
tmux kill-session -t screeps 2>/dev/null \
  && echo "stopped session 'screeps'" \
  || echo "no 'screeps' session running"
