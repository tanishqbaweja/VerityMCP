# Windows setup for VerityMCP. Install once; afterwards launch with start.bat.
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipBrowser,
    [switch]$SkipCloudflared
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

function Say([string]$message) { Write-Host "[VerityMCP setup] $message" }
function Fail([string]$message) { throw $message }

function Find-Tool([string[]]$names) {
    foreach ($name in $names) {
        $tool = Get-Command $name -ErrorAction SilentlyContinue
        if ($tool) { return $tool.Source }
    }
    return $null
}

function Refresh-ProcessPath {
    $paths = @(
        $env:PATH,
        [Environment]::GetEnvironmentVariable("Path", "Machine"),
        [Environment]::GetEnvironmentVariable("Path", "User")
    ) | Where-Object { $_ }
    $env:PATH = $paths -join [IO.Path]::PathSeparator
}

function Invoke-Checked([string]$program, [string[]]$arguments) {
    Say ("Running: {0} {1}" -f (Split-Path $program -Leaf), ($arguments -join " "))
    & $program @arguments
    if ($LASTEXITCODE -ne 0) {
        Fail ("Command failed (exit {0}): {1}" -f $LASTEXITCODE, $program)
    }
}

function Get-NodeMajor {
    $node = Find-Tool -names @("node.exe", "node")
    if (-not $node) { return 0 }
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.') { return 0 }
    return [int]$Matches[1]
}

function Get-Cloudflared {
    $cmd = Find-Tool -names @("cloudflared.exe", "cloudflared")
    if ($cmd) { return $cmd }
    foreach ($base in @([Environment]::GetEnvironmentVariable("ProgramFiles(x86)"), $env:ProgramFiles)) {
        if ($base) {
            $candidate = Join-Path $base "cloudflared\cloudflared.exe"
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}

function Test-Chromium {
    $node = Find-Tool -names @("node.exe", "node")
    if (-not $node -or -not (Test-Path "node_modules\playwright")) { return $false }
    $js = "try { const p=require('playwright'); const fs=require('node:fs'); process.exit(fs.existsSync(p.chromium.executablePath())?0:1); } catch { process.exit(1); }"
    & $node -e $js 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Install-Winget([string]$id) {
    $winget = Find-Tool -names @("winget.exe", "winget")
    if (-not $winget) {
        Fail "Missing prerequisite $id. Install Microsoft App Installer (winget), then rerun setup. For local-only use, pass -SkipCloudflared."
    }
    Invoke-Checked -program $winget -arguments @(
        "install", "--id", $id, "--exact", "--source", "winget",
        "--accept-source-agreements", "--accept-package-agreements"
    )
    Refresh-ProcessPath
}

try {
    Say ("Project: {0}" -f $projectRoot)
    if (-not (Test-Path "package.json") -or -not (Test-Path "pnpm-lock.yaml")) {
        Fail "package.json or pnpm-lock.yaml is missing. Run setup inside the VerityMCP repository."
    }

    $nodeMajor = Get-NodeMajor
    $pnpm = Find-Tool -names @("pnpm.cmd", "pnpm")
    $cloudflared = Get-Cloudflared
    $git = Find-Tool -names @("git.exe", "git")

    if ($CheckOnly) {
        Say "Read-only prerequisite check:"
        Say ("  Node.js 20+: {0}" -f $(if ($nodeMajor -ge 20) { "OK" } else { "MISSING / TOO OLD" }))
        Say ("  pnpm: {0}" -f $(if ($pnpm) { "OK" } else { "MISSING" }))
        Say ("  Git: {0}" -f $(if ($git) { "OK" } else { "MISSING" }))
        if (-not $SkipCloudflared) {
            Say ("  cloudflared: {0}" -f $(if ($cloudflared) { "OK" } else { "MISSING" }))
        }
        $deps = Test-Path "node_modules\playwright"
        Say ("  Project packages: {0}" -f $(if ($deps) { "present" } else { "MISSING" }))
        if (-not $SkipBrowser) {
            $chromium = Test-Chromium
            Say ("  Playwright Chromium: {0}" -f $(if ($chromium) { "OK" } else { "MISSING" }))
        } else { $chromium = $true }
        $built = Test-Path "dist\cli.js"
        Say ("  Compiled app: {0}" -f $(if ($built) { "present" } else { "MISSING" }))
        if ($nodeMajor -lt 20 -or -not $pnpm -or -not $git -or (-not $SkipCloudflared -and -not $cloudflared) -or -not $deps -or -not $chromium -or -not $built) { exit 1 }
        Say "Everything checked is ready."
        exit 0
    }

    if ($nodeMajor -lt 20) {
        Say "Node.js >= 20 is required. Installing the current LTS via winget..."
        Install-Winget "OpenJS.NodeJS.LTS"
        $nodeMajor = Get-NodeMajor
        if ($nodeMajor -lt 20) {
            Fail "Node.js >= 20 is not visible. Open a new terminal and rerun setup (or install it from https://nodejs.org/)."
        }
    }
    Say ("Node.js: {0}" -f (& (Find-Tool -names @("node.exe", "node")) --version))

    if (-not $pnpm) {
        $npm = Find-Tool -names @("npm.cmd", "npm")
        if (-not $npm) { Fail "Node.js is present but npm is missing. Repair your Node.js installation and rerun setup." }
        Say "Installing pnpm 10 via npm..."
        Invoke-Checked -program $npm -arguments @("install", "--global", "pnpm@10")
        Refresh-ProcessPath
        $pnpm = Find-Tool -names @("pnpm.cmd", "pnpm")
        if (-not $pnpm) { Fail "pnpm was installed but is not visible. Open a new terminal and rerun setup." }
    }
    Say ("pnpm: {0}" -f (& $pnpm --version))

    if (-not $git) {
        Say "Installing Git for version-control tools..."
        Install-Winget "Git.Git"
        $git = Find-Tool -names @("git.exe", "git")
        if (-not $git) { Fail "Git installed but not visible. Open a new terminal and rerun setup." }
    }
    Say ("Git found: {0}" -f $git)

    if (-not $SkipCloudflared) {
        if (-not $cloudflared) {
            Say "Installing cloudflared (required for the Windows remote tunnel)..."
            Install-Winget "Cloudflare.cloudflared"
            $cloudflared = Get-Cloudflared
            if (-not $cloudflared) {
                Fail "cloudflared was installed but cannot be found. Open a new terminal and rerun setup, or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/."
            }
        }
        Say ("cloudflared found: {0}" -f $cloudflared)
    } else {
        Say "Cloudflare tunnel dependency skipped (-SkipCloudflared). Local connections can still work."
    }

    Say "Installing exact dependencies from pnpm-lock.yaml..."
    Invoke-Checked -program $pnpm -arguments @("install", "--frozen-lockfile")

    if (-not $SkipBrowser) {
        Say "Installing the Chromium browser used by Playwright..."
        Invoke-Checked -program $pnpm -arguments @("exec", "playwright", "install", "chromium")
    } else {
        Say "Browser download skipped (-SkipBrowser). Browser tools may not work."
    }

    Say "Building VerityMCP..."
    Invoke-Checked -program $pnpm -arguments @("build")
    if (-not (Test-Path "dist\cli.js")) { Fail "Build finished without dist\cli.js." }

    Say "Installation complete. On Windows, run start.bat to launch VerityMCP."
} catch {
    Write-Host "[VerityMCP setup] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
