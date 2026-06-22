#!/bin/sh
# Pin screepsmod-auth to 2.8.3 on a launcher that can't pin mod versions.
#
# WHY: screepers/screeps-launcher:latest writes each `mods:` entry verbatim as a
# package.json dependency KEY, so an inline `screepsmod-auth@2.8.3` becomes the
# unresolvable key `"screepsmod-auth@2.8.3": "*"` and the server crash-loops on
# first boot. A config `resolutions:` block is ignored (the launcher always
# writes its own defaults). And node/yarn don't exist in the image until the
# launcher fetches them at runtime, so a PATH `yarn` shim can't be resolved at
# entrypoint time.
#
# HOW: run a tiny background loop that rewrites the launcher-generated
# /screeps/package.json, pinning `"screepsmod-auth": "*"` to `"2.8.3"`, and keep
# doing it across the whole boot window. The launcher writes package.json and
# then runs `yarn config set` (~1s) before `yarn install` resolves deps, so the
# loop reliably pins it before resolution; the rewrite is idempotent once pinned.
#
# Why 2.8.3: 2.9.0's auth mod fails to register its CLI hooks under this launcher
# (`setPassword`/`auth` come back undefined → the harness bootstrap signin throws
# "setPassword is not defined", /api/auth/* never loads). Drop this once the
# launcher supports pinning or upstream fixes 2.9.x.

PKG=/screeps/package.json
(
  i=0
  while [ "$i" -lt 1500 ]; do
    if [ -f "$PKG" ]; then
      sed -i 's#"screepsmod-auth": "\*"#"screepsmod-auth": "2.8.3"#' "$PKG" 2>/dev/null || true
    fi
    i=$((i + 1))
    sleep 0.3
  done
) &

exec /usr/bin/screeps-launcher "$@"
