param()
# Stop the isolated control DSH instance started by start-control.ps1.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$statePath = Join-Path $root 'e2e/control/.state.json'
if (-not (Test-Path $statePath)) {
  Write-Output 'control not running (no state file)'
  return
}
try {
  $state = Get-Content $statePath -Raw | ConvertFrom-Json
  if ($state.pid) {
    $proc = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $state.pid -Force
      Write-Output "stopped control pid=$($state.pid)"
    } else {
      Write-Output "control pid=$($state.pid) already gone"
    }
  }
} catch {
  Write-Output "failed to read state: $_"
}
Remove-Item $statePath -Force -ErrorAction SilentlyContinue
