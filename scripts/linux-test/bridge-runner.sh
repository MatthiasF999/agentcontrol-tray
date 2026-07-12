#!/usr/bin/env bash
#
# bridge-runner.sh — runs INSIDE the Flow A container (Dockerfile.bridge).
#
# Drives the real public bridge installer, verifies the systemd --user unit
# comes up + the bridge answers /health locally and can reach the backend,
# then writes /output/result.json + a journalctl text log for the host.
#
# Two-phase by uid: invoked as root (via `docker exec`) it does the privileged
# prep the installer needs (the wsl.sh WSL2 guard), then re-execs itself as the
# unprivileged test user for the actual install — because the installer writes
# a per-user `systemctl --user` unit, not a system one.
#
set -euo pipefail

TEST_USER="${TEST_USER:-actest}"
INSTALL_URL="${INSTALL_URL:-https://install.agent-control.io/wsl.sh}"
API_HEALTH="${API_HEALTH:-https://api.agent-control.io/health}"
BRIDGE_PORT="${BRIDGE_PORT:-3000}"     # wsl.sh default; .env PORT= overrides
SERVICE=agentcontrol-bridge
OUTPUT="${OUTPUT:-/output}"

log() { printf '[bridge-runner] %s\n' "$*"; }

# --- phase 1: root prep, then drop to the test user --------------------------
if [[ "$(id -u)" -eq 0 ]]; then
  # wsl.sh hard-exits unless /proc/version mentions "microsoft". We are a plain
  # Ubuntu container, so shadow /proc/version with a WSL-looking string. Needs
  # --privileged; harmless and reverts on container teardown.
  if ! grep -qi microsoft /proc/version 2>/dev/null; then
    log "spoofing /proc/version to satisfy the installer's WSL2 guard"
    printf 'Linux version 5.15.0-microsoft-standard-WSL2 (docker-test)\n' \
      > /run/fake-proc-version
    mount --bind /run/fake-proc-version /proc/version
  fi
  mkdir -p "$OUTPUT/logs"
  chown -R "$TEST_USER:$TEST_USER" "$OUTPUT"
  log "re-exec as $TEST_USER for the per-user install"
  exec su "$TEST_USER" -c "OUTPUT='$OUTPUT' INSTALL_URL='$INSTALL_URL' \
    API_HEALTH='$API_HEALTH' BRIDGE_PORT='$BRIDGE_PORT' bash '$0' --as-user"
fi

# --- phase 2: unprivileged install + verify ----------------------------------
# Point systemctl --user / journalctl --user at this user's running manager
# (started at boot because the image enables linger for the user).
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"

STARTED_UTC="$(date -u +%FT%TZ)"
STEPS=()   # each entry: name|status|detail

add_step() { STEPS+=("$1|$2|${3:-}"); log "$1: $2 ${3:-}"; }

step_user_manager() {
  for _ in $(seq 1 30); do
    systemctl --user is-system-running >/dev/null 2>&1 && break
    [[ -S "${XDG_RUNTIME_DIR}/bus" ]] && break
    sleep 1
  done
  if [[ ! -S "${XDG_RUNTIME_DIR}/bus" ]]; then
    add_step user-manager fail "no systemd --user bus at ${XDG_RUNTIME_DIR}/bus"
    return 1
  fi
  add_step user-manager pass "user systemd session live"
}

step_install() {
  log "installing bridge: curl $INSTALL_URL | bash"
  if curl -fsSL "$INSTALL_URL" | bash > "$OUTPUT/logs/install.log" 2>&1; then
    add_step install-bridge pass "wsl.sh completed"
  else
    add_step install-bridge fail "installer exited non-zero (see logs/install.log)"
    return 1
  fi
}

step_unit_active() {
  for _ in $(seq 1 24); do
    if systemctl --user is-active --quiet "$SERVICE"; then
      add_step unit-active pass "systemctl --user: $SERVICE active"; return 0
    fi
    sleep 5
  done
  add_step unit-active fail "$SERVICE not active within 120s"
  return 1
}

step_local_health() {
  local url="http://localhost:${BRIDGE_PORT}/health" body
  for _ in $(seq 1 12); do
    body="$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      add_step local-health pass "$url -> $body"; return 0
    fi
    sleep 3
  done
  add_step local-health fail "no /health on :${BRIDGE_PORT} within 36s"
  return 1
}

step_backend_reachable() {
  # Connectivity + liveness of the backend the bridge pairs against. Pairing
  # itself needs an interactive claim code, so that stays a manual follow-up.
  local body
  body="$(curl -fsS --max-time 10 "$API_HEALTH" 2>/dev/null || true)"
  if [[ -n "$body" ]]; then
    add_step backend-reachable pass "$API_HEALTH -> $body"
  else
    add_step backend-reachable skip "no network / backend unreachable (offline CI ok)"
  fi
}

capture_journal() {
  # Text-log analogue of the Windows harness screenshots.
  journalctl --user -u "$SERVICE" -n 200 --no-pager \
    > "$OUTPUT/logs/journal-${SERVICE}.log" 2>&1 || \
    echo "journalctl --user unavailable" > "$OUTPUT/logs/journal-${SERVICE}.log"
}

write_result() {
  local pass="$1" steps_json="" first=1 name status detail
  for entry in "${STEPS[@]}"; do
    IFS='|' read -r name status detail <<< "$entry"
    detail="${detail//\\/\\\\}"; detail="${detail//\"/\\\"}"
    [[ $first -eq 1 ]] || steps_json+=","
    first=0
    steps_json+=$(printf '{"name":"%s","status":"%s","detail":"%s"}' \
      "$name" "$status" "$detail")
  done
  cat > "$OUTPUT/result.json" <<EOF
{
  "flow": "bridge",
  "pass": $pass,
  "steps": [$steps_json],
  "logs": "logs/",
  "startedUtc": "$STARTED_UTC",
  "finishedUtc": "$(date -u +%FT%TZ)"
}
EOF
  log "wrote $OUTPUT/result.json (pass=$pass)"
}

main() {
  local pass=true
  step_user_manager   || pass=false
  step_install        || pass=false
  step_unit_active    || pass=false
  step_local_health   || pass=false
  step_backend_reachable
  capture_journal
  write_result "$pass"
  [[ "$pass" == true ]]
}

main "$@"
