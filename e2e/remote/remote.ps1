# dsh-remote-go · V0 local driver (Windows PowerShell 7)
#
# Talk to the remote test host over SSH, run the remote-side shell scripts, keep
# a local SSH tunnel open, and persist run state:
#   .state.json  remote port / pid / log / local tunnel port
#   .token       launch token (needs care: do not commit)
#
# Usage (from repo root or this directory):
#   pwsh -File e2e/remote/remote.ps1 setup        # bootstrap Node + dsh on remote
#   pwsh -File e2e/remote/remote.ps1 start        # start remote web + local tunnel
#   pwsh -File e2e/remote/remote.ps1 status       # runtime + process inspection (read-only)
#   pwsh -File e2e/remote/remote.ps1 stop         # stop remote web + local tunnel
#   pwsh -File e2e/remote/remote.ps1 all          # setup + start
#
# V0 handover note: the plugin owns the remote `dsh web` lifecycle in the real
# E2E, reusing the isolated runtime installed here. Only use `start`/`stop` for
# manual V0 reproduction; `status` is always safe (it never starts or stops).
#
# Env: DSH_REMOTE_HOST (required, ssh alias or user@host), DSH_REMOTE_LOCAL_PORT (default: reuse remote port)
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'start', 'stop', 'status', 'tunnel-start', 'tunnel-stop', 'all')]
  [string]$Action = 'status',

  [string]$RemoteHost = $(if ($env:DSH_REMOTE_HOST) { $env:DSH_REMOTE_HOST } else { '' }),

  [int]$LocalPort = $(if ($env:DSH_REMOTE_LOCAL_PORT) { [int]$env:DSH_REMOTE_LOCAL_PORT } else { 0 })
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RemoteHost)) {
  throw 'RemoteHost is required: set DSH_REMOTE_HOST (an ~/.ssh/config alias or user@host) or pass -RemoteHost'
}
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'

$Here = Split-Path -Parent $PSCommandPath
$RemoteRoot = '.dsh-remote-go'
$StatePath = Join-Path $Here '.state.json'
$TokenPath = Join-Path $Here '.token'
$TunnelPidPath = Join-Path $Here '.tunnel.pid'
$TunnelErrLog = Join-Path $Here 'evidence/tunnel.stderr.log'
$TunnelOutLog = Join-Path $Here 'evidence/tunnel.stdout.log'
$RemoteScripts = @('setup-remote.sh', 'start-remote.sh', 'stop-remote.sh', 'status-remote.sh')

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-SshArgs([string]$RemoteCommand) {
  @(
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes',
    $RemoteHost,
    $RemoteCommand
  )
}

# Run one remote command; retry only plausible transport failures.
function Invoke-RemoteCommand {
  param(
    [Parameter(Mandatory)][string]$RemoteCommand,
    [int]$Attempts = 5
  )
  $lastError = ''
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $lines = & ssh @(Get-SshArgs $RemoteCommand) 2>&1
    $code = $LASTEXITCODE
    $text = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
    if ($code -eq 0) { return $text }
    if ($text -match '(?i)(timed out|connection refused|connection reset|broken pipe|kex_exchange_identification|no route to host|network is unreachable|connection closed)') {
      $lastError = $text
      Start-Sleep -Seconds (2 * $attempt)
      continue
    }
    return @{ ExitCode = $code; Output = $text }
  }
  throw "ssh failed after $Attempts attempts: $RemoteCommand`n$lastError"
}

function Invoke-RemoteCommandChecked([string]$RemoteCommand) {
  $result = Invoke-RemoteCommand -RemoteCommand $RemoteCommand
  if ($result -is [hashtable]) {
    throw "remote command failed (exit $($result.ExitCode)): $RemoteCommand`n$($result.Output)"
  }
  return $result
}

function ConvertFrom-KeyValue([string]$Text) {
  $map = @{}
  foreach ($line in ($Text -split "`n")) {
    $clean = $line.TrimEnd("`r")
    if ($clean -match '^([A-Za-z0-9_]+)=(.*)$') {
      $map[$Matches[1]] = $Matches[2]
    }
  }
  return $map
}

