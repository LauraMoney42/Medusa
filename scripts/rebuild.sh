#!/usr/bin/env bash
# rebuild.sh — Full Medusa rebuild + graceful restart.
#
# Usage: ./scripts/rebuild.sh
#
# Steps:
#   1. Run full production build (server TS + client Vite + copy to dist/public)
#   2. Rebuild Medusa.app Electron wrapper (app/build-app.sh)
#   3. Gracefully stop existing server process (SIGTERM, 5s timeout, then SIGKILL)
#   4. Start fresh server process in background
#   5. Confirm server is up before printing success
#
# NOTE: After running this script, you must QUIT and RELAUNCH Medusa.app manually.
#       The app binary is rebuilt but the running instance isn't auto-restarted.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SERVER_PORT="${PORT:-3456}"
HEALTH_URL="http://localhost:${SERVER_PORT}/api/health"
LOG_FILE="/tmp/medusa-server.log"

echo "=== Medusa Rebuild + Restart ==="
echo ""

# ---- Step 1: Build server + client ----
echo "Building server + client..."
if ! bash "$ROOT_DIR/scripts/build.sh"; then
  echo ""
  echo "❌ Build FAILED — server not restarted. Fix build errors before tagging QA."
  exit 1
fi

echo ""
echo "✅ Server + client build succeeded."
echo ""

# ---- Step 2: Rebuild Medusa.app (Electron wrapper) ----
echo "Rebuilding Medusa.app..."
if ! bash "$ROOT_DIR/app/build-app.sh"; then
  echo ""
  echo "❌ Medusa.app build FAILED — server not restarted. Fix Swift build errors before tagging QA."
  exit 1
fi

echo ""
echo "✅ Medusa.app rebuilt. ⚠️  You must QUIT and RELAUNCH Medusa.app to pick up changes."
echo ""

# ---- Step 3: Stop existing server ----
EXISTING_PIDS=$(pgrep -f "node dist/index.js" 2>/dev/null || true)

if [ -n "$EXISTING_PIDS" ]; then
  echo "Stopping existing server (PID: $EXISTING_PIDS)..."
  # Graceful SIGTERM first
  kill -SIGTERM $EXISTING_PIDS 2>/dev/null || true

  # Wait up to 5s for graceful exit
  for i in $(seq 1 10); do
    sleep 0.5
    STILL_RUNNING=$(pgrep -f "node dist/index.js" 2>/dev/null || true)
    if [ -z "$STILL_RUNNING" ]; then
      echo "Server stopped gracefully."
      break
    fi
    if [ "$i" -eq 10 ]; then
      echo "Server didn't stop in 5s — force killing..."
      kill -SIGKILL $EXISTING_PIDS 2>/dev/null || true
      sleep 0.5
    fi
  done
else
  echo "No existing server process found."
fi

echo ""

# ---- Step 4: Start fresh server ----
echo "Starting Medusa server..."
cd "$ROOT_DIR"
nohup node server/dist/index.js >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "Server starting (PID: $NEW_PID)..."

# ---- Step 5: Wait for server to be ready ----
echo "Waiting for server to be ready..."
for i in $(seq 1 20); do
  sleep 0.5
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    echo ""
    echo "✅ Medusa rebuilt and restarted — safe to tag QA"
    echo "   Server PID: $NEW_PID | Port: $SERVER_PORT | Log: $LOG_FILE"
    echo "   ⚠️  Remember: QUIT + RELAUNCH Medusa.app to use the new binary."
    exit 0
  fi
done

echo ""
echo "❌ Server started (PID: $NEW_PID) but health check failed after 10s."
echo "   Check logs: tail -50 $LOG_FILE"
exit 1
