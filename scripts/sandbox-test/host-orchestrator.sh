#!/usr/bin/env bash
#
# host-orchestrator.sh — WSL-side driver for the Windows-Sandbox installer test.
#
# Stages the installer + PowerShell harness into a host folder, launches
# Windows Sandbox (which runs sandbox-runner.ps1 as its LogonCommand), waits
# for the run to finish, then reads output/result.json back and reports.
#
# Usage:
#   ./host-orchestrator.sh                 # download the live bootstrapper
#   ./host-orchestrator.sh --local ./x.exe # use a local installer instead
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

# --- args --------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)        LOCAL_SETUP="${2:?--local needs a path}"; shift 2 ;;
    --keep-sandbox) KEEP_SANDBOX=1; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[host] %s\n' "$*"; }

# --- stage -------------------------------------------------------------------
log "preparing host folders under $HOST_WSL_ROOT"
mkdir -p "$STAGING" "$OUTPUT/screenshots"
rm -f "$OUTPUT/result.json"

if [[ -n "$LOCAL_SETUP" ]]; then
  [[ -f "$LOCAL_SETUP" ]] || { echo "no such file: $LOCAL_SETUP" >&2; exit 1; }
  log "using local installer: $LOCAL_SETUP"
  cp "$LOCAL_SETUP" "$STAGING/setup.exe"
else
  log "downloading $SETUP_URL"
  curl -fSL "$SETUP_URL" -o "$STAGING/setup.exe"
fi

cp "$SCRIPT_DIR/helpers.psm1"      "$STAGING/helpers.psm1"
cp "$SCRIPT_DIR/sandbox-runner.ps1" "$STAGING/sandbox-runner.ps1"

# Render test.wsb from the template (host root is the only parameter today, but
# keeping the render step means moving HOST_WIN_ROOT needs no manual edit).
# perl with \Q...\E does a literal replace — safe with the backslashes in the
# Windows paths (sed would misread \U / \D etc. as escapes).
WSB_HOST="$HOST_WSL_ROOT/test.wsb"
TEMPLATE_ROOT='C:\Users\Dev\AgentControlSandbox'
OLD="$TEMPLATE_ROOT" NEW="$HOST_WIN_ROOT" \
  perl -pe 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "$SCRIPT_DIR/test.wsb" > "$WSB_HOST"
log "rendered $WSB_HOST"

# --- run ---------------------------------------------------------------------
if [[ "$KEEP_SANDBOX" -eq 1 ]]; then
  log "launching sandbox (interactive — will NOT auto-close)"
  powershell.exe -NoProfile -Command "Start-Process '${HOST_WIN_ROOT}\\test.wsb'"
else
  log "launching sandbox and waiting for it to exit"
  powershell.exe -NoProfile -Command "Start-Process '${HOST_WIN_ROOT}\\test.wsb' -Wait" || true
fi

# --- collect (poll result.json even if -Wait returned early) -----------------
RESULT="$OUTPUT/result.json"
log "waiting for $RESULT"
for _ in $(seq 1 120); do
  [[ -f "$RESULT" ]] && break
  sleep 5
done

if [[ ! -f "$RESULT" ]]; then
  echo "[host] FAIL: no result.json produced (sandbox may still be running)" >&2
  exit 1
fi

log "result.json:"
cat "$RESULT"
echo
PASS=$(grep -o '"pass"[[:space:]]*:[[:space:]]*true' "$RESULT" || true)
if [[ -n "$PASS" ]]; then
  log "PASS — screenshots in $OUTPUT/screenshots"
  exit 0
fi
echo "[host] FAIL — see errors in $RESULT and $OUTPUT/screenshots" >&2
exit 1
