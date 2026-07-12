#!/usr/bin/env bash
#
# hyperv-test-orchestrator.sh — WSL-side driver for the Hyper-V VM test harness.
#
# Reverts the AgentControl-Test VM to its golden snapshot, boots it, stages the
# installer + PowerShell harness over SSH, runs runner-vm.ps1 inside the guest,
# scp's output/result.json + screenshots back, then powers the VM off.
#
# Unlike the Windows-Sandbox harness (scripts/sandbox-test), this survives the
# host's own WSL session — the guest runs WSL2 via nested virtualization, so no
# `wsl --shutdown` is ever needed. See scripts/hyperv-test/BLUEPRINT.md.
#
# Assumes the base builder (Import-DevVM.ps1, Phase 66j; or the deprecated
# Build-BaseImage-FromIso.ps1) has already produced the VM + snapshot and baked
# ~/.ssh/id_ed25519's pubkey into the guest.
#
# Flows (mirror the 66d contract):
#   --flow tray   installer download + install-dir verify + tray launch
#   --flow wsl    full WSL2 + Ubuntu + bridge install + verify-pair-flow (default)
#   --flow full   tray then wsl
#
# Usage:
#   ./hyperv-test-orchestrator.sh                    # wsl flow, live bootstrapper
#   ./hyperv-test-orchestrator.sh --flow full        # both flows in one boot
#   ./hyperv-test-orchestrator.sh --local ./x.exe    # local installer (tray/full)
#   ./hyperv-test-orchestrator.sh --keep-vm-running  # don't Stop-VM afterwards
#   ./hyperv-test-orchestrator.sh --vm-name X --snapshot-name Y
#
# @line-limit-exception: single linear stage->run->collect harness; splitting
# the step helpers across files would hurt readability of the boot sequence.
set -euo pipefail

# --- config ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_URL="https://install.agent-control.io/setup.exe"
VM_NAME='agentcontrol-test-vm'
SNAPSHOT_NAME='clean-agentcontrol-base'
VM_USER='User'
VM_IP_FALLBACK='172.31.0.10'          # static Internal-switch IP (BLUEPRINT §2)
SSH_KEY="$HOME/.ssh/id_ed25519"
STAGE_WIN='C:/AgentControlTest/staging'   # forward-slash form OpenSSH scp accepts
OUTPUT_WIN='C:/test-output'
OUTPUT_LOCAL="$SCRIPT_DIR/output"
FLOW='wsl'
LOCAL_SETUP=''
KEEP_VM=0

# --- args --------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --flow)           FLOW="${2:?--flow needs tray|wsl|full}"; shift 2 ;;
    --local)          LOCAL_SETUP="${2:?--local needs a path}"; shift 2 ;;
    --vm-name)        VM_NAME="${2:?--vm-name needs a value}"; shift 2 ;;
    --snapshot-name)  SNAPSHOT_NAME="${2:?--snapshot-name needs a value}"; shift 2 ;;
    --keep-vm-running) KEEP_VM=1; shift ;;
    -h|--help)        grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$FLOW" in tray|wsl|full) ;; *) echo "bad --flow: $FLOW" >&2; exit 2 ;; esac

log()  { printf '[hyperv] %s\n' "$*"; }
fail() { echo "[hyperv] FAIL: $*" >&2; exit 1; }

# Run a PowerShell one-liner on the host; strip CRs from the result.
ps() { powershell.exe -NoProfile -NonInteractive -Command "$*" 2>/dev/null | tr -d '\r'; }

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o ConnectTimeout=10 -o LogLevel=ERROR)
VM_IP=''

# --- VM lifecycle ------------------------------------------------------------
revert_snapshot() {
  log "reverting $VM_NAME -> snapshot $SNAPSHOT_NAME"
  ps "Restore-VMSnapshot -VMName '$VM_NAME' -Name '$SNAPSHOT_NAME' -Confirm:\$false" \
    || fail "Restore-VMSnapshot failed (VM/snapshot missing? run Import-DevVM.ps1 first)"
}

start_vm() {
  log "starting $VM_NAME"
  # Start-VM is a no-op if already running after a revert; ignore that error.
  ps "Start-VM -Name '$VM_NAME' -ErrorAction SilentlyContinue" || true
}

# Poll the VM's network adapter for an IPv4 address; fall back to the pinned
# Internal-switch IP if discovery yields nothing within the window.
discover_ip() {
  log "discovering VM IP (up to 90s)"
  local q="(Get-VMNetworkAdapter -VMName '$VM_NAME' | Select-Object -First 1).IPAddresses | Where-Object { \$_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+\$' } | Select-Object -First 1"
  for _ in $(seq 1 18); do
    VM_IP="$(ps "$q")"
    [[ -n "$VM_IP" ]] && { log "VM IP = $VM_IP"; return; }
    sleep 5
  done
  VM_IP="$VM_IP_FALLBACK"
  log "IP discovery timed out; using fallback $VM_IP"
}

