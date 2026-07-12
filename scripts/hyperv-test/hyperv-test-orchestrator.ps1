<#
.SYNOPSIS
  Host-side driver for the Hyper-V VM test harness, over PowerShell Direct
  (VMBus) instead of SSH. Reverts agentcontrol-test-vm to its golden snapshot,
  boots it, stages the installer + PowerShell harness into the guest over a PS
  Direct session, runs runner-vm.ps1 inside the guest, copies output\result.json
  + screenshots back, then powers the VM off.

  PowerShell Direct execs over the VMBus, so it needs no guest network, no
  OpenSSH server, no firewall rule for port 22, and no WSL2->guest routing. That
  removes the five failure modes the SSH path carried and lets this harness run
  on any Windows host with Hyper-V and a Windows guest. (WSL2 cannot reach a
  Hyper-V guest over the Default Switch at all - vSwitch isolation, WSL issues
  #4288/#11494 - which is what made the SSH path unreliable in the first place.)

  Replaces the SSH-based body of hyperv-test-orchestrator.sh (now a thin WSL
  wrapper that shells out to this script). Same flags and stages as before.

  -Flow tray   installer download + install-dir verify + tray launch
  -Flow wsl    full WSL2 + Ubuntu + bridge install + verify-pair-flow (default)
  -Flow full   tray then wsl

.NOTES
  Run from an ELEVATED PowerShell on the Hyper-V host (PS Direct + the Hyper-V
  cmdlets both require admin). Assumes Import-DevVM.ps1 has already produced the
  VM + clean-agentcontrol-base snapshot.

  # @line-limit-exception: single linear stage->run->collect harness; splitting
  # the step helpers across files would hurt readability of the boot sequence.
#>
[CmdletBinding()]
param(
  [ValidateSet('tray', 'wsl', 'full')][string]$Flow = 'wsl',
  [string]$Local = '',
  [string]$VmName = 'agentcontrol-test-vm',
  [string]$SnapshotName = 'clean-agentcontrol-base',
  [string]$OutputRoot = '',
  [string]$UbuntuRootfsPath = 'C:\Hyper-V\AgentControlTest\ubuntu-jammy-wsl.rootfs.tar.gz',
  [switch]$KeepVmRunning
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is empty when param defaults are evaluated under `powershell.exe
# -File`, so resolve the script dir in the body and fill any path defaults here.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($OutputRoot)) { $OutputRoot = Join-Path $scriptDir 'output' }

# --- config ------------------------------------------------------------------
$SetupUrl   = 'https://install.agent-control.io/setup.exe'
$VmUser     = 'User'
$StageWin   = 'C:\AgentControlTest\staging'
$OutputWin  = 'C:\test-output'
$StageLocal = Join-Path $scriptDir '.stage'

function Log  { param([string]$Msg) Write-Host "[hyperv] $Msg" }
function Fail { param([string]$Msg) [Console]::Error.WriteLine("[hyperv] FAIL: $Msg"); exit 1 }

# --- VM lifecycle ------------------------------------------------------------
function Restore-Snapshot {
  Log "reverting $VmName -> snapshot $SnapshotName"
  try { Restore-VMSnapshot -VMName $VmName -Name $SnapshotName -Confirm:$false }
  catch { Fail "Restore-VMSnapshot failed (VM/snapshot missing? run Import-DevVM.ps1 first): $($_.Exception.Message)" }
}

function Start-Guest {
  Log "starting $VmName"
  # Start-VM is a no-op if the revert already left it running; ignore that.
  Start-VM -Name $VmName -ErrorAction SilentlyContinue | Out-Null
}

# Blank-password 'User' is the WinDev image default; Passw0rd! is the documented
# fallback if Microsoft rotated it (mirrors Import-DevVM.ps1).
function New-GuestCredential {
  param([string]$Password = '')
  $sec = New-Object System.Security.SecureString
  foreach ($ch in $Password.ToCharArray()) { $sec.AppendChar($ch) }
  return New-Object System.Management.Automation.PSCredential($VmUser, $sec)
}

# Open a PS Direct (VMBus) session, retrying while the guest finishes booting.
# Replaces discover_ip + wait_ssh: no IP discovery, no port 22, no network.
function Wait-GuestSession {
  param([int]$TimeoutSec = 180)
  Log "waiting for PowerShell Direct session (up to ${TimeoutSec}s)"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    foreach ($pw in @('', 'Passw0rd!')) {
      try {
        $s = New-PSSession -VMName $VmName -Credential (New-GuestCredential $pw) -ErrorAction Stop
        Log 'PS Direct session established'
        return $s
      } catch { Start-Sleep -Seconds 5 }
    }
  } while ((Get-Date) -lt $deadline)
  Fail "no PS Direct session to $VmName within ${TimeoutSec}s (guest booted? Import-DevVM.ps1 run?)"
}

# --- staging -----------------------------------------------------------------
function Get-SetupExe {
  param([string]$Dst)
  if ($Local) {
    if (-not (Test-Path -LiteralPath $Local)) { Fail "no such file: $Local" }
    Log "using local installer: $Local"
    Copy-Item -LiteralPath $Local -Destination $Dst -Force
  } else {
    Log "downloading $SetupUrl"
    Invoke-WebRequest -Uri $SetupUrl -OutFile $Dst -UseBasicParsing
  }
}

