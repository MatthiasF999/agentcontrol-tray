<#
.SYNOPSIS
  Quarterly refresh check for the Microsoft "Windows 11 dev environment" base
  image. Refetches the Hyper-V Quick Create gallery manifest, compares the
  current disk sha256 against the hash recorded at the last import, and -- if
  Microsoft has published a newer image -- re-runs Import-DevVM.ps1 -Force to
  rebuild the `clean-agentcontrol-base` snapshot from the fresh disk.

  Why this exists: the gallery image is a 90-day Enterprise Evaluation. Import
  runs `slmgr /rearm` so each reverted snapshot is licensed, but rearms are
  finite (~5) and Microsoft periodically replaces the disk with a newer build
  under the SAME gallery entry (only the URI + hash change). This script is the
  one automated touch-point for that: run it on a schedule (Phase 66i wires it
  as a quarterly job) and it is a no-op until the hash actually moves.

  Idempotent + safe: on no change it does nothing; on change (or -Force) it
  delegates the whole rebuild to Import-DevVM.ps1. Run elevated.

.EXAMPLE
  pwsh -File Update-DevVM.ps1              # check; rebuild only if the hash moved
  pwsh -File Update-DevVM.ps1 -CheckOnly   # report drift, never rebuild (CI gate)
  pwsh -File Update-DevVM.ps1 -Force       # rebuild regardless
#>
[CmdletBinding()]
param(
  [string]$WorkDir    = 'C:\Hyper-V\AgentControlTest',
  [string]$GalleryUrl = 'https://go.microsoft.com/fwlink/?linkid=851584',
  [string]$ImageName  = 'Windows 11 dev environment',
  # Records the disk hash + URI of the last successful import.
  [string]$StatePath  = '',
  [switch]$CheckOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $StatePath) { $StatePath = Join-Path $WorkDir 'devvm\imported-image.json' }

function Info { param($m) Write-Host "[update] $m" -ForegroundColor Cyan }

# Current gallery disk (URI + sha256) for $ImageName. Mirrors Import-DevVM's
# Resolve-GalleryImage: strip Microsoft's trailing commas before ConvertFrom-Json.
function Get-GalleryDisk {
  # UTF-16 + BOM manifest: download + BOM-aware read (see Import-DevVM.ps1).
  $manifest = Join-Path $WorkDir 'devvm\gallery.json'
  New-Item -ItemType Directory -Force -Path (Split-Path $manifest) | Out-Null
  Invoke-WebRequest -Uri $GalleryUrl -OutFile $manifest -UseBasicParsing
  $raw   = Get-Content -Raw $manifest
  $clean = [regex]::Replace($raw, ',(\s*[}\]])', '$1')
  $img   = ($clean | ConvertFrom-Json).images | Where-Object { $_.name -eq $ImageName } | Select-Object -First 1
  if (-not $img) { throw "gallery has no image named '$ImageName'" }
  return [pscustomobject]@{ Uri = $img.disk.uri; Sha256 = ($img.disk.hash -replace '^sha256:', ''); Entry = $img.disk.archiveRelativePath }
}

$current = Get-GalleryDisk
$knownHash = if (Test-Path $StatePath) { (Get-Content -Raw $StatePath | ConvertFrom-Json).Sha256 } else { $null }
Info "gallery sha256 : $($current.Sha256)"
Info "imported sha256: $(if ($knownHash) { $knownHash } else { '(none recorded)' })"

$drifted = ($knownHash -ne $current.Sha256)
if (-not $drifted -and -not $Force) { Info 'base image is current -- nothing to do'; return }
if ($drifted) { Info 'Microsoft published a newer dev image (hash changed)' }

if ($CheckOnly) {
  Info 'CheckOnly: drift detected but not rebuilding (exit 2 for CI)'
  exit 2
}

Info 'rebuilding base image via Import-DevVM.ps1 -Force ...'
& (Join-Path $scriptDir 'Import-DevVM.ps1') -WorkDir $WorkDir -GalleryUrl $GalleryUrl -ImageName $ImageName -Force
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Import-DevVM.ps1 failed (exit $LASTEXITCODE)" }

New-Item -ItemType Directory -Force -Path (Split-Path $StatePath) | Out-Null
$current | ConvertTo-Json | Set-Content -Path $StatePath -Encoding ascii
Info "recorded new image hash to $StatePath"
Info 'base image refreshed'
