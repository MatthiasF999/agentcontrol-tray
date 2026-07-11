<#
.SYNOPSIS
  Runs INSIDE Windows Sandbox as the LogonCommand for the WSL-inclusive test.
  Drives the FULL bootstrapper flow — WSL2 kernel, Ubuntu-22.04, and the wsl.sh
  bridge installer — screenshots every phase, and writes output/result.json.

  Distinct from sandbox-runner.ps1 (which only covers the Windows-side installer
  + tray). This one needs nested virtualization (see test-wsl.wsb
  ProtectedClient=Disable); when that is unavailable the run records step
  'nested_virt_unsupported', dumps diagnostics, and reports pass=false.

.NOTES
  # @line-limit-exception: single self-driving harness script; splitting the
  # step functions across modules would hurt readability of the linear flow.
#>
[CmdletBinding()]
param(
  # Desktop mapped-folder root; staging + output live side by side under it.
  [string]$DesktopRoot = (Join-Path $env:USERPROFILE 'Desktop')
)

$ErrorActionPreference = 'Stop'
$staging   = Join-Path $DesktopRoot 'staging'
$outputDir = Join-Path $DesktopRoot 'output'
Import-Module (Join-Path $staging 'helpers.psm1') -Force
Set-OutputRoot $outputDir | Out-Null

# wsl.exe emits UTF-16LE by default; WSL_UTF8 switches it to UTF-8 so captured
# stdout parses cleanly (mirrors the decode() in src-tauri/src/commands/wsl.rs).
$env:WSL_UTF8 = '1'

# ---- config -----------------------------------------------------------------
$Distro                 = 'Ubuntu-22.04'
$WslShUrl               = 'https://install.agent-control.io/wsl.sh'
$BridgeUnit             = 'agentcontrol-bridge'
$KernelReadyTimeoutSec  = 300
$DistroReadyTimeoutSec  = 300
# 24H2 == build 26100; ProtectedClient=Disable only unlocks nested virt there.
$MinBuildForNestedVirt  = 26100
# Substrings in wsl.exe output that mean the host can't nest a hypervisor.
$NestedVirtSignatures = @(
  '0x80370102', 'Virtual Machine Platform', 'virtualization',
  'nested', 'hypervisor', 'HCS_E_HYPERV_NOT_INSTALLED', 'not been enabled'
)

$result = [ordered]@{
  pass                = $false
  distro              = $Distro
  windowsBuild        = $null
  nestedVirtSupported = $true
  diagnostics         = $null
  steps               = @()
  errors              = @()
  startedUtc          = (Get-Date).ToUniversalTime().ToString('o')
}

