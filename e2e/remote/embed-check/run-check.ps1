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

$node = if ($env:DSH_NODE) { $env:DSH_NODE } else { (Get-Command node -ErrorAction SilentlyContinue)?.Source }
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  throw 'node not found on PATH; install Node >= 24 or set DSH_NODE to the node executable'
}

# pnpm is only needed when puppeteer-core has not been installed yet.
$pnpmJs = if ($env:DSH_PNPM) { $env:DSH_PNPM } else { $null }
$pnpmExe = if (-not $pnpmJs) { (Get-Command pnpm -ErrorAction SilentlyContinue)?.Source } else { $null }
if (-not $pnpmJs -and -not $pnpmExe) { throw 'pnpm not found on PATH; install pnpm 11 or set DSH_PNPM (pnpm.mjs) or install e2e/remote/embed-check dependencies manually' }

if (-not (Test-Path -LiteralPath $StatePath)) { throw "missing $StatePath; run e2e/remote/remote.ps1 start first" }
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json

if ($RemotePort -le 0) { $RemotePort = [int]$state.remotePort }
if ([string]::IsNullOrWhiteSpace($TokenFile)) { $TokenFile = Join-Path $RemoteDir '.token' }
if (-not (Test-Path -LiteralPath $TokenFile)) { throw "missing token file: $TokenFile" }
if ([string]::IsNullOrWhiteSpace($Chrome)) {
  $Chrome = if ($env:CHROME_PATH) { $env:CHROME_PATH } else { (Get-Command chrome, msedge -ErrorAction SilentlyContinue | Select-Object -First 1)?.Source }
}
if (-not $Chrome -or -not (Test-Path -LiteralPath $Chrome)) { throw "Chrome/Edge not found: pass -Chrome <path>, set CHROME_PATH, or put chrome/msedge on PATH" }

if (-not (Test-Path -LiteralPath (Join-Path $Here 'node_modules/puppeteer-core'))) {
  Write-Host '==> installing puppeteer-core (no browser download)'
  Push-Location $Here
  try {
    if ($pnpmJs) {
      & $node $pnpmJs install
    } else {
      & $pnpmExe install
    }
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
