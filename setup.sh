#!/usr/bin/env bash
# One-command setup for VerityMCP on macOS and Linux.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

CHECK_ONLY=0
SKIP_BROWSER=0
SKIP_CLOUDFLARED=0

usage() {
  cat <<'USAGE'
Usage: bash ./setup.sh [--check] [--skip-browser] [--skip-cloudflared]
  --check             Only report missing requirements; make no changes
  --skip-browser      Skip Playwright's Chromium download
  --skip-cloudflared  Skip the remote tunnel dependency (local-only)
USAGE
}
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --skip-browser) SKIP_BROWSER=1 ;;
    --skip-cloudflared) SKIP_CLOUDFLARED=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'Unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '[VerityMCP setup] %s\n' "$*"; }
die() { printf '[VerityMCP setup] ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  if ! have node; then printf '0\n'; return; fi
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0\n'
}

# Prefer existing pnpm. Corepack can supply pnpm without a global npm install.
select_pnpm() {
  if have pnpm; then PNPM=(pnpm); return 0; fi
  if have corepack; then PNPM=(corepack pnpm); return 0; fi
  return 1
}

chromium_ready() {
  [[ -d node_modules/playwright ]] || return 1
  node -e "try { const p=require('playwright'); const fs=require('node:fs'); process.exit(fs.existsSync(p.chromium.executablePath())?0:1); } catch { process.exit(1); }" >/dev/null 2>&1
}

as_root() {
  if [[ "$(id -u)" == "0" ]]; then "$@"
  elif have sudo; then sudo "$@"
  else die "Administrator access is required for '$*'. Install the prerequisite manually, then rerun setup."
  fi
}

install_node() {
  if have brew; then
    say "Installing Node.js with Homebrew..."
    brew install node
  elif [[ "$(uname -s)" == "Linux" ]] && have apt-get; then
    say "Installing Node.js from the system package manager..."
    as_root apt-get update
    as_root apt-get install -y nodejs npm
  elif [[ "$(uname -s)" == "Linux" ]] && have dnf; then
    as_root dnf install -y nodejs npm
  elif [[ "$(uname -s)" == "Linux" ]] && have pacman; then
    as_root pacman -S --needed --noconfirm nodejs npm
  else
    die "Node.js >= 20 is required. Install it from https://nodejs.org/ and rerun setup."
  fi
}

install_cloudflared() {
  if have brew; then
    say "Installing cloudflared using Homebrew..."
    brew install cloudflared
    return
  fi
  if [[ "$(uname -s)" != "Linux" ]]; then
    die "Install cloudflared with Homebrew (https://brew.sh/) and rerun, or use --skip-cloudflared for local-only access."
  fi
  local arch asset url dest tmp
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) asset="cloudflared-linux-amd64" ;;
    aarch64|arm64) asset="cloudflared-linux-arm64" ;;
    *) die "Unsupported architecture ($arch). See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/." ;;
  esac
  if ! have curl && ! have wget; then
    die "curl or wget is required to download cloudflared. Install one and rerun."
  fi
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
  dest="$HOME/.local/bin/cloudflared"
  mkdir -p "$HOME/.local/bin"
  tmp="$(mktemp "$HOME/.local/bin/.cloudflared.XXXXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  say "Downloading cloudflared from Cloudflare's official release..."
  if have curl; then
    curl --fail --location --retry 3 --silent --show-error "$url" -o "$tmp"
  else
    wget --quiet --output-document="$tmp" "$url"
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
  trap - EXIT
  export PATH="$HOME/.local/bin:$PATH"
  say "Installed cloudflared in $dest."
}

[[ -f package.json && -f pnpm-lock.yaml ]] || die "Run this script inside the VerityMCP repository."
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "This setup script supports macOS and Linux. On Windows use setup.ps1." ;;
esac

export PATH="$HOME/.local/bin:$PATH"
NODE_MAJOR="$(node_major)"
PNPM=()
select_pnpm || true

