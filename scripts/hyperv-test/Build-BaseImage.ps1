<#
.SYNOPSIS
  ONE-TIME builder for the Phase 66h Hyper-V test VM. Turns a Windows 11
  Enterprise 90-day evaluation ISO into a ready-to-clone Hyper-V guest with
  WSL2 + Ubuntu-22.04 + OpenSSH pre-installed, then snapshots it as
  `clean-agentcontrol-base` -- the immutable golden state the per-run
  orchestrator (Phase 66h.2) reverts to before every test.

  Run elevated (admin) on a Windows 11 Pro/Enterprise host with Hyper-V enabled.
  Idempotent: re-running reuses an existing VHDX/VM/snapshot rather than
  rebuilding. Does NOT touch the host's own WSL -- that is the entire point of the
  VM approach (see BLUEPRINT.md §"Why Windows Sandbox can't do this").

.EXAMPLE
  pwsh -File Build-BaseImage.ps1
  pwsh -File Build-BaseImage.ps1 -IsoPath D:\iso\Win11-Eval.iso -Force
  pwsh -File Build-BaseImage.ps1 -Resume   # after a mid-provisioning crash

.NOTES
  # @line-limit-exception: single linear one-time build pipeline; the step
  # functions read as one recipe and splitting them across modules would hide
  # the ordering that matters (nested-virt flag before start, dismount before
  # New-VM, etc.). Plus a small Start/Stop-Heartbeat pair keeping the 30-60min
  # Convert-WindowsImage + first-boot polling phases visibly alive.
