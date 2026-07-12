# Phase 66h — Hyper-V VM test harness (blueprint)

Docs-only design for a **persistent Windows 11 Hyper-V VM with nested
virtualization** that runs the full WSL-inclusive installer/pairing test
**without depending on the host's WSL** — the flaw that blocks Phase 66d
(Windows Sandbox).

## Why Windows Sandbox can't do this

| Constraint | Consequence |
|---|---|
| Windows Sandbox + WSL2 both require Hyper-V | They share the host **HNS** (Host Networking Service) |
| Claude Code runs *inside* host Ubuntu WSL | Host WSL is always active during a test |
| Active host WSL vhost + Sandbox HNS collide | Sandbox starts `WindowsSandboxServer` only; **`RemoteSession` never spawns, LogonCommand never fires**, window handle = 0 |
| Fix would be `wsl --shutdown` | That kills Claude Code's own session — non-starter |

Root-cause confirmed via debug: `Get-Process WindowsSandbox*` returns Server
only, sandbox window handle 0, LogonCommand output never written — even after
killing the docker-desktop distro, because host Ubuntu WSL stays active.

**Hyper-V VM approach dodges this:** the VM is a first-class Hyper-V guest (not a
Sandbox container sharing host HNS), and WSL2 runs *inside* the guest via
[nested virtualization](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization).
The host's WSL is irrelevant — no `wsl --shutdown`, Claude's session survives.

---

## 1. Architecture overview

| Layer | Detail |
|---|---|
| Host | Windows 11 + Hyper-V; Claude Code in host Ubuntu WSL drives via `powershell.exe` |
| Control plane | WSL bash → `powershell.exe -c` → Hyper-V PowerShell module → managed VM |
| Guest VM | Windows 11, 16 GB disk (dynamic VHDX), 8 GB RAM, 4 vCPU, **nested-virt ON** |
| Guest contents | WSL2 kernel + `Ubuntu-22.04` pre-provisioned + Windows **OpenSSH server** |
| Data channel | SSH (WSL host → VM) over a **Hyper-V Internal switch** (static host-only IP) |
| Reset model | `Restore-VMSnapshot clean-agentcontrol-base` before every run |

```mermaid
flowchart LR
  subgraph HOST["Windows 11 host"]
    subgraph HWSL["host Ubuntu WSL (Claude Code)"]
      ORCH["hyperv-test-orchestrator.sh"]
    end
    PS["powershell.exe\nHyper-V module"]
    SW(["Internal vSwitch\nAgentControl-Test\n172.31.0.1/24"])
    subgraph VM["Win11 guest VM (nested-virt ON)"]
      SSHD["OpenSSH server\n172.31.0.10:22"]
      RUN["runner-vm.ps1"]
      subgraph GWSL["guest WSL2"]
        UB["Ubuntu-22.04\n+ bridge + verify-pair-flow.mjs"]
      end
      RUN --> GWSL
    end
  end
  ORCH -->|Restore/Start/Stop-VM| PS --> VM
  ORCH -->|scp / ssh| SSHD
  SSHD --> RUN
  SW --- SSHD
```

---

## 2. VM base image construction (one-time) — `Build-BaseImage.ps1`

### 2.1 Windows 11 source — **recommendation: ISO + AutoUnattend**

