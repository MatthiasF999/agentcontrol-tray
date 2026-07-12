<#
.SYNOPSIS
  UIAutomation + screenshot + result helpers for the AgentControl Hyper-V VM
  test. Imported by runner-vm.ps1 inside the guest VM.

  Lifted from scripts/sandbox-test/helpers.psm1 (Phase 66d). Behaviour is
  identical; only the doc context differs — here the output root is a plain
  guest folder (C:\test-output) that the WSL orchestrator scp's back, rather
  than a Sandbox MappedFolder.

  Exports: Set-OutputRoot, Save-Screenshot, Find-Window, Find-Button,
           Invoke-Button, Write-Result.

  Screenshot caveat: CopyFromScreen only captures a live desktop. When
  runner-vm.ps1 is invoked over a non-interactive SSH session (Session 0),
  the grab may be black — the WSL-flow steps are wsl.exe CLI so this only
  matters to the tray flow's UIAutomation. See README troubleshooting.
#>

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:OutputRoot = $null
$script:ShotRoot   = $null
$script:ShotIndex  = 0

function Set-OutputRoot {
  <# Point every screenshot / result file at $Path\... Creates the tree. #>
  param([Parameter(Mandatory)][string]$Path)
  $script:OutputRoot = $Path
  $script:ShotRoot   = Join-Path $Path 'screenshots'
  New-Item -ItemType Directory -Force -Path $script:ShotRoot | Out-Null
  return $script:OutputRoot
}

function Save-Screenshot {
  <#
    Grab the full virtual screen to screenshots/NNN-label.png. Returns path.
    Never fatal: a Session-0 SSH context yields a black frame, not an error;
    the step it documents still records its own pass/fail.
  #>
  param([Parameter(Mandatory)][string]$Label)
  if (-not $script:ShotRoot) { throw 'Set-OutputRoot must run before Save-Screenshot.' }
  $script:ShotIndex++
  $safe = ($Label -replace '[^\w\-]', '-')
  $name = ('{0:000}-{1}.png' -f $script:ShotIndex, $safe)
  $file = Join-Path $script:ShotRoot $name
  try {
    $vs   = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp  = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size)
      $g.Dispose()
      $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
  } catch {
    # Non-interactive session: record the intent, don't abort the run.
    Set-Content -LiteralPath ($file -replace '\.png$', '.txt') `
      -Value "screenshot unavailable: $($_.Exception.Message)"
  }
  return $file
}

function Find-Window {
  <#
    Wait up to $TimeoutSec for a top-level window whose Name contains any of
    $NameLike (case-insensitive substring). Returns the AutomationElement or
    $null on timeout.
  #>
  param(
    [Parameter(Mandatory)][string[]]$NameLike,
    [int]$TimeoutSec = 60
  )
  $root     = [System.Windows.Automation.AutomationElement]::RootElement
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    $kids = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $kids) {
      $n = $w.Current.Name
      if ([string]::IsNullOrWhiteSpace($n)) { continue }
      foreach ($needle in $NameLike) {
        if ($n.ToLower().Contains($needle.ToLower())) { return $w }
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Find-Button {
  <#
    Search $Window's subtree for a Button whose Name matches any candidate in
    $Names (case-insensitive, ignoring '&' accelerators and surrounding
    whitespace). Locale-agnostic: pass every locale's label as a candidate.
    Returns the AutomationElement or $null.
  #>
  param(
    [Parameter(Mandatory)][System.Windows.Automation.AutomationElement]$Window,
    [Parameter(Mandatory)][string[]]$Names,
    [int]$TimeoutSec = 30
  )
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $wanted   = $Names | ForEach-Object { ($_ -replace '[&\s]', '').ToLower() }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    $btns = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($b in $btns) {
      $label = ($b.Current.Name -replace '[&\s]', '').ToLower()
      if ($wanted -contains $label) { return $b }
    }
    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Invoke-Button {
  <# Click a button element via the Invoke pattern (falls back to focus+space). #>
  param([Parameter(Mandatory)][System.Windows.Automation.AutomationElement]$Button)
  $pattern = $null
  if ($Button.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    return $true
  }
  try {
    $Button.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait(' ')
    return $true
  } catch { return $false }
}

function Write-Result {
  <# Serialise the result object to output/result.json (UTF-8, no BOM). #>
  param([Parameter(Mandatory)][object]$Result)
  if (-not $script:OutputRoot) { throw 'Set-OutputRoot must run before Write-Result.' }
  $file = Join-Path $script:OutputRoot 'result.json'
  $json = $Result | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
  return $file
}

Export-ModuleMember -Function Set-OutputRoot, Save-Screenshot, Find-Window, `
  Find-Button, Invoke-Button, Write-Result
