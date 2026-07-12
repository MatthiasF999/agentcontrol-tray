# Hyper-V VM installer/pairing test harness (Phase 66h)

Automated end-to-end test of the AgentControl installer + WSL bootstrapper on a
**persistent Windows 11 Hyper-V VM with nested virtualization**. Every run
reverts the VM to a golden snapshot, drives the flow over SSH, screenshots each
phase, verifies the artifacts, and scp's `result.json` back — then powers the VM
off.

Why a VM and not Windows Sandbox: Sandbox + host WSL both share the host's
Hyper-V networking, so a Sandbox `RemoteSession` never spawns while Claude Code's
own WSL is active. A first-class Hyper-V guest running WSL2 via nested virt
sidesteps that entirely — **the host WSL session survives, no `wsl --shutdown`**.
Full rationale in [`BLUEPRINT.md`](./BLUEPRINT.md).

## Prerequisites

- Phase 66h.1's `Build-BaseImage.ps1` has already run once on the host, producing:
  - VM `AgentControl-Test` (nested-virt on, static RAM, Standard checkpoints)
  - snapshot `clean-agentcontrol-base` (WSL2 kernel + Ubuntu-22.04 + OpenSSH server)
  - your `~/.ssh/id_ed25519.pub` baked into the guest's `administrators_authorized_keys`
- Host reachable from WSL: `powershell.exe`, `ssh`, `scp`, `nc`, `curl` on PATH.
- The guest is reachable at the pinned Internal-switch IP `172.31.0.10` (or
  discovered via `Get-VMNetworkAdapter`).

## Files

| File                        | Runs on | Purpose |
|-----------------------------|---------|---------|
| `hyperv-test-orchestrator.sh` | WSL   | Revert snapshot, boot, stage inputs, run guest, collect result. `--flow tray\|wsl\|full`. |
| `runner-vm.ps1`             | guest VM | Drives installer / WSL bootstrap over SSH, writes `result.json`. No `Stop-Computer`. |
| `helpers-vm.psm1`           | guest VM | UIAutomation + screenshot + result helpers (lifted from 66d `helpers.psm1`). |
| `BLUEPRINT.md`              | —     | Design doc (architecture, base-image build, risks). |

`verify-pair-flow.mjs` is **not** stored here — the orchestrator copies the single
source of truth from `../e2e-pair-verify/` into staging at run time.

## Flows

| Flow   | Covers | Budget |
|--------|--------|--------|
| `tray` | installer download + install-dir verify + tray launch | ~3 min |
| `wsl` (default) | WSL2 kernel + Ubuntu-22.04 + `wsl.sh` bridge + verify-pair-flow | ~11 min |
| `full` | `tray` then `wsl` in one boot | ~13 min |

Total budget ~12 min for `wsl`: 5 s snapshot revert + ~60 s boot + ~10 min
install + ~30 s verify. Use it as a nightly / pre-release gate, not per commit.

## Usage

```bash
# default: wsl flow, live bootstrapper from install.agent-control.io
./hyperv-test-orchestrator.sh

# both flows in one boot
./hyperv-test-orchestrator.sh --flow full

# use a locally built installer instead of downloading (tray/full)
./hyperv-test-orchestrator.sh --flow tray --local ./src-tauri/target/release/setup.exe

# leave the VM running afterwards (interactive debugging)
./hyperv-test-orchestrator.sh --keep-vm-running

# non-default VM / snapshot names
./hyperv-test-orchestrator.sh --vm-name MyVM --snapshot-name my-base
```

Output lands in `./output/`: `result.json`, `pair-flow.json` (wsl flow),
`diagnostics.txt` (on failure), and `screenshots/NNN-*.png`. Exit code is `0` on
`"pass": true`, `1` otherwise.

## Pair-flow (service_role) key

To exercise the magic-link → `/pair-bridge/` return path, drop a
`pair-verify.env` next to this README (copy `../sandbox-test/pair-verify.env.example`).
It is gitignored; the orchestrator scp's it into staging and `runner-vm.ps1`
loads it via `PAIR_VERIFY_ENV`. Absent → the step records `skip` (the usual
local case), and the run can still pass.

## Data flow

```
hyperv-test-orchestrator.sh (host WSL)        AgentControl-Test VM (nested-virt)
  Restore-VMSnapshot ──powershell.exe──────►    revert to clean-agentcontrol-base
  Start-VM + discover IP + wait ssh:22  ───►     OpenSSH server up
  scp staging (setup.exe, *.ps1, *.mjs)  ──►     C:\AgentControlTest\staging
  ssh runner-vm.ps1 -Flow ...  ────────────►     drive install + WSL + screenshot
  scp C:\test-output back  ◄───────────────      write result.json
  grep "pass": true, exit 0/1                    (orchestrator runs Stop-VM)
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Restore-VMSnapshot failed` | Base image not built — run 66h.1 `Build-BaseImage.ps1` first, or pass `--vm-name`/`--snapshot-name`. |
| `ssh never came up on ...:22` | Guest still booting (raise the wait), OpenSSH service not auto-started, or IP drifted — check `Get-VMNetworkAdapter -VMName AgentControl-Test`. |
| SSH permission denied | Host pubkey not in the guest's `administrators_authorized_keys` — re-run the base build's key-bake step (BLUEPRINT §2.2f). |
| Screenshots are black | `runner-vm.ps1` runs in a non-interactive SSH (Session 0) context, so `CopyFromScreen` can't see the console desktop. The WSL-flow steps are `wsl.exe` CLI and unaffected; the tray flow's UIAutomation needs the interactive session — launch via a scheduled task in the auto-logged-in console session if tray screenshots matter. |
| `no result.json collected` | Guest run crashed before writing output — inspect with `--keep-vm-running` then `ssh test@<ip>` and read `C:\test-output`. |
| `verify-pair-flow` always `skip` | No `pair-verify.env` present (expected locally). Add it to enable the step. |

## Relationship to Phase 66d (Windows Sandbox)

66h reuses 66d's contract and step logic verbatim where it can: the
`result.json` shape, `verify-pair-flow.mjs`, the pair-verify.env convention, and
the UIAutomation/screenshot helpers. The differences are the isolation
mechanism (Hyper-V snapshot revert vs `.wsb` launch) and the control channel
(SSH vs Sandbox MappedFolder + LogonCommand). See
[`../sandbox-test/README.md`](../sandbox-test/README.md).