Microsoft **no longer publishes ready-made developer VHDX images** (the old
"Windows dev VM" downloads are
[discontinued](https://learn.microsoft.com/en-us/answers/questions/2259075/windows-developer-vm-or-images-where-are-they-now)).
The only supported free source is the
[Windows 11 Enterprise **90-day evaluation ISO**](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise).

| Option | Verdict |
|---|---|
| **Eval ISO + `Convert-WindowsImage` + AutoUnattend.xml** | ✅ **Recommended** — fully scriptable, no manual OOBE, reproducible |
| Ready-made Microsoft VHDX | ❌ Discontinued — not available |
| VHLK VHDX | ❌ Hardware-cert only, wrong workload |
| Hyper-V Quick Create | ⚠️ Interactive OOBE, not scriptable — dev bootstrap only |

`Convert-WindowsImage.ps1` turns the ISO's `install.wim` into a bootable VHDX and
bakes in an `AutoUnattend.xml` so first boot reaches the desktop with **no
interaction** (auto-login test user, skip OOBE/privacy prompts). See
[Convert-WindowsImage](https://deepwiki.com/MicrosoftDocs/Virtualization-Documentation/5.4-convert-windowsimage-and-vm-tools)
and [AutoUnattend for Win11](https://www.deploymentresearch.com/back-to-basics-using-an-autounattend-xml-file-to-automate-windows-11-setup-from-media/).

### 2.2 `Build-BaseImage.ps1` design

Idempotent, run once on the host (elevated). Produces VM `AgentControl-Test`
with snapshot `clean-agentcontrol-base`.

| Step | Action | Notes |
|---|---|---|
| a | `Convert-WindowsImage -SourcePath win11-eval.iso -VHDFormat VHDX -DiskLayout UEFI -UnattendPath AutoUnattend.xml -SizeBytes 64GB` | Dynamic disk; 16 GB is the min *used*, cap 64 GB |
| b | `New-VM -Generation 2 -MemoryStartupBytes 8GB -VHDPath ...` + `Set-VMProcessor -Count 4 -ExposeVirtualizationExtensions $true` | **Nested-virt flag — VM must be OFF to set it** |
| c | `Set-VM -CheckpointType Standard` + `Set-VMMemory -DynamicMemoryEnabled $false` | Static RAM required for nested-virt |
| d | First boot → AutoUnattend auto-logs-in test user, runs Windows Update, reboots | ~15–20 min unattended |
| e | `wsl --install --no-launch` → reboot → `wsl --install -d Ubuntu-22.04 --no-launch` | Pre-provision distro; nested-virt makes WSL2 work inside guest |
| f | Install **Windows OpenSSH Server** (`Add-WindowsCapability OpenSSH.Server`), start + auto-start service, drop authorized host pubkey | Key-based auth (§6) |
| g | Enable registry **auto-login** for test user (`DefaultUserName`/`AutoAdminLogon`) | So WSL user-session/systemd is available |
| h | `Checkpoint-VM -SnapshotName clean-agentcontrol-base` | The immutable golden state |

Connect the VM to an **Internal** vSwitch `AgentControl-Test` with a static guest
IP (`172.31.0.10`, host `172.31.0.1`) — deterministic SSH target, no
DHCP/NAT-port-forward guesswork. NAT is the fallback if isolation is needed.

---

## 3. Per-run orchestration — `hyperv-test-orchestrator.sh` + `runner-vm.ps1`

WSL-side driver. Total budget **~12 min** (revert 5 s + boot ~60 s + install
~10 min + verify ~30 s). Mirrors 66d's `host-orchestrator.sh` contract
(stage → run → collect `result.json` → pass/fail exit code).

| # | Orchestrator step | Command (via `powershell.exe -c` or ssh) |
|---|---|---|
| 1 | Revert to golden | `Restore-VMSnapshot -VMName AgentControl-Test -Name clean-agentcontrol-base` |
| 2 | Boot | `Start-VM -Name AgentControl-Test` |
| 3 | Wait for SSH | poll `Test-NetConnection 172.31.0.10 -Port 22` (or bash `nc -z`) until open, ~90 s cap |
| 4 | Stage inputs | `scp setup.exe verify-pair-flow.mjs pair-verify.env runner-vm.ps1 helpers.psm1 → test@172.31.0.10:C:\AgentControlTest\staging` |
| 5 | Run | `ssh test@172.31.0.10 "powershell -File C:\AgentControlTest\staging\runner-vm.ps1"` |
| 6 | Collect | `scp test@172.31.0.10:...\output\{result.json,pair-flow.json,screenshots} → ./output` |
| 7 | Teardown | `Stop-VM -Name AgentControl-Test -TurnOff` (state discarded — step 1 reverts next run) |

`runner-vm.ps1` = the **guest-side driver**, invoked over SSH instead of as a
Sandbox LogonCommand. It calls the reused step functions (§4). Because it runs in
the auto-logged-in user's context via OpenSSH, WSL `--user` systemd is available
(unlike the Sandbox's `WDAGUtilityAccount` quirk).

Reuse `collect_result()`'s poll-for-`result.json` + `grep '"pass": true'` logic
and per-run exit code verbatim from `host-orchestrator.sh`.

---

## 4. Reuse from Phase 66d

| 66d artifact | 66h reuse | Change |
|---|---|---|
| `sandbox-runner-wsl.ps1` step functions (`Step-InstallKernel` … `Step-VerifyPairFlow`) | ✅ Lift into `runner-vm.ps1` | Invoked over SSH, not LogonCommand; **drop** `Stop-Computer` (orchestrator does `Stop-VM`) |
| `helpers.psm1` (`Save-Screenshot`, `Write-Result`, `Set-OutputRoot`) | ✅ As-is | Staged over scp |
| `verify-pair-flow.mjs` | ✅ **As-is, no dupe** | Runs in guest WSL Ubuntu; §5 |
| `pair-verify.env` (gitignored service_role) | ✅ As-is | scp'd RO into guest staging; absent → step records `skip` |
| Test user + org (migration 0150, PR #86) | ✅ As-is | Same seeded user the verifier mints magic-links for |
| `host-orchestrator.sh` flow/collect contract | ✅ Pattern | Snapshot/SSH replaces `.wsb` launch |

The path substitution differs: 66d used the Sandbox mapped-folder
`/mnt/c/Users/WDAGUtilityAccount/Desktop/staging`; 66h uses a fixed guest path
`C:\AgentControlTest\staging` (WSL sees `/mnt/c/AgentControlTest/staging`).

---

## 5. Integration with `verify-pair-flow.mjs` (no duplication)

`verify-pair-flow.mjs` is zero-dep (Node ≥20 built-ins). `runner-vm.ps1`'s
`Step-VerifyPairFlow` calls it inside guest WSL exactly as 66d does — only the
mount path changes:

```
export PAIR_VERIFY_ENV='/mnt/c/AgentControlTest/staging/pair-verify.env'
node '/mnt/c/AgentControlTest/staging/verify-pair-flow.mjs'
```

It greps the `PAIRFLOW_JSON {...}` line, persists `pair-flow.json`, asserts the
magic-link landed on `/pair-bridge/` with `claim_code` intact. Single source of
truth — the file is scp'd from `scripts/e2e-pair-verify/`, never copied into the
hyperv-test tree.

---

## 6. Migration plan — sub-PRs

4 sub-PRs, mostly linear (66h.2 depends on 66h.1's VM existing; 66h.3 folds into
.2; .4 documents). All docs/scripts — no product-code change.

| PR | Deliverable | Depends on |
|---|---|---|
| **66h.1** | `Build-BaseImage.ps1` + `AutoUnattend.xml` + one-time-setup doc | — (this BLUEPRINT) |
| **66h.2** | `hyperv-test-orchestrator.sh` + `runner-vm.ps1` (lifts 66d steps) | 66h.1 |
| **66h.3** | Wire `verify-pair-flow.mjs` reuse + `pair-verify.env.example` + guest-path fixups | 66h.2 |
| **66h.4** | `PHASE-66H-SUMMARY.md` + runbook (build-once, run-many) | 66h.1–.3 |

---

## 7. Risks + unknowns

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Win11 licensing for CI** — eval ISO is 90-day; re-arm or rebuild needed. Long-term CI wants a real license/key. | Rebuild base quarterly from fresh eval ISO, **or** user supplies a licensed key in AutoUnattend |
| 2 | **SSH-into-Windows auth** — password is brittle/insecure. | **Key-based**: bake host pubkey into `administrators_authorized_keys` during base build (§2.2f) |
| 3 | **Snapshot revert semantics** — standard checkpoints reset disk *and* memory; differencing-disk bloat over time. | Use **Standard** checkpoint (not Production/VSS) for exact state; `Stop-VM -TurnOff` each run so no runtime state accrues; periodically merge/rebuild |
| 4 | **Nested-virt prerequisites** — needs Intel VT-x/AMD-V exposed, static RAM, VM off to set flag, host build supporting it. | `Build-BaseImage.ps1` asserts `(Get-VMProcessor).ExposeVirtualizationExtensions` + `DynamicMemoryEnabled=$false` before snapshot |
| 5 | **~12 min/run + ~20 GB base VHDX storage** | Acceptable for a nightly/pre-release gate, not per-commit; single reusable base disk |
| 6 | Internal-switch guest IP may drift if not pinned | AutoUnattend sets static `172.31.0.10`; orchestrator asserts reachability before staging |

---

## 8. Success criteria

- [ ] One command from WSL: `./hyperv-test-orchestrator.sh` → `output/result.json` in **< 15 min**
- [ ] **Host WSL session survives** — no `wsl --shutdown`, Claude Code keeps running
- [ ] Reproducible — every run starts from `clean-agentcontrol-base`, byte-identical
- [ ] Integrates with existing `verify-pair-flow.mjs` (reused, not duplicated)
- [ ] Full chain green in guest: WSL2 kernel → Ubuntu-22.04 → bridge install → bridge live → pair-flow verified

---

## 9. What the user must provide

| Item | Needed? | Why |
|---|---|---|
| **Windows 11 Enterprise eval ISO** | ✅ Yes (one-time download) | No ready-made VHDX exists; base build consumes the ISO |
| Windows 11 **license key** | ⚠️ Optional | Only if avoiding the 90-day eval re-arm/rebuild cadence |
| Pre-built base VHDX | ❌ No | `Build-BaseImage.ps1` produces it from the ISO |
| SSH keypair | ❌ No (auto-generated) | Base build bakes in the host pubkey |
| `pair-verify.env` (service_role) | ⚠️ Optional | Present → pair-flow step runs; absent → recorded `skip` (same as 66d) |

## Sources

- [Enable nested virtualization (Hyper-V)](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization)
- [Windows dev VM images discontinued](https://learn.microsoft.com/en-us/answers/questions/2259075/windows-developer-vm-or-images-where-are-they-now)
- [Windows 11 Enterprise evaluation](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise)
- [Convert-WindowsImage + VM tools](https://deepwiki.com/MicrosoftDocs/Virtualization-Documentation/5.4-convert-windowsimage-and-vm-tools)
- [AutoUnattend.xml for Windows 11](https://www.deploymentresearch.com/back-to-basics-using-an-autounattend-xml-file-to-automate-windows-11-setup-from-media/)
</content>
</invoke>
