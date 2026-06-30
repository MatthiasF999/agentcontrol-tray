<#
  AgentControl bootstrapper worker.

  Runs hidden, driven by agentcontrol-bootstrapper.nsi. Does the three
  things the stock NSIS toolchain cannot do without third-party plugins:
  TLS download, JSON parse, and SHA256 verify. Communicates back to the
  NSIS UI purely through small files in -WorkDir (no stdout coupling):

    phase.txt    human-readable status line (no trailing newline)
    pct.txt      download percent, integer 0-100
    path.txt     verified installer path        (written before result)
    version.txt  resolved manifest version       (written before result)
    error.txt    failure message                 (written before result)
    result.txt   final sentinel: "DONE" or "ERR" (written LAST)

  NSIS polls result.txt; because it is written last, the companion files
  are guaranteed present once the sentinel appears.
#>
param(
  [Parameter(Mandatory = $true)][string]$ManifestUrl,
  [Parameter(Mandatory = $true)][string]$WorkDir
)

$ErrorActionPreference = 'Stop'

function W([string]$name, [string]$value) {
  [System.IO.File]::WriteAllText((Join-Path $WorkDir $name), $value)
}
function Fail([string]$message) {
  W 'error.txt' $message
  W 'result.txt' 'ERR'
  exit 1
}

# PS 5.1 on Win10 defaults to TLS1.0 for some calls; opt into modern TLS.
try {
  [Net.ServicePointManager]::SecurityProtocol = `
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
} catch { }

W 'pct.txt' '0'
W 'phase.txt' 'Fetching manifest...'

try {
  $manifest = Invoke-RestMethod -UseBasicParsing -Uri $ManifestUrl -TimeoutSec 30
} catch {
  Fail 'Could not reach the AgentControl update server.'
}

$url = [string]$manifest.windows.url
$sha = [string]$manifest.windows.sha256
$ver = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($sha)) {
  Fail 'Update manifest is missing windows.url / windows.sha256.'
}

$out = Join-Path $WorkDir 'agentcontrol-setup.exe'
W 'phase.txt' "Downloading AgentControl $ver..."

try {
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.UserAgent = 'AgentControlBootstrapper'
  $req.AllowAutoRedirect = $true
  $resp = $req.GetResponse()
  $total = [int64]$resp.ContentLength
  $stream = $resp.GetResponseStream()
  $file = [System.IO.File]::Create($out)
  $buffer = New-Object byte[] 65536
  $soFar = [int64]0
  while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $file.Write($buffer, 0, $read)
    $soFar += $read
    if ($total -gt 0) { W 'pct.txt' ([string][math]::Floor($soFar * 100 / $total)) }
  }
  $file.Close(); $stream.Close(); $resp.Close()
} catch {
  Fail 'Download failed. Check your network connection and try again.'
}

W 'pct.txt' '100'
W 'phase.txt' 'Verifying integrity...'

$actual = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
if ($actual -ine $sha) {
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  Fail 'Checksum mismatch - the download was corrupted or tampered with.'
}

W 'phase.txt' 'Starting installer...'
W 'path.txt' $out
W 'version.txt' $ver
W 'result.txt' 'DONE'
exit 0
