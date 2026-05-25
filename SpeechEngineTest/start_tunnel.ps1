<#
.SYNOPSIS
  Exposes port 3001 via Cloudflare quick tunnel for the Speech Engine WS server.
  Run ws-server.mjs and app-server.mjs separately.
#>

param(
    [int]$WsPort = 3001
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== Speech Engine Cloudflare Tunnel ===' -ForegroundColor Cyan
Write-Host ('Exposing port {0} via Cloudflare tunnel...' -f $WsPort)

$tunnelLogFile = Join-Path $env:TEMP ('cloudflared_se_{0}.log' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))

$tunnelProcess = Start-Process -FilePath 'cloudflared' `
    -ArgumentList 'tunnel', '--url', ('http://localhost:{0}' -f $WsPort), '--no-autoupdate' `
    -PassThru -NoNewWindow `
    -RedirectStandardError $tunnelLogFile

Write-Host ('Tunnel started (PID {0}), waiting for URL...' -f $tunnelProcess.Id) -ForegroundColor Green

$tunnelUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $tunnelLogFile) {
        $logContent = Get-Content $tunnelLogFile -Raw -ErrorAction SilentlyContinue
        if ($logContent -match '(https://[a-z0-9\-]+\.trycloudflare\.com)') {
            $tunnelUrl = $Matches[1]
            break
        }
    }
}

if (-not $tunnelUrl) {
    Write-Host 'ERROR: Could not detect tunnel URL.' -ForegroundColor Red
    Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue
    exit 1
}

$wssUrl = $tunnelUrl -replace '^https://', 'wss://'
$speechEngineWsUrl = '{0}/ws' -f $wssUrl

Write-Host '============================================' -ForegroundColor Yellow
Write-Host ('  Tunnel URL            : {0}' -f $tunnelUrl) -ForegroundColor Yellow
Write-Host ('  Speech Engine WS URL  : {0}' -f $speechEngineWsUrl) -ForegroundColor Yellow
Write-Host '============================================' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Press Ctrl+C to stop the tunnel.'

try {
    while (-not $tunnelProcess.HasExited) {
        Start-Sleep -Seconds 2
    }
}
finally {
    if (-not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue
    }
    if (Test-Path $tunnelLogFile) {
        Remove-Item $tunnelLogFile -ErrorAction SilentlyContinue
    }
    Write-Host 'Tunnel stopped.' -ForegroundColor Cyan
}
