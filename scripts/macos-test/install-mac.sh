#!/usr/bin/env bash
# mac.sh — install OR upgrade the AgentControl bridge on macOS.
#
# The native-macOS peer of wsl.sh: the public install endpoint serves this
# script + a prebuilt bridge tarball, so end-users never need GitHub access
# or a build toolchain. Where wsl.sh drives a systemd --user unit, this drives
# a launchd LaunchAgent.
#
#   curl -fsSL https://install.agent-control.io/mac.sh | bash
#
# The same command installs a fresh bridge or upgrades an existing one — the
# LaunchAgent is unloaded and re-bootstrapped on every run (idempotent).
#
# Env overrides:
#   AGENTCONTROL_HOST=install.acme.example.com   # different install host
#   BRIDGE_DIR=/path/to/bridge                    # different install dir
#   PORT=3001                                     # bridge listen port
#
set -euo pipefail

INSTALL_HOST="${AGENTCONTROL_HOST:-install.agent-control.io}"
BRIDGE_TARBALL_URL="${BRIDGE_TARBALL_URL:-https://${INSTALL_HOST}/bridge.tar.gz}"
BRIDGE_DIR="${BRIDGE_DIR:-$HOME/agentcontrol-bridge}"
LABEL="io.agentcontrol.bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/agentcontrol"
PORT="${PORT:-3001}"

log() { printf '[install-mac] %s\n' "$*"; }

log "host=${INSTALL_HOST} bridge_dir=${BRIDGE_DIR} port=${PORT}"

# 1. Ensure a Node runtime + npm exist. Prefer whatever is already on PATH;
#    fall back to Homebrew (`brew install node`) when node is missing. If
#    neither node nor brew is present we cannot proceed — point the user at
#    the two supported ways to get Node on macOS.
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    log "node not found — installing via Homebrew"
    brew install node
  else
    echo "[install-mac] ERROR: Node.js is not installed and Homebrew is not available." >&2
    echo "[install-mac] Install Homebrew (https://brew.sh) then re-run, or install Node from https://nodejs.org." >&2
    exit 1
  fi
fi

# 2. Download + unpack the prebuilt bridge tarball (ships dist/ — no build
#    step, mirroring wsl.sh). --strip-components=1 flattens the top dir.
log "downloading bridge tarball from ${BRIDGE_TARBALL_URL}"
mkdir -p "$BRIDGE_DIR"
curl -fsSL "$BRIDGE_TARBALL_URL" | tar -xz -C "$BRIDGE_DIR" --strip-components=1

# 3. Install runtime deps only (the tarball already carries a built dist/).
log "npm ci --omit=dev"
( cd "$BRIDGE_DIR" && npm ci --omit=dev --no-fund --no-audit )

# 4. Write .env with a fresh local API key + the bridge port. Mirrors the
#    tray's write_env_file Rust command (PORT=3001, CLAUDE_HOME). Preserve an
#    existing key across upgrades so a paired bridge stays paired.
if [ -f "${BRIDGE_DIR}/.env" ] && grep -q '^BRIDGE_API_KEY=' "${BRIDGE_DIR}/.env"; then
  API_KEY="$(grep '^BRIDGE_API_KEY=' "${BRIDGE_DIR}/.env" | head -1 | cut -d= -f2-)"
else
  API_KEY="${BRIDGE_API_KEY:-$(openssl rand -hex 24)}"
fi
{
  echo "PORT=${PORT}"
  echo "BRIDGE_API_KEY=${API_KEY}"
  echo "CLAUDE_HOME=${HOME}/.claude"
} >"${BRIDGE_DIR}/.env"
log "wrote ${BRIDGE_DIR}/.env"

# 5. Materialise the LaunchAgent plist. Runs `node dist/index.js` from the
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

# 6. (Re)load the agent. bootout is best-effort (no-op if not loaded).
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
log "launchctl bootstrap done — ${LABEL} loaded"
