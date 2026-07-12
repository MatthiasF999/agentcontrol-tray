#!/usr/bin/env bash
#
# hyperv-test-orchestrator.sh - thin WSL wrapper around the PowerShell orchestrator.
#
# The real driver is hyperv-test-orchestrator.ps1, which execs into the guest
# over PowerShell Direct (VMBus). PS Direct needs no guest network, so there is
# no SSH, no OpenSSH server, no port-22 firewall rule, and no WSL2->guest routing
# to set up - which is exactly what made the old SSH-based bash driver flaky
# (WSL2 cannot reach a Hyper-V Default-Switch guest at all; WSL #4288/#11494).
#
# This wrapper just lets WSL users keep calling ./hyperv-test-orchestrator.sh:
# it translates the flags and any POSIX --local path to Windows form and shells
# out to powershell.exe. Same flags/semantics as before.
#
# Usage:
#   ./hyperv-test-orchestrator.sh                    # wsl flow, live bootstrapper
#   ./hyperv-test-orchestrator.sh --flow full        # both flows in one boot
#   ./hyperv-test-orchestrator.sh --local ./x.exe    # local installer (tray/full)
#   ./hyperv-test-orchestrator.sh --keep-vm-running  # don't Stop-VM afterwards
#   ./hyperv-test-orchestrator.sh --vm-name X --snapshot-name Y
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Convert /mnt/c/... to C:\... so powershell.exe understands it.
winpath() { local p="$1"; wslpath -w "$p" 2>/dev/null || printf '%s' "$p"; }

# Translate the bash long-flags to the .ps1's parameter names; convert -Local.
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local|-Local)             args+=("-Local" "$(winpath "$2")"); shift 2 ;;
    --flow)                     args+=("-Flow" "$2"); shift 2 ;;
    --vm-name)                  args+=("-VmName" "$2"); shift 2 ;;
    --snapshot-name)            args+=("-SnapshotName" "$2"); shift 2 ;;
    --keep-vm-running)          args+=("-KeepVmRunning"); shift ;;
    *)                          args+=("$1"); shift ;;
  esac
done

powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$(winpath "$SCRIPT_DIR/hyperv-test-orchestrator.ps1")" "${args[@]}"
