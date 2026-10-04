# DevSpace 4.0 Launcher with Cloudflare Tunnel & Verification Engine
$ErrorActionPreference = "Stop"

$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflaredPath)) {
    $cloudflaredPath = "cloudflared"
}

# Dedicated port for DevSpace 4.0 (never touches DevSpace 1.0 on 7676, DevSpace 2.0 on 7878, or DevSpace 3.0 on 7979)
$port = 7980
$portBusy = Get-NetTCPConnection -LocalPort 7980 -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
    Write-Host "[Launcher] Port 7980 is currently in use. DevSpace 4.0 will use port 7981." -ForegroundColor Yellow
    $port = 7981
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "    DEVSPACE 4.0 (Verified Computer Engineering Layer)    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "[Launcher] Starting Cloudflare tunnel on port $port..." -ForegroundColor Gray

# Temporary log file for cloudflared output
$tempLog = [System.IO.Path]::GetTempFileName()
$tunnelProc = $null
$tunnelUrl = $null

try {
    $tunnelProc = Start-Process -FilePath $cloudflaredPath -ArgumentList "tunnel --url http://127.0.0.1:$port" -RedirectStandardError $tempLog -PassThru -NoNewWindow
    $timeout = [DateTime]::Now.AddSeconds(20)

    while ([DateTime]::Now -lt $timeout -and -not $tunnelUrl) {
        Start-Sleep -Milliseconds 600
        if (Test-Path $tempLog) {
            $content = Get-Content $tempLog -Raw -ErrorAction SilentlyContinue
            if ($content -match '(https://[a-zA-Z0-9-]+\.trycloudflare\.com)') {
                $tunnelUrl = $matches[1]
            }
        }
    }
} catch {
    Write-Host "[Launcher] Cloudflare tunnel not found or failed to start. Falling back to local HTTP." -ForegroundColor Yellow
}

if (-not $tunnelUrl) {
    Write-Host "[Launcher] Notice: Operating in local-only mode on http://127.0.0.1:$port" -ForegroundColor Yellow
    $mcpUrl = "http://127.0.0.1:$port/mcp"
    $tunnelUrl = "http://127.0.0.1:$port"
} else {
    $mcpUrl = "$tunnelUrl/mcp"
}

# Copy MCP URL to Windows clipboard
try {
    Set-Clipboard -Value $mcpUrl
    $clipboardNotice = "(COPIED TO CLIPBOARD)"
} catch {
    $clipboardNotice = ""
}

# Read owner token if available
$authPath = "$env:USERPROFILE\.devspace\auth.json"
$ownerToken = ""
if (Test-Path $authPath) {
    try {
        $authJson = Get-Content $authPath -Raw | ConvertFrom-Json
        $ownerToken = $authJson.ownerToken
    } catch {}
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "                 CONNECTION READY!                        " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  MCP Server URL:   $mcpUrl  $clipboardNotice" -ForegroundColor Yellow
Write-Host "  Alternative Root: $tunnelUrl" -ForegroundColor Yellow
if ($ownerToken) {
    Write-Host "  Owner Password:   $ownerToken" -ForegroundColor Cyan
}
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next Steps in ChatGPT / Claude / MCP Client:" -ForegroundColor White
Write-Host "1. Paste '$mcpUrl' into your MCP Client." -ForegroundColor White
Write-Host "2. When prompted for authorization, enter the Owner Password above." -ForegroundColor White
Write-Host "3. Start coding! DevSpace 4.0 provides verified actions, first-class browser automation, and 65 tools." -ForegroundColor White
Write-Host ""
Write-Host "Starting DevSpace 4.0 server..." -ForegroundColor Gray
Write-Host ""

try {
    # Build and launch DevSpace 4.0 server
    $projectRoot = Split-Path -Parent $PSScriptRoot
    Set-Location $projectRoot
    Write-Host "[Launcher] Compiling TypeScript..." -ForegroundColor Gray
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        & pnpm build
    } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
        & npm run build
    }
    & node dist/cli.js serve --port $port --public-base-url $tunnelUrl
} finally {
    Write-Host "[Launcher] Cleaning up Cloudflare tunnel..." -ForegroundColor Gray
    if ($tunnelProc -and -not $tunnelProc.HasExited) {
        Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $tempLog) {
        Remove-Item $tempLog -Force -ErrorAction SilentlyContinue
    }
}
