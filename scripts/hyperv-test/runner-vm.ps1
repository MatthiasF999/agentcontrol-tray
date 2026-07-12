<#
.SYNOPSIS
  Runs INSIDE the agentcontrol-test-vm Hyper-V VM, invoked over SSH by
  hyperv-test-orchestrator.sh. Drives the installer / WSL bootstrapper flow,
  screenshots each phase, and writes <OutputRoot>\result.json for the
  orchestrator to scp back.

  Analog of 66d's sandbox-runner-wsl.ps1 + sandbox-runner.ps1, merged and
  adapted for a real VM: launched via SSH (not a Sandbox LogonCommand), so it
  does NOT Stop-Computer — the orchestrator does Stop-VM after collecting
  output. Nested virt is baked into the base image and asserted by the base
  builder (Import-DevVM.ps1), so this drops 66d's nested-virt detection apparatus.

  -Flow tray  installer run + install-dir verify + tray launch
  -Flow wsl   wsl --update + import Ubuntu-22.04 (staged rootfs) + wsl.sh bridge
              + verify-pair-flow
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

function Repair-WslText {
  # Older wsl.exe ignores WSL_UTF8 and emits UTF-16LE; PowerShell then decodes
  # those bytes with the console codepage, leaving every other byte as U+0000
  # (and a leading FF FE BOM as U+FFFD). Genuine wsl text never contains U+0000,
  # so an embedded null reliably flags mangled UTF-16LE: strip the null padding
  # and BOM artifact to recover the ASCII text. Modern wsl.exe honours WSL_UTF8
  # -> clean UTF-8 -> no nulls -> the string is returned unchanged.
  param([string]$Text)
  if ($Text -and $Text.IndexOf("`0") -ge 0) {
    return $Text.Replace("`0", '').Replace([string][char]0xFFFD, '')
  }
  return $Text
}

function Invoke-Wsl {
  <# Run wsl.exe with $WslArgs; capture merged stdout/stderr + exit code.
     Repairs UTF-16LE output from older wsl.exe that ignores the WSL_UTF8 hint.
     Locally disables ErrorActionPreference='Stop' so wsl.exe stderr writes
     don't terminate before the text is captured/repaired. #>
  param([Parameter(Mandatory)][string[]]$WslArgs)
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& wsl.exe @WslArgs 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEAP
  }
  return [pscustomobject]@{ Code = $code; Text = (Repair-WslText $text) }
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

function Step-UpdateWsl {
  # wsl --update refreshes the inbox wsl.exe to a modern build that understands
  # --no-distribution and honours WSL_UTF8. Silent-succeed when already current.
  # Blocks until the download finishes (30-60s on a stale box); no extra timeout
  # needed since Invoke-Wsl waits on wsl.exe rather than polling.
  # Requires an elevated token; this runner drives PowerShell Direct into the
  # VM's `User` account, whose UAC-filtered token can't launch the WSL platform
  # MSI, so --update fails "requires elevation". We skip in that case -- the
  # inbox wsl.exe already supports `wsl --import`, which Step-ImportDistro uses to
  # re-register the distro without elevation, and a real user's installer elevates
  # via UAC before touching wsl.
  $r = Invoke-Wsl @('--update')
  $shot = Save-Screenshot 'wsl-update'
  if ($r.Code -eq 0 -or $r.Text -match 'already the latest version|already installed') {
    Add-Step 'update-wsl' 'pass' 'wsl --update (or already latest)' $shot
    return
  }
  if ($r.Text -match 'requires elevation|elevation required') {
    Add-Step 'update-wsl' 'skip' 'wsl --update needs elevation; relying on pre-provisioned base' $shot
    return
  }
  throw "wsl --update failed ($($r.Code)): $($r.Text.Trim())"
}

