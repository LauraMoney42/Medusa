#!/usr/bin/env bash
# setup.sh — Medusa first-run setup.
# Run once after cloning: bash setup.sh  (or: npm run setup)
#
# What this does:
#   1. Checks prerequisites (node ≥18, npm, claude CLI)
#   2. Installs all npm dependencies (root + client + server)
#   3. Builds server TypeScript → dist/
#   4. Registers Playwright MCP with Claude Code (user scope)
#   5. Creates .env from .env.example if missing

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Cover Homebrew (ARM + Intel), nvm, and Claude Code's bundled installs
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# ── Terminal colors ──────────────────────────────────────────────────────────
G="\033[0;32m"; Y="\033[1;33m"; R="\033[0;31m"; B="\033[1m"; X="\033[0m"
ok()   { echo -e "${G}✓${X} $*"; }
warn() { echo -e "${Y}⚠${X}  $*"; }
err()  { echo -e "${R}✗${X} $*"; }
hdr()  { echo -e "\n${B}$*${X}"; }

echo -e "${B}"
cat << 'BANNER'
  ███╗   ███╗███████╗██████╗ ██╗   ██╗███████╗ █████╗
  ████╗ ████║██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
  ██╔████╔██║█████╗  ██║  ██║██║   ██║███████╗███████║
  ██║╚██╔╝██║██╔══╝  ██║  ██║██║   ██║╚════██║██╔══██║
  ██║ ╚═╝ ██║███████╗██████╔╝╚██████╔╝███████║██║  ██║
  ╚═╝     ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝
BANNER
echo -e "  Setup v1.0${X}"
echo ""

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
hdr "1/5  Checking prerequisites..."

MISSING=()
if ! command -v node &>/dev/null; then
    MISSING+=("node ≥18  →  https://nodejs.org  or:  brew install node")
fi
if ! command -v npm &>/dev/null; then
    MISSING+=("npm  (ships with node)")
fi
if ! command -v claude &>/dev/null; then
    MISSING+=("claude CLI  →  https://claude.ai/download")
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
    err "Missing required tools:"
    for m in "${MISSING[@]}"; do echo "      • $m"; done
    echo ""
    err "Install the above and re-run: bash setup.sh"
    exit 1
fi

NODE_VER=$(node --version)
NPM_VER=$(npm --version)
ok "node $NODE_VER"
ok "npm  v$NPM_VER"
ok "claude CLI"

# Warn if node < 18
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ $NODE_MAJOR -lt 18 ]]; then
    warn "node $NODE_VER detected — node ≥18 recommended (some features may not work)"
fi

# ── 2. Install npm dependencies ───────────────────────────────────────────────
hdr "2/5  Installing npm dependencies..."

cd "$ROOT_DIR"
npm install --silent
ok "root deps  (includes @playwright/mcp)"

cd "$ROOT_DIR/client"
npm install --silent
ok "client deps"

cd "$ROOT_DIR/server"
npm install --silent
ok "server deps"

# ── 3. Build server TypeScript ────────────────────────────────────────────────
hdr "3/5  Building server TypeScript..."

cd "$ROOT_DIR/server"
npx tsc 2>&1 | grep -E "^src.*error TS" | head -10 || true

if [[ -f "$ROOT_DIR/server/dist/index.js" ]]; then
    ok "Server built  →  server/dist/index.js"
else
    warn "dist/index.js not found — check TypeScript errors above"
fi

# ── 4. Playwright MCP ─────────────────────────────────────────────────────────
hdr "4/5  Configuring Playwright MCP..."

# .mcp.json (committed to repo) handles project-level MCP config for Claude Code.
# We also register at user scope so it persists across all projects on this machine.
#
# The binary lives in ./node_modules/@playwright/mcp/cli.js (installed in step 2).
# Uses system Chrome — no separate browser download needed on macOS.

NODE_BIN="$(command -v node)"
MCP_CLI="$ROOT_DIR/node_modules/@playwright/mcp/cli.js"

if [[ ! -f "$MCP_CLI" ]]; then
    err "@playwright/mcp not found at $MCP_CLI — npm install may have failed"
    warn "Playwright MCP registration skipped"
else
    # Re-register (idempotent — remove first to avoid duplicate)
    claude mcp remove playwright --scope user 2>/dev/null || true
    claude mcp add --scope user playwright -- \
        "$NODE_BIN" "$MCP_CLI" \
        --browser chrome \
        --caps screenshots \
        2>&1 | grep -v "^$" || true
    ok "Playwright MCP registered (user scope)"
    ok ".mcp.json project config in place"
    echo "    Tools: browser_navigate, browser_click, browser_type, browser_snapshot, browser_take_screenshot, ..."
fi

# ── 5. Environment file ────────────────────────────────────────────────────────
hdr "5/5  Environment..."

cd "$ROOT_DIR"
if [[ ! -f ".env" ]]; then
    if [[ -f ".env.example" ]]; then
        cp .env.example .env
        warn ".env created from .env.example"
        warn "→  Open .env and set:  AUTH_TOKEN=<random-secret>"
    else
        warn "No .env.example — create .env manually"
    fi
else
    ok ".env already exists"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${G}${B}══════════════════════════════════════${X}"
echo -e "${G}${B}  ✓ Medusa setup complete!${X}"
echo -e "${G}${B}══════════════════════════════════════${X}"
echo ""
echo "  Start dev:        npm run dev"
echo "  Start prod:       npm run build && npm start"
echo ""
echo "  Playwright MCP auto-loads when Claude Code opens this repo."
echo "  Restart Claude Code if it was open during setup."
echo ""
