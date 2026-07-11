#!/usr/bin/env bash
# install-mac.sh — HALF-SHIPPED macOS bridge installer (test-harness stub).
#
# STATUS: this is a stand-in. The production install host serves only
# `wsl.sh` + `bridge.tar.gz` (Windows/Linux/WSL path). There is no
# `install.agent-control.io/mac.sh` yet. This script reproduces, natively
# on macOS, what the WSL onboarding does on Linux:
#
#   WSL onboarding                         macOS equivalent (here)
#   ------------------------------------   -----------------------------------
#   curl install/bridge.tar.gz | tar -xz   same
#   npm install && npm run build           same
#   write .env  (PORT=3001 + API key)      same
#   systemctl --user  service              launchd LaunchAgent (this script)
#
# FOLLOW-UP: promote this to `install.agent-control.io/mac.sh` in a later
# PR so `curl -fsSL https://install.agent-control.io/mac.sh | bash` works
# the way `wsl.sh` does today. Until then the harness vendors it in-repo.
#
# Idempotent: re-running unloads any existing LaunchAgent first.
set -euo pipefail

HOST="${AGENTCONTROL_HOST:-agent-control.io}"
BRIDGE_TARBALL_URL="${BRIDGE_TARBALL_URL:-https://install.${HOST}/bridge.tar.gz}"
BRIDGE_DIR="${BRIDGE_DIR:-$HOME/agentcontrol-bridge}"
LABEL="io.agentcontrol.bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/agentcontrol"
PORT="${PORT:-3001}"

log() { printf '[install-mac] %s\n' "$*"; }

log "host=${HOST} bridge_dir=${BRIDGE_DIR} port=${PORT}"

# 1. Download + unpack the bridge source tarball.
log "downloading bridge tarball from ${BRIDGE_TARBALL_URL}"
mkdir -p "$BRIDGE_DIR"
curl -fsSL "$BRIDGE_TARBALL_URL" | tar -xz -C "$BRIDGE_DIR" --strip-components=1

# 2. Build the bridge (TypeScript → dist/index.js).
log "npm install"
( cd "$BRIDGE_DIR" && npm install --no-fund --no-audit )
log "npm run build"
( cd "$BRIDGE_DIR" && npm run build )

# 3. Write .env with a fresh local API key + the bridge port. Mirrors the
#    tray's write_env_file Rust command (PORT=3001, CLAUDE_HOME).
API_KEY="${BRIDGE_API_KEY:-$(openssl rand -hex 24)}"
{
  echo "PORT=${PORT}"
  echo "BRIDGE_API_KEY=${API_KEY}"
  echo "CLAUDE_HOME=${HOME}/.claude"
} >"${BRIDGE_DIR}/.env"
log "wrote ${BRIDGE_DIR}/.env"

# 4. Materialise the LaunchAgent plist. Runs `node dist/index.js` from the
#    bridge dir, restarts on crash, logs to ~/Library/Logs/agentcontrol.
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"
cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${BRIDGE_DIR}/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${BRIDGE_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>${PORT}</string>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/bridge.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/bridge.err.log</string>
</dict>
</plist>
PLIST_EOF
log "wrote ${PLIST}"

# 5. (Re)load the agent. bootout is best-effort (no-op if not loaded).
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
log "launchctl bootstrap done — ${LABEL} loaded"
