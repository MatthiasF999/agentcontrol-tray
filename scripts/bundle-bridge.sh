#!/usr/bin/env bash
#
# bundle-bridge.sh — Phase 39.11
#
# Copies the bridge's production-ready `dist/` + `node_modules/` +
# `package.json` into src-tauri/bridge/, where Tauri's bundle picks it
# up as a resource (per tauri.conf.json `bundle.resources`).
#
# Inputs:
#   BRIDGE_REPO  — path to the bridge checkout (default: ../agentcontrol-bridge)
#   FRESH_BUILD  — if 'true', rebuild bridge from sources first
#
# In CI we set BRIDGE_REPO to the sibling checkout and FRESH_BUILD=true
# so the bundled bridge matches the tray release tag.

set -euo pipefail
# Phase 39.11.3 — surface every shell command in CI logs so failures
# narrow to a single line. The npm-audit noise hides the real exit
# point otherwise (macOS tray-run-3 was unreadable without this).
[ -n "${CI:-}" ] && set -x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAY_ROOT="$(dirname "$SCRIPT_DIR")"
BRIDGE_REPO="${BRIDGE_REPO:-$(realpath "$TRAY_ROOT/../agentcontrol-bridge")}"
FRESH_BUILD="${FRESH_BUILD:-false}"
DEST="$TRAY_ROOT/src-tauri/bridge"

if [ ! -d "$BRIDGE_REPO" ]; then
  echo "✖ bridge repo not found: $BRIDGE_REPO" >&2
  echo "  set BRIDGE_REPO=/abs/path/to/agentcontrol-bridge and rerun" >&2
  exit 1
fi

echo "==> bundle-bridge: source=$BRIDGE_REPO  dest=$DEST  fresh=$FRESH_BUILD"

if [ "$FRESH_BUILD" = "true" ]; then
  echo "==> rebuilding bridge from sources"
  (cd "$BRIDGE_REPO" && npm ci && npm run build && npm prune --omit=dev)
fi

# Bail if dist/ is missing — we shouldn't ship a broken sidecar.
if [ ! -d "$BRIDGE_REPO/dist" ]; then
  echo "✖ bridge dist/ missing — run with FRESH_BUILD=true or build first" >&2
  exit 1
fi

# Wipe-and-copy: bridge resources are reproducible from source, no
# state worth preserving across runs.
rm -rf "$DEST"
mkdir -p "$DEST"

# Required runtime files. node_modules is intentionally included
# AFTER `npm prune --omit=dev`. better-sqlite3 native binary is
# host-arch-specific; CI must run this on the same arch as the tray
# release target.
cp -r "$BRIDGE_REPO/dist" "$DEST/dist"
cp -r "$BRIDGE_REPO/node_modules" "$DEST/node_modules"
cp "$BRIDGE_REPO/package.json" "$DEST/package.json"
cp "$BRIDGE_REPO/package-lock.json" "$DEST/package-lock.json"
# Copy the dist/db/schema.sql that the Dockerfile-Stage-1 also copies
# manually (tsc only emits .js).
if [ -f "$BRIDGE_REPO/src/db/schema.sql" ]; then
  mkdir -p "$DEST/dist/db"
  cp "$BRIDGE_REPO/src/db/schema.sql" "$DEST/dist/db/schema.sql"
fi

# Bridge needs policy CSV + casbin model. Phase 39.11.1 moved
# shared/policy/ INSIDE the bridge repo so CI can find it.
# Path-resolution trap (Phase 39.11.2): casbinEngine.ts resolves the
# policy dir via `new URL('../../../shared/policy/', import.meta.url)`
# relative to its own JS file. From `<root>/dist/policy/casbinEngine.js`
# that lands at `<root>/shared/policy/` — meaning shared/ must be a
# SIBLING of dist/, NOT a child of the bridge root. In Tauri-resources
# terms: ship it at `Resources/shared/policy/` next to `Resources/bridge/`,
# not at `Resources/bridge/shared/`. We write to `$DEST/../shared/policy/`
# accordingly.
SHARED_POLICY_SRC="$BRIDGE_REPO/shared/policy"
SHARED_POLICY_DEST="$(dirname "$DEST")/shared/policy"
if [ -d "$SHARED_POLICY_SRC" ]; then
  rm -rf "$SHARED_POLICY_DEST"
  mkdir -p "$SHARED_POLICY_DEST"
  cp "$SHARED_POLICY_SRC/model.conf"      "$SHARED_POLICY_DEST/model.conf"
  cp "$SHARED_POLICY_SRC/seed-policy.csv" "$SHARED_POLICY_DEST/seed-policy.csv"
else
  echo "✖ shared/policy not found under bridge repo ($SHARED_POLICY_SRC)" >&2
  exit 1
fi

# Phase 39.11.4 — `du -sb` (GNU bytes flag) is not portable to BSD du
# on macOS runners; it errored with exit code 64 and tanked the whole
# script under `set -e`. `du -sh` is in POSIX and gives us a
# human-readable size on every runner.
size=$(du -sh "$DEST" 2>/dev/null | cut -f1 || echo "?")
echo "✓ bundled bridge into $DEST (${size})"
