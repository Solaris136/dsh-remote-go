# dsh-remote-go · V0/B evidence: token -> cookie -> authenticated page -> API/WS trust fence
#
# Requires a running local tunnel (run `pwsh -File remote.ps1 start` first) and
# reads .state.json + .token. Writes redacted evidence files under evidence/ and
# evidence/curl-check.result.json.
#
#   pwsh -File e2e/remote/curl-check.ps1
#
# Redaction: the launch token and the signed cookie VALUE are replaced before
# anything is written to disk; header names, cookie name, attributes, status
# codes, Location and Origin/Host results are kept verbatim.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'

$Here = Split-Path -Parent $PSCommandPath
$StatePath = Join-Path $Here '.state.json'
$TokenPath = Join-Path $Here '.token'
$EvidenceDir = Join-Path $Here 'evidence'

if (-not (Test-Path -LiteralPath $StatePath)) { throw "missing $StatePath; run remote.ps1 start first" }
if (-not (Test-Path -LiteralPath $TokenPath)) { throw "missing $TokenPath; run remote.ps1 start first" }

$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
$token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
$port = [int]$state.localPort
if (-not $port) { throw 'state.json has no localPort' }
$base = "http://127.0.0.1:$port"
$wsKey = 'dGhlIHNhbXBsZSBub25jZQ=='

New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$jarPath = Join-Path $EvidenceDir 'cookies.jar'

function Redact([string]$Text) {
  $out = $Text
  if ($token) { $out = $out.Replace($token, '<TOKEN>') }
  # set-cookie: keep name and attributes, redact the signed value
  $out = [regex]::Replace($out, '(?im)^(set-cookie:\s*)([^=;\s]+)=([^;]+)', '$1$2=<COOKIE_VALUE>')
  # cookie jar rows (7 tab-separated fields, field 7 = value)
  $out = [regex]::Replace($out, '(?m)^(#HttpOnly_)?([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)$', {
      param($m)
      "$($m.Groups[1].Value)$($m.Groups[2].Value)`t$($m.Groups[3].Value)`t$($m.Groups[4].Value)`t$($m.Groups[5].Value)`t$($m.Groups[6].Value)`t<COOKIE_VALUE>"
    })
  return $out
}

function Save-Evidence([string]$Name, [string]$Content) {
  $path = Join-Path $EvidenceDir $Name
  [IO.File]::WriteAllText($path, (Redact $Content), [System.Text.UTF8Encoding]::new($false))
  return $path
}

