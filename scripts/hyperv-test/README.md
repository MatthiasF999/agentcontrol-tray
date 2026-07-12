# Hyper-V VM test harness — base image build (Phase 66j)

A **persistent Windows 11 Hyper-V VM with nested virtualization** that can run
the full WSL-inclusive installer / pairing test **without touching the host's
own WSL** — the flaw that blocks the Windows-Sandbox approach (Phase 66d). See
[`BLUEPRINT.md`](./BLUEPRINT.md) for the full architecture.

This PR (**66j**) replaces the base-image builder. Instead of building from a raw
Windows 11 evaluation ISO (fragile: OOBE, AutoLogon, and reboot-race bugs), it
imports **Microsoft's pre-built "Windows 11 dev environment"** image and
provisions it **host-side over PowerShell Direct** — no in-guest first-boot
script, no OOBE, no AutoLogon, no reboots. Setup drops from ~90 min to ~10-20 min
(most of which is the one-time image download).

> The scripts have **not been executed against a live host** (they need a Windows
> host with Hyper-V). This PR lands the build tooling; first smoke is the user
> running `Import-DevVM.ps1`.

## Two paths

| Path | Script | Status | When |
|------|--------|--------|------|
| **Microsoft dev VM (gallery)** | `Import-DevVM.ps1` | ✅ **Recommended** | Default. Pre-built, WSL2 already on, no OOBE. |
| Build from eval ISO | `Build-BaseImage-FromIso.ps1` | ⚠️ Deprecated | Only if you need a licensed key or a current 25H2 build the gallery image doesn't offer. |

## Files

| File | Runs on | Purpose |
|------|---------|---------|
| `Import-DevVM.ps1` | Windows host (elevated) | **Primary.** Resolve gallery image → download+verify → extract VHDX → create VM → provision over PowerShell Direct → `slmgr /rearm` → snapshot. |
| `Update-DevVM.ps1` | Windows host (elevated) | Quarterly refresh: refetch the gallery, hash-diff, rebuild only if Microsoft published a newer image. Cron-able (Phase 66i). |
| `Build-BaseImage-FromIso.ps1` | Windows host (elevated) | Deprecated ISO + AutoUnattend flow, kept for reference. |
| `AutoUnattend.xml`, `First-Boot.ps1` | (ISO flow only) | Consumed by `Build-BaseImage-FromIso.ps1`. |
| `README.md` | — | This file. |

## Prerequisites

- **Windows 11 Pro / Enterprise / Education** host (Home has no Hyper-V).
- **Hyper-V feature enabled** — from an elevated PowerShell:
  `Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All`, then reboot.
- **Run elevated** (admin) — Hyper-V cmdlets, VHDX extraction, and PowerShell
  Direct all require it.
- **≥ 40 GB free** at the work dir (`C:\Hyper-V\AgentControlTest` by default) —
  the compressed image plus the extracted VHDX.
- **A host SSH keypair** — `\\wsl$\Ubuntu\home\dev\.ssh\id_ed25519.pub` by
  default (generate with `ssh-keygen -t ed25519` if absent). Its **public** key
  is baked into the guest for both the Windows admin and the Ubuntu `dev` user.
- **Internet access** on the host — downloads the gallery image + (by default)
  the Ubuntu distro inside the guest.

---

## Using the Microsoft Dev VM

Microsoft **discontinued the standalone developer-VHDX download** (the old
`developer.microsoft.com/.../virtual-machines` page now redirects to a page with
no VMs). The only surviving pre-built dev VM is the one the **Hyper-V Quick
Create gallery** serves — and, crucially, its backing disk is reachable by a
plain URL, so `Import-DevVM.ps1` fetches it **without the Quick Create GUI**:

1. It downloads the public gallery manifest
   (`https://go.microsoft.com/fwlink/?linkid=851584`).
2. Finds the `Windows 11 dev environment` entry and reads its `disk.uri` +
   sha256.