# ---- small helpers ----------------------------------------------------------
function Add-Step {
  param([string]$Name, [string]$Status, [string]$Detail = '', [string]$Shot = '')
  $result.steps += [ordered]@{
    name = $Name; status = $Status; detail = $Detail; screenshot = $Shot
    atUtc = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Invoke-Wsl {
  <# Run wsl.exe with $WslArgs; capture merged stdout/stderr + exit code. #>
  param([Parameter(Mandatory)][string[]]$WslArgs)
  $text = (& wsl.exe @WslArgs 2>&1 | Out-String)
  return [pscustomobject]@{ Code = $LASTEXITCODE; Text = $text }
}

function Test-NestedVirt {
  param([string]$Text)
  foreach ($sig in $NestedVirtSignatures) {
    if ($Text -match [regex]::Escape($sig)) { return $true }
  }
  return $false
}

function Wait-For {
  param([int]$TimeoutSec, [Parameter(Mandatory)][scriptblock]$Test)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (& $Test) { return $true }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Get-NestedVirtInfo {
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $vmp = $null
  try {
    $vmp = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction Stop).State
  } catch { $vmp = "query-failed: $($_.Exception.Message)" }
  [pscustomobject]@{
    VirtualizationFirmwareEnabled = $cpu.VirtualizationFirmwareEnabled
    HypervisorPresent             = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
    VirtualMachinePlatform        = $vmp
  }
}

function Get-WslEvents {
  try {
    Get-WinEvent -LogName System -MaxEvents 60 -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -match 'Hyper-V|Wsl|Lxss|Vmcompute' } |
      Select-Object -First 15 TimeCreated, Id, LevelDisplayName, ProviderName, Message
  } catch { "event query failed: $($_.Exception.Message)" }
}

function Write-Diagnostics {
  <# Dump WSL + host + nested-virt state so a failed run explains itself. #>
  $dump  = Join-Path $outputDir 'diagnostics.txt'
  $parts = @(
    '=== wsl --status ===',        (Invoke-Wsl @('--status')).Text,
    '=== wsl --version ===',       (Invoke-Wsl @('--version')).Text,
    '=== wsl --list --verbose ===', (Invoke-Wsl @('--list','--verbose')).Text,
    '=== Windows ===',             ((Get-CimInstance Win32_OperatingSystem) |
                                     Select-Object Caption, Version, BuildNumber | Out-String),
    '=== Nested virt / Hyper-V ===', (Get-NestedVirtInfo | Out-String),
    '=== Recent Hyper-V/WSL events ===', (Get-WslEvents | Out-String)
  )
  [System.IO.File]::WriteAllText($dump, ($parts -join "`r`n"),
    (New-Object System.Text.UTF8Encoding($false)))
  $result.diagnostics = $dump
}

function Stop-NestedVirt {
  <# Record the nested-virt failure, dump diagnostics, abort the run. #>
  param([string]$Detail)
  $result.nestedVirtSupported = $false
  Add-Step 'nested_virt_unsupported' 'fail' $Detail (Save-Screenshot 'nested-virt-fail')
  Write-Diagnostics
  throw "nested_virt_unsupported: $Detail"
}

# ---- steps ------------------------------------------------------------------
function Step-VerifyHost {
  $build = 0
  try {
    $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
  } catch {}
  $result.windowsBuild = $build
  $caption = (Get-CimInstance Win32_OperatingSystem).Caption
  $shot = Save-Screenshot 'host-info'
  if ($build -lt $MinBuildForNestedVirt) {
    Add-Step 'verify-host' 'warn' "$caption build $build < $MinBuildForNestedVirt (24H2); nested virt likely unavailable" $shot
  } else {
    Add-Step 'verify-host' 'pass' "$caption build $build" $shot
  }
}

function Step-InstallKernel {
  $r = Invoke-Wsl @('--install', '--no-distribution', '--no-launch')
  $shot = Save-Screenshot 'kernel-install'
  if ($r.Code -ne 0) {
    if (Test-NestedVirt $r.Text) { Stop-NestedVirt "wsl --install: $($r.Text.Trim())" }
    throw "wsl --install --no-distribution failed ($($r.Code)): $($r.Text.Trim())"
  }
  Add-Step 'install-kernel' 'pass' 'wsl --install --no-distribution --no-launch' $shot
}

function Step-WaitKernel {
  $ok = Wait-For $KernelReadyTimeoutSec {
    $s = Invoke-Wsl @('--status')
    $s.Code -eq 0 -and $s.Text -match 'Default Version' -and $s.Text -notmatch 'kernel file is not found|--update'
  }
  $shot = Save-Screenshot 'kernel-ready'
  if (-not $ok) {
    $last = (Invoke-Wsl @('--status')).Text
    if (Test-NestedVirt $last) { Stop-NestedVirt "kernel never ready: $($last.Trim())" }
    throw "WSL kernel not ready within ${KernelReadyTimeoutSec}s"
  }
  Add-Step 'wait-kernel' 'pass' 'wsl --status reports kernel installed' $shot
}

function Step-InstallDistro {
  $r = Invoke-Wsl @('--install', '-d', $Distro, '--no-launch')
  $shot = Save-Screenshot 'distro-install'
  if ($r.Code -ne 0) {
    if (Test-NestedVirt $r.Text) { Stop-NestedVirt "distro install: $($r.Text.Trim())" }
    throw "wsl --install -d $Distro failed ($($r.Code)): $($r.Text.Trim())"
  }
  Add-Step 'install-distro' 'pass' "wsl --install -d $Distro --no-launch" $shot
}

function Step-WaitDistro {
  $ok = Wait-For $DistroReadyTimeoutSec {
    $l = Invoke-Wsl @('--list', '--quiet')
    $l.Code -eq 0 -and (($l.Text -split "\r?\n" | ForEach-Object { $_.Trim() }) -contains $Distro)
  }
  $shot = Save-Screenshot 'distro-ready'
  if (-not $ok) { throw "$Distro not registered within ${DistroReadyTimeoutSec}s" }
  Add-Step 'wait-distro' 'pass' "$Distro present in wsl --list --quiet" $shot
}

function Step-InstallBridge {
  # -u root bypasses the first-run NewUserPrompt; no default UNIX user exists yet.
  $cmd = "curl -sSL $WslShUrl | bash"
  $r = Invoke-Wsl @('-d', $Distro, '-u', 'root', '-e', 'bash', '-lc', $cmd)
  $shot = Save-Screenshot 'bridge-install'
  if ($r.Code -ne 0) {
    throw "wsl.sh bridge install failed ($($r.Code)): $($r.Text.Trim())"
  }
  Add-Step 'install-bridge' 'pass' "curl $WslShUrl | bash (root)" $shot
}

function Step-VerifyBridge {
  $st = Invoke-Wsl @('-d', $Distro, '-e', 'systemctl', '--user', 'status', $BridgeUnit)
  $shot = Save-Screenshot 'bridge-status'
  if ($st.Text -match 'active \(running\)') {
    Add-Step 'verify-bridge' 'pass' 'systemctl --user: active (running)' $shot
    return
  }
  # user-systemd may be unusable without a created default user; a live process
  # is still proof the installer started the bridge.
  $pg = Invoke-Wsl @('-d', $Distro, '-u', 'root', '-e', 'bash', '-lc', 'pgrep -af agentcontrol-bridge')
  if ($pg.Code -eq 0 -and $pg.Text.Trim()) {
    Add-Step 'verify-bridge' 'warn' "no --user unit, but process live: $($pg.Text.Trim())" $shot
    return
  }
  throw "agentcontrol-bridge not active: $($st.Text.Trim())"
}

# ---- run --------------------------------------------------------------------
try {
  Step-VerifyHost
  Step-InstallKernel
  Step-WaitKernel
  Step-InstallDistro
  Step-WaitDistro
  Step-InstallBridge
  Step-VerifyBridge
  $result.pass = $true
} catch {
  $result.errors += $_.Exception.Message
  try { Add-Step 'error' 'fail' $_.Exception.Message (Save-Screenshot 'error') } catch {}
  try { if (-not $result.diagnostics) { Write-Diagnostics } } catch {}
}

$result.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
Save-Screenshot 'final' | Out-Null
Write-Result -Result $result | Out-Null

# Signal the host the run is complete, then shut the sandbox down so the
# host-side Start-Process -Wait returns.
Start-Sleep -Seconds 2
Stop-Computer -Force
