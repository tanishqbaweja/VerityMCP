# VerityMCP Launcher with Cloudflare Tunnel & Verification Engine
$ErrorActionPreference = "Stop"

# Keep the launcher rooted at the same project directory as the Node server.
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflaredPath)) {
    $cloudflaredPath = "cloudflared"
}

# Clean up any orphaned cloudflared processes from previous sessions
Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Dedicated port for VerityMCP
$port = 7980
$portBusy = Get-NetTCPConnection -LocalPort 7980 -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
    Write-Host "[Launcher] Port 7980 is currently in use. VerityMCP will use port 7981." -ForegroundColor Yellow
    $port = 7981
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "    VERITY MCP (Verified Local Computer Engineering Layer)    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "[Launcher] Starting Cloudflare tunnel on port $port..." -ForegroundColor Gray

# Temporary log file for cloudflared output
$tempLog = [System.IO.Path]::GetTempFileName()
$tunnelProc = $null
$tunnelUrl = $null

try {
    $tunnelProc = Start-Process -FilePath $cloudflaredPath -ArgumentList "tunnel --url http://127.0.0.1:$port" -RedirectStandardError $tempLog -PassThru -NoNewWindow
    $timeout = [DateTime]::Now.AddSeconds(45)

    while ([DateTime]::Now -lt $timeout -and -not $tunnelUrl) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $tempLog) {
            try {
                $fs = [System.IO.File]::Open($tempLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $sr = [System.IO.StreamReader]::new($fs)
                $content = $sr.ReadToEnd()
                $sr.Close()
                $fs.Close()
                if ($content -match '(https://[a-zA-Z0-9-]+\.trycloudflare\.com)') {
                    $tunnelUrl = $matches[1]
                    break
                }
            } catch {}
        }
        if ($tunnelProc.HasExited) {
            Write-Host "[Launcher] Cloudflared process exited unexpectedly with code $($tunnelProc.ExitCode)" -ForegroundColor Yellow
            break
        }
    }
} catch {
    Write-Host "[Launcher] Cloudflare tunnel failed to start: $_" -ForegroundColor Yellow
}

if (-not $tunnelUrl) {
    Write-Host "[Launcher] Notice: Could not acquire Cloudflare tunnel URL within timeout. Operating in local-only mode on http://127.0.0.1:$port" -ForegroundColor Yellow
    $mcpUrl = "http://127.0.0.1:$port/mcp"
    $tunnelUrl = "http://127.0.0.1:$port"
} else {
    $mcpUrl = "$tunnelUrl/mcp"
    Write-Host "[Launcher] Cloudflare tunnel established successfully!" -ForegroundColor Green
}

# Copy MCP URL to Windows clipboard
try {
    Set-Clipboard -Value $mcpUrl
    $clipboardNotice = "(COPIED TO CLIPBOARD)"
} catch {
    $clipboardNotice = ""
}

# Resolve the same owner credential as the Node server:
# VERITY_OWNER_TOKEN, project data directory, then legacy home data.
$ownerToken = [string]$env:VERITY_OWNER_TOKEN
$dataRoot = if ($env:VERITY_DATA_DIR) {
    [System.IO.Path]::GetFullPath($env:VERITY_DATA_DIR)
} elseif ($env:VERITY_ROOT) {
    Join-Path ([System.IO.Path]::GetFullPath($env:VERITY_ROOT)) ".verity"
} else {
    Join-Path $projectRoot ".verity"
}
$authPath = Join-Path $dataRoot "auth.json"
$legacyAuthPath = Join-Path $env:USERPROFILE ".verity\auth.json"

function Read-OwnerToken([string]$filePath) {
    if (-not (Test-Path -LiteralPath $filePath)) { return $null }
    try {
        $json = Get-Content -LiteralPath $filePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $value = if ($json.ownerToken) { [string]$json.ownerToken } elseif ($json.token) { [string]$json.token } else { "" }
        if (-not $value.Trim()) { throw "Missing ownerToken/token field" }
        return $value
    } catch {
        throw "Unable to read owner credentials from $filePath. Refusing to start without authentication: $_"
    }
}

if (-not $ownerToken.Trim()) {
    $ownerToken = Read-OwnerToken $authPath
    if (-not $ownerToken) { $ownerToken = Read-OwnerToken $legacyAuthPath }
}

if (-not $ownerToken) {
    # First run: generate a secure password once, and keep it in ignored local state.
    [System.IO.Directory]::CreateDirectory($dataRoot) | Out-Null
    $randomBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
    $ownerToken = [Convert]::ToBase64String($randomBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $payload = @{ ownerToken = $ownerToken } | ConvertTo-Json
    $stream = $null
    try {
        $stream = [System.IO.File]::Open($authPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $payloadBytes = New-Object System.Text.UTF8Encoding($false)
        $buffer = $payloadBytes.GetBytes($payload + [Environment]::NewLine)
        $stream.Write($buffer, 0, $buffer.Length)
    } catch [System.IO.IOException] {
        if (Test-Path -LiteralPath $authPath) {
            $ownerToken = Read-OwnerToken $authPath
        } else { throw }
    } finally {
        if ($stream) { $stream.Dispose() }
    }
    Write-Host "[Launcher] Created a persistent owner password in the local .verity directory." -ForegroundColor Gray
}
if (-not $ownerToken) { throw "Owner password is unavailable. Refusing to start without authentication." }

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
Write-Host "Next Steps in ChatGPT Web:" -ForegroundColor White
Write-Host "1. Paste '$mcpUrl' into your MCP / Custom Action Connector." -ForegroundColor White
Write-Host "2. Authentication Options:" -ForegroundColor White
Write-Host "   - Option A (Recommended - API Key):" -ForegroundColor Cyan
Write-Host "     Select 'API Key' -> Type 'Bearer' -> use the Owner Password printed above." -ForegroundColor Gray
Write-Host "   - Option B (OAuth 2.1):" -ForegroundColor Cyan
Write-Host "     Select 'OAuth' -> Endpoints are auto-discovered from $tunnelUrl" -ForegroundColor Gray
Write-Host "     If manual: Auth URL = $tunnelUrl/oauth/authorize | Token URL = $tunnelUrl/oauth/token" -ForegroundColor Gray
Write-Host "3. Start coding! VerityMCP provides verified actions, first-class browser automation, and 78 tools." -ForegroundColor White
Write-Host ""
Write-Host "Starting VerityMCP server..." -ForegroundColor Gray
Write-Host ""

try {
    # Build and launch VerityMCP server
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