function Push-RemoteScripts {
  Write-Step "uploading remote scripts to ${RemoteHost}:~/$RemoteRoot/scripts"
  Invoke-RemoteCommandChecked "mkdir -p ~/$RemoteRoot/scripts" | Out-Null
  foreach ($name in $RemoteScripts) {
    $localPath = Join-Path $Here $name
    if (-not (Test-Path -LiteralPath $localPath)) { continue }
    $text = [IO.File]::ReadAllText($localPath) -replace "`r`n", "`n"
    if (-not $text.EndsWith("`n")) { $text += "`n" }
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $b64 = [Convert]::ToBase64String($bytes)

    $uploaded = $false
    for ($attempt = 1; $attempt -le 4 -and -not $uploaded; $attempt++) {
      # base64 keeps the byte stream ASCII-only: PowerShell->native stdin adds a
      # trailing newline, which the remote decoder ignores, so md5 comparison is exact.
      $b64 | & ssh @(Get-SshArgs "base64 -d -i > ~/$RemoteRoot/scripts/$name") 2>$null
      if ($LASTEXITCODE -eq 0) { $uploaded = $true; break }
      Start-Sleep -Seconds 2
    }
    if (-not $uploaded) { throw "upload failed: $name" }

    $remoteMd5 = (Invoke-RemoteCommandChecked "md5sum ~/$RemoteRoot/scripts/$name | cut -d' ' -f1").Trim()
    $localMd5 = [BitConverter]::ToString([Security.Cryptography.MD5]::HashData($bytes)).Replace('-', '').ToLowerInvariant()
    if ($remoteMd5 -ne $localMd5) { throw "upload checksum mismatch for $name ($remoteMd5 != $localMd5)" }
    Write-Host ("    {0}  ({1} bytes, md5 {2})" -f $name, $bytes.Length, $localMd5)
  }
}

function Invoke-RemoteScript {
  param([Parameter(Mandatory)][string]$Name)
  $result = Invoke-RemoteCommand -RemoteCommand "bash ~/$RemoteRoot/scripts/$Name"
  if ($result -is [hashtable]) {
    return [pscustomobject]@{ ExitCode = $result.ExitCode; Output = $result.Output }
  }
  return [pscustomobject]@{ ExitCode = 0; Output = $result }
}

function Get-HttpCode([int]$Port, [string]$Path = '/') {
  $code = & curl.exe -s -o NUL -m 3 -w '%{http_code}' "http://127.0.0.1:$Port$Path" 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($code)) { return '000' }
  return $code.Trim()
}

