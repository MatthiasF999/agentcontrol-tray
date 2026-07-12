# shellcheck shell=bash
# helpers.sh — shared primitives for the macOS test harness runners.
#
# Sourced (not executed) by bridge-runner.sh and tray-runner.sh. Provides
# screenshot capture, AppleScript execution, window/process waiting, and a
# jq-based result.json writer. Function names mirror the Windows harness's
# PowerShell verbs (Save-Screenshot, Run-AppleScript, …) so the two OS
# harnesses read the same.
#
# Every runner sets OUTPUT_DIR before sourcing; screenshots land under
# $OUTPUT_DIR/screenshots and results under $OUTPUT_DIR.

set -uo pipefail

OUTPUT_DIR="${OUTPUT_DIR:-output}"
SHOT_DIR="${OUTPUT_DIR}/screenshots"
SHOT_SEQ=0

# ANSI-free structured log line so the CI console + captured log stay grep-able.
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

ensure-dirs() {
  mkdir -p "$SHOT_DIR"
}

# Save-Screenshot <label> [region]
#   region (optional): "x,y,w,h" → -R flag; omit for full-screen (-x quiet).
#   Files are zero-padded + label-suffixed so they sort in capture order.
#   screencapture may emit a blank frame on a headless runner; that is
#   still a useful post-mortem artifact, so a non-zero exit is logged, not
#   fatal.
Save-Screenshot() {
  local label="${1:-shot}" region="${2:-}"
  ensure-dirs
  SHOT_SEQ=$((SHOT_SEQ + 1))
  local n
  n="$(printf '%02d' "$SHOT_SEQ")"
  local path="${SHOT_DIR}/${n}-${label}.png"
  if [ -n "$region" ]; then
    screencapture -x -R "$region" "$path" || log "screencapture (region) failed for $label"
  else
    screencapture -x "$path" || log "screencapture failed for $label"
  fi
  if [ -f "$path" ]; then
    log "screenshot → $path"
  fi
}

# Run-AppleScript <script-text>
#   Runs one osascript program, echoing its stdout. Returns osascript's exit
#   code so callers can branch. Never aborts the runner (set -e is off).
Run-AppleScript() {
  local script="$1"
  osascript -e "$script"
}

# Wait-Window <process-name> [timeout-seconds]
#   Polls System Events until the named process has at least one window (or
#   the process merely exists, for menu-bar-only apps). Returns 0 on
#   success, 1 on timeout.
Wait-Window() {
  local proc="$1" timeout="${2:-30}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    local exists
    exists="$(Run-AppleScript "tell application \"System Events\" to (exists process \"${proc}\")" 2>/dev/null || echo false)"
    if [ "$exists" = "true" ]; then
      log "process '${proc}' is running (after ${waited}s)"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "timed out (${timeout}s) waiting for process '${proc}'"
  return 1
}

# Wait-Http <url> [timeout-seconds] [expected-substring]
#   Polls a URL until curl succeeds (2xx) and, if given, the body contains
#   expected-substring. Echoes the final body. Returns 0/1.
Wait-Http() {
  local url="$1" timeout="${2:-30}" want="${3:-}" waited=0 body=''
  while [ "$waited" -lt "$timeout" ]; do
    if body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"; then
      if [ -z "$want" ] || printf '%s' "$body" | grep -q "$want"; then
        printf '%s' "$body"
        return 0
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done
  printf '%s' "$body"
  return 1
}

# Write-Result <result.json path> <status> <key=value>...
#   Builds a JSON object via jq from flat key=value pairs plus a top-level
#   status + ISO timestamp. All values are strings (jq --arg); callers that
#   need typed fields can post-process. jq is preinstalled on GH runners.
Write-Result() {
  local out="$1" status="$2"
  shift 2
  ensure-dirs
  local args=(--arg status "$status" --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
  local filter='{status:$status, finished_at:$finished_at'
  local pair k v
  for pair in "$@"; do
    k="${pair%%=*}"
    v="${pair#*=}"
    args+=(--arg "$k" "$v")
    filter="${filter}, ${k}:\$${k}"
  done
  filter="${filter}}"
  jq -n "${args[@]}" "$filter" >"$out"
  log "result → $out ($status)"
  cat "$out"
}
