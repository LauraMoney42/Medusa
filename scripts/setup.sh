#!/usr/bin/env bash
# setup.sh — One-shot setup for Medusa.
# Run once after cloning: bash scripts/setup.sh
# After this: npm run dev (or npm start for production)
#
# What this does:
#   1. Checks required tools (node, npm, claude)
#   2. Installs root + client + server npm deps
#   3. Builds server TypeScript → dist/
#   4. Registers Playwright MCP server with Claude Code (user scope)
#   5. Installs & registers OneNote MCP server
#   6. Creates .env from .env.example if missing

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Expand PATH to cover Homebrew (Apple Silicon + Intel), nvm, and Claude Code installs
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# ── Colors ──────────────────────────────────────────────────────────────────
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BOLD="\033[1m"
RESET="\033[0m"

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

echo -e "${BOLD}"
echo "╔══════════════════════════════════╗"
echo "║        Medusa Setup v1.1         ║"
echo "╚══════════════════════════════════╝"
echo -e "${RESET}"

# ── 1. Prerequisite checks ───────────────────────────────────────────────────
step "1/6  Checking prerequisites..."

MISSING=()

if ! command -v node &>/dev/null; then
    MISSING+=("node (https://nodejs.org or: brew install node)")
fi
if ! command -v npm &>/dev/null; then
    MISSING+=("npm (comes with node)")
fi
if ! command -v claude &>/dev/null; then
    MISSING+=("claude CLI (https://claude.ai/download)")
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
    err "Missing required tools:"
    for m in "${MISSING[@]}"; do echo "    • $m"; done
    echo ""
    err "Install them and re-run setup.sh"
    exit 1
fi

NODE_VER=$(node --version)
NPM_VER=$(npm --version)
ok "node $NODE_VER"
ok "npm  v$NPM_VER"
ok "claude CLI found"

# ── 2. npm install (root + client + server) ──────────────────────────────────
step "2/6  Installing npm dependencies..."

cd "$ROOT_DIR"
npm install --silent
ok "root deps installed"

cd "$ROOT_DIR/client"
npm install --silent
ok "client deps installed"

cd "$ROOT_DIR/server"
npm install --silent
ok "server deps installed"

# ── 3. Build server TypeScript ───────────────────────────────────────────────
step "3/6  Building server (TypeScript → dist/)..."

cd "$ROOT_DIR/server"
npx tsc --noEmit false 2>&1 | grep -E "error TS" | head -20 || true

if [[ -d "$ROOT_DIR/server/dist" ]]; then
    ok "Server built → server/dist/"
else
    warn "Build may have had issues — check above output"
fi

# ── 4. Playwright MCP ────────────────────────────────────────────────────────
step "4/6  Configuring Playwright MCP for Claude Code..."

# Install @playwright/mcp globally (lightweight — no browser download needed,
# uses system Chrome which is already present on Mac)
if npm list -g @playwright/mcp &>/dev/null 2>&1; then
    ok "@playwright/mcp already installed globally"
else
    echo "    Installing @playwright/mcp globally..."
    npm install -g @playwright/mcp --silent
    ok "@playwright/mcp installed"
fi

# Find node binary (handles both homebrew and nvm installs)
NODE_BIN="$(command -v node)"
MCP_CLI="$(npm root -g)/@playwright/mcp/cli.js"

if [[ ! -f "$MCP_CLI" ]]; then
    # Fallback: search common locations
    MCP_CLI="$(find /opt/homebrew/lib/node_modules /usr/local/lib/node_modules 2>/dev/null \
        -name "cli.js" -path "*/@playwright/mcp/cli.js" | head -1)"
fi

if [[ -z "$MCP_CLI" ]]; then
    warn "Could not locate @playwright/mcp/cli.js — MCP registration skipped"
    warn "Manually run: claude mcp add playwright -- \$(which node) <path-to-mcp>/cli.js --browser chrome --caps screenshots"
