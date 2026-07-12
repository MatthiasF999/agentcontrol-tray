# Hyper-V VM test harness — base image build (Phase 66h.1)

A **persistent Windows 11 Hyper-V VM with nested virtualization** that can run
the full WSL-inclusive installer / pairing test **without touching the host's
own WSL** — the flaw that blocks the Windows-Sandbox approach (Phase 66d). See
[`BLUEPRINT.md`](./BLUEPRINT.md) for the full architecture and the four sub-PRs.

This PR (**66h.1**) is the **one-time base-image builder**. It converts a
Windows 11 Enterprise evaluation ISO into a ready-to-clone Hyper-V guest with
WSL2 + Ubuntu-22.04 + OpenSSH pre-installed, then snapshots it as
`clean-agentcontrol-base`. Later PRs (66h.2–.4) add the per-run orchestrator that
reverts to that snapshot before every test.

> Nothing here runs the actual test yet, and **the scripts have not been executed
> against a live host** (they need a Windows host with Hyper-V). This PR lands the
> build tooling; first smoke is the user running `Build-BaseImage.ps1`.

## Files

| File | Runs on | Purpose |
|------|---------|---------|
| `Build-BaseImage.ps1` | Windows host (elevated) | One-time: ISO → VHDX → VM → provision → snapshot. |
| `AutoUnattend.xml` | (baked into VHDX) | Zero-touch Windows setup: skip OOBE, auto-login, launch `First-Boot.ps1`. |
| `First-Boot.ps1` | inside the VM (first logon) | Install OpenSSH + WSL2 kernel + Ubuntu-22.04 + `dev` user; write `provisioning-complete.txt`. |
| `README.md` | — | This file. |

## Prerequisites

- **Windows 11 Pro / Enterprise / Education** host (Home has no Hyper-V).
- **Hyper-V feature enabled** — from an elevated PowerShell:
  `Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All`, then reboot.
- **Run elevated** (admin) — Hyper-V cmdlets, VHDX mount, and ACLs require it.
- **≥ 40 GB free** at the work dir (`C:\Hyper-V\AgentControlTest` by default).
- **A host SSH keypair** — `\\wsl$\Ubuntu\home\dev\.ssh\id_ed25519.pub` by
  default (generate with `ssh-keygen -t ed25519` if absent). Its **public** key
  is baked into the guest for both the Windows admin and the Ubuntu `dev` user.
- **Internet access** on the host — the builder downloads
  `Convert-WindowsImage.ps1`, the WSL2 kernel MSI, and the Ubuntu rootfs once.

## Step 1 — download the Windows 11 evaluation ISO (user action)

Microsoft no longer ships ready-made developer VHDX images, so the base is built
from the free 90-day evaluation ISO:

1. Go to the [Windows 11 Enterprise evaluation center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise).
2. Download the **ISO – Enterprise** (English, x64).
3. Save it to **`C:\Hyper-V\AgentControlTest\Win11-Enterprise-Eval.iso`**
   (or anywhere, and pass `-IsoPath`).

## Step 2 — build the base image

From an **elevated** PowerShell:

```powershell
pwsh -File scripts\hyperv-test\Build-BaseImage.ps1
```

The script is idempotent — re-running reuses an existing VHDX / VM / snapshot.
Pass `-Force` to rebuild from scratch.

**Time budget: ~90 min for the first build** (ISO→VHDX ~10–20 min, unattended
Windows setup ~10–15 min, WSL + Ubuntu provisioning ~10–15 min, plus the one-time
downloads). Subsequent runs that reuse artifacts are far faster.

### What it does

1. Verify prereqs (admin, Hyper-V, disk, ISO, vSwitch).
2. Stage the injection payload (host pubkey, `First-Boot.ps1`, WSL2 kernel MSI,
   Ubuntu rootfs) into `…\inject`.
3. Convert the ISO to a dynamic UEFI VHDX with `AutoUnattend.xml` baked in
   (offline WIM apply — no TPM/SecureBoot setup gate).
