#!/usr/bin/env bash
# bridge-runner.sh — end-to-end bridge smoke on a macOS host.
#
# Flow: install bridge (native launchd path via install-mac.sh) → verify the
# LaunchAgent is registered → health-probe localhost:3001 → reachability of
# the public api.<host> control plane → screenshot → write result.json.
#
# Failure policy: every check is recorded in result.json. The runner exits
# non-zero only when STRICT=1 and a critical check failed; by default
# (STRICT=0) it exits 0 so the smoke job stays green and a human reads the
# artifact. The tarball endpoint is gated, so first CI runs are expected to
# land "degraded" until install.<host>/bridge.tar.gz is reachable.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${HERE}/output}"
# shellcheck source=./helpers.sh
. "${HERE}/helpers.sh"
ensure-dirs

HOST="${AGENTCONTROL_HOST:-agent-control.io}"
STRICT="${STRICT:-0}"
LABEL="io.agentcontrol.bridge"
RESULT="${OUTPUT_DIR}/result.json"
LOG_FILE="${OUTPUT_DIR}/bridge-runner.log"

# Mirror all output to a log artifact.
exec > >(tee -a "$LOG_FILE") 2>&1

install_ok=false ; launchctl_ok=false ; health_ok=false ; cp_ok=false
bridge_version='' ; health_body='' ; cp_status=''

log "=== bridge smoke start (host=${HOST}, strict=${STRICT}) ==="

# 1. Install (download + build + launchd load). Captured, non-fatal.
if AGENTCONTROL_HOST="$HOST" bash "${HERE}/install-mac.sh"; then
  install_ok=true
  log "install-mac.sh succeeded"
else
  log "install-mac.sh FAILED (tarball gated / network?) — continuing to record state"
fi

# 2. LaunchAgent registered?
if launchctl print "gui/$(id -u)/${LABEL}" >"${OUTPUT_DIR}/launchctl-print.txt" 2>&1 \
   || launchctl list 2>/dev/null | grep -q "$LABEL"; then
  launchctl_ok=true
  log "LaunchAgent '${LABEL}' is registered"
else
  log "LaunchAgent '${LABEL}' NOT registered"
fi

# 3. Local bridge health (localhost:3001). /health then /pair as fallback.
if health_body="$(Wait-Http "http://localhost:${BRIDGE_PORT:-3001}/health" 40)"; then
  health_ok=true
  bridge_version="$(printf '%s' "$health_body" | jq -r '.version // empty' 2>/dev/null || true)"
  printf '%s\n' "$health_body" >"${OUTPUT_DIR}/health.json"
  log "bridge /health OK: ${health_body}"
elif health_body="$(Wait-Http "http://localhost:${BRIDGE_PORT:-3001}/pair" 5)"; then
  health_ok=true
  printf '%s\n' "$health_body" >"${OUTPUT_DIR}/pair.json"
  log "bridge /pair reachable: ${health_body}"
else
  log "bridge localhost:${BRIDGE_PORT:-3001} unreachable"
  cp "$HOME/Library/Logs/agentcontrol/bridge.err.log" "${OUTPUT_DIR}/bridge.err.log" 2>/dev/null || true
fi

# 4. Public control-plane reachability (api.<host>). Any HTTP response (even
#    401/404) proves the endpoint resolves + TLS terminates.
cp_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://api.${HOST}/" || echo 000)"
if [ "$cp_status" != "000" ]; then
  cp_ok=true
  log "control plane api.${HOST} responded HTTP ${cp_status}"
else
  log "control plane api.${HOST} unreachable"
fi

# 5. Screenshot the console state for post-mortem.
Save-Screenshot "bridge-console"

# 6. Overall verdict + result.json.
status='pass'
$install_ok && $launchctl_ok && $health_ok || status='degraded'
{ $health_ok || $cp_ok; } || status='fail'

Write-Result "$RESULT" "$status" \
  "host=${HOST}" \
  "install_ok=${install_ok}" \
  "launchctl_ok=${launchctl_ok}" \
  "health_ok=${health_ok}" \
  "control_plane_ok=${cp_ok}" \
  "control_plane_http=${cp_status}" \
  "bridge_version=${bridge_version}"

log "=== bridge smoke done: ${status} ==="
if [ "$STRICT" = "1" ] && [ "$status" = "fail" ]; then
  exit 1
fi
exit 0