#>
[CmdletBinding()]
param(
  [string]$IsoPath        = 'C:\Hyper-V\AgentControlTest\Win11-Enterprise-Eval.iso',
  [string]$WorkDir        = 'C:\Hyper-V\AgentControlTest',
  [string]$VmName         = 'agentcontrol-test-vm',
  [string]$SwitchName     = 'Default Switch',
  [string]$SnapshotName   = 'clean-agentcontrol-base',
  [string]$Edition        = 'Windows 11 Enterprise Evaluation',
  # Host SSH pubkey baked into the guest (Windows admin + Ubuntu dev). Default
  # reads the host Ubuntu WSL key over the \\wsl$ share.
  [string]$HostPubKeyPath = '\\wsl$\Ubuntu\home\dev\.ssh\id_ed25519.pub',
  [string]$WslKernelUrl   = 'https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi',
  # Canonical periodically moves WSL rootfs paths -- verify by curl -sIL before merging
  [string]$UbuntuRootfsUrl = 'https://cloud-images.ubuntu.com/wsl/releases/jammy/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz',
  # Canonical Microsoft ISO->VHDX converter; downloaded once into $WorkDir.
  [string]$ConvertImageUrl = 'https://raw.githubusercontent.com/MicrosoftDocs/Virtualization-Documentation/main/hyperv-tools/Convert-WindowsImage/Convert-WindowsImage.ps1',
  [int]$MemoryGB          = 8,
  [int]$CpuCount          = 4,
  [int]$DiskGB            = 64,
  [int]$ProvisioningTimeoutMin = 40,
  [switch]$Force,
  # Resume a crashed run: the VM already exists and is (or was) provisioning.
  # Skips ISO/VHDX build, payload injection and VM creation; jumps straight to
  # the provisioning wait + snapshot. Use after the script died mid-Wait (e.g.
  # the pre-sshd SSH-probe stderr crash) with a VM left running.
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vhdxPath  = Join-Path $WorkDir "$VmName.vhdx"
$stageDir  = Join-Path $WorkDir 'inject'   # files copied into the VHDX offline
$converter = Join-Path $WorkDir 'Convert-WindowsImage.ps1'

function Info  { param($m) Write-Host "[build] $m" -ForegroundColor Cyan }
function Warn  { param($m) Write-Host "[build] $m" -ForegroundColor Yellow }

# Live "elapsed mm:ss" heartbeat from a side thread so long silent native calls
# don't look hung. -StreamingHost is load-bearing: without it the thread-job's
# Write-Host is buffered until Receive-Job, i.e. not live.
function Start-Heartbeat {
  param([string]$Label)
  if (-not (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue)) {
    Warn "Start-ThreadJob unavailable; '$Label' runs without a live heartbeat"; return $null
  }
  Start-ThreadJob -StreamingHost $Host -ArgumentList $Label -ScriptBlock {
    param($l); $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($true) { Start-Sleep -Seconds 30; Write-Host "[build] $l -- elapsed $($sw.Elapsed.ToString('mm\:ss'))" -ForegroundColor DarkCyan }
  }
}
function Stop-Heartbeat {
  param($Job)
  if ($Job) { $Job | Stop-Job -EA SilentlyContinue; $Job | Remove-Job -Force -EA SilentlyContinue }
}

# Validate the answer file BEFORE the 30-60 min ISO->VHDX conversion so a
# malformed or mis-placed setting fails in seconds -- not after a booted guest
# rejects unattend.xml deep in the specialize pass.
function Test-Unattend {
  param([string]$Path)
  if (-not (Test-Path $Path)) { throw "AutoUnattend.xml not found at $Path" }
  $doc = New-Object System.Xml.XmlDocument
  try { $doc.Load($Path) }   # .Load reads the file directly: BOM- and encoding-safe
  catch { throw "AutoUnattend.xml is not well-formed XML: $($_.Exception.Message)" }

  $ns = New-Object System.Xml.XmlNamespaceManager $doc.NameTable
  $ns.AddNamespace('u', 'urn:schemas-microsoft-com:unattend')
  # RunSynchronous is a child of Microsoft-Windows-Deployment, never Shell-Setup;
  # mis-placing it makes Setup reject the whole specialize pass with
  # "A component or setting specified in the answer file does not exist."
  $bad = $doc.SelectNodes(
    "//u:component[@name='Microsoft-Windows-Shell-Setup']/u:RunSynchronous", $ns)
  if ($bad.Count -gt 0) {
    throw 'AutoUnattend.xml: RunSynchronous is under Shell-Setup; it belongs to the Microsoft-Windows-Deployment component'
  }
  Info 'AutoUnattend.xml validated (well-formed; RunSynchronous placement OK)'
}

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
  if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    throw 'Hyper-V PowerShell module not available.'
  }
  New-Item -ItemType Directory -Force -Path $WorkDir, $stageDir | Out-Null

  $drive = (Get-Item $WorkDir).PSDrive.Name
  $freeGB = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
  if ($freeGB -lt 40) { throw "need >= 40GB free on $drive`: only ${freeGB}GB" }

  if (-not (Test-Path $IsoPath)) {
    throw "Win11 eval ISO not found at $IsoPath. Download the Windows 11 Enterprise 90-day evaluation ISO (see README.md) and place it there, or pass -IsoPath."
  }
  if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
    throw "vSwitch '$SwitchName' not found. Create one or pass -SwitchName."
  }
  Info "prereqs OK -- ${freeGB}GB free on $drive, ISO present, switch '$SwitchName'"
}

# ---- 2. stage injection payload --------------------------------------------
function Get-File {
  param([string]$Url, [string]$Dest, [string]$Label)
  if (Test-Path $Dest) { Info "$Label already present ($Dest)"; return }
  Info "downloading $Label ..."
  $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing }
  finally { $ProgressPreference = $old }
}

function New-InjectionPayload {
  if (-not (Test-Path $HostPubKeyPath)) {
    throw "host SSH pubkey not found at $HostPubKeyPath. Generate one (ssh-keygen -t ed25519) or pass -HostPubKeyPath."
  }
  Copy-Item $HostPubKeyPath (Join-Path $stageDir 'host_id.pub') -Force
  Copy-Item (Join-Path $scriptDir 'First-Boot.ps1') $stageDir -Force
  Get-File $WslKernelUrl   (Join-Path $stageDir 'wsl_update_x64.msi') 'WSL2 kernel MSI'
  Get-File $UbuntuRootfsUrl (Join-Path $stageDir 'ubuntu-jammy.tar.gz') 'Ubuntu-22.04 rootfs'
  Info "injection payload staged in $stageDir"
}