function Get-FirstLine([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  return (($Text -split "`n")[0]).TrimEnd("`r")
}

function Get-HeaderValue([string[]]$Lines, [string]$Name) {
  foreach ($line in $Lines) {
    if ($line -match ('(?i)^' + [regex]::Escape($Name) + ':\s*(.*)$')) { return $Matches[1].Trim() }
  }
  return ''
}

function Get-HeaderLines([string[]]$Lines, [string]$Name) {
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($line in $Lines) {
    if ($line -match ('(?i)^' + [regex]::Escape($Name) + ':\s*(.*)$')) { $found.Add($Matches[1].Trim()) }
  }
  return @($found)
}

function Invoke-Curl {
  param(
    [string]$Name,
    [string[]]$CurlArgs
  )
  $headersFile = Join-Path $EvidenceDir "$Name.headers.txt"
  $bodyFile = Join-Path $EvidenceDir "$Name.body.txt"
  $allArgs = @('-s', '-S', '--max-time', '20', '-D', $headersFile, '-o', $bodyFile) + $CurlArgs
  $stdout = & curl.exe @allArgs 2>&1 | Out-String
  $exit = $LASTEXITCODE
  $headerText = if (Test-Path -LiteralPath $headersFile) { Get-Content -LiteralPath $headersFile -Raw } else { '' }
  $bodyText = if (Test-Path -LiteralPath $bodyFile) { Get-Content -LiteralPath $bodyFile -Raw } else { '' }
  $statusLine = Get-FirstLine $headerText
  $status = 0
  if ($statusLine -match '^HTTP/\S+\s+(\d{3})') { $status = [int]$Matches[1] }
  Save-Evidence "$Name.headers.txt" $headerText | Out-Null
  Save-Evidence "$Name.body.txt" $bodyText | Out-Null
  $headerLines = @($headerText -split "`n" | ForEach-Object { $_.TrimEnd("`r") })
  return [pscustomobject]@{
    Name       = $Name
    ExitCode   = $exit
    Status     = $status
    StatusLine = $statusLine
    HeaderText = $headerText
    BodyText   = $bodyText
    StdErr     = $stdout.Trim()
    Headers    = $headerLines
  }
}

$checks = New-Object System.Collections.Generic.List[object]
$details = [ordered]@{}

function Add-Check([string]$Id, [string]$Expect, [string]$Actual, [bool]$Pass, [string]$Evidence) {
  $checks.Add([pscustomobject]@{ id = $Id; expect = $Expect; actual = $Actual; pass = $Pass; evidence = $Evidence })
  $mark = if ($Pass) { 'PASS' } else { 'FAIL' }
  Write-Host ("  [{0}] {1}: {2} (actual: {3})" -f $mark, $Id, $Expect, $Actual)
}

Write-Host "==> curl evidence against $base"

# --- B1: token exchange (GET /?token=...) -> 303 + Set-Cookie + Location ./ -
$exchange = Invoke-Curl '01-token-exchange' @('-c', $jarPath, "$base/?token=$token")
$cookieHeaders = @(Get-HeaderLines $exchange.Headers 'set-cookie')
$location = Get-HeaderValue $exchange.Headers 'location'
$details.tokenExchange = [ordered]@{
  status     = $exchange.Status
  statusLine = $exchange.StatusLine
  location   = $location
  setCookie  = $cookieHeaders
}
Add-Check 'B1.token-exchange' 'HTTP 303 + Set-Cookie + Location ./' `
  ("HTTP $($exchange.Status); location='$location'; set-cookie-count=$($cookieHeaders.Count)") `
  ($exchange.Status -eq 303 -and $cookieHeaders.Count -ge 1 -and $location -eq './') '01-token-exchange.headers.txt'

$cookie = if ($cookieHeaders.Count -gt 0) { $cookieHeaders[0] } else { '' }
$cookieName = ''
if ($cookie -match '^([^=]+)=') { $cookieName = $Matches[1] }
$cookieAttributes = if ($cookie -match '^[^=]+=([^;]+)(.*)$') { $Matches[2] } else { '' }
Add-Check 'B1b.cookie-name' 'cookie name is dsh-auth-<base64url sha256(authority)>' `
  "name='$cookieName'" ($cookieName.StartsWith('dsh-auth-') -and $cookieName.Length -gt 20) '01-token-exchange.headers.txt'
Add-Check 'B1c.cookie-flags' 'HttpOnly; SameSite=Strict; Path=/' $cookieAttributes.Trim() `
  ($cookie -match '(?i)HttpOnly' -and $cookie -match '(?i)SameSite=Strict' -and $cookie -match '(?i)Path=/') '01-token-exchange.headers.txt'
Add-Check 'B1d.cookie-http-no-secure' 'no Secure flag on plain HTTP' ('SecurePresent=' + [bool]($cookie -match '(?i);\s*Secure')) `
  (-not ($cookie -match '(?i);\s*Secure')) '01-token-exchange.headers.txt'

$jarText = if (Test-Path -LiteralPath $jarPath) { Get-Content -LiteralPath $jarPath -Raw } else { '' }
$jarRedacted = Join-Path $EvidenceDir '01-cookies.jar.redacted.txt'
[IO.File]::WriteAllText($jarRedacted, (Redact $jarText), [System.Text.UTF8Encoding]::new($false))
$details.cookieJar = @($jarText -split "`n" | Where-Object { $_ -and $_ -notmatch '^#' } | ForEach-Object {
    $parts = $_ -split "`t"
    if ($parts.Count -ge 6) { [ordered]@{ domain = $parts[0]; path = $parts[2]; secure = $parts[3]; name = $parts[5]; value = '<redacted>' } }
  })

# --- B2: authenticated GET / with the cookie jar -> 200 + real HTML --------
$page = Invoke-Curl '02-authenticated' @('-b', $jarPath, "$base/")
$title = ''
if ($page.BodyText -match '(?is)<title[^>]*>(.*?)</title>') { $title = $Matches[1].Trim() }
$contentType = Get-HeaderValue $page.Headers 'content-type'
$xfo = @(Get-HeaderLines $page.Headers 'x-frame-options')
$csp = @(Get-HeaderLines $page.Headers 'content-security-policy')
$frameAncestors = ''
foreach ($value in $csp) {
  if ($value -match '(?i)frame-ancestors\s+([^;]+)') { $frameAncestors = $Matches[1].Trim() }
}
$details.authenticatedPage = [ordered]@{
  status         = $page.Status
  contentType    = $contentType
  title          = $title
  bodyLength     = $page.BodyText.Length
  xFrameOptions  = $xfo
  csp            = $csp
  frameAncestors = $frameAncestors
}
Add-Check 'B2.authenticated-200' 'HTTP 200 with text/html' `
  ("HTTP $($page.Status); content-type='$contentType'; title='$title'; bodyLength=$($page.BodyText.Length)") `
  ($page.Status -eq 200 -and $contentType -match '(?i)text/html') '02-authenticated.headers.txt'
