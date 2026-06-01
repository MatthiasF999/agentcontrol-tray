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

# Bridge needs policy CSV + casbin model — shared/policy lives in a
# sibling directory. Copy as a sibling of dist/ so casbinEngine.ts
# resolves `../../../shared/policy/` correctly (after our 39.3 deploy
# pattern this resolves to `<bridge>/shared/policy/`).
SHARED_POLICY="$(dirname "$BRIDGE_REPO")/shared/policy"
if [ -d "$SHARED_POLICY" ]; then
  mkdir -p "$DEST/shared/policy"
  cp "$SHARED_POLICY/model.conf" "$DEST/shared/policy/model.conf"
  cp "$SHARED_POLICY/seed-policy.csv" "$DEST/shared/policy/seed-policy.csv"
fi

bytes=$(du -sb "$DEST" 2>/dev/null | cut -f1)
mb=$(( bytes / 1024 / 1024 ))
echo "✓ bundled bridge into $DEST (${mb} MB)"