# ---- 3. ISO -> VHDX (offline WIM apply, unattend baked in) ------------------
function New-BaseVhdx {
  if (Test-Path $vhdxPath) {
    if (-not $Force) { Info "VHDX already exists ($vhdxPath); reuse (pass -Force to rebuild)"; return }
    Remove-Item $vhdxPath -Force
  }
  Get-File $ConvertImageUrl $converter 'Convert-WindowsImage.ps1'
  . $converter   # dot-source to expose the Convert-WindowsImage function
  $unattend = Join-Path $scriptDir 'AutoUnattend.xml'
  Test-Unattend $unattend   # fail fast on a bad answer file, before the long conversion
  Info "converting ISO -> VHDX (edition '$Edition', ${DiskGB}GB dynamic UEFI) -- 30-60 min; -Verbose + a 30s heartbeat prove it is alive ..."
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $hb = Start-Heartbeat 'converting ISO -> VHDX'
  try {
    Convert-WindowsImage -SourcePath $IsoPath -Edition $Edition `
      -VHDPath $vhdxPath -VHDFormat VHDX -DiskLayout UEFI `
      -SizeBytes ($DiskGB * 1GB) -UnattendPath $unattend -Verbose
  } finally { Stop-Heartbeat $hb }
  if (-not (Test-Path $vhdxPath)) { throw 'Convert-WindowsImage did not produce a VHDX' }
  Info "VHDX built: $vhdxPath in $($sw.Elapsed.ToString('mm\:ss'))"
}

function Copy-PayloadIntoVhdx {
  # Mount the freshly-built VHDX and drop the injection payload at
  # C:\provisioning so First-Boot.ps1 (referenced by AutoUnattend) can find it.
  Info 'mounting VHDX to inject C:\provisioning ...'
  $disk = Mount-VHD -Path $vhdxPath -Passthru | Get-Disk
  try {
    $vol = $disk | Get-Partition |
      Where-Object { $_.DriveLetter } |
      Get-Volume | Where-Object { $_.FileSystem -eq 'NTFS' } |
      Sort-Object Size -Descending | Select-Object -First 1
    if (-not $vol) { throw 'no NTFS volume with a drive letter on the mounted VHDX' }
    $target = "$($vol.DriveLetter):\provisioning"
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item (Join-Path $stageDir '*') $target -Recurse -Force
    Info "payload copied to VHDX $target"
  } finally {
    Dismount-VHD -Path $vhdxPath
  }
}