4. Mount the VHDX and copy the payload to `C:\provisioning` inside it.
5. Create a **Generation 2** VM (`agentcontrol-test-vm`): 8 GB **static** RAM,
   4 vCPU, **nested virtualization on**
   (`Set-VMProcessor -ExposeVirtualizationExtensions $true`), vTPM + Secure Boot,
   VHDX + ISO attached, on the **Default Switch**.
6. Start it; `AutoUnattend.xml` auto-logs-in and runs `First-Boot.ps1`, which
   installs OpenSSH (key auth), the WSL2 kernel, imports Ubuntu-22.04, creates
   the `dev` user, and writes `C:\provisioning-complete.txt`.
7. The host polls over SSH until that file appears, detaches the ISO, shuts the
   guest down cleanly, and takes the `clean-agentcontrol-base` snapshot.

### Key parameters (defaults)

| Param | Default | Notes |
|-------|---------|-------|
| `-IsoPath` | `C:\Hyper-V\AgentControlTest\Win11-Enterprise-Eval.iso` | The eval ISO you downloaded. |
| `-WorkDir` | `C:\Hyper-V\AgentControlTest` | VHDX + downloads + injection staging. |
| `-VmName` | `agentcontrol-test-vm` | Hyper-V VM name. |
| `-SwitchName` | `Default Switch` | Any existing vSwitch (Default Switch = NAT + DHCP). |
| `-SnapshotName` | `clean-agentcontrol-base` | The golden snapshot the orchestrator reverts to. |
| `-Edition` | `Windows 11 Enterprise Evaluation` | WIM edition applied. |
| `-HostPubKeyPath` | `\\wsl$\Ubuntu\home\dev\.ssh\id_ed25519.pub` | Baked into guest (admin + `dev`). |
| `-MemoryGB` / `-CpuCount` / `-DiskGB` | `8` / `4` / `64` | Static RAM (nested-virt), vCPU, max dynamic disk. |
| `-ProvisioningTimeoutMin` | `40` | Cap on the first-boot provisioning wait. |
| `-Force` | *(off)* | Rebuild VHDX/VM/snapshot even if present. |

**Documented credentials** (throwaway eval VM, host-only network; SSH key is the
real access path):

- Windows admin `Administrator` / `AgentControl!Test1`
- Ubuntu `dev` / `AgentControl!Test1` (passwordless sudo)

## Troubleshooting

### Watching provisioning progress (Basic vs Enhanced Session Mode)

Hyper-V Manager's VMConnect has TWO connection modes:

- **Enhanced Session Mode (ESM)** — default. Uses an RDP-like wrapper that shows
  its own guest-credentials dialog BEFORE connecting. Even when AutoLogon has
  successfully logged the guest into Windows, ESM's own credential prompt makes
  it LOOK like AutoLogon failed. This is a false alarm.

- **Basic Session Mode** — raw video output. Shows what Windows is actually
  displaying. AutoLogon events are visible here.

**To watch AutoLogon + First-Boot.ps1 progress**: in VMConnect, switch off ESM:
`View menu → Enhanced Session → uncheck` (or press `Ctrl+Alt+End`). Reconnect.
You should see Windows boot → auto-login as Administrator → First-Boot.ps1
PowerShell console pops up.

**If Basic Session Mode ALSO lands on a login screen**, THEN AutoLogon is truly
broken — apply the "Manual login on first boot" step below.

