<#
.SYNOPSIS
  ONE-TIME builder for the Phase 66j Hyper-V test VM, built from Microsoft's
  pre-built "Windows 11 dev environment" image instead of a raw eval ISO. Turns
  that image into a ready-to-clone Hyper-V guest with WSL2 + Ubuntu-22.04 +
  OpenSSH pre-installed, then snapshots it as `clean-agentcontrol-base` -- the
  immutable golden state the per-run orchestrator reverts to before every test.

  This replaces Build-BaseImage-FromIso.ps1 (the ISO + AutoUnattend flow). It is
  dramatically simpler: the MS image is already provisioned (no OOBE, no
  AutoLogon, no FirstLogonCommands, no reboot-and-resume plumbing), and WSL2 is
  already enabled -- so all provisioning runs HOST-side over PowerShell Direct
  (VMBus, no guest network needed), not from a fragile in-guest first-boot script.

  Where the image comes from: Microsoft discontinued the standalone developer
  VHDX download (developer.microsoft.com/.../virtual-machines now redirects to a
  page with no VMs). The only surviving pre-built dev VM is the one the Hyper-V
  Quick Create GALLERY serves -- and its backing disk URI is fully scriptable
  (no GUI): we fetch the public gallery JSON, find the "Windows 11 dev
  environment" entry, and download its disk directly. As of 2026 that is
  `WinDev2407Eval` (a July-2024 / 22H2 Enterprise Evaluation build), so its
  90-day eval has expired -- `slmgr /rearm` in provisioning resets the clock to
  ~90 days so every reverted snapshot starts licensed. See README + Update-DevVM.ps1.

  Run elevated (admin) on a Windows 11 Pro/Enterprise host with Hyper-V enabled.
  Idempotent: re-running reuses an existing zip/VHDX/VM/snapshot rather than
  rebuilding. Does NOT touch the host's own WSL -- that is the whole point.

.EXAMPLE
  pwsh -File Import-DevVM.ps1
  pwsh -File Import-DevVM.ps1 -Force
  pwsh -File Import-DevVM.ps1 -DiskUri <url> -DiskSha256 <hex> -ArchiveEntry WinDev2407Eval.vhdx

.NOTES
  # @line-limit-exception: single linear one-time build pipeline; the step
  # functions read as one recipe and the ordering matters (extract before New-VM,
  # nested-virt flag while off, rearm before the reboot that applies it, snapshot
  # last). Splitting across modules would hide that sequence.
