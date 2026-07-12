#!/usr/bin/env bash
#
# host-orchestrator.sh — WSL-side driver for the Windows-Sandbox test harness.
#
# Stages the installer + PowerShell harness into a host folder, launches
# Windows Sandbox (which runs the flow's runner as its LogonCommand), waits for
# the run to finish, then reads output/result*.json back and reports.
#
# Flows:
#   --flow tray   (default) installer download + tray launch      — test.wsb
#   --flow wsl    full WSL2 + Ubuntu + bridge install             — test-wsl.wsb
#   --flow full   tray first, then wsl only if tray passed
#
# Usage:
#   ./host-orchestrator.sh                 # tray flow, live bootstrapper
#   ./host-orchestrator.sh --flow wsl      # WSL-inclusive flow (~15 min)
#   ./host-orchestrator.sh --flow full     # both, in sequence
#   ./host-orchestrator.sh --local ./x.exe # use a local installer (tray/full)
#   ./host-orchestrator.sh --keep-sandbox  # don't auto-shutdown (interactive)
#
set -euo pipefail

# --- config ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_URL="https://install.agent-control.io/setup.exe"
HOST_WIN_ROOT='C:\Users\Dev\AgentControlSandbox'          # Windows form
HOST_WSL_ROOT='/mnt/c/Users/Dev/AgentControlSandbox'      # WSL form
STAGING="$HOST_WSL_ROOT/staging"
OUTPUT="$HOST_WSL_ROOT/output"
LOCAL_SETUP=''
KEEP_SANDBOX=0
FLOW='tray'

# --- args --------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --flow)         FLOW="${2:?--flow needs tray|wsl|full}"; shift 2 ;;
    --local)        LOCAL_SETUP="${2:?--local needs a path}"; shift 2 ;;
    --keep-sandbox) KEEP_SANDBOX=1; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$FLOW" in tray|wsl|full) ;; *) echo "bad --flow: $FLOW" >&2; exit 2 ;; esac

log() { printf '[host] %s\n' "$*"; }

# --- stage the harness shared by every flow ----------------------------------
stage_common() {
  log "preparing host folders under $HOST_WSL_ROOT"
  mkdir -p "$STAGING" "$OUTPUT/screenshots"
  cp "$SCRIPT_DIR/helpers.psm1" "$STAGING/helpers.psm1"
  # Pair-flow verifiers run inside WSL after the bridge installs (wsl flow):
  # verify-pair-flow.mjs at the HTTP-redirect layer, verify-pair-flow-spa.mjs
  # driving the real SPA in headless Chromium (Playwright, guest-side prereq).
  cp "$SCRIPT_DIR/../e2e-pair-verify/verify-pair-flow.mjs" "$STAGING/verify-pair-flow.mjs"
  cp "$SCRIPT_DIR/../e2e-pair-verify/verify-pair-flow-spa.mjs" "$STAGING/verify-pair-flow-spa.mjs"
}

# The pair-flow verifier needs a service_role key. It lives in a gitignored
# host file scripts/sandbox-test/pair-verify.env; stage it RO if present, else
# the runner records step 'verify-pair-flow' = skip.
stage_pair_env() {
  if [[ -f "$SCRIPT_DIR/pair-verify.env" ]]; then
    log "staging pair-verify.env (service_role, RO)"
    cp "$SCRIPT_DIR/pair-verify.env" "$STAGING/pair-verify.env"
  else
    log "no pair-verify.env — verify-pair-flow step will be skipped in-sandbox"
  fi
}

# Download / copy the bootstrapper — only the tray + full flows launch it.
stage_setup_exe() {
  if [[ -n "$LOCAL_SETUP" ]]; then
    [[ -f "$LOCAL_SETUP" ]] || { echo "no such file: $LOCAL_SETUP" >&2; exit 1; }
    log "using local installer: $LOCAL_SETUP"
    cp "$LOCAL_SETUP" "$STAGING/setup.exe"
  else
    log "downloading $SETUP_URL"
    curl -fSL "$SETUP_URL" -o "$STAGING/setup.exe"
  fi
}

# Render a .wsb template into the host root, substituting the host path. perl
# with \Q...\E does a literal replace — safe with the backslashes in the Windows
# paths (sed would misread \U / \D etc. as escapes).
render_wsb() {
  local wsb="$1"
  local template_root='C:\Users\Dev\AgentControlSandbox'
  OLD="$template_root" NEW="$HOST_WIN_ROOT" \
    perl -pe 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "$SCRIPT_DIR/$wsb" > "$HOST_WSL_ROOT/$wsb"
  log "rendered $HOST_WSL_ROOT/$wsb"
}

launch_wsb() {
  local wsb="$1"
  if [[ "$KEEP_SANDBOX" -eq 1 ]]; then
    log "launching $wsb (interactive — will NOT auto-close)"
    powershell.exe -NoProfile -Command "Start-Process '${HOST_WIN_ROOT}\\${wsb}'"
  else
    log "launching $wsb and waiting for it to exit"
    powershell.exe -NoProfile -Command "Start-Process '${HOST_WIN_ROOT}\\${wsb}' -Wait" || true
  fi
}

# Poll for result.json (Start-Process -Wait can return before the sandbox has
# flushed it), print it, copy it aside per-flow, return 0 on pass.
collect_result() {
  local flow="$1"
  local result="$OUTPUT/result.json"
  log "waiting for $result"
  for _ in $(seq 1 240); do
    [[ -f "$result" ]] && break
    sleep 5
  done
  if [[ ! -f "$result" ]]; then
    echo "[host] FAIL ($flow): no result.json produced (sandbox may still be running)" >&2
    return 1
  fi
  cp "$result" "$OUTPUT/result-$flow.json"
  log "result-$flow.json:"; cat "$result"; echo
  if grep -q '"pass"[[:space:]]*:[[:space:]]*true' "$result"; then
    log "PASS ($flow) — screenshots in $OUTPUT/screenshots"
    return 0
  fi
  echo "[host] FAIL ($flow) — see $OUTPUT/result-$flow.json and screenshots" >&2
  return 1
}

# Run one flow end to end. $1 = tray|wsl.
run_flow() {
  local flow="$1" wsb runner
  case "$flow" in
    tray) wsb='test.wsb';     runner='sandbox-runner.ps1' ;;
    wsl)  wsb='test-wsl.wsb'; runner='sandbox-runner-wsl.ps1' ;;
  esac
  rm -f "$OUTPUT/result.json"
  cp "$SCRIPT_DIR/$runner" "$STAGING/$runner"
  [[ "$flow" == 'tray' ]] && stage_setup_exe
  [[ "$flow" == 'wsl' ]] && stage_pair_env
  render_wsb "$wsb"
  launch_wsb "$wsb"
  collect_result "$flow"
}

# --- dispatch ----------------------------------------------------------------
stage_common
case "$FLOW" in
  tray|wsl)
    run_flow "$FLOW"; exit $?
    ;;
  full)
    log "full flow: tray then wsl"
    if ! run_flow tray; then
      echo "[host] FAIL (full): tray flow failed — skipping wsl" >&2
      exit 1
    fi
    run_flow wsl; exit $?
    ;;
esac