# Wait for SSH (port 22) to accept connections on the guest.
wait_ssh() {
  log "waiting for ssh $VM_IP:22 (up to 120s)"
  for _ in $(seq 1 24); do
    if nc -z -w 3 "$VM_IP" 22 2>/dev/null; then log "ssh port open"; return; fi
    sleep 5
  done
  fail "ssh never came up on $VM_IP:22"
}

vm_ssh() { ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "$@"; }
vm_scp() { scp "${SSH_OPTS[@]}" "$@"; }

# --- staging -----------------------------------------------------------------
stage_setup_exe() {
  local dst="$SCRIPT_DIR/.stage/setup.exe"
  if [[ -n "$LOCAL_SETUP" ]]; then
    [[ -f "$LOCAL_SETUP" ]] || fail "no such file: $LOCAL_SETUP"
    log "using local installer: $LOCAL_SETUP"
    cp "$LOCAL_SETUP" "$dst"
  else
    log "downloading $SETUP_URL"
    curl -fSL "$SETUP_URL" -o "$dst"
  fi
}

# Build a local .stage dir with exactly what this flow needs, then scp it in.
stage_inputs() {
  local st="$SCRIPT_DIR/.stage"
  rm -rf "$st"; mkdir -p "$st"
  cp "$SCRIPT_DIR/runner-vm.ps1"   "$st/runner-vm.ps1"
  cp "$SCRIPT_DIR/helpers-vm.psm1" "$st/helpers-vm.psm1"
  # verify-pair-flow.mjs is the single source of truth in e2e-pair-verify — copy
  # it into staging at run time, never duplicate it into the hyperv-test tree.
  if [[ "$FLOW" == 'wsl' || "$FLOW" == 'full' ]]; then
    cp "$SCRIPT_DIR/../e2e-pair-verify/verify-pair-flow.mjs" "$st/verify-pair-flow.mjs"
    # service_role key: gitignored host file; present -> pair-flow runs, else skip.
    if [[ -f "$SCRIPT_DIR/pair-verify.env" ]]; then
      log "staging pair-verify.env (service_role, RO)"
      cp "$SCRIPT_DIR/pair-verify.env" "$st/pair-verify.env"
    else
      log "no pair-verify.env — verify-pair-flow will record 'skip' in-guest"
    fi
  fi
  [[ "$FLOW" == 'tray' || "$FLOW" == 'full' ]] && stage_setup_exe

  log "scp staging -> $VM_USER@$VM_IP:$STAGE_WIN"
  vm_ssh "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path '$STAGE_WIN','$OUTPUT_WIN' | Out-Null\""
  vm_scp "$st"/* "$VM_USER@$VM_IP:$STAGE_WIN/"
}

# --- run + collect -----------------------------------------------------------
run_guest() {
  log "running runner-vm.ps1 (flow=$FLOW) in guest"
  # &&-free: let the runner write result.json even on step failure; we grade it.
  vm_ssh "powershell -NoProfile -ExecutionPolicy Bypass -File $STAGE_WIN/runner-vm.ps1 -Flow $FLOW -StagingRoot 'C:\\AgentControlTest\\staging' -OutputRoot 'C:\\test-output'" \
    || log "runner-vm.ps1 exited non-zero (grading result.json anyway)"
}

collect_result() {
  rm -rf "$OUTPUT_LOCAL"; mkdir -p "$OUTPUT_LOCAL"
  log "collecting $OUTPUT_WIN -> $OUTPUT_LOCAL"
  vm_scp -r "$VM_USER@$VM_IP:$OUTPUT_WIN/*" "$OUTPUT_LOCAL/" 2>/dev/null || true
  local result="$OUTPUT_LOCAL/result.json"
  [[ -f "$result" ]] || fail "no result.json collected from guest"
  echo "[hyperv] result.json:"; cat "$result"; echo
  if grep -q '"pass"[[:space:]]*:[[:space:]]*true' "$result"; then
    log "PASS ($FLOW) — screenshots in $OUTPUT_LOCAL/screenshots"
    return 0
  fi
  echo "[hyperv] FAIL ($FLOW) — see $OUTPUT_LOCAL/result.json + screenshots" >&2
  return 1
}

teardown() {
  if [[ "$KEEP_VM" -eq 1 ]]; then
    log "leaving $VM_NAME running (--keep-vm-running); IP $VM_IP"
    return
  fi
  log "powering off $VM_NAME (next run reverts the snapshot anyway)"
  ps "Stop-VM -Name '$VM_NAME' -TurnOff -Force -ErrorAction SilentlyContinue" || true
}

# --- dispatch ----------------------------------------------------------------
rc=0
revert_snapshot
start_vm
discover_ip
wait_ssh
stage_inputs
run_guest
collect_result || rc=1
teardown
exit "$rc"