#>
[CmdletBinding()]
param(
  [string]$WorkDir      = 'C:\Hyper-V\AgentControlTest',
  [string]$VmName       = 'agentcontrol-test-vm',
  [string]$SwitchName   = 'Default Switch',
  [string]$SnapshotName = 'clean-agentcontrol-base',
  # Public Hyper-V Quick Create gallery manifest (UTF-16, tolerant of trailing
  # commas). We read the disk URI + hash from the entry named below.
  [string]$GalleryUrl   = 'https://go.microsoft.com/fwlink/?linkid=851584',
  [string]$ImageName    = 'Windows 11 dev environment',
  # Offline / pinned override: skip the gallery fetch and use these directly.
  # ArchiveEntry is the .vhdx path inside the downloaded .zip.
  [string]$DiskUri      = '',
  [string]$DiskSha256   = '',
  [string]$ArchiveEntry = '',
  # Host SSH pubkey baked into the guest admin (administrators_authorized_keys)
  # and the Ubuntu dev user. Default reads the host Ubuntu WSL key.
  [string]$HostPubKeyPath = '\\wsl$\Ubuntu\home\dev\.ssh\id_ed25519.pub',
  [string]$Distro       = 'Ubuntu-22.04',
  # Ubuntu rootfs tarball on the HOST, copied into the guest and `wsl --import`ed.
  # Left empty it is auto-downloaded from $UbuntuRootfsUrl and cached in $WorkDir
  # (see Get-UbuntuRootfs). Set it to pin a pre-placed tarball on air-gapped hosts.
  [string]$UbuntuRootfsPath = '',
  # Canonical Ubuntu 22.04 (jammy) WSL rootfs, published by Canonical. Used to
  # auto-download when -UbuntuRootfsPath is empty so no in-guest store download
  # (`wsl --install -d`) is ever needed -- that path fails on the offline MS eval image.
  [string]$UbuntuRootfsUrl = 'https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz',
  [string]$DevPassword  = 'AgentControl!Test1',
  # MS dev VM auto-logon account. Its password has historically been blank; some
  # builds used 'Passw0rd!'. PowerShell Direct needs the guest credential, so we
  # try these candidates in order (override with -GuestPassword if MS changed it).
  [string]$GuestUser    = 'User',
  [string[]]$GuestPasswordCandidates = @('', 'Passw0rd!'),
  [string]$GuestPassword = '',
  [int]$MemoryGB        = 8,
  [int]$CpuCount        = 4,
  [int]$ProvisionTimeoutMin = 20,
  [switch]$SkipRearm,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$devDir    = Join-Path $WorkDir 'devvm'
$vhdxPath  = Join-Path $devDir "$VmName.vhdx"

function Info { param($m) Write-Host "[import] $m" -ForegroundColor Cyan }
function Warn { param($m) Write-Host "[import] $m" -ForegroundColor Yellow }

# ---- 1. prereqs -------------------------------------------------------------
function Test-Prereqs {
  $admin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { throw 'must run elevated (admin)' }
  $hv = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
  if (-not $hv -or $hv.State -ne 'Enabled') {
    throw 'Hyper-V feature not enabled. Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All, then reboot.'
  }
  if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V PowerShell module not available.' }
  if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
    throw "vSwitch '$SwitchName' not found. Create one or pass -SwitchName."
  }
  if (-not (Test-Path $HostPubKeyPath)) {
    throw "host SSH pubkey not found at $HostPubKeyPath. Generate one (ssh-keygen -t ed25519) or pass -HostPubKeyPath."
  }
  New-Item -ItemType Directory -Force -Path $WorkDir, $devDir | Out-Null
  $drive  = (Get-Item $WorkDir).PSDrive.Name
  $freeGB = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
  if ($freeGB -lt 40) { throw "need >= 40GB free on $drive`: only ${freeGB}GB" }
  Info "prereqs OK -- ${freeGB}GB free on $drive, switch '$SwitchName', host pubkey present"
}

# ---- 1b. auto-download the Ubuntu WSL rootfs (host-side, cached) ------------
# We always `wsl --import` a rootfs tarball inside the guest rather than let it
# `wsl --install -d` from the MS Store: the WinDev eval image has no Store creds /
# route, so --install (which internally --imports) dies with a bare "-1". Fetch
# Canonical's canonical jammy WSL rootfs on the HOST (which does have network) and
# hand it to the guest. Idempotent: a cached file > 100MB is reused as-is.
function Get-UbuntuRootfs {
  $dest = Join-Path $WorkDir 'ubuntu-jammy-wsl.rootfs.tar.gz'
  if ((Test-Path $dest) -and -not $Force) {
    $sizeMB = [math]::Round((Get-Item $dest).Length / 1MB, 1)
    if ($sizeMB -gt 100) { Info "cached Ubuntu rootfs OK (${sizeMB}MB) -> $dest"; return $dest }
    Warn "cached Ubuntu rootfs looks truncated (${sizeMB}MB); re-downloading"
  }
  Info "downloading Ubuntu 22.04 WSL rootfs from $UbuntuRootfsUrl ..."
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $UbuntuRootfsUrl -OutFile $dest -UseBasicParsing } finally { $ProgressPreference = $old }
  $sizeMB = [math]::Round((Get-Item $dest).Length / 1MB, 1)
  if ($sizeMB -lt 100) { throw "downloaded Ubuntu rootfs is only ${sizeMB}MB (expected > 100MB); download likely failed" }
  Info "Ubuntu rootfs downloaded (${sizeMB}MB) -> $dest"
  return $dest
}

