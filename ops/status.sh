#!/usr/bin/env bash
# Show whether the services are up and which ports are listening.
echo "=== tmux sessions ==="
tmux ls 2>/dev/null || echo "(none)"
echo "=== service ports (expect 127.0.0.1) ==="
ss -tlnp 2>/dev/null | grep -E ":(4000|4100|5173)\b" || echo "(no service ports listening)"