function Test-PortFree([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try {
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Get-FreePort {
  for ($i = 0; $i -lt 200; $i++) {
    $candidate = Get-Random -Minimum 20000 -Maximum 60000
    if (Test-PortFree -Port $candidate) { return $candidate }
  }
  throw 'could not find a free local port'
}

function Get-TunnelProcess {
  if (-not (Test-Path -LiteralPath $TunnelPidPath)) { return $null }
  $raw = (Get-Content -LiteralPath $TunnelPidPath -Raw).Trim()
  if ($raw -notmatch '^\d+$') { return $null }
  return Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
}

function Start-Tunnel {
  param([int]$RemotePort)

  $existing = Get-TunnelProcess
  if ($existing) {
    $recorded = if (Test-Path -LiteralPath $StatePath) { Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } else { $null }
    if ($recorded -and $recorded.localPort -and (Get-HttpCode -Port ([int]$recorded.localPort)) -ne '000') {
      Write-Host "    reusing tunnel pid $($existing.Id) on 127.0.0.1:$($recorded.localPort)"
      return [int]$recorded.localPort
    }
    Stop-Process -Id $existing.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $TunnelPidPath -ErrorAction SilentlyContinue
  }

  $requested = if ($LocalPort -gt 0) { $LocalPort } else { $RemotePort }
  $localPort = $requested
  if (-not (Test-PortFree -Port $localPort)) {
    $localPort = Get-FreePort
    Write-Host "    local port $requested busy; using $localPort"
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TunnelErrLog) | Out-Null
  $forward = "127.0.0.1:${localPort}:127.0.0.1:${RemotePort}"
  $sshArgs = @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-L', $forward,
    $RemoteHost
  )
  $proc = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardError $TunnelErrLog -RedirectStandardOutput $TunnelOutLog
  Set-Content -LiteralPath $TunnelPidPath -Value ([string]$proc.Id) -NoNewline -Encoding ascii

  $waited = 0
  while ($waited -lt 40) {
    $code = Get-HttpCode -Port $localPort
    if ($code -ne '000') {
      Write-Host "    tunnel up: 127.0.0.1:$localPort -> ${RemoteHost}:127.0.0.1:$RemotePort (pid $($proc.Id), probe $code)"
      return $localPort
    }
    if ($proc.HasExited) {
      $err = if (Test-Path -LiteralPath $TunnelErrLog) { Get-Content -LiteralPath $TunnelErrLog -Raw } else { '' }
      throw "ssh tunnel exited early (code $($proc.ExitCode)): $err"
    }
    Start-Sleep -Milliseconds 500
    $waited++
  }
  throw "ssh tunnel did not become reachable on 127.0.0.1:$localPort"
}

function Stop-Tunnel {
  $proc = Get-TunnelProcess
  if ($proc) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "    tunnel stopped (pid $($proc.Id))"
  } else {
    Write-Host '    no tunnel process recorded'
  }
  Remove-Item -LiteralPath $TunnelPidPath -ErrorAction SilentlyContinue
}

function Save-Token([string]$Token) {
  [IO.File]::WriteAllText($TokenPath, $Token, [System.Text.UTF8Encoding]::new($false))
  try {
    # R,W plus D (delete) so `stop` can remove the stale token later.
    & icacls $TokenPath /inheritance:r /grant:r "$($env:USERNAME):(R,W,D)" 2>$null | Out-Null
  } catch {
    Write-Host '    (could not tighten .token ACL; file still written)'
  }
}

function Get-RemoteToken {
  $token = (Invoke-RemoteCommandChecked "cat ~/$RemoteRoot/run/web.token").Trim()
  if ($token.Length -lt 16 -or $token -notmatch '^[A-Za-z0-9_-]+$') {
    throw 'unexpected token content from remote run/web.token'
  }
  return $token
}

# ---------------------------------------------------------------------------
switch ($Action) {
  'setup' {
    Push-RemoteScripts
    Write-Step 'remote bootstrap: Node v24.22.2 + @deepseek-ai/dsh@0.2.2-rc.1'
    $result = Invoke-RemoteScript -Name 'setup-remote.sh'
    Write-Host $result.Output
    if ($result.ExitCode -ne 0) { throw "setup-remote.sh failed (exit $($result.ExitCode))" }
  }

  'start' {
    Push-RemoteScripts
    Write-Step 'starting remote DSH web (isolated DSH_HOME, setsid+nohup)'
    $result = Invoke-RemoteScript -Name 'start-remote.sh'
    Write-Host $result.Output
    if ($result.ExitCode -ne 0) { throw "start-remote.sh failed (exit $($result.ExitCode))" }

    $kv = ConvertFrom-KeyValue $result.Output
    if (-not $kv.ContainsKey('PORT')) { throw 'start-remote.sh did not report PORT' }
    $remotePort = [int]$kv['PORT']
    $remotePid = [int]$kv['PID']
    $token = Get-RemoteToken
    Save-Token $token

    Write-Step "opening local SSH tunnel for remote 127.0.0.1:$remotePort"
    $localPort = Start-Tunnel -RemotePort $remotePort

    $state = [ordered]@{
      status            = 'running'
      remoteHost        = $RemoteHost
      runtimeRoot       = "~/$RemoteRoot"
      remotePort        = $remotePort
      localPort         = $localPort
      remotePid         = $remotePid
      tunnelPid         = if (Test-Path -LiteralPath $TunnelPidPath) { [int](Get-Content -LiteralPath $TunnelPidPath -Raw) } else { 0 }
      log               = $kv['LOG']
      dshHome           = $kv['DSH_HOME']
      nodeBin           = "~/$RemoteRoot/node/bin/node"
      dshBin            = "~/$RemoteRoot/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js"
      startCommand      = 'DSH_HOME=~/.dsh-remote-go/home setsid nohup ~/.dsh-remote-go/node/bin/node ~/.dsh-remote-go/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 0 >> ~/.dsh-remote-go/logs/remote-web.log 2>&1 &'
      tokenFile         = $TokenPath
      tokenLength       = if ($kv.ContainsKey('TOKEN_LEN')) { [int]$kv['TOKEN_LEN'] } else { $token.Length }
      tokenPrefix       = if ($kv.ContainsKey('TOKEN_PREFIX')) { $kv['TOKEN_PREFIX'] } else { $token.Substring(0, 6) }
      remoteProbeHttp   = $kv['REMOTE_PROBE_HTTP']
      startupSeconds    = if ($kv.ContainsKey('STARTUP_SECONDS')) { [int]$kv['STARTUP_SECONDS'] } else { 0 }
      localProbeHttp    = Get-HttpCode -Port $localPort
      sshConnection     = $kv['SSH_CONNECTION']
      sshTty            = $kv['SSH_TTY']
      checkedAt         = (Get-Date).ToString('o')
    }
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8

    Write-Step 'local reachability'
    Write-Host ("    GET http://127.0.0.1:{0}/  ->  HTTP {1} (401 expected before token exchange)" -f $localPort, (Get-HttpCode -Port $localPort))
    Write-Host ''
    Write-Host "state file : $StatePath"
    Write-Host "token file : $TokenPath"
    Write-Host "remote log : $($kv['LOG'])"
    Write-Host ("endpoint   : http://127.0.0.1:{0}/" -f $localPort)
  }

  'tunnel-start' {
    if (-not (Test-Path -LiteralPath $StatePath)) { throw "no .state.json; run 'start' first" }
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $localPort = Start-Tunnel -RemotePort ([int]$state.remotePort)
    $state.localPort = $localPort
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
    Write-Host "tunnel: 127.0.0.1:$localPort -> ${RemoteHost}:127.0.0.1:$($state.remotePort)"
  }

  'tunnel-stop' {
    Stop-Tunnel
  }

  'stop' {
    Push-RemoteScripts
    Write-Step 'stopping remote DSH web'
    $result = Invoke-RemoteScript -Name 'stop-remote.sh'
    Write-Host $result.Output
    if ($result.ExitCode -ne 0) { Write-Host "    (stop-remote.sh exit $($result.ExitCode))" }
    Write-Step 'stopping local tunnel'
    Stop-Tunnel
    # The launch token dies with the process: drop the local copy so a stale
    # credential never survives the handover.
    if (Test-Path -LiteralPath $TokenPath) { Remove-Item -LiteralPath $TokenPath -Force }
    if (Test-Path -LiteralPath $StatePath) {
      $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
      $state | Add-Member -NotePropertyName stoppedAt -NotePropertyValue ((Get-Date).ToString('o')) -Force
      $state | Add-Member -NotePropertyName status -NotePropertyValue 'stopped' -Force
      $state | Add-Member -NotePropertyName tokenFile -NotePropertyValue $null -Force
      $state | Add-Member -NotePropertyName tokenPrefix -NotePropertyValue $null -Force
      $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
    }
    Write-Host 'stopped.'
  }

  'status' {
    Push-RemoteScripts
    Write-Step 'remote status'
    $result = Invoke-RemoteScript -Name 'status-remote.sh'
    Write-Host $result.Output
    Write-Step 'local tunnel status'
    $proc = Get-TunnelProcess
    if ($proc) {
      Write-Host "    tunnel pid $($proc.Id) alive"
      if (Test-Path -LiteralPath $StatePath) {
        $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        if ($state.localPort) {
          Write-Host ("    GET http://127.0.0.1:{0}/ -> HTTP {1}" -f $state.localPort, (Get-HttpCode -Port ([int]$state.localPort)))
        }
      }
    } else {
      Write-Host '    no tunnel process recorded'
    }
  }

  'all' {
    Push-RemoteScripts
    Write-Step 'remote bootstrap: Node v24.22.2 + @deepseek-ai/dsh@0.2.2-rc.1'
    $setup = Invoke-RemoteScript -Name 'setup-remote.sh'
    Write-Host $setup.Output
    if ($setup.ExitCode -ne 0) { throw "setup-remote.sh failed (exit $($setup.ExitCode))" }

    Write-Step 'starting remote DSH web (isolated DSH_HOME, setsid+nohup)'
    $result = Invoke-RemoteScript -Name 'start-remote.sh'
    Write-Host $result.Output
    if ($result.ExitCode -ne 0) { throw "start-remote.sh failed (exit $($result.ExitCode))" }

    $kv = ConvertFrom-KeyValue $result.Output
    $remotePort = [int]$kv['PORT']
    $token = Get-RemoteToken
    Save-Token $token
    $localPort = Start-Tunnel -RemotePort $remotePort
    $state = [ordered]@{
      status          = 'running'
      remoteHost      = $RemoteHost
      runtimeRoot     = "~/$RemoteRoot"
      remotePort      = $remotePort
      localPort       = $localPort
      remotePid       = [int]$kv['PID']
      tunnelPid       = if (Test-Path -LiteralPath $TunnelPidPath) { [int](Get-Content -LiteralPath $TunnelPidPath -Raw) } else { 0 }
      log             = $kv['LOG']
      dshHome         = $kv['DSH_HOME']
      nodeBin         = "~/$RemoteRoot/node/bin/node"
      dshBin          = "~/$RemoteRoot/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js"
      startCommand    = 'DSH_HOME=~/.dsh-remote-go/home setsid nohup ~/.dsh-remote-go/node/bin/node ~/.dsh-remote-go/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 0 >> ~/.dsh-remote-go/logs/remote-web.log 2>&1 &'
      tokenFile       = $TokenPath
      tokenLength     = $token.Length
      tokenPrefix     = $token.Substring(0, 6)
      remoteProbeHttp = $kv['REMOTE_PROBE_HTTP']
      startupSeconds  = if ($kv.ContainsKey('STARTUP_SECONDS')) { [int]$kv['STARTUP_SECONDS'] } else { 0 }
      localProbeHttp  = Get-HttpCode -Port $localPort
      sshConnection   = $kv['SSH_CONNECTION']
      sshTty          = $kv['SSH_TTY']
      checkedAt       = (Get-Date).ToString('o')
    }
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
    Write-Host ''
    Write-Host ("endpoint   : http://127.0.0.1:{0}/" -f $localPort)
    Write-Host "state file : $StatePath"
  }

  default { throw "unknown action: $Action" }
}