# ---- 2. resolve the gallery image (URI + sha256 + in-zip vhdx path) --------
function Resolve-GalleryImage {
  if ($DiskUri -and $DiskSha256 -and $ArchiveEntry) {
    Info "using pinned image override ($ArchiveEntry)"
    return [pscustomobject]@{ Uri = $DiskUri; Sha256 = $DiskSha256; Entry = $ArchiveEntry }
  }
  Info "fetching Quick Create gallery manifest ..."
  # The manifest is UTF-16 with a BOM; download to a file and let Get-Content
  # auto-detect the BOM rather than trust Invoke-WebRequest's charset guess.
  $manifest = Join-Path $devDir 'gallery.json'
  Invoke-WebRequest -Uri $GalleryUrl -OutFile $manifest -UseBasicParsing
  $raw = Get-Content -Raw $manifest
  # Microsoft's gallery JSON carries trailing commas (its bespoke parser tolerates
  # them); ConvertFrom-Json does not, so strip them first.
  $clean = [regex]::Replace($raw, ',(\s*[}\]])', '$1')
  $gallery = $clean | ConvertFrom-Json
  $img = $gallery.images | Where-Object { $_.name -eq $ImageName } | Select-Object -First 1
  if (-not $img) { throw "gallery has no image named '$ImageName' -- names present: $(($gallery.images.name) -join ', ')" }
  $sha = ($img.disk.hash -replace '^sha256:', '')
  $entry = $img.disk.archiveRelativePath
  Info "resolved '$ImageName' -> $($img.disk.uri) (entry $entry)"
  return [pscustomobject]@{ Uri = $img.disk.uri; Sha256 = $sha; Entry = $entry }
}

# ---- 3. download + verify + extract the VHDX -------------------------------
function Get-DevVmZip {
  param([pscustomobject]$Image)
  $zip = Join-Path $devDir ([IO.Path]::GetFileName(($Image.Uri -split '\?')[0]))
  $needDownload = $true
  if ((Test-Path $zip) -and -not $Force) {
    Info "verifying cached $([IO.Path]::GetFileName($zip)) ..."
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -eq $Image.Sha256) { $needDownload = $false; Info 'cached zip hash OK' }
    else { Warn 'cached zip hash mismatch; re-downloading' }
  }
  if ($needDownload) {
    Info "downloading dev VM (~10-20GB) -- this is the long step ..."
    $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Image.Uri -OutFile $zip -UseBasicParsing } finally { $ProgressPreference = $old }
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash
    if ($got -ne $Image.Sha256) { throw "downloaded zip sha256 $got != expected $($Image.Sha256)" }
    Info 'download sha256 verified'
  }
  return $zip
}

function Expand-Vhdx {
  param([string]$Zip, [string]$Entry)
  if ((Test-Path $vhdxPath) -and -not $Force) { Info "VHDX already extracted ($vhdxPath)"; return }
  if (Test-Path $vhdxPath) { Remove-Item $vhdxPath -Force }
  Info "extracting $Entry from zip ..."
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $za = [IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    $e = $za.Entries | Where-Object { $_.FullName -eq $Entry -or $_.Name -eq $Entry } | Select-Object -First 1
    if (-not $e) { throw "zip does not contain entry '$Entry' -- has: $(($za.Entries.FullName) -join ', ')" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $vhdxPath, $true)
  } finally { $za.Dispose() }
  # Clear the mark-of-the-web ADS: a downloaded VHDX with Zone.Identifier breaks
  # app launches / perf inside the guest (MS documents this for VHDX images).
  Unblock-File -Path $vhdxPath -ErrorAction SilentlyContinue
  Info "VHDX extracted: $vhdxPath"
}

