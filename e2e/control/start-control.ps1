param(
  [switch]$Restart,
  [int]$ReadyTimeoutSec = 60
)
# Start the isolated control DSH instance used by the end-to-end tests.
# Writes e2e/control/.state.json (port, token, pid, log path) and keeps running.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Resolve the Node.js binary without assuming an installation path:
#   $env:E2E_NODE wins, otherwise the first `node` on PATH.
function Resolve-NodeExe {
  if ($env:E2E_NODE) {
    if (-not (Test-Path -LiteralPath $env:E2E_NODE)) {
      throw "E2E_NODE is set but does not point at an existing file: $($env:E2E_NODE)"
    }
    return (Resolve-Path -LiteralPath $env:E2E_NODE).Path
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) {
    $candidate = if ($command.Source) { $command.Source } else { $command.Path }
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw @"
Node.js was not found. The Windows E2E control instance needs Node 24 to run DSH.
Install Node 24 and put it on PATH, or point this script at an existing binary:
  `$env:E2E_NODE = 'C:\Program Files\nodejs\node.exe'
"@
}
$node = Resolve-NodeExe
$dshBin = Join-Path $root 'e2e/control/node_modules/@deepseek-ai/dsh/lib/bin.js'
if (-not (Test-Path $dshBin)) { throw "control runtime missing; run: pnpm --dir e2e/control add --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.1" }
$controlHome = Join-Path $root 'e2e/control/home'
$logs = Join-Path $root 'e2e/control/logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs 'control.log'
$errLog = Join-Path $logs 'control.err.log'
$statePath = Join-Path $root 'e2e/control/.state.json'

if (Test-Path $statePath) {
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    if ($state.pid) {
      $existing = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
      if ($existing -and -not $Restart) {
        Write-Output "control already running: pid=$($state.pid) port=$($state.port)"
        return
      }
      if ($existing) { Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
    }
  } catch { }
}

if (Test-Path $log) { Remove-Item $log -Force }
if (Test-Path $errLog) { Remove-Item $errLog -Force }
$env:DSH_HOME = $controlHome
$proc = Start-Process -FilePath $node -ArgumentList @($dshBin, '--profile', 'web', '--no-open', '--port', '0') `
  -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -NoNewWindow
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$line = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  if ($proc.HasExited) { break }
  if (Test-Path $log) {
    $match = Select-String -Path $log -Pattern 'dsh web: (\S+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($match) { $line = $match.Matches[0].Groups[1].Value; break }
  }
}
if (-not $line) {
  Write-Output "control failed to start; log tail:"
  if (Test-Path $log) { Get-Content $log -Tail 40 }
  if (Test-Path $errLog) { Get-Content $errLog -Tail 40 }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  throw 'control DSH did not print its readiness line'
}
$uri = [uri]$line
$token = ''
$query = $uri.Query
if ($query.StartsWith('?')) { $query = $query.Substring(1) }
foreach ($pair in $query.Split('&')) {
  if ($pair.StartsWith('token=')) { $token = [uri]::UnescapeDataString($pair.Substring('token='.Length)); break }
}
$state = [ordered]@{
  pid = $proc.Id
  port = $uri.Port
  token = $token
  url = $line
  origin = "http://127.0.0.1:$($uri.Port)"
  log = $log
  errLog = $errLog
  dshHome = $controlHome
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$state | ConvertTo-Json -Depth 4 | Set-Content -Path $statePath -Encoding UTF8
Write-Output "control started: pid=$($state.pid) port=$($state.port) url=$line"
