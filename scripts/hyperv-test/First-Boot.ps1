<#
.SYNOPSIS
  Runs ONCE inside the Phase 66h test VM at first auto-logon (invoked by the
  AutoUnattend.xml FirstLogonCommands). Turns a bare Windows 11 Enterprise Eval
  desktop into the golden base image: Windows OpenSSH server (key auth to the
  injected host pubkey), WSL2 kernel, a pre-imported Ubuntu-22.04, and a `dev`
  UNIX user with the same host pubkey. Writes C:\provisioning-complete.txt when
  done so Build-BaseImage-FromIso.ps1 (on the host) knows to snapshot.

  Idempotent: safe to re-run. Everything it needs was staged into
  C:\provisioning by Build-BaseImage-FromIso.ps1 (offline VHDX injection) --
  wsl_update_x64.msi, ubuntu-jammy.tar.gz, host_id.pub.

.NOTES
  # @line-limit-exception: single linear first-boot provisioner; splitting the
  # OpenSSH / WSL / Ubuntu blocks across files would obscure the boot sequence.
#>
[CmdletBinding()]
param(
  [string]$ProvisioningDir = 'C:\provisioning',
  [string]$Distro          = 'Ubuntu-22.04',
  [string]$WslInstallDir   = 'C:\WSL\Ubuntu-22.04',
  # Must match the dev password documented in README.md. SSH key auth is the
  # real access path; this only exists so `su - dev` etc. work interactively.
  [string]$DevPassword     = 'AgentControl!Test1'
)

$ErrorActionPreference = 'Stop'
$log = 'C:\provisioning\first-boot.log'
function Log { param([string]$m)
  $line = "{0}  {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $m
  Add-Content -Path $log -Value $line
  Write-Host $line
}

# ---- phase marker + resume-after-reboot plumbing ----------------------------
# On a fresh Win11 25H2 eval image the WSL optional features report
# RestartRequired=Possible; the WSL kernel stays inert until the box reboots, so
# `wsl --import` fails with -1. We enable the features, reboot, and resume via an
# AtLogon scheduled task (AutoLogon re-fires and the task re-runs this script --
# FirstLogonCommands only fire on the very first logon, not after reboot). The
# registry marker records progress across the reboot AND guards against an
# infinite reboot loop.
$PhaseKey        = 'HKLM:\SOFTWARE\AgentControl'
$ResumeTaskName  = 'AgentControlFirstBootPhase2'
$ScriptPath      = $MyInvocation.MyCommand.Path
$script:RestartNeeded = $false