# ---- 4. create + provision the VM ------------------------------------------
function New-TestVm {
  if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) {
    if (-not $Force) { Info "VM '$VmName' already exists; reuse (pass -Force to recreate)"; return }
    Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue
    Remove-VM -Name $VmName -Force
  }
  Info "creating Gen2 VM '$VmName' (${MemoryGB}GB static RAM, $CpuCount vCPU) ..."
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) `
    -VHDPath $vhdxPath -SwitchName $SwitchName | Out-Null
  Set-VMMemory  -VMName $VmName -DynamicMemoryEnabled $false   # nested-virt needs static RAM
  Set-VMProcessor -VMName $VmName -Count $CpuCount -ExposeVirtualizationExtensions $true
  Set-VM -Name $VmName -CheckpointType Standard -AutomaticCheckpointsEnabled $false
  # Gen2 + Win11 wants Secure Boot + vTPM. Secure Boot is on by default; add vTPM.
  Set-VMKeyProtector -VMName $VmName -NewLocalKeyProtector
  Enable-VMTPM -VMName $VmName
  # Attach the ISO for first boot (setup completes specialize/oobe from the VHDX).
  Add-VMDvdDrive -VMName $VmName -Path $IsoPath
  Info "VM created; nested-virt exposed, vTPM enabled, ISO attached"
}

function Wait-Provisioning {
  # First-Boot.ps1 writes C:\provisioning-complete.txt inside the guest. Poll by
  # remounting the VHDX between checks would fight the running VM, so instead we
  # SSH-probe: the guest's OpenSSH comes up mid-provisioning, and the completion
  # file is readable over SSH once written. Fall back to a fixed wait if SSH
  # never answers (headless host with no key path) -- see README troubleshooting.
  Info "starting VM; waiting up to ${ProvisioningTimeoutMin}min for provisioning ..."
  if ((Get-VM -Name $VmName).State -ne 'Running') { Start-VM -Name $VmName }
  $deadline = (Get-Date).AddMinutes($ProvisioningTimeoutMin)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ip = $null
  do {
    Start-Sleep -Seconds 20
    $elapsed = $sw.Elapsed.ToString('mm\:ss')
    if (-not $ip) {
      $ip = (Get-VMNetworkAdapter -VMName $VmName).IPAddresses |
        Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
      if ($ip) { Info "guest IP: $ip" }
    }
    if ($ip) {
      # The guest's OpenSSH is absent for the first ~15-25min of boot, so early
      # probes time out. Under $ErrorActionPreference=Stop, PS 5.1 turns a native
      # command's stderr into a terminating NativeCommandError, and 2>$null does
      # not fully suppress it -- so wrap in try/catch and treat any failure (or
      # non-zero exit) as a plain 'WAIT'. This keeps the loop (and its per-tick
      # Info heartbeat below) alive until sshd answers.
      $probe = 'WAIT'
      try {
        $probe = & ssh -o BatchMode=yes -o StrictHostKeyChecking=no `
          -o ConnectTimeout=5 "Administrator@$ip" `
          'if (Test-Path C:\provisioning-complete.txt) { "DONE" } elseif (Test-Path C:\provisioning-failed.txt) { "FAILED" } else { "WAIT" }' 2>$null
        if ($LASTEXITCODE -ne 0) { $probe = 'WAIT' }
      } catch { $probe = 'WAIT' }
      if ($probe -match 'DONE')   { Info "provisioning complete (elapsed $elapsed)"; return $ip }
      if ($probe -match 'FAILED') { throw 'guest provisioning failed -- see C:\provisioning\first-boot.log inside the VM' }
    }
    Info "provisioning... elapsed $elapsed ($(if ($ip) { "guest $ip, installing/oobe" } else { 'waiting for guest IP' }))"
  } while ((Get-Date) -lt $deadline)
  throw "provisioning did not complete within ${ProvisioningTimeoutMin}min (SSH reachable=$([bool]$ip))"
}

# ---- 5. finalize: detach ISO, shut down, snapshot --------------------------
function Complete-Base {
  param([string]$GuestIp)
  Info 'detaching ISO + shutting down guest cleanly ...'
  $dvd = Get-VMDvdDrive -VMName $VmName
  if ($dvd) { $dvd | Remove-VMDvdDrive }
  Stop-VM -Name $VmName -Force
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-VM -Name $VmName).State -ne 'Off' -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
  }
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
  Info "SSH target     : Administrator@$GuestIp  (port 22, key: $HostPubKeyPath)"
  Info "Ubuntu / dev   : Ubuntu-22.04, user 'dev' (same host pubkey)"
  Info 'Next: run the Phase 66h.2 orchestrator to execute a test run.'
  Info '=================================================='
}

# ---- run --------------------------------------------------------------------
Test-Prereqs
if ($Resume) {
  if (-not (Get-VM -Name $VmName -ErrorAction SilentlyContinue)) {
    throw "-Resume: VM '$VmName' not found -- nothing to resume. Run without -Resume to build from scratch."
  }
  if (Get-VMSnapshot -VMName $VmName -Name $SnapshotName -ErrorAction SilentlyContinue) {
    Warn "-Resume: snapshot '$SnapshotName' already exists -- base image looks complete; leaving it. Pass -Force (no -Resume) to rebuild."
    return
  }
  Info "resume: VM '$VmName' exists, no snapshot yet -- skipping build/inject/create, continuing to provisioning wait"
} else {
  New-InjectionPayload
  New-BaseVhdx
  Copy-PayloadIntoVhdx
  New-TestVm
}
$guestIp = Wait-Provisioning
Complete-Base -GuestIp $guestIp
