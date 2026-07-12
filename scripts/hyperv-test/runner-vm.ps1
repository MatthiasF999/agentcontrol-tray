<#
.SYNOPSIS
  Runs INSIDE the AgentControl-Test Hyper-V VM, invoked over SSH by
  hyperv-test-orchestrator.sh. Drives the installer / WSL bootstrapper flow,
  screenshots each phase, and writes <OutputRoot>\result.json for the
  orchestrator to scp back.

  Analog of 66d's sandbox-runner-wsl.ps1 + sandbox-runner.ps1, merged and
  adapted for a real VM: launched via SSH (not a Sandbox LogonCommand), so it
  does NOT Stop-Computer — the orchestrator does Stop-VM after collecting
  output. Nested virt is baked into the base image and asserted by the base
  builder (Import-DevVM.ps1), so this drops 66d's nested-virt detection apparatus.

  -Flow tray  installer run + install-dir verify + tray launch
  -Flow wsl   WSL2 kernel + Ubuntu-22.04 + wsl.sh bridge + verify-pair-flow
  -Flow full  tray then wsl

.NOTES
  # @line-limit-exception: single self-driving harness merging the tray and
  # wsl step sets; splitting the linear flow across modules would hurt
  # readability. Shared helpers already live in helpers-vm.psm1.
#>
[CmdletBinding()]
param(
  [ValidateSet('tray', 'wsl', 'full')][string]$Flow = 'wsl',
  [string]$StagingRoot = 'C:\AgentControlTest\staging',
  [string]$OutputRoot  = 'C:\test-output'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $StagingRoot 'helpers-vm.psm1') -Force
Set-OutputRoot $OutputRoot | Out-Null
# wsl.exe emits UTF-16LE by default; WSL_UTF8 switches it to UTF-8 so captured
# stdout parses cleanly (mirrors the decode() in src-tauri/src/commands/wsl.rs).
$env:WSL_UTF8 = '1'

# ---- config -----------------------------------------------------------------
$Distro                = 'Ubuntu-22.04'
$WslShUrl              = 'https://install.agent-control.io/wsl.sh'
$BridgeUnit            = 'agentcontrol-bridge'
$KernelReadyTimeoutSec = 300
$DistroReadyTimeoutSec = 300
$SetupExe              = Join-Path $StagingRoot 'setup.exe'
$TrayExeName           = 'agentcontrol-tray.exe'
$InstallDirs = @(
  (Join-Path $env:LOCALAPPDATA 'agentcontrol-tray'),
  (Join-Path ${env:ProgramFiles} 'agentcontrol-tray'),
  (Join-Path ${env:ProgramFiles(x86)} 'agentcontrol-tray')
)
# Advance-button labels across locales; '&' + spaces are stripped when matched.
$NextNames    = @('Next', 'Weiter', '&Next', '&Weiter')
$InstallNames = @('Install', 'Installieren', '&Install', '&Installieren')
$FinishNames  = @('Finish', 'Fertig stellen', 'Fertigstellen', 'Close', 'Schließen')
$WindowNames  = @('AgentControl', 'agentcontrol-tray', 'Setup')
# staging as guest WSL sees it (C:\AgentControlTest -> /mnt/c/AgentControlTest).
$StagingWsl   = '/mnt/c/' + ($StagingRoot -replace '^[A-Za-z]:\\', '' -replace '\\', '/')