function Get-FirstBootPhase {
  (Get-ItemProperty -Path $PhaseKey -Name FirstBootPhase -ErrorAction SilentlyContinue).FirstBootPhase
}
function Set-FirstBootPhase { param([string]$Phase)
  if (-not (Test-Path $PhaseKey)) { New-Item -Path $PhaseKey -Force | Out-Null }
  Set-ItemProperty -Path $PhaseKey -Name FirstBootPhase -Value $Phase
  Log "phase marker => $Phase"
}
function Register-ResumeTask {
  $action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f $ScriptPath)
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User Administrator
  # Interactive principal: runs inside the AutoLogon session, no stored password.
  $principal = New-ScheduledTaskPrincipal -UserId Administrator -RunLevel Highest -LogonType Interactive
  Register-ScheduledTask -TaskName $ResumeTaskName -Action $action -Trigger $trigger `
    -Principal $principal -Force | Out-Null
  Log "registered resume task '$ResumeTaskName' (AtLogon/Administrator)"
}
function Unregister-ResumeTask {
  if (Get-ScheduledTask -TaskName $ResumeTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $ResumeTaskName -Confirm:$false
    Log "unregistered resume task '$ResumeTaskName'"
  }
}

# Already fully provisioned (e.g. a base-image re-run): no-op so we never loop.
if ((Get-FirstBootPhase) -eq 'complete') {
  Log "FirstBootPhase=complete; nothing to do"
  return
}

$pubKeyPath = Join-Path $ProvisioningDir 'host_id.pub'
$kernelMsi  = Join-Path $ProvisioningDir 'wsl_update_x64.msi'
$rootfsTar  = Join-Path $ProvisioningDir 'ubuntu-jammy.tar.gz'
# kernelMsi is best-effort (Win10/older-Win11 only); Install-WslKernel falls
# back to native `wsl --install` on Win11 25H2+ where the MSI is deprecated.
foreach ($f in @($pubKeyPath, $rootfsTar)) {
  if (-not (Test-Path $f)) { throw "missing injected artifact: $f" }
}
$pubKey = (Get-Content -Raw $pubKeyPath).Trim()

# ---- 1. OpenSSH server ------------------------------------------------------
function Install-OpenSSHServer {
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
  if ($cap.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
  }
  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd
  # Firewall rule ships with the capability but re-assert it defensively.
  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  # SSH sessions get PowerShell (matches how the orchestrator drives runner-vm.ps1).
  $pwsh = (Get-Command powershell.exe).Source
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value $pwsh -PropertyType String -Force | Out-Null
  Log "OpenSSH server installed; default shell = $pwsh"
}

function Set-AdminAuthorizedKey {
  # Admin accounts authenticate via administrators_authorized_keys, NOT the
  # per-user ~/.ssh path. ACL must be SYSTEM + Administrators only, no inherit --
  # sshd refuses the file otherwise.
  $akFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
  Set-Content -Path $akFile -Value $pubKey -Encoding ascii -NoNewline
  $acl = Get-Acl $akFile
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($id in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $id, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -Path $akFile -AclObject $acl
  Log "administrators_authorized_keys written + ACL locked to SYSTEM/Administrators"
}

# ---- 2. WSL2 kernel + Ubuntu ------------------------------------------------
function Install-WslKernel {
  # The two optional features WSL2 needs; already present via nested-virt but
  # assert them so a fresh eval image is covered.
  foreach ($feat in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
    $s = Get-WindowsOptionalFeature -Online -FeatureName $feat
    if ($s.State -ne 'Enabled') {
      $r = Enable-WindowsOptionalFeature -Online -FeatureName $feat -NoRestart -All
      if ($r.RestartNeeded) { $script:RestartNeeded = $true }
      Log "enabled optional feature $feat (RestartNeeded=$($r.RestartNeeded))"
    } elseif ($s.RestartRequired -and "$($s.RestartRequired)" -ne 'No') {
      # Pre-enabled (nested-virt) but the box has not rebooted since, so the WSL
      # kernel is still inert -- a reboot is required before `wsl --import`.
      $script:RestartNeeded = $true
      Log "optional feature $feat already enabled but RestartRequired=$($s.RestartRequired)"
    }
  }
  # Win11 25H2+ ships WSL as a built-in Store app; the standalone
  # wsl_update_x64.msi is deprecated + fails with 1603. Try the MSI first for
  # older Win10/11 builds; on failure, fall back to native `wsl --install`.
  $msiOk = $false
  if (Test-Path $kernelMsi) {
    $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
      '/i', "`"$kernelMsi`"", '/quiet', '/norestart')
    if ($p.ExitCode -in @(0, 3010)) {
      $msiOk = $true
      Log "WSL2 kernel installed via MSI (exit $($p.ExitCode))"
    } else {
      Log "wsl_update_x64.msi failed exit $($p.ExitCode); falling back to native 'wsl --install'"
    }
  }
  if (-not $msiOk) {
    # Native path (Win11 25H2+): wsl --install --no-distribution --no-launch
    $out = & wsl.exe --install --no-distribution --no-launch 2>&1
    $out | ForEach-Object { Log "wsl --install: $_" }
    if ($LASTEXITCODE -ne 0) { throw "wsl --install failed (exit $LASTEXITCODE)" }
    if ("$out" -match 'reboot|restart') { $script:RestartNeeded = $true }
  }
  & wsl.exe --set-default-version 2 | Out-Null
  Log "WSL2 kernel installed; default version = 2"
}

