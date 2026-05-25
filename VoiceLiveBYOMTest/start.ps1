<#
.SYNOPSIS
  Starts the Voice Live BYOM test: dev server + local echo API + Cloudflare tunnel.

.DESCRIPTION
  1. Launches local_chat_completion_api.py on port 8787 (echo BYOM endpoint).
  2. Runs `cloudflared tunnel --url http://localhost:8787` for a public HTTPS URL.
  3. Starts the Vite dev server (server.mjs) on port 5174.
  4. Prints the BYOM endpoint URL to paste into the browser UI.

  Press Ctrl+C to stop all processes.
#>

param(
    [int]$ApiPort = 8787,
    [int]$DevPort = 5174
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

# Refresh PATH to pick up cloudflared if recently installed
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

Write-Host "`n=== Voice Live BYOM Test ===" -ForegroundColor Cyan
Write-Host "Starting echo API + Cloudflare tunnel + dev server...`n"

# --- Step 1: Start local echo API ---
$apiProcess = Start-Process -FilePath "python" `
    -ArgumentList "local_chat_completion_api.py", "--host", "0.0.0.0", "--port", $ApiPort `
    -WorkingDirectory $scriptDir `
    -PassThru -NoNewWindow

Write-Host "[api] Echo API started (PID $($apiProcess.Id)) on http://localhost:$ApiPort" -ForegroundColor Green
Start-Sleep -Seconds 2

# --- Step 2: Start Cloudflare tunnel ---
$tunnelLogFile = Join-Path $env:TEMP "cloudflared_voicelive_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

$tunnelProcess = Start-Process -FilePath "cloudflared" `
    -ArgumentList "tunnel", "--url", "http://localhost:$ApiPort", "--no-autoupdate" `
    -PassThru -NoNewWindow `
    -RedirectStandardError $tunnelLogFile

Write-Host "[tunnel] Cloudflare tunnel started (PID $($tunnelProcess.Id))" -ForegroundColor Green
Write-Host "[tunnel] Waiting for public URL..."

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

# --- Step 3: Start dev server ---
$env:PORT = $DevPort
$devProcess = Start-Process -FilePath "node" `
    -ArgumentList "server.mjs" `
    -WorkingDirectory $scriptDir `
    -PassThru -NoNewWindow

Write-Host "[dev] Dev server started (PID $($devProcess.Id)) on http://localhost:$DevPort" -ForegroundColor Green
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "========================================================" -ForegroundColor Yellow
Write-Host "  Voice Live BYOM Test Ready!" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Yellow
Write-Host "  Browser UI     : http://localhost:$DevPort" -ForegroundColor Yellow
Write-Host "  BYOM Endpoint  : $byomEndpoint" -ForegroundColor Yellow
Write-Host "  Tunnel URL     : $tunnelUrl" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "In the browser:" -ForegroundColor Cyan
Write-Host "  1. Paste BYOM endpoint: $byomEndpoint" -ForegroundColor White
Write-Host "  2. Fill in Voice Live endpoint + API key" -ForegroundColor White
Write-Host "  3. Click Connect" -ForegroundColor White
Write-Host ""
Write-Host "Press Ctrl+C to stop all processes.`n"

try {
    while (-not $apiProcess.HasExited -and -not $tunnelProcess.HasExited -and -not $devProcess.HasExited) {
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
    if (-not $devProcess.HasExited) {
        Stop-Process -Id $devProcess.Id -ErrorAction SilentlyContinue
        Write-Host "[dev] Stopped." -ForegroundColor Gray
    }
    if (Test-Path $tunnelLogFile) {
        Remove-Item $tunnelLogFile -ErrorAction SilentlyContinue
    }
    Write-Host "Done.`n" -ForegroundColor Cyan
}