Add-Check 'B2b.html-title' 'HTML title is DeepSeek Harness (or contains DSH)' "title='$title'" `
  ($title -match '(?i)deepseek harness|dsh') '02-authenticated.body.txt'
Add-Check 'B2c.no-x-frame-options' 'no X-Frame-Options header (iframe allowed)' ("x-frame-options='" + ($xfo -join ', ') + "'") `
  ($xfo.Count -eq 0) '02-authenticated.headers.txt'
Add-Check 'B2d.no-csp-frame-ancestors' 'no CSP frame-ancestors (iframe allowed)' ("csp='" + ($csp -join ' | ') + "'; frame-ancestors='" + $frameAncestors + "'") `
  ([string]::IsNullOrEmpty($frameAncestors)) '02-authenticated.headers.txt'

# --- B3: no cookie -> 401 --------------------------------------------------
$noCookie = Invoke-Curl '03-unauthenticated' @("$base/")
$details.unauthenticated = [ordered]@{
  status          = $noCookie.Status
  statusLine      = $noCookie.StatusLine
  wwwAuthenticate = @(Get-HeaderLines $noCookie.Headers 'www-authenticate')
  body            = (Redact $noCookie.BodyText).Trim()
}
Add-Check 'B3.unauthenticated-401' 'HTTP 401 without cookie' "HTTP $($noCookie.Status)" ($noCookie.Status -eq 401) '03-unauthenticated.headers.txt'

# --- B4: RPC + API trust fence (Host/Origin/Sec-Fetch-Site) ----------------
$rpcPath = '/api/session/list'
$rpcArgs = @('-X', 'POST', '-H', 'content-type: application/json', '-d', '{}')
$rpcCookie = Invoke-Curl '04-rpc-authenticated' (@('-b', $jarPath) + $rpcArgs + @("$base$rpcPath"))
$rpcBodyPreview = (Redact $rpcCookie.BodyText).Trim()
$details.rpc = [ordered]@{
  status      = $rpcCookie.Status
  bodyPreview = $rpcBodyPreview.Substring(0, [Math]::Min(200, $rpcBodyPreview.Length))
}
Add-Check 'B4.rpc-authenticated-200' 'POST /api/session/list with cookie -> 200' "HTTP $($rpcCookie.Status)" ($rpcCookie.Status -eq 200) '04-rpc-authenticated.headers.txt'

$rpcNoCookie = Invoke-Curl '05-rpc-unauthenticated' (@() + $rpcArgs + @("$base$rpcPath"))
Add-Check 'B5.rpc-unauthenticated-401' 'POST /api/session/list without cookie -> 401' "HTTP $($rpcNoCookie.Status)" ($rpcNoCookie.Status -eq 401) '05-rpc-unauthenticated.headers.txt'

$rpcSameOrigin = Invoke-Curl '06-rpc-origin-same-authority' (@('-b', $jarPath, '-H', "Origin: $base") + $rpcArgs + @("$base$rpcPath"))
Add-Check 'B6.rpc-origin-same-authority-200' 'Origin = listener authority -> 200' "HTTP $($rpcSameOrigin.Status)" ($rpcSameOrigin.Status -eq 200) '06-rpc-origin-same-authority.headers.txt'

$rpcForeignOrigin = Invoke-Curl '07-rpc-origin-foreign' (@('-b', $jarPath, '-H', 'Origin: http://evil.example') + $rpcArgs + @("$base$rpcPath"))
Add-Check 'B7.rpc-origin-foreign-403' 'foreign Origin -> 403' "HTTP $($rpcForeignOrigin.Status)" ($rpcForeignOrigin.Status -eq 403) '07-rpc-origin-foreign.headers.txt'

$rpcForeignHost = Invoke-Curl '08-rpc-host-foreign' (@('-b', $jarPath, '-H', 'Host: evil.example') + $rpcArgs + @("$base$rpcPath"))
Add-Check 'B8.rpc-host-foreign-403' 'foreign Host -> 403 (DNS-rebinding fence)' "HTTP $($rpcForeignHost.Status)" ($rpcForeignHost.Status -eq 403) '08-rpc-host-foreign.headers.txt'

$rpcCrossSite = Invoke-Curl '09-rpc-sec-fetch-site-cross-site' (@('-b', $jarPath, '-H', 'Sec-Fetch-Site: cross-site') + $rpcArgs + @("$base$rpcPath"))
Add-Check 'B9.rpc-cross-site-403' 'Sec-Fetch-Site: cross-site -> 403' "HTTP $($rpcCrossSite.Status)" ($rpcCrossSite.Status -eq 403) '09-rpc-sec-fetch-site-cross-site.headers.txt'

$rpcSameSite = Invoke-Curl '10-rpc-sec-fetch-site-same-site' (@('-b', $jarPath, '-H', 'Sec-Fetch-Site: same-site') + $rpcArgs + @("$base$rpcPath"))
Add-Check 'B10.rpc-same-site-200' 'Sec-Fetch-Site: same-site -> 200 (same-site iframe passes)' "HTTP $($rpcSameSite.Status)" ($rpcSameSite.Status -eq 200) '10-rpc-sec-fetch-site-same-site.headers.txt'

# --- B5: WebSocket mux upgrade -------------------------------------------
$wsHeaders = @(
  '-H', 'Connection: Upgrade',
  '-H', 'Upgrade: websocket',
  '-H', 'Sec-WebSocket-Version: 13',
  '-H', "Sec-WebSocket-Key: $wsKey"
)
$wsUpgrade = Invoke-Curl '11-ws-mux-upgrade' (@('-b', $jarPath, '--max-time', '5') + $wsHeaders + @("$base/api/remote.mux"))
$details.websocketUpgrade = [ordered]@{
  statusLine = $wsUpgrade.StatusLine
  headers    = @($wsUpgrade.Headers | Where-Object { $_ -match '(?i)^(HTTP/|upgrade:|connection:|sec-websocket)' })
  stderr     = $wsUpgrade.StdErr
}
Add-Check 'B11.ws-mux-upgrade-101' 'GET /api/remote.mux upgrade with cookie -> 101' $wsUpgrade.StatusLine ($wsUpgrade.Status -eq 101) '11-ws-mux-upgrade.headers.txt'

$wsForeignOrigin = Invoke-Curl '12-ws-mux-foreign-origin' (@('-b', $jarPath, '--max-time', '5', '-H', 'Origin: http://evil.example') + $wsHeaders + @("$base/api/remote.mux"))
Add-Check 'B12.ws-mux-foreign-origin-403' 'WS upgrade with foreign Origin -> 403' "HTTP $($wsForeignOrigin.Status)" ($wsForeignOrigin.Status -eq 403) '12-ws-mux-foreign-origin.headers.txt'

# --- informational: index route does not enforce Origin (browser SameSite does)
$indexForeignOrigin = Invoke-Curl '13-index-origin-foreign-info' @('-b', $jarPath, '-H', 'Origin: http://evil.example', "$base/")
$details.indexForeignOrigin = [ordered]@{ status = $indexForeignOrigin.Status; note = 'index/static routes authenticate by authority-bound cookie only; Origin/Sec-Fetch-Site fence applies to /api/*' }

$passed = @($checks | Where-Object { $_.pass }).Count
$failed = @($checks | Where-Object { -not $_.pass }).Count
$result = [ordered]@{
  generatedAt = (Get-Date).ToString('o')
  remoteHost  = $state.remoteHost
  remotePort  = [int]$state.remotePort
  localPort   = $port
  baseUrl     = $base
  tokenLength = $token.Length
  tokenPrefix = $token.Substring(0, 6)
  checks      = $checks
  summary     = [ordered]@{ total = $checks.Count; passed = $passed; failed = $failed }
  details     = $details
}
$resultPath = Join-Path $EvidenceDir 'curl-check.result.json'
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8

Write-Host ''
Write-Host ("summary: {0}/{1} passed, {2} failed" -f $passed, $checks.Count, $failed)
Write-Host "evidence: $EvidenceDir"
Write-Host "result  : $resultPath"
if ($failed -gt 0) { exit 1 }
