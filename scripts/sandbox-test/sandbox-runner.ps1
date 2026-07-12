<#
.SYNOPSIS
  Runs INSIDE Windows Sandbox as the LogonCommand. Drives the AgentControl
  installer, screenshots every step, verifies the install artifacts + tray
  launch, and writes output/result.json for the host to read back.

  Two installer shapes are handled by the same loop:
   * the public bootstrapper setup.exe  — frameless, self-driving, then runs
     the real Tauri NSIS installer with /S (silent). No standard wizard.
   * a real agentcontrol-tray_<ver>_x64-setup.exe — a standard NSIS/MUI
     wizard with Next / Install / Finish (English by default; the button
     candidates below also cover a German build).
  So the loop is artifact-driven: it clicks any advance button it can find,
  but success is decided by the install dir + tray exe appearing, not by
  reaching a "Finish" page.
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

# ---- config -----------------------------------------------------------------
$SetupExe    = Join-Path $staging 'setup.exe'
$TrayExeName = 'agentcontrol-tray.exe'
$InstallDirs = @(
  (Join-Path $env:LOCALAPPDATA 'agentcontrol-tray'),        # currentUser
  (Join-Path ${env:ProgramFiles} 'agentcontrol-tray'),       # perMachine x64
  (Join-Path ${env:ProgramFiles(x86)} 'agentcontrol-tray')
)
# Advance-button labels across locales; '&' + spaces are stripped when matched.
$NextNames    = @('Next', 'Weiter', '&Next', '&Weiter')
$InstallNames = @('Install', 'Installieren', '&Install', '&Installieren')
$FinishNames  = @('Finish', 'Fertig stellen', 'Fertigstellen', 'Close', 'Schließen')
$WindowNames  = @('AgentControl', 'agentcontrol-tray', 'Setup')

$result = [ordered]@{
  pass       = $false
  installDir = $null
  steps      = @()
  errors     = @()
  startedUtc = (Get-Date).ToUniversalTime().ToString('o')
}

function Add-Step {
  param([string]$Name, [string]$Status, [string]$Detail = '', [string]$Shot = '')
  $result.steps += [ordered]@{
    name = $Name; status = $Status; detail = $Detail; screenshot = $Shot
    atUtc = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Get-InstalledDir {
  foreach ($d in $InstallDirs) {
    if ($d -and (Test-Path (Join-Path $d $TrayExeName))) { return $d }
  }
  return $null
}

function Step-VerifySetup {
  if (-not (Test-Path $SetupExe)) { throw "setup.exe not found at $SetupExe" }
  $shot = Save-Screenshot 'pre-launch'
  Add-Step 'verify-setup-present' 'pass' "found $SetupExe" $shot
}

function Step-Launch {
  Start-Process -FilePath $SetupExe -PassThru | Out-Null
  Start-Sleep -Seconds 3
  $shot = Save-Screenshot 'launched'
  Add-Step 'launch-installer' 'pass' 'setup.exe started' $shot
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
  # POSTINSTALL hook may already have launched it; start again is harmless.
  if (-not (Get-Process -Name 'agentcontrol-tray' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $exe | Out-Null
  }
  Start-Sleep -Seconds 5
  $proc = Get-Process -Name 'agentcontrol-tray' -ErrorAction SilentlyContinue
  if (-not $proc) { throw "tray process not running after launch of $exe" }
  Add-Step 'launch-tray' 'pass' "pid $($proc.Id)" (Save-Screenshot 'tray-running')
}

# ---- run --------------------------------------------------------------------
try {
  Step-VerifySetup
  Step-Launch
  Step-DriveWizard
  $dir = Step-WaitInstalled
  Step-LaunchTray -Dir $dir
  $result.pass = $true
} catch {
  $result.errors += $_.Exception.Message
  try { Add-Step 'error' 'fail' $_.Exception.Message (Save-Screenshot 'error') } catch {}
}

$result.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
Save-Screenshot 'final' | Out-Null
Write-Result -Result $result | Out-Null

# Signal the host the run is complete, then shut the sandbox down so the
# host-side Start-Process -Wait returns.
Start-Sleep -Seconds 2
Stop-Computer -Force