function Invoke-RebootIfRequired {
  if (-not $script:RestartNeeded) { return }
  # Loop guard: if we already rebooted once for this reason, do NOT reboot again
  # -- proceed and let `wsl --import` try, since a second reboot would not help.
  if ((Get-FirstBootPhase) -eq 'features-enabled-pending-reboot') {
    Log "restart still flagged after a prior reboot; proceeding without another reboot"
    return
  }
  Set-FirstBootPhase 'features-enabled-pending-reboot'
  Register-ResumeTask
  Log "WSL features enabled but reboot required; rebooting + resuming via task"
  Restart-Computer -Force
  # Restart-Computer returns before the box goes down; hold here so we never race
  # into `wsl --import` (which would fail -1) during the shutdown window.
  Start-Sleep -Seconds 120
  exit 0
}

function Import-UbuntuDistro {
  $env:WSL_UTF8 = '1'
  $existing = (& wsl.exe --list --quiet) -split "\r?\n" | ForEach-Object { $_.Trim() }
  if ($existing -contains $Distro) {
    Log "$Distro already imported; skipping"
  } else {
    New-Item -ItemType Directory -Force -Path $WslInstallDir | Out-Null
    & wsl.exe --import $Distro $WslInstallDir $rootfsTar --version 2
    if ($LASTEXITCODE -ne 0) {
      # A just-installed WSL can be in a pending state where the service is not
      # ready; a shutdown + single retry clears it (short of a full reboot).
      Log "wsl --import $Distro failed ($LASTEXITCODE); wsl --shutdown + retry"
      & wsl.exe --shutdown 2>&1 | ForEach-Object { Log "wsl --shutdown: $_" }
      Start-Sleep -Seconds 8
      & wsl.exe --import $Distro $WslInstallDir $rootfsTar --version 2
      if ($LASTEXITCODE -ne 0) { throw "wsl --import $Distro failed after retry ($LASTEXITCODE)" }
    }
    Log "$Distro imported to $WslInstallDir"
  }
  & wsl.exe --set-default $Distro | Out-Null
}

function Set-UbuntuDevUser {
  # Create dev + SSH key, make it the WSL default user (so `wsl -d <distro>`
  # and systemd --user work), and never prompt for interactive first-run setup.
  $bootstrap = @"
set -e
id dev >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo dev
echo 'dev:$DevPassword' | chpasswd
echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev && chmod 440 /etc/sudoers.d/dev
install -d -m 700 -o dev -g dev /home/dev/.ssh
printf '%s\n' '$pubKey' > /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys
printf '[user]\ndefault=dev\n[boot]\nsystemd=true\n' > /etc/wsl.conf
"@
  $bootstrap = $bootstrap -replace "`r`n", "`n"
  & wsl.exe -d $Distro -u root -e bash -lc $bootstrap
  if ($LASTEXITCODE -ne 0) { throw "Ubuntu dev-user bootstrap failed ($LASTEXITCODE)" }
  & wsl.exe --terminate $Distro | Out-Null   # apply wsl.conf (default user + systemd)
  Log "Ubuntu dev user + authorized_keys + wsl.conf (systemd) configured"
}

# ---- 3. finalize ------------------------------------------------------------
function Complete-Provisioning {
  # Turn off the unattended auto-login now that provisioning is done.
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value '0' -ErrorAction SilentlyContinue
  # Remove the resume task (harmless no-op if we never rebooted) and mark done
  # so any later re-run short-circuits at the top.
  Unregister-ResumeTask
  Set-FirstBootPhase 'complete'
  $stamp = (Get-Date).ToUniversalTime().ToString('o')
  Set-Content -Path 'C:\provisioning-complete.txt' -Value $stamp -Encoding ascii
  Log "provisioning complete @ $stamp"
}

try {
  Log "==== First-Boot.ps1 starting ===="
  Install-OpenSSHServer
  Set-AdminAuthorizedKey
  Install-WslKernel
  Invoke-RebootIfRequired
  Import-UbuntuDistro
  Set-UbuntuDevUser
  Complete-Provisioning
  Log "==== First-Boot.ps1 finished OK ===="
} catch {
  Log "FATAL: $($_.Exception.Message)"
  Set-Content -Path 'C:\provisioning-failed.txt' -Value $_.Exception.Message -Encoding ascii
  throw
}
