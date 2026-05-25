<#
.SYNOPSIS
  Starts the local no-auth BYOM echo API and exposes it via a Cloudflare quick tunnel.

.DESCRIPTION
  1. Launches local_chat_completion_api.py on port 8787.
  2. Runs `cloudflared tunnel --url http://localhost:8787` to get a public HTTPS URL.
  3. Prints the public URL to use as the BYOM endpoint in the Voice Live test UI.

  Press Ctrl+C to stop both processes.
#>

param(
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"

Write-Host "`n=== Voice Live BYOM Cloudflare Tunnel ===" -ForegroundColor Cyan
Write-Host "Starting local echo API on port $Port and Cloudflare quick tunnel...`n"

# Start the local chat completion API in background
$apiProcess = Start-Process -FilePath "python" `
    -ArgumentList "local_chat_completion_api.py", "--host", "0.0.0.0", "--port", $Port `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -NoNewWindow

Write-Host "[api] Local echo API started (PID $($apiProcess.Id)) on http://localhost:$Port" -ForegroundColor Green

# Give the API a moment to bind
Start-Sleep -Seconds 2

# Start cloudflared tunnel — it prints the public URL to stderr
$tunnelLogFile = Join-Path $env:TEMP "cloudflared_tunnel_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

$tunnelProcess = Start-Process -FilePath "cloudflared" `
    -ArgumentList "tunnel", "--url", "http://localhost:$Port", "--no-autoupdate" `
    -PassThru -NoNewWindow `
    -RedirectStandardError $tunnelLogFile

Write-Host "[tunnel] Cloudflare tunnel started (PID $($tunnelProcess.Id))" -ForegroundColor Green
Write-Host "[tunnel] Waiting for public URL...`n"

# Poll the log file for the tunnel URL
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
    Write-Host "[tunnel] ERROR: Could not detect tunnel URL. Check $tunnelLogFile" -ForegroundColor Red
    Stop-Process -Id $apiProcess.Id -ErrorAction SilentlyContinue
    Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue
    exit 1
}

$byomEndpoint = "$tunnelUrl/openai/v1"

Write-Host "============================================" -ForegroundColor Yellow
Write-Host "  Cloudflare Tunnel URL : $tunnelUrl" -ForegroundColor Yellow
Write-Host "  BYOM Endpoint         : $byomEndpoint" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Yellow
Write-Host "`nPaste the BYOM endpoint above into the Voice Live test UI."
Write-Host "Press Ctrl+C to stop both processes.`n"

try {
    # Wait for either process to exit
    while (-not $apiProcess.HasExited -and -not $tunnelProcess.HasExited) {
        Start-Sleep -Seconds 2
    }
}
finally {
    Write-Host "`nShutting down..." -ForegroundColor Cyan
    if (-not $apiProcess.HasExited) {
        Stop-Process -Id $apiProcess.Id -ErrorAction SilentlyContinue
        Write-Host "[api] Stopped." -ForegroundColor Gray
    }
    if (-not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue
        Write-Host "[tunnel] Stopped." -ForegroundColor Gray
    }
    if (Test-Path $tunnelLogFile) {
        Remove-Item $tunnelLogFile -ErrorAction SilentlyContinue
    }
    Write-Host "Done.`n" -ForegroundColor Cyan
}