# ---- 3b. offline VHDX prep: allow blank-password network logon -------------
# MS's WinDev*Eval image ships auto-logon user 'User' with a blank, undocumented
# password. PowerShell Direct authenticates over a network-logon type, and Win11's
# default LSA policy LimitBlankPasswordUse=1 refuses blank passwords for anything
# but console logon -- so PS Direct fails "The credential is invalid" regardless of
# the password we try. Flipping the policy to 0 offline (before first boot) lets the
# blank-password logon through. Ref: https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/accounts-limit-local-account-use-of-blank-passwords-to-console-logon-only
function Prepare-WinDevVhdx {
  param([Parameter(Mandatory)][string]$VhdxPath)
  # Never touch a VHDX a running VM has open -- offline hive edits would corrupt it.
  $attached = Get-VM | Where-Object { $_.State -eq 'Running' } |
    Get-VMHardDiskDrive | Where-Object { $_.Path -eq $VhdxPath }
  if ($attached) {
    Warn "VHDX '$VhdxPath' is attached to a running VM; skipping blank-password policy fix"
    return
  }
  $mount = Join-Path $env:TEMP "agentcontrol-vhdxmount-$([guid]::NewGuid().Guid)"
  New-Item -ItemType Directory -Force -Path $mount | Out-Null
  $hive = 'HKLM\_ACOffSys'
  $vhd  = $null
  try {
    $vhd  = Mount-VHD -Path $VhdxPath -NoDriveLetter -Passthru
    # The Windows volume is the largest Basic partition; the small EFI/MSR/recovery
    # partitions are < 1GB, so filter those out and take the biggest that remains.
    $part = Get-Partition -DiskNumber $vhd.DiskNumber |
      Where-Object { $_.Type -eq 'Basic' -and $_.Size -gt 1GB } |
      Sort-Object Size -Descending | Select-Object -First 1
    if (-not $part) { throw "no Basic > 1GB (Windows) partition found on $VhdxPath" }
    Add-PartitionAccessPath -DiskNumber $vhd.DiskNumber -PartitionNumber $part.PartitionNumber -AccessPath $mount
    $systemHive = Join-Path $mount 'Windows\System32\config\SYSTEM'
    if (-not (Test-Path $systemHive)) { throw "SYSTEM hive not found at $systemHive" }
    & reg load $hive $systemHive | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "reg load SYSTEM hive failed ($LASTEXITCODE)" }
    try {
      $lsaKey = "$hive\ControlSet001\Control\Lsa"
      $cur = & reg query $lsaKey /v LimitBlankPasswordUse 2>$null | Select-String 'LimitBlankPasswordUse'
      if ($cur -match '0x0\b') {
        Info 'blank-password network logon policy already disabled on VHDX (no-op)'
      } else {
        & reg add $lsaKey /v LimitBlankPasswordUse /t REG_DWORD /d 0 /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "reg add LimitBlankPasswordUse failed ($LASTEXITCODE)" }
        Info 'blank-password network logon policy disabled on VHDX (WinDev workaround)'
      }
    } finally {
      # Release .NET handles on the loaded hive before unloading, else reg unload fails.
      [gc]::Collect(); Start-Sleep -Seconds 2
      & reg unload $hive | Out-Null
    }
  } finally {
    if ($vhd) { Dismount-VHD -Path $VhdxPath -ErrorAction SilentlyContinue }
    Remove-Item -Path $mount -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---- 4. create the VM ------------------------------------------------------
function New-DevVm {
  if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) {
    if (-not $Force) { Info "VM '$VmName' already exists; reuse (pass -Force to recreate)"; return }
    Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue
    Remove-VM -Name $VmName -Force
  }
  Info "creating Gen2 VM '$VmName' (${MemoryGB}GB static RAM, $CpuCount vCPU, nested-virt) ..."
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) `
    -VHDPath $vhdxPath -SwitchName $SwitchName | Out-Null
  Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $false          # nested-virt needs static RAM
  Set-VMProcessor -VMName $VmName -Count $CpuCount -ExposeVirtualizationExtensions $true
  Set-VM -Name $VmName -CheckpointType Standard -AutomaticCheckpointsEnabled $false
  Set-VMKeyProtector -VMName $VmName -NewLocalKeyProtector           # vTPM + Secure Boot (Gen2 Win11)
  Enable-VMTPM -VMName $VmName
  Enable-VMIntegrationService -VMName $VmName -Name 'Guest Service Interface'
  Info "guest service interface enabled (required for PowerShell Direct)"
  Info 'VM created; nested-virt exposed, vTPM enabled'
}

# ---- 5. connect over PowerShell Direct -------------------------------------
function Connect-GuestSession {
  Info "starting VM; waiting up to ${ProvisionTimeoutMin}min for PowerShell Direct ..."
  $gsi = Get-VMIntegrationService -VMName $VmName -Name 'Guest Service Interface'
  if (-not $gsi.Enabled) {
    Warn "Guest Service Interface disabled; enabling now (was: $($gsi.Enabled))"
    Enable-VMIntegrationService -VMName $VmName -Name 'Guest Service Interface'
  }
  if ((Get-VM -Name $VmName).State -ne 'Running') { Start-VM -Name $VmName }
  $candidates = if ($GuestPassword) { @($GuestPassword) } else { $GuestPasswordCandidates }
  $deadline = (Get-Date).AddMinutes($ProvisionTimeoutMin)
  do {
    Start-Sleep -Seconds 15
    foreach ($pw in $candidates) {
      # ConvertTo-SecureString rejects an empty string -> use an empty SecureString directly.
      $sec = if ([string]::IsNullOrEmpty($pw)) {
        New-Object System.Security.SecureString
      } else {
        ConvertTo-SecureString $pw -AsPlainText -Force
      }
      $cred = New-Object System.Management.Automation.PSCredential($GuestUser, $sec)
      try {
        $s = New-PSSession -VMName $VmName -Credential $cred -ErrorAction Stop
        Info "PowerShell Direct connected as '$GuestUser'$(if(-not $pw){' (blank password)'})"
        return $s
      } catch { }
    }
    Info "waiting for guest to accept PowerShell Direct ..."
  } while ((Get-Date) -lt $deadline)
  throw "could not open a PowerShell Direct session as '$GuestUser' within ${ProvisionTimeoutMin}min. If Microsoft changed the default credentials, pass -GuestUser/-GuestPassword."
}

# ---- 6. provision the guest over the session -------------------------------
function Invoke-GuestProvisioning {
  param($Session)
  $pubKey = (Get-Content -Raw $HostPubKeyPath).Trim()
  if (-not (Test-Path $UbuntuRootfsPath)) { throw "UbuntuRootfsPath not found: $UbuntuRootfsPath" }
  Info "copying Ubuntu rootfs into guest ..."
  Invoke-Command -Session $Session -ScriptBlock { New-Item -ItemType Directory -Force -Path 'C:\provisioning' | Out-Null }
  Copy-Item -ToSession $Session -Path $UbuntuRootfsPath -Destination 'C:\provisioning\ubuntu-rootfs.tar.gz' -Force
  Info 'provisioning guest (OpenSSH + key + WSL/Ubuntu + rearm) over PowerShell Direct ...'
  Invoke-Command -Session $Session -ArgumentList $pubKey, $Distro, $DevPassword, $SkipRearm.IsPresent -ScriptBlock {
    param($PubKey, $Distro, $DevPassword, $SkipRearm)
    $ErrorActionPreference = 'Stop'
    function GLog { param($m) Write-Host "[guest] $m" }

    # OpenSSH server: key auth, PowerShell default shell, firewall.
    if ((Get-WindowsCapability -Online -Name 'OpenSSH.Server*').State -ne 'Installed') {
      Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    }
    Set-Service -Name sshd -StartupType Automatic; Start-Service sshd
    if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    }
    New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
      -Value (Get-Command powershell.exe).Source -PropertyType String -Force | Out-Null
    # Admin accounts authenticate via administrators_authorized_keys (SYSTEM +
    # Administrators ACL, no inheritance) -- not the per-user ~/.ssh path.
    $ak = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    Set-Content -Path $ak -Value $PubKey -Encoding ascii -NoNewline
    $acl = Get-Acl $ak; $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'Allow')))
    }
    Set-Acl -Path $ak -AclObject $acl
    GLog 'OpenSSH server + administrators_authorized_keys ready'

    # WSL: the dev image already has the platform enabled and has rebooted since
    # capture, so no feature-enable/reboot dance -- import the host-supplied rootfs
    # in one shot. We never `wsl --install -d` (Store download) here: the offline MS
    # eval image has no Store route and it fails with a bare "-1".
    $env:WSL_UTF8 = '1'
    & wsl.exe --set-default-version 2 | Out-Null
    $rootfs = 'C:\provisioning\ubuntu-rootfs.tar.gz'
    if (-not (Test-Path $rootfs)) { throw "Ubuntu rootfs not staged at $rootfs -- host copy step did not run" }
    $have = (& wsl.exe --list --quiet) -split "\r?\n" | ForEach-Object { $_.Trim() }
    if ($have -notcontains $Distro) {
      New-Item -ItemType Directory -Force -Path "C:\WSL\$Distro" | Out-Null
      & wsl.exe --import $Distro "C:\WSL\$Distro" $rootfs --version 2
      if ($LASTEXITCODE -ne 0) { throw "wsl --import $Distro failed ($LASTEXITCODE)" }
      GLog "$Distro registered"
    } else { GLog "$Distro already present" }
    & wsl.exe --set-default $Distro | Out-Null
    # dev UNIX user: same host pubkey, passwordless sudo, systemd, default user.
    $bootstrap = @"
set -e
id dev >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo dev
echo 'dev:$DevPassword' | chpasswd
echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev && chmod 440 /etc/sudoers.d/dev
install -d -m 700 -o dev -g dev /home/dev/.ssh
printf '%s\n' '$PubKey' > /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys
printf '[user]\ndefault=dev\n[boot]\nsystemd=true\n' > /etc/wsl.conf
"@ -replace "`r`n", "`n"
    & wsl.exe -d $Distro -u root -e bash -lc $bootstrap
    if ($LASTEXITCODE -ne 0) { throw "Ubuntu dev-user bootstrap failed ($LASTEXITCODE)" }
    & wsl.exe --terminate $Distro | Out-Null
    GLog 'Ubuntu dev user + authorized_keys + wsl.conf configured'

    # Reset the expired 90-day evaluation clock so reverted snapshots boot licensed.
    if (-not $SkipRearm) {
      $r = & cscript //nologo "$env:WinDir\System32\slmgr.vbs" /rearm 2>&1
      GLog "slmgr /rearm: $r"
    }
    Set-Content -Path 'C:\provisioning-complete.txt' -Value ((Get-Date).ToUniversalTime().ToString('o')) -Encoding ascii
    GLog 'guest provisioning complete'
  }
  Info 'guest provisioning finished'
}