| Symptom | Likely cause / fix |
|---------|--------------------|
| `must run elevated` | Start PowerShell as Administrator. |
| `Hyper-V feature not enabled` | Enable it (see Prereqs) and reboot. |
| `Win11 eval ISO not found` | Download it to the default path or pass `-IsoPath`. |
| `Convert-WindowsImage did not produce a VHDX` | Wrong `-Edition` string — list editions with `Get-WindowsImage -ImagePath <mounted>\sources\install.wim`; eval media is usually `Windows 11 Enterprise Evaluation`. |
| `need >= 40GB free` | Free space or point `-WorkDir` at a bigger drive. |
| **VM lands at the login screen instead of auto-logging in** | AutoLogon in `AutoUnattend.xml` is broken. On Windows 11 26200 the usual cause is a `SkipMachineOOBE`/`SkipUserOOBE` in the OOBE block (both are deprecated and short-circuit the OOBE machine that writes the AutoAdminLogon registry values *and* registers FirstLogonCommands, so AutoLogon **and** First-Boot.ps1 both silently fail). Remove them and rely on the `Hide*` settings. Second cause: the built-in `Administrator` configured via `<LocalAccount>` (name collision) instead of `<AdministratorPassword>`, so the AutoLogon password ends up out of sync. `Build-BaseImage.ps1`'s `Test-Unattend` now fails fast on a missing AutoLogon/FirstLogonCommands and warns on `Skip*OOBE`. **On Win11 25H2+ AutoLogon can be ignored even with a valid answer file** (Microsoft is deprecating password AutoLogon in favour of Passkeys / Windows Hello) -- see the dedicated row below; this is a known limitation, not a build bug. |
| **Win11 25H2+ (build 26200): one manual login on first boot** *(second troubleshooting step — only after the Basic-vs-ESM check above)* | **First rule out Enhanced Session Mode** (see "Watching provisioning progress" above): a login screen under ESM is usually a false alarm and AutoLogon actually worked. Only if **Basic Session Mode ALSO** lands on a login screen is AutoLogon genuinely broken. In that real-failure case the VM may sit at the login screen despite a valid `<AutoLogon>` block. This needs **one** manual step, once, on the first base-image build: (1) open `agentcontrol-test-vm` in **Hyper-V Manager** (Connect, in Basic Session Mode); (2) at the login screen click **Administrator**; (3) type the password `AgentControl!Test1` and press Enter. `First-Boot.ps1` then fires automatically via `FirstLogonCommands`, provisioning runs to completion, and the builder's SSH poll picks it up from there. The builder detects this case: once the guest has an IP but sshd stays silent past `-ManualLoginHintMin` minutes (default 10) it prints a one-time hint with these exact steps. After this build the base snapshot is captured, so per-run orchestrator reverts never hit the login screen again. |
| **First-Boot log shows `wsl_update_x64.msi install failed (exit 1603)`** | Win11 25H2 (build 26200) ships WSL as a built-in Store app; the standalone `wsl_update_x64.msi` is deprecated and its MSI install fails with 1603. **No action needed** -- `First-Boot.ps1` automatically falls back to native `wsl --install --no-distribution --no-launch` and continues. If that native path **also** fails, log into the guest and run `wsl --status` manually, then confirm the `Microsoft-Windows-Subsystem-Linux` and `VirtualMachinePlatform` Windows features are enabled (`Get-WindowsOptionalFeature -Online -FeatureName <name>`). |
| Provisioning never completes / SSH never answers | Open the VM in Hyper-V Manager, log in (`Administrator` / password above), read `C:\provisioning\first-boot.log`. Common causes: no host pubkey, download blocked, nested-virt not actually available on the physical host. |
| `guest provisioning failed` | `C:\provisioning-failed.txt` + `first-boot.log` inside the VM have the error. |
| WSL fails inside the guest | The **physical** host must expose VT-x/AMD-V and not itself block nesting; confirm the host isn't a VM that disallows nested virt. |
| Wrong SSH host key on rebuild | The guest IP is DHCP; clear the stale entry with `ssh-keygen -R <ip>` (or the builder's `StrictHostKeyChecking=no` handles it). |

## The 90-day clock

The evaluation edition is a **90-day** license. When it expires, rebuild the base
from a fresh eval ISO (`-Force`), or re-arm inside the guest with `slmgr /rearm`
(a few times), or supply a licensed key in `AutoUnattend.xml`. For a nightly /
pre-release gate this quarterly rebuild is acceptable (see BLUEPRINT §7).

## What's next

- **66h.2** — `hyperv-test-orchestrator.sh` + `runner-vm.ps1`: revert to
  `clean-agentcontrol-base`, boot, `scp` inputs, run the reused 66d step
  functions over SSH, collect `result.json`.
- **66h.3** — wire `verify-pair-flow.mjs` reuse + `pair-verify.env.example`.
- **66h.4** — `PHASE-66H-SUMMARY.md` + build-once/run-many runbook.
