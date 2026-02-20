#!/usr/bin/env bash
# dev.sh — Start server and client in dev mode with hot reload.
# Uses caffeinate to prevent Mac sleep during development.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:$PATH"

# Track child PIDs for cleanup
SERVER_PID=""
CLIENT_PID=""

cleanup() {
    echo ""
    echo "Shutting down..."
    [[ -n "$CLIENT_PID" ]] && kill "$CLIENT_PID" 2>/dev/null
    [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
    # Kill caffeinate if we spawned one
    [[ -n "${CAFE_PID:-}" ]] && kill "$CAFE_PID" 2>/dev/null
    wait 2>/dev/null
    echo "Done."
}
trap cleanup SIGINT SIGTERM EXIT

# Prevent Mac from sleeping
caffeinate -i -w $$ &
CAFE_PID=$!

echo "=== Medusa Dev Mode ==="
echo "Root: $ROOT_DIR"
echo ""

# Start server with hot reload
echo "Starting server..."
cd "$ROOT_DIR/server"
npx tsx watch src/index.ts &
SERVER_PID=$!

# Start client dev server
echo "Starting client..."
cd "$ROOT_DIR/client"
npm run dev &
CLIENT_PID=$!

echo ""
echo "Server: http://localhost:3456"
echo "Client: http://localhost:5173 (Vite proxy)"
echo "Press Ctrl+C to stop both."
echo ""

# Wait for either process to exit
wait
