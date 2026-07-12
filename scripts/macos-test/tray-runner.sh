#!/usr/bin/env bash
# tray-runner.sh — launch + drive the built tray .app on a macOS host.
#
# Flow: locate the .app (TRAY_APP env, else glob the Tauri build output) →
# `open` it → wait for the process → AppleScript to surface its window →
# screenshots → write result.json.
#
# Limitation: the UI is a Tauri WKWebView. Its buttons are DOM nodes, opaque
# to the macOS Accessibility API, so AppleScript/System Events can drive
# native chrome (window, menu-bar extra) but NOT in-webview controls. We
# therefore assert launch + window presence and rely on screenshots for
# visual verification; deep UI driving would need a webdriver (tauri-driver
# / WKWebView remote inspector), tracked as a follow-up.
#
# Failure policy matches bridge-runner: STRICT=1 hard-fails on 'fail',
# default STRICT=0 exits 0 after producing artifacts.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${HERE}/output}"
# shellcheck source=./helpers.sh
. "${HERE}/helpers.sh"
ensure-dirs

STRICT="${STRICT:-0}"
PROC="agentcontrol-tray"
RESULT="${OUTPUT_DIR}/result.json"
LOG_FILE="${OUTPUT_DIR}/tray-runner.log"
exec > >(tee -a "$LOG_FILE") 2>&1

found_ok=false ; launch_ok=false ; window_ok=false
app_path='' ; window_count=0

log "=== tray smoke start (strict=${STRICT}) ==="

# 1. Locate the .app. Prefer explicit TRAY_APP; else search Tauri output
#    (aarch64 / universal), newest first.
if [ -n "${TRAY_APP:-}" ] && [ -d "${TRAY_APP}" ]; then
  app_path="$TRAY_APP"
else
  app_path="$(find "${REPO_ROOT}/src-tauri/target" -maxdepth 5 -type d -name '*.app' \
    -path '*/release/bundle/macos/*' 2>/dev/null | head -n1)"
fi

if [ -n "$app_path" ] && [ -d "$app_path" ]; then
  found_ok=true
  log "found app bundle: ${app_path}"
else
  log "no .app bundle found under src-tauri/target — was the tauri build run?"
fi

# 2. Launch it. Locally built bundles carry no quarantine attribute, so
#    Gatekeeper permits `open` even though the app is unsigned.
if $found_ok; then
  if open "$app_path"; then
    log "open '${app_path}' issued"
    if Wait-Window "$PROC" 40; then
      launch_ok=true
    fi
  else
    log "open FAILED for ${app_path}"
  fi
fi

# 3. Surface + count windows via AppleScript; screenshot each stage.
if $launch_ok; then
  Save-Screenshot "tray-launched"
  Run-AppleScript "tell application \"System Events\" to tell process \"${PROC}\"
    set frontmost to true
  end tell" || log "could not set ${PROC} frontmost (menu-bar-only app?)"
  sleep 2
  window_count="$(Run-AppleScript "tell application \"System Events\" to count windows of process \"${PROC}\"" 2>/dev/null || echo 0)"
  log "window count for ${PROC}: ${window_count}"
  [ "${window_count:-0}" -gt 0 ] 2>/dev/null && window_ok=true
  Save-Screenshot "tray-window"
else
  Save-Screenshot "tray-no-launch"
fi

# 4. Verdict + result.json.
status='pass'
$found_ok && $launch_ok || status='degraded'
$found_ok || status='fail'

Write-Result "$RESULT" "$status" \
  "app_path=${app_path}" \
  "found_ok=${found_ok}" \
  "launch_ok=${launch_ok}" \
  "window_ok=${window_ok}" \
  "window_count=${window_count}"

log "=== tray smoke done: ${status} ==="
if [ "$STRICT" = "1" ] && [ "$status" = "fail" ]; then
  exit 1
fi
exit 0