$result = [ordered]@{
  pass         = $false
  flow         = $Flow
  distro       = $Distro
  installDir   = $null
  windowsBuild = $null
  diagnostics  = $null
  steps        = @()
  errors       = @()
  startedUtc   = (Get-Date).ToUniversalTime().ToString('o')
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

function Wait-For {
  param([int]$TimeoutSec, [Parameter(Mandatory)][scriptblock]$Test)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (& $Test) { return $true }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Write-Diagnostics {
  $dump  = Join-Path $OutputRoot 'diagnostics.txt'
  $parts = @(
    '=== wsl --status ===',         (Invoke-Wsl @('--status')).Text,
    '=== wsl --version ===',        (Invoke-Wsl @('--version')).Text,
    '=== wsl --list --verbose ===', (Invoke-Wsl @('--list', '--verbose')).Text,
    '=== Windows ===',              ((Get-CimInstance Win32_OperatingSystem) |
                                      Select-Object Caption, Version, BuildNumber | Out-String)
  )
  [System.IO.File]::WriteAllText($dump, ($parts -join "`r`n"),
    (New-Object System.Text.UTF8Encoding($false)))
  $result.diagnostics = $dump
}

# ---- tray-flow steps (lifted from 66d sandbox-runner.ps1) -------------------
function Get-InstalledDir {
  foreach ($d in $InstallDirs) {
    if ($d -and (Test-Path (Join-Path $d $TrayExeName))) { return $d }
  }
  return $null
}

function Step-VerifySetup {
  if (-not (Test-Path $SetupExe)) { throw "setup.exe not found at $SetupExe" }
  Add-Step 'verify-setup-present' 'pass' "found $SetupExe" (Save-Screenshot 'pre-launch')
}

function Step-Launch {
  Start-Process -FilePath $SetupExe -PassThru | Out-Null
  Start-Sleep -Seconds 3
  Add-Step 'launch-installer' 'pass' 'setup.exe started' (Save-Screenshot 'launched')
}

function Step-DriveWizard {
  # Locale-agnostic best-effort walk. Never fatal: the bootstrapper self-drives
  # and silent installers expose no buttons, so a miss is fine — artifacts decide.
  $win = Find-Window -NameLike $WindowNames -TimeoutSec 30
  if (-not $win) { Add-Step 'find-window' 'skip' 'no wizard window (self-driving/silent)'; return }
  Add-Step 'find-window' 'pass' $win.Current.Name (Save-Screenshot 'window')
  foreach ($stage in @(
      @{ n = 'next';    names = $NextNames },
      @{ n = 'install'; names = $InstallNames },
      @{ n = 'finish';  names = $FinishNames })) {
    $btn = Find-Button -Window $win -Names $stage.names -TimeoutSec 20
    if ($btn) {
      $ok = Invoke-Button $btn
      Add-Step ("click-" + $stage.n) ($(if ($ok) { 'pass' } else { 'fail' })) $btn.Current.Name (Save-Screenshot $stage.n)
      Start-Sleep -Seconds 2
    } else {
      Add-Step ("click-" + $stage.n) 'skip' 'button not present'
    }
  }
}

function Step-WaitInstalled {
  $deadline = (Get-Date).AddSeconds(180)
  do {
    $dir = Get-InstalledDir
    if ($dir) {
      $result.installDir = $dir
      Add-Step 'verify-install-dir' 'pass' $dir (Save-Screenshot 'installed')
      return $dir
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  throw 'install dir / tray exe never appeared within 180s'
}

function Step-LaunchTray {
  param([string]$Dir)
  $exe = Join-Path $Dir $TrayExeName
  if (-not (Get-Process -Name 'agentcontrol-tray' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $exe | Out-Null
  }
  Start-Sleep -Seconds 5
  $proc = Get-Process -Name 'agentcontrol-tray' -ErrorAction SilentlyContinue
  if (-not $proc) { throw "tray process not running after launch of $exe" }
  Add-Step 'launch-tray' 'pass' "pid $($proc.Id)" (Save-Screenshot 'tray-running')
}

# ---- wsl-flow steps ---------------------------------------------------------
function Step-VerifyHost {
  $build = 0
  try {
    $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
  } catch {}
  $result.windowsBuild = $build
  $caption = (Get-CimInstance Win32_OperatingSystem).Caption
  Add-Step 'verify-host' 'pass' "$caption build $build" (Save-Screenshot 'host-info')
}

function Step-InstallKernel {
  $r = Invoke-Wsl @('--install', '--no-distribution', '--no-launch')
  $shot = Save-Screenshot 'kernel-install'
  if ($r.Code -ne 0) { throw "wsl --install --no-distribution failed ($($r.Code)): $($r.Text.Trim())" }
  Add-Step 'install-kernel' 'pass' 'wsl --install --no-distribution --no-launch' $shot
}

function Step-WaitKernel {
  $ok = Wait-For $KernelReadyTimeoutSec {
    $s = Invoke-Wsl @('--status')
    $s.Code -eq 0 -and $s.Text -match 'Default Version' -and $s.Text -notmatch 'kernel file is not found|--update'
  }
  $shot = Save-Screenshot 'kernel-ready'
  if (-not $ok) { throw "WSL kernel not ready within ${KernelReadyTimeoutSec}s" }
  Add-Step 'wait-kernel' 'pass' 'wsl --status reports kernel installed' $shot
}

function Step-InstallDistro {
  $r = Invoke-Wsl @('--install', '-d', $Distro, '--no-launch')
  $shot = Save-Screenshot 'distro-install'
  if ($r.Code -ne 0) { throw "wsl --install -d $Distro failed ($($r.Code)): $($r.Text.Trim())" }
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
  if ($r.Code -ne 0) { throw "wsl.sh bridge install failed ($($r.Code)): $($r.Text.Trim())" }
  Add-Step 'install-bridge' 'pass' "curl $WslShUrl | bash (root)" $shot
}

function Step-VerifyBridge {
  $st = Invoke-Wsl @('-d', $Distro, '-e', 'systemctl', '--user', 'status', $BridgeUnit)
  $shot = Save-Screenshot 'bridge-status'
  if ($st.Text -match 'active \(running\)') {
    Add-Step 'verify-bridge' 'pass' 'systemctl --user: active (running)' $shot
    return
  }
  $pg = Invoke-Wsl @('-d', $Distro, '-u', 'root', '-e', 'bash', '-lc', 'pgrep -af agentcontrol-bridge')
  if ($pg.Code -eq 0 -and $pg.Text.Trim()) {
    Add-Step 'verify-bridge' 'warn' "no --user unit, but process live: $($pg.Text.Trim())" $shot
    return
  }
  throw "agentcontrol-bridge not active: $($st.Text.Trim())"
}

function Step-VerifyPairFlow {
  # Zero-dep Node guard for the magic-link -> pair-bridge return path, run in
  # guest WSL. service_role key rides in via staged pair-verify.env; else skip.
  $envHost = Join-Path $StagingRoot 'pair-verify.env'
  if (-not (Test-Path $envHost)) {
    Add-Step 'verify-pair-flow' 'skip' 'no staging\pair-verify.env (service_role key) present' (Save-Screenshot 'pairflow-skip')
    return
  }
  $mjsWsl = "$StagingWsl/verify-pair-flow.mjs"
  $envWsl = "$StagingWsl/pair-verify.env"
  $cmd = "export PAIR_VERIFY_ENV='$envWsl'; node '$mjsWsl'"
  $r = Invoke-Wsl @('-d', $Distro, '-u', 'root', '-e', 'bash', '-lc', $cmd)
  $shot = Save-Screenshot 'pairflow'
  # The verifier prints one machine-readable line: PAIRFLOW_JSON {...}. Persist
  # it beside result.json and surface the (redacted) final URL.
  $m = [regex]::Match($r.Text, 'PAIRFLOW_JSON (\{.*\})')
  $finalUrl = ''
  if ($m.Success) {
    [System.IO.File]::WriteAllText((Join-Path $OutputRoot 'pair-flow.json'),
      $m.Groups[1].Value, (New-Object System.Text.UTF8Encoding($false)))
    try { $finalUrl = ($m.Groups[1].Value | ConvertFrom-Json).finalUrl } catch {}
  }
  if ($r.Code -eq 0) {
    Add-Step 'verify-pair-flow' 'pass' "magic-link returned to pair-bridge: $finalUrl" $shot
  } else {
    Add-Step 'verify-pair-flow' 'fail' "pair-flow regression (final URL: $finalUrl): $($r.Text.Trim())" $shot
    throw "verify-pair-flow failed: $finalUrl"
  }
}

function Invoke-TrayFlow {
  Step-VerifySetup; Step-Launch; Step-DriveWizard
  Step-LaunchTray -Dir (Step-WaitInstalled)
}

function Invoke-WslFlow {
  Step-VerifyHost; Step-InstallKernel; Step-WaitKernel
  Step-InstallDistro; Step-WaitDistro
  Step-InstallBridge; Step-VerifyBridge; Step-VerifyPairFlow
}

# ---- run --------------------------------------------------------------------
try {
  if ($Flow -eq 'tray' -or $Flow -eq 'full') { Invoke-TrayFlow }
  if ($Flow -eq 'wsl'  -or $Flow -eq 'full') { Invoke-WslFlow }
  $result.pass = $true
} catch {
  $result.errors += $_.Exception.Message
  try { Add-Step 'error' 'fail' $_.Exception.Message (Save-Screenshot 'error') } catch {}
  try { if (-not $result.diagnostics) { Write-Diagnostics } } catch {}
}

$result.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
Save-Screenshot 'final' | Out-Null
Write-Result -Result $result | Out-Null
# No Stop-Computer — the orchestrator runs Stop-VM after scp'ing output back.