else
    # Register with Claude Code (user scope = persists across all projects)
    # Remove existing to avoid duplicate if re-running setup
    claude mcp remove playwright --scope user 2>/dev/null || true
    claude mcp add --scope user playwright -- \
        "$NODE_BIN" "$MCP_CLI" \
        --browser chrome \
        --caps screenshots \
        2>&1 | grep -v "^$" || true
    ok "Playwright MCP registered (user scope)"
    echo "    Command: $NODE_BIN $MCP_CLI --browser chrome --caps screenshots"
fi

# ── 5. OneNote MCP ───────────────────────────────────────────────────────────
step "5/6  Configuring OneNote MCP for Claude Code..."

# Install mcp-server-onenote globally — provides OneNote read/search/create via MS Graph API
if npm list -g mcp-server-onenote &>/dev/null 2>&1; then
    ok "mcp-server-onenote already installed globally"
else
    echo "    Installing mcp-server-onenote globally..."
    npm install -g mcp-server-onenote --silent
    ok "mcp-server-onenote installed"
fi

# Locate the installed entry point
ONENOTE_CLI="$(npm root -g)/mcp-server-onenote/dist/index.js"
if [[ ! -f "$ONENOTE_CLI" ]]; then
    ONENOTE_CLI="$(find /opt/homebrew/lib/node_modules /usr/local/lib/node_modules 2>/dev/null \
        -name "index.js" -path "*/mcp-server-onenote/dist/index.js" | head -1)"
fi

if [[ -z "$ONENOTE_CLI" ]]; then
    warn "Could not locate mcp-server-onenote — skipping registration"
    warn "To enable OneNote: npm install -g mcp-server-onenote"
    warn "Then add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET to .env"
else
    # Update .mcp.json with the resolved path (portable across machines)
    # .mcp.json is the project-level MCP config read by Claude Code automatically
    python3 - "$ONENOTE_CLI" "$NODE_BIN" "$ROOT_DIR/.mcp.json" << 'PYEOF'
import json, sys, os

onenote_cli = sys.argv[1]
node_bin    = sys.argv[2]
mcp_path    = sys.argv[3]

config = {"mcpServers": {}}
if os.path.exists(mcp_path):
    with open(mcp_path) as f:
        config = json.load(f)

config["mcpServers"]["playwright"] = {
    "command": node_bin,
    "args": ["./node_modules/@playwright/mcp/cli.js", "--browser", "chrome", "--caps", "screenshots"],
    "env": {}
}
config["mcpServers"]["onenote"] = {
    "command": node_bin,
    "args": [onenote_cli],
    "env": {
        "AZURE_TENANT_ID": "${AZURE_TENANT_ID}",
        "AZURE_CLIENT_ID": "${AZURE_CLIENT_ID}",
        "AZURE_CLIENT_SECRET": "${AZURE_CLIENT_SECRET}"
    }
}

with open(mcp_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PYEOF

    ok "OneNote MCP registered in .mcp.json"
    echo "    Add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET to .env"
    echo "    See docs/ONENOTE_SETUP.md for Azure app registration steps"
fi

# ── 6. .env setup ────────────────────────────────────────────────────────────
step "6/6  Environment setup..."

cd "$ROOT_DIR"
if [[ ! -f ".env" ]]; then
    if [[ -f ".env.example" ]]; then
        cp .env.example .env
        warn ".env created from .env.example — fill in API keys before starting"
    else
        warn "No .env.example found — create .env manually with ANTHROPIC_API_KEY=sk-ant-..."
    fi
else
    ok ".env already exists"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ Setup complete!${RESET}"
echo ""
echo "  Next steps:"
echo "  1. Add your API key to .env:       ANTHROPIC_API_KEY=sk-ant-..."
echo "  2. For OneNote: add to .env:       AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET"
echo "     (See docs/ONENOTE_SETUP.md for Azure app registration guide)"
echo "  3. Start dev mode:                 npm run dev"
echo "  4. Or production:                  npm run build && npm start"
echo ""
echo "  Playwright MCP lets Medusa control Chrome autonomously."
echo "  OneNote MCP lets Medusa read/search/create OneNote pages."
echo "  Both activate automatically when Claude Code starts (restart if open)."
echo ""
