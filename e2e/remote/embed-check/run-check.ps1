# dsh-remote-go · run the V0 iframe embedding check
#
# Installs puppeteer-core into this folder (if missing) and runs embed-check.mjs
# against the currently tunnelled remote DSH web server. Reads ../.state.json and
# ../.token written by remote.ps1.
#
#   pwsh -File e2e/remote/embed-check/run-check.ps1
#   pwsh -File e2e/remote/embed-check/run-check.ps1 -Chrome "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
[CmdletBinding()]
param(
  [int]$RemotePort = 0,
  [string]$TokenFile = '',
  [string]$Chrome = '',
  [int]$TimeoutMs = 45000
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'

$Here = Split-Path -Parent $PSCommandPath
$RemoteDir = Split-Path -Parent $Here
$StatePath = Join-Path $RemoteDir '.state.json'

$node = if ($env:DSH_NODE) { $env:DSH_NODE } else { 'C:\Users\zhang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' }
$pnpm = if ($env:DSH_PNPM) { $env:DSH_PNPM } else { 'C:\Users\zhang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' }
if (-not (Test-Path -LiteralPath $node)) { throw "node not found: $node (set DSH_NODE)" }
if (-not (Test-Path -LiteralPath $pnpm)) { throw "pnpm not found: $pnpm (set DSH_PNPM)" }

if (-not (Test-Path -LiteralPath $StatePath)) { throw "missing $StatePath; run e2e/remote/remote.ps1 start first" }
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json

if ($RemotePort -le 0) { $RemotePort = [int]$state.remotePort }
if ([string]::IsNullOrWhiteSpace($TokenFile)) { $TokenFile = Join-Path $RemoteDir '.token' }
if (-not (Test-Path -LiteralPath $TokenFile)) { throw "missing token file: $TokenFile" }
if ([string]::IsNullOrWhiteSpace($Chrome)) {
  $Chrome = if ($env:CHROME_PATH) { $env:CHROME_PATH } else { 'C:\Users\zhang\scoop\shims\chrome.exe' }
}
if (-not (Test-Path -LiteralPath $Chrome)) { throw "chrome not found: $Chrome (pass -Chrome or set CHROME_PATH)" }

if (-not (Test-Path -LiteralPath (Join-Path $Here 'node_modules/puppeteer-core'))) {
  Write-Host '==> installing puppeteer-core (no browser download)'
  Push-Location $Here
  try {
    & $node $pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

Write-Host "==> iframe check: remote 127.0.0.1:$RemotePort via puppeteer-core ($Chrome)"
& $node (Join-Path $Here 'embed-check.mjs') `
  --remote-port $RemotePort `
  --token-file $TokenFile `
  --chrome $Chrome `
  --timeout-ms $TimeoutMs
exit $LASTEXITCODE