# Build a local .stage dir with exactly what this flow needs, then copy it into
# the guest over the PS Direct session via Copy-Item -ToSession (no scp/network).
function Copy-Inputs {
  param([System.Management.Automation.Runspaces.PSSession]$Session)
  if (Test-Path $StageLocal) { Remove-Item -Recurse -Force $StageLocal }
  New-Item -ItemType Directory -Force -Path $StageLocal | Out-Null
  Copy-Item (Join-Path $scriptDir 'runner-vm.ps1')   (Join-Path $StageLocal 'runner-vm.ps1')
  Copy-Item (Join-Path $scriptDir 'helpers-vm.psm1') (Join-Path $StageLocal 'helpers-vm.psm1')
  if ($Flow -in 'wsl', 'full') {
    # verify-pair-flow.mjs is the single source of truth in e2e-pair-verify - copy
    # it into staging at run time, never duplicate it into the hyperv-test tree.
    Copy-Item (Join-Path $scriptDir '..\e2e-pair-verify\verify-pair-flow.mjs') (Join-Path $StageLocal 'verify-pair-flow.mjs')
    # service_role key: gitignored host file; present -> pair-flow runs, else skip.
    $envHost = Join-Path $scriptDir 'pair-verify.env'
    if (Test-Path $envHost) {
      Log 'staging pair-verify.env (service_role, RO)'
      Copy-Item $envHost (Join-Path $StageLocal 'pair-verify.env')
    } else {
      Log 'no pair-verify.env - verify-pair-flow will record skip in-guest'
    }
  }
  if ($Flow -in 'tray', 'full') { Get-SetupExe (Join-Path $StageLocal 'setup.exe') }

  Log "copying staging -> guest $StageWin (Copy-Item -ToSession)"
  Invoke-Command -Session $Session -ScriptBlock {
    param($Stage, $Out)
    New-Item -ItemType Directory -Force -Path $Stage, $Out | Out-Null
  } -ArgumentList $StageWin, $OutputWin
  foreach ($f in Get-ChildItem -File $StageLocal) {
    Copy-Item -ToSession $Session -Path $f.FullName -Destination (Join-Path $StageWin $f.Name) -Force
  }

  # Ubuntu rootfs for the wsl flow. Copied straight to the session (not via
  # .stage) since it is large. runner-vm.ps1's Step-ImportDistro re-imports it
  # under the interactive User's HKCU: Import-DevVM.ps1 registered the distro
  # under a network-logon HKCU (a transient hive), so the registration never
  # reaches the interactive session AutoLogon starts. Absent -> warn and let the
  # runner decide (it passes only if the distro is already registered in-session).
  if ($Flow -in 'wsl', 'full') {
    if (Test-Path -LiteralPath $UbuntuRootfsPath) {
      Log "staging Ubuntu rootfs -> guest (Copy-Item -ToSession): $UbuntuRootfsPath"
      Copy-Item -ToSession $Session -Path $UbuntuRootfsPath -Destination (Join-Path $StageWin 'ubuntu-jammy-wsl.rootfs.tar.gz') -Force
    } else {
      Log "WARNING: Ubuntu rootfs not found at $UbuntuRootfsPath - Step-ImportDistro will fail unless the distro is already registered in the guest's interactive session"
    }
  }
}

# --- run + collect -----------------------------------------------------------
function Invoke-Guest {
  param([System.Management.Automation.Runspaces.PSSession]$Session)
  Log "running runner-vm.ps1 (flow=$Flow) in guest"
  # Run in a child powershell so its own exit code / policy never disturbs the
  # session; a non-zero exit is fine - the runner still writes result.json and
  # we grade that (native-exe exit codes do not throw in Invoke-Command).
  Invoke-Command -Session $Session -ScriptBlock {
    param($Stage, $Out, $FlowArg)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
      -File (Join-Path $Stage 'runner-vm.ps1') -Flow $FlowArg -StagingRoot $Stage -OutputRoot $Out
    if ($LASTEXITCODE -ne 0) { Write-Host "[hyperv] runner-vm.ps1 exit $LASTEXITCODE (grading result.json anyway)" }
  } -ArgumentList $StageWin, $OutputWin, $Flow
}

function Get-Result {
  param([System.Management.Automation.Runspaces.PSSession]$Session)
  if (Test-Path $OutputRoot) { Remove-Item -Recurse -Force $OutputRoot }
  New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
  Log "collecting $OutputWin -> $OutputRoot (Copy-Item -FromSession)"
  try {
    Copy-Item -FromSession $Session -Path (Join-Path $OutputWin '*') -Destination $OutputRoot -Recurse -Force
  } catch {}
  $result = Join-Path $OutputRoot 'result.json'
  if (-not (Test-Path $result)) { Fail 'no result.json collected from guest' }
  $json = Get-Content -LiteralPath $result -Raw
  Write-Host '[hyperv] result.json:'; Write-Host $json
  $pass = $false
  try { $pass = [bool]((ConvertFrom-Json $json).pass) } catch {}
  if ($pass) {
    Log "PASS ($Flow) - screenshots in $OutputRoot\screenshots"
    return $true
  }
  [Console]::Error.WriteLine("[hyperv] FAIL ($Flow) - see $OutputRoot\result.json + screenshots")
  return $false
}

function Stop-Guest {
  if ($KeepVmRunning) { Log "leaving $VmName running (-KeepVmRunning)"; return }
  Log "powering off $VmName (next run reverts the snapshot anyway)"
  Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue | Out-Null
}

# --- dispatch ----------------------------------------------------------------
$rc = 0
Restore-Snapshot
Start-Guest
$session = Wait-GuestSession
Copy-Inputs -Session $session
Invoke-Guest -Session $session
if (-not (Get-Result -Session $session)) { $rc = 1 }
Remove-PSSession $session -ErrorAction SilentlyContinue
Stop-Guest
exit $rc