# ---- 7. rearm reboot + snapshot --------------------------------------------
function Complete-Base {
  if (-not $SkipRearm) {
    # /rearm only takes effect after a reboot; cycle the guest so the snapshot
    # captures the freshly re-armed (licensed, ~90-day) state.
    Info 'restarting guest so the rearm takes effect ...'
    Restart-VM -Name $VmName -Force -Wait -For Heartbeat -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 20
  }
  Info 'shutting guest down cleanly ...'
  Stop-VM -Name $VmName -Force
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-VM -Name $VmName).State -ne 'Off' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
  if ((Get-VM -Name $VmName).State -ne 'Off') { Stop-VM -Name $VmName -TurnOff -Force }
  if (Get-VMSnapshot -VMName $VmName -Name $SnapshotName -ErrorAction SilentlyContinue) {
    Warn "snapshot '$SnapshotName' already exists; leaving it"
  } else {
    Checkpoint-VM -Name $VmName -SnapshotName $SnapshotName
    Info "snapshot '$SnapshotName' taken"
  }
  Write-Host ''
  Info '================ BASE IMAGE READY ================'
  Info "VM name        : $VmName"
  Info "Base VHDX      : $vhdxPath"
  Info "Base snapshot  : $SnapshotName"
  Info "SSH target     : $GuestUser@<guest-ip>  (port 22, key: $HostPubKeyPath)"
  Info "Ubuntu / dev   : $Distro, user 'dev' (same host pubkey)"
  Info 'Guest IP is DHCP (Default Switch); the orchestrator discovers it via Get-VMNetworkAdapter.'
  Info 'Next: run the per-run orchestrator to execute a test.'
  Info '=================================================='
}