if [[ "$CHECK_ONLY" == 1 ]]; then
  say "Read-only prerequisite check:"
  READY=1
  if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 20 )); then
    say "  Node.js 20+: OK"
  else
    say "  Node.js 20+: MISSING / TOO OLD"
    READY=0
  fi
  if (( ${#PNPM[@]} > 0 )); then
    say "  pnpm / Corepack: OK"
  else
    say "  pnpm / Corepack: MISSING"
    READY=0
  fi
  if have git; then say "  Git: OK"; else say "  Git: MISSING"; READY=0; fi
  if [[ "$SKIP_CLOUDFLARED" == 0 ]]; then
    if have cloudflared; then say "  cloudflared: OK"; else say "  cloudflared: MISSING"; READY=0; fi
  fi
  if [[ -d node_modules/playwright ]]; then say "  Project packages: present"; else say "  Project packages: MISSING"; READY=0; fi
  if [[ "$SKIP_BROWSER" == 0 ]]; then
    if chromium_ready; then say "  Playwright Chromium: OK"; else say "  Playwright Chromium: MISSING"; READY=0; fi
  fi
  if [[ -f dist/cli.js ]]; then say "  Compiled app: present"; else say "  Compiled app: MISSING"; READY=0; fi
  (( READY == 1 )) || exit 1
  say "Everything checked is ready."
  exit 0
fi

if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  say "Node.js >= 20 not found."
  install_node
  NODE_MAJOR="$(node_major)"
  if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
    die "Node.js 20+ is not on PATH. Install a supported version from https://nodejs.org/ and rerun setup."
  fi
fi
say "Node.js: $(node --version)"

if (( ${#PNPM[@]} == 0 )); then
  have npm || die "npm is missing. Repair the Node.js installation."
  say "Installing pnpm 10 through npm..."
  npm install --global pnpm@10 || die "Cannot globally install pnpm. Install it manually (or enable Corepack), then rerun."
  select_pnpm || die "pnpm installed but is not on PATH. Restart your terminal and rerun."
fi
say "pnpm: $("${PNPM[@]}" --version)"

if ! have git; then
  say "Installing Git for VerityMCP's Git tools..."
  if have brew; then brew install git
  elif have apt-get; then as_root apt-get update; as_root apt-get install -y git
  elif have dnf; then as_root dnf install -y git
  elif have pacman; then as_root pacman -S --needed --noconfirm git
  else die "Install Git from https://git-scm.com/ and rerun setup."
  fi
fi
have git || die "Git is still unavailable on PATH."

if [[ "$SKIP_CLOUDFLARED" == 0 ]]; then
  if ! have cloudflared; then install_cloudflared; fi
  have cloudflared || die "cloudflared is still missing. Add it to PATH and rerun setup."
  say "cloudflared: installed"
else
  say "Cloudflare tunnel dependency skipped (local-only mode)."
fi

say "Installing locked project dependencies..."
"${PNPM[@]}" install --frozen-lockfile

if [[ "$SKIP_BROWSER" == 0 ]]; then
  say "Installing Playwright Chromium..."
  if [[ "$(uname -s)" == "Linux" ]] && have apt-get; then
    "${PNPM[@]}" exec playwright install --with-deps chromium
  else
    "${PNPM[@]}" exec playwright install chromium
    if [[ "$(uname -s)" == "Linux" ]]; then
      say "On non-Debian Linux, install the system browser libraries required by Playwright."
    fi
  fi
else
  say "Browser download skipped; browser tools may not work."
fi

say "Compiling VerityMCP..."
"${PNPM[@]}" build
[[ -f dist/cli.js ]] || die "Build succeeded but dist/cli.js is missing."
say "Installation complete. Run '${PNPM[*]} start' to launch the local server."
say "For remote ChatGPT access on macOS/Linux, run a cloudflared tunnel separately and use its HTTPS /mcp URL."