3. Downloads that `.zip` (cached + hash-verified), extracts the `.vhdx`, and
   builds the VM.

As of 2026 the gallery serves **`WinDev2407Eval`** — a **July-2024 / 22H2**
Enterprise **Evaluation** build. Two consequences you should know:

- It is **not 25H2** (Microsoft no longer publishes a newer pre-built image).
- Its 90-day evaluation **has already expired**, so `Import-DevVM.ps1` runs
  **`slmgr /rearm`** during provisioning (then reboots so it takes effect). That
  resets the clock to ~90 days, so **every reverted snapshot boots licensed**.
  Rearms are finite (~5 per image); run `Update-DevVM.ps1` quarterly to pick up
  a fresh image from Microsoft when the hash changes.

### Step 1 — run the import

From an **elevated** PowerShell:

```powershell
pwsh -File scripts\hyperv-test\Import-DevVM.ps1
```

Idempotent — re-running reuses the cached zip / extracted VHDX / VM / snapshot.
Pass `-Force` to rebuild from scratch.

**Time budget: ~10-20 min** (dominated by the one-time ~10-20 GB image
download; VM create + PowerShell Direct provisioning is a few minutes).

### What it does

1. Verify prereqs (admin, Hyper-V, switch, disk, host pubkey).
2. Resolve the gallery image → disk URI + sha256 + in-zip VHDX name.
3. Download the zip (skip if cached + hash matches), **verify sha256**, extract
   the VHDX, clear its mark-of-the-web.
4. Create a **Generation 2** VM (`agentcontrol-test-vm`): 8 GB **static** RAM, 4
   vCPU, **nested virtualization on**, vTPM + Secure Boot, on the **Default
   Switch** (NAT + DHCP).
5. Start it; the MS image auto-logs-in as `User` — so provisioning runs from the
   **host** over PowerShell Direct (`New-PSSession -VMName`), no guest network
   needed: install OpenSSH (key auth via `administrators_authorized_keys`),
   ensure `Ubuntu-22.04` (via `wsl --install -d`, or an offline
   `-UbuntuRootfsPath` import), create the `dev` user, then `slmgr /rearm`.
6. Reboot the guest so the rearm applies, shut down cleanly, take the
   `clean-agentcontrol-base` snapshot, and record the imported image hash to
   `devvm\imported-image.json`.

### Key parameters (defaults)