# ---- run --------------------------------------------------------------------
Test-Prereqs
# On -Force, tear the VM down first so it no longer locks the VHDX we re-extract.
if ($Force -and (Get-VM -Name $VmName -ErrorAction SilentlyContinue)) {
  Info "-Force: removing existing VM '$VmName' before rebuild"
  Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue
  Remove-VM -Name $VmName -Force
}
$image = Resolve-GalleryImage
$entry = if ($ArchiveEntry) { $ArchiveEntry } else { $image.Entry }
$zip   = Get-DevVmZip -Image $image
Expand-Vhdx -Zip $zip -Entry $entry
# Offline-fix the LSA blank-password policy so PowerShell Direct can log the MS
# dev image's blank-password 'User' account in (see Prepare-WinDevVhdx).
Prepare-WinDevVhdx -VhdxPath $vhdxPath
New-DevVm
# Ensure a rootfs tarball is on the host before we provision: auto-download the
# canonical Ubuntu jammy WSL rootfs unless the caller pinned one (air-gapped hosts).
if (-not $UbuntuRootfsPath) { $UbuntuRootfsPath = Get-UbuntuRootfs }
$session = Connect-GuestSession
try { Invoke-GuestProvisioning -Session $session } finally { Remove-PSSession $session -ErrorAction SilentlyContinue }
Complete-Base
# Record what we imported so Update-DevVM.ps1 can detect a newer gallery image.
[pscustomobject]@{ Uri = $image.Uri; Sha256 = $image.Sha256; Entry = $entry; ImportedUtc = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content -Path (Join-Path $devDir 'imported-image.json') -Encoding ascii
