#!/usr/bin/env bash
#
# host-orchestrator.sh — host-side driver for the Linux bridge + tray tests.
#
# Docker is the isolation primitive (works on native Linux, WSL2, and macOS
# Docker Desktop): a fresh Ubuntu container per run, thrown away after. Mirrors
# the Windows-Sandbox harness — stage nothing, build, run, read result.json.
#
# Usage:
#   ./host-orchestrator.sh                 # both flows (bridge, then tray)
#   ./host-orchestrator.sh --flow bridge   # CI-friendly quick test (priority 1)
#   ./host-orchestrator.sh --flow tray     # UI smoke only (best-effort)
#   ./host-orchestrator.sh --keep          # don't --rm the bridge container
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="$SCRIPT_DIR/output"
FLOW=both
KEEP=0
BRIDGE_IMG=agentcontrol-test-bridge
TRAY_IMG=agentcontrol-test-tray
BRIDGE_CTR=acbridge-test

while [[ $# -gt 0 ]]; do
  case "$1" in
    --flow)  FLOW="${2:?--flow needs bridge|tray|both}"; shift 2 ;;
    --keep)  KEEP=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$FLOW" in bridge|tray|both) ;; *) echo "bad --flow: $FLOW" >&2; exit 2 ;; esac

log()  { printf '[host] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

have docker || { echo "[host] docker not found on PATH" >&2; exit 1; }

# result.json pass? — grep is enough (no jq dependency on the host).
result_pass() { grep -Eq '"pass"[[:space:]]*:[[:space:]]*true' "$1"; }

run_bridge() {
  local out="$OUTPUT/bridge"
  rm -rf "$out"; mkdir -p "$out"
  log "building $BRIDGE_IMG"
  docker build -f "$SCRIPT_DIR/Dockerfile.bridge" -t "$BRIDGE_IMG" "$SCRIPT_DIR"
  docker rm -f "$BRIDGE_CTR" >/dev/null 2>&1 || true
  # Booting systemd container needs --privileged + cgroup + tmpfs /run.
  log "starting systemd container $BRIDGE_CTR"
  docker run -d --privileged --name "$BRIDGE_CTR" \
    --tmpfs /run --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -v "$out:/output" "$BRIDGE_IMG" >/dev/null
  log "waiting for init to settle, then running bridge-runner.sh"
  sleep 5
  local rc=0
  docker exec "$BRIDGE_CTR" /opt/linux-test/bridge-runner.sh || rc=$?
  if [[ "$KEEP" -eq 0 ]]; then docker rm -f "$BRIDGE_CTR" >/dev/null 2>&1 || true
  else log "keeping container $BRIDGE_CTR (--keep)"; fi
  report "bridge" "$out/result.json" "$rc"
}

run_tray() {
  local out="$OUTPUT/tray"
  rm -rf "$out"; mkdir -p "$out"
  log "building $TRAY_IMG"
  docker build -f "$SCRIPT_DIR/Dockerfile.tray" -t "$TRAY_IMG" "$SCRIPT_DIR"
  log "running tray container"
  local rc=0
  docker run --rm -v "$out:/output" "$TRAY_IMG" || rc=$?
  report "tray" "$out/result.json" "$rc"
}

report() {   # report <flow> <result.json> <container-rc>
  local flow="$1" rj="$2" rc="$3"
  if [[ ! -f "$rj" ]]; then
    echo "[host] $flow FAIL: no result.json (container rc=$rc)" >&2
    FAILED=1; return
  fi
  log "$flow result.json:"; cat "$rj"; echo
  if result_pass "$rj"; then log "$flow PASS"; else
    echo "[host] $flow FAIL — see $rj and $(dirname "$rj")" >&2; FAILED=1
  fi
}

FAILED=0
[[ "$FLOW" == bridge || "$FLOW" == both ]] && run_bridge
[[ "$FLOW" == tray   || "$FLOW" == both ]] && run_tray
[[ "$FAILED" -eq 0 ]] && { log "all requested flows passed"; exit 0; }
echo "[host] one or more flows failed" >&2; exit 1