| Param | Default | Notes |
|-------|---------|-------|
| `-WorkDir` | `C:\Hyper-V\AgentControlTest` | Image cache + extracted VHDX under `devvm\`. |
| `-VmName` | `agentcontrol-test-vm` | Hyper-V VM name. |
| `-SwitchName` | `Default Switch` | NAT + DHCP; guest IP is dynamic (orchestrator discovers it). |
| `-SnapshotName` | `clean-agentcontrol-base` | The golden snapshot the orchestrator reverts to. |
| `-ImageName` | `Windows 11 dev environment` | Gallery entry to import. |
| `-DiskUri` / `-DiskSha256` / `-ArchiveEntry` | *(from gallery)* | Pin/override the image (offline / reproducible builds). |
| `-HostPubKeyPath` | `\\wsl$\Ubuntu\home\dev\.ssh\id_ed25519.pub` | Baked into guest (admin + `dev`). |
| `-Distro` | `Ubuntu-22.04` | WSL distro provisioned in the guest. |
| `-UbuntuRootfsPath` | *(empty)* | Offline: a host rootfs tarball to `wsl --import` instead of `wsl --install -d`. |
| `-GuestUser` / `-GuestPassword` | `User` / *(auto)* | MS dev-VM logon. Password is tried blank then `Passw0rd!`; override if MS changed it. |
| `-SkipRearm` | *(off)* | Skip `slmgr /rearm` + its reboot (e.g. a still-valid image). |
| `-Force` | *(off)* | Rebuild even if zip/VHDX/VM/snapshot exist. |

**Documented credentials** (throwaway VM; SSH key is the real access path):

- Windows admin `User` (Microsoft's default; blank password).
- Ubuntu `dev` / `AgentControl!Test1` (passwordless sudo).

### Quarterly refresh — `Update-DevVM.ps1`

The gallery image is an evaluation build that Microsoft replaces periodically
under the same entry (only the URI + hash change). `Update-DevVM.ps1` refetches
the manifest and compares the current disk hash to the one recorded at the last
import:

```powershell
pwsh -File scripts\hyperv-test\Update-DevVM.ps1            # rebuild only if the hash moved
pwsh -File scripts\hyperv-test\Update-DevVM.ps1 -CheckOnly # report drift, exit 2, never rebuild (CI gate)
```

A no-op until the hash actually changes; on change it delegates the full rebuild
to `Import-DevVM.ps1 -Force`. Phase 66i wires the `-CheckOnly` form into the
pipeline as a scheduled quarterly job.

### Troubleshooting (dev VM)

| Symptom | Likely cause / fix |
|---------|--------------------|
| `must run elevated` | Start PowerShell as Administrator. |
| `Hyper-V feature not enabled` | Enable it (see Prereqs) and reboot. |
| `vSwitch 'Default Switch' not found` | Create a switch or pass `-SwitchName`. |
| `gallery has no image named ...` | Microsoft renamed/removed the entry. Check the printed names; pass `-ImageName`, or pin `-DiskUri/-DiskSha256/-ArchiveEntry`. |
| `downloaded zip sha256 != expected` | Truncated download or Microsoft rotated the image mid-fetch. Re-run (it re-downloads); if it persists, run `Update-DevVM.ps1` to pick up the new hash. |
| `could not open a PowerShell Direct session` | MS changed the default credentials. Pass `-GuestUser` / `-GuestPassword`. Confirm the guest booted (open it in Hyper-V Manager). |
| `wsl --install -d ... failed` | Guest had no NAT internet. Supply an offline rootfs with `-UbuntuRootfsPath <host tar.gz>`. |
| `slmgr /rearm` reports no rearms left | This image has been rearmed ~5 times — run `Update-DevVM.ps1` (or `Import-DevVM.ps1 -Force`) to pull a fresh image with a full rearm budget. |
| WSL fails inside the guest | The **physical** host must expose VT-x/AMD-V and not itself block nested virt. |

---

## Legacy: build from ISO (deprecated)

`Build-BaseImage-FromIso.ps1` is the original Phase 66h flow: it converts a
Windows 11 Enterprise 90-day evaluation ISO into the base image via
`Convert-WindowsImage` + an `AutoUnattend.xml` + an in-guest `First-Boot.ps1`.
It is **deprecated** — `Import-DevVM.ps1` is simpler and less fragile — but kept
for the case where you need a **licensed key** or a **current 25H2 build** the
gallery image doesn't offer.

If you use it, the ISO route's failure modes (Win11 25H2 ignoring unattend
AutoLogon and parking at the login screen, deprecated `Skip*OOBE`, the
`wsl_update_x64.msi` 1603 fallback, and the WSL-feature reboot-and-resume race)
are documented inline in `Build-BaseImage-FromIso.ps1` and `First-Boot.ps1`.
Download the ISO from the
[Windows 11 Enterprise evaluation center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise)
to `C:\Hyper-V\AgentControlTest\Win11-Enterprise-Eval.iso`, then run
`pwsh -File scripts\hyperv-test\Build-BaseImage-FromIso.ps1`.

## What's next

- **Per-run orchestrator** — `hyperv-test-orchestrator.sh` + `runner-vm.ps1`:
  revert to `clean-agentcontrol-base`, boot, discover the guest IP, `scp` inputs,
  run the reused 66d step functions over SSH (as `User@<ip>`), collect
  `result.json`.
- **Phase 66i** — CI automation: cache the extracted VHDX, run
  `Update-DevVM.ps1 -CheckOnly` quarterly, rebuild + re-snapshot on drift.