function Step-ImportDistro {
  # WSL registration is per-user: it lives under HKCU\...\CurrentVersion\Lxss.
  # Import-DevVM.ps1 ran `wsl --import` as the `User` account over PS Direct,
  # which is a NETWORK logon -> its HKCU is a transient hive, NOT the interactive
  # User's NTUSER.DAT. So the base-image registration never reaches the session
  # AutoLogon starts, and `wsl --list` here shows "no installed distributions".
  # Fix: re-import the staged rootfs now, inside the interactive session, so the
  # registration lands in the right HKCU. `wsl --import` works on the old inbox
  # wsl.exe (unlike `wsl --install --no-distribution`) and is idempotent per run.
  $l = Invoke-Wsl @('--list', '--quiet')
  if ($l.Code -eq 0 -and (($l.Text -split "\r?\n" | ForEach-Object { $_.Trim() }) -contains $Distro)) {
    Add-Step 'import-distro' 'pass' "$Distro already registered in this session" (Save-Screenshot 'distro-preregistered')
    return
  }
  $rootfs = Join-Path $StagingRoot 'ubuntu-jammy-wsl.rootfs.tar.gz'
  if (-not (Test-Path $rootfs)) {
    throw "rootfs not staged at $rootfs -- pass -UbuntuRootfsPath to the orchestrator OR pre-place it at C:\Hyper-V\AgentControlTest\ubuntu-jammy-wsl.rootfs.tar.gz"
  }
  $target = Join-Path 'C:\WSL' $Distro
  # The base snapshot may already have C:\WSL\<Distro>\ext4.vhdx on disk from
  # Import-DevVM.ps1's build-time `wsl --import`, but that registration never
  # reached the interactive User's HKCU (network-logon transient-hive quirk above).
  # We only get here after the skip-if-registered probe confirmed $Distro is NOT
  # registered, so the dir is an orphan -- `wsl --import` would fail with "The
  # supplied install location is already in use". Wipe it before re-importing.
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
  }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $r = Invoke-Wsl @('--import', $Distro, $target, $rootfs, '--version', '2')
  $shot = Save-Screenshot 'distro-import'
  if ($r.Code -ne 0) { throw "wsl --import $Distro failed ($($r.Code)): $($r.Text.Trim())" }
  $v = Invoke-Wsl @('--list', '--quiet')
  if (-not ($v.Code -eq 0 -and (($v.Text -split "\r?\n" | ForEach-Object { $_.Trim() }) -contains $Distro))) {
    throw "wsl --import reported success but $Distro absent from wsl --list --quiet: $($v.Text.Trim())"
  }
  Add-Step 'import-distro' 'pass' "wsl --import $Distro -> $target (from staged rootfs)" $shot
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

function Step-InstallAndVerifyBridge {
  # wsl.sh install + nohup start + port verify, all in ONE wsl.exe call, so the
  # WSL2 distro stays alive throughout. Splitting install and verify into
  # separate wsl.exe invocations caused the distro to auto-shut-down between
  # them, killing the bridge process (see PR #74/#75 iterations). Verify by port
  # (ss :3001) -- the bridge is functional as long as it is listening.
  $script = @'
set -uo pipefail
curl -sSL __WSL_SH_URL__ | bash
WSLSH_EXIT=$?
if [ $WSLSH_EXIT -ne 0 ]; then
  echo "[test] wsl.sh returned $WSLSH_EXIT; proceeding with manual bridge start" >&2
fi
if [ ! -f /root/agentcontrol-bridge/dist/index.js ]; then
  echo "[test] /root/agentcontrol-bridge/dist/index.js missing after wsl.sh; abort" >&2
  exit 1
fi
cd /root/agentcontrol-bridge
nohup /usr/bin/env node dist/index.js > /tmp/agentcontrol-bridge.log 2>&1 &
BRIDGE_PID=$!
echo "[test] bridge spawn pid=$BRIDGE_PID"
# Poll port 3001 up to 30s
for i in $(seq 1 30); do
  if ss -ltn 2>/dev/null | grep -q ':3001'; then
    echo "[test] bridge listening on :3001 after ${i}s"
    exit 0
  fi
  if ! kill -0 $BRIDGE_PID 2>/dev/null; then
    echo "[test] bridge process (pid=$BRIDGE_PID) died before port opened" >&2
    echo "----- bridge log tail -----" >&2
    tail -80 /tmp/agentcontrol-bridge.log >&2
    exit 1
  fi
  sleep 1
done
echo "[test] port 3001 never opened after 30s; bridge log tail:" >&2
tail -80 /tmp/agentcontrol-bridge.log >&2
exit 1
'@
  # Substitute the URL via explicit .Replace() (not PS string interpolation) to
  # keep the here-string literal in bash.
  $script = $script.Replace('__WSL_SH_URL__', $WslShUrl)
  $r = Invoke-Wsl @('-d', $Distro, '-u', 'root', '-e', 'bash', '-lc', $script)
  $shot = Save-Screenshot 'bridge-install-verify'
  if ($r.Code -ne 0) {
    throw "bridge install+verify failed ($($r.Code)):`n$($r.Text.Trim())"
  }
  Add-Step 'install-and-verify-bridge' 'pass' 'wsl.sh + node dist/index.js listening on :3001 (single wsl session)' $shot
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
  Step-VerifyHost; Step-UpdateWsl; Step-ImportDistro; Step-WaitDistro
  Step-InstallAndVerifyBridge; Step-VerifyPairFlow
}

# ---- run --------------------------------------------------------------------
try {
  if ($Flow -eq 'tray' -or $Flow -eq 'full') { Invoke-TrayFlow }
  if ($Flow -eq 'wsl'  -or $Flow -eq 'full') { Invoke-WslFlow }
  $result.pass = $true
} catch {
  $msg = Repair-WslText $_.Exception.Message
  $result.errors += $msg
  try { Add-Step 'error' 'fail' $msg (Save-Screenshot 'error') } catch {}
  try { if (-not $result.diagnostics) { Write-Diagnostics } } catch {}
}

$result.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
Save-Screenshot 'final' | Out-Null
Write-Result -Result $result | Out-Null
# No Stop-Computer — the orchestrator runs Stop-VM after scp'ing output back.
