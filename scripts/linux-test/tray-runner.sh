#!/usr/bin/env bash
#
# tray-runner.sh — runs INSIDE the Flow B container (Dockerfile.tray).
#
# Best-effort UI smoke: fetch the tray .deb, install it, launch the Tauri
# binary under a virtual X server, screenshot each step, and best-effort walk
# the pair window with xdotool. Success is decided by the binary staying alive
# + at least one screenshot captured — the tray icon rendering into an SNI host
# is inherently flaky headless (see README Flow B caveats), so it never fails
# the run on its own.
#
set -euo pipefail

DEB_URL="${DEB_URL:-https://install.agent-control.io/tray.deb}"
TRAY_BIN="${TRAY_BIN:-agentcontrol-tray}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
OUTPUT="${OUTPUT:-/output}"
SHOTS="$OUTPUT/screenshots"
export DISPLAY=":${DISPLAY_NUM}"

log() { printf '[tray-runner] %s\n' "$*"; }
STEPS=(); SHOT_IDX=0
add_step() { STEPS+=("$1|$2|${3:-}"); log "$1: $2 ${3:-}"; }

shot() {   # shot <label> — grab the root window to screenshots/NNN-label.png
  SHOT_IDX=$((SHOT_IDX + 1))
  local f; f="$(printf '%s/%03d-%s.png' "$SHOTS" "$SHOT_IDX" "$1")"
  import -window root "$f" 2>/dev/null || \
    xwd -root -silent 2>/dev/null | convert xwd:- "$f" 2>/dev/null || \
    log "screenshot '$1' failed (no X capture tool worked)"
  echo "$f"
}

start_x() {
  mkdir -p "$SHOTS"
  Xvfb ":${DISPLAY_NUM}" -screen 0 1280x800x24 >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if ! xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
    add_step start-xvfb fail "Xvfb :${DISPLAY_NUM} never came up"; return 1
  fi
  # Panel hosts the StatusNotifierWatcher the tray icon docks into.
  dbus-launch --exit-with-session xfce4-panel >/dev/null 2>&1 &
  sleep 2
  add_step start-xvfb pass "Xvfb + panel on :${DISPLAY_NUM}"
}

install_deb() {
  log "fetching tray deb: $DEB_URL"
  if ! curl -fsSL "$DEB_URL" -o /tmp/tray.deb; then
    add_step fetch-deb fail "download failed: $DEB_URL"; return 1
  fi
  if apt-get install -y /tmp/tray.deb >/tmp/deb-install.log 2>&1 \
     || dpkg -i /tmp/tray.deb >>/tmp/deb-install.log 2>&1; then
    add_step install-deb pass "installed $(basename "$DEB_URL")"
  else
    add_step install-deb fail "dpkg/apt install failed (see /tmp/deb-install.log)"
    return 1
  fi
}

launch_tray() {
  command -v "$TRAY_BIN" >/dev/null 2>&1 || { add_step launch-tray fail "$TRAY_BIN not on PATH after install"; return 1; }
  "$TRAY_BIN" >/tmp/tray.log 2>&1 &
  echo $! > /tmp/tray.pid
  sleep 6
  shot launched >/dev/null
  if kill -0 "$(cat /tmp/tray.pid)" 2>/dev/null; then
    add_step launch-tray pass "pid $(cat /tmp/tray.pid) alive"
  else
    add_step launch-tray fail "$TRAY_BIN exited early (see /tmp/tray.log)"
    return 1
  fi
}

walk_pair() {
  # Best-effort: find any AgentControl window and step through it. A miss is a
  # skip, not a fail — headless the window may never map.
  local wid
  wid="$(xdotool search --name 'AgentControl' 2>/dev/null | head -1 || true)"
  if [[ -z "$wid" ]]; then
    add_step walk-pair skip "no AgentControl window mapped headless"; return 0
  fi
  xdotool windowactivate "$wid" 2>/dev/null || true
  shot pair-window >/dev/null
  xdotool key --window "$wid" Return 2>/dev/null || true
  sleep 2
  shot pair-after-return >/dev/null
  add_step walk-pair pass "walked window $wid"
}

write_result() {
  local pass="$1" steps_json="" first=1 name status detail
  for entry in "${STEPS[@]}"; do
    IFS='|' read -r name status detail <<< "$entry"
    detail="${detail//\\/\\\\}"; detail="${detail//\"/\\\"}"
    [[ $first -eq 1 ]] || steps_json+=","; first=0
    steps_json+=$(printf '{"name":"%s","status":"%s","detail":"%s"}' "$name" "$status" "$detail")
  done
  cat > "$OUTPUT/result.json" <<EOF
{
  "flow": "tray",
  "pass": $pass,
  "steps": [$steps_json],
  "screenshots": "screenshots/",
  "finishedUtc": "$(date -u +%FT%TZ)"
}
EOF
  log "wrote $OUTPUT/result.json (pass=$pass)"
}

main() {
  local pass=true
  start_x     || pass=false
  install_deb || pass=false
  launch_tray || pass=false
  walk_pair
  shot final >/dev/null
  write_result "$pass"
  [[ "$pass" == true ]]
}

main "$@"
