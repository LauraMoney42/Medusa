#!/usr/bin/env bash
# build.sh — Build client and copy into server for production serving.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:$PATH"

echo "=== Medusa Production Build ==="
echo ""

# Build server TypeScript
echo "Building server..."
cd "$ROOT_DIR/server"
npm run build
echo "Server built."

# Build client
echo ""
echo "Building client..."
cd "$ROOT_DIR/client"
npm run build
echo "Client built."

# Copy to server/dist/public
echo "Copying client build to server/dist/public..."
mkdir -p "$ROOT_DIR/server/dist/public"
rm -rf "$ROOT_DIR/server/dist/public/"*
cp -r "$ROOT_DIR/client/dist/"* "$ROOT_DIR/server/dist/public/"
echo "Done."

echo ""
echo "=== To run in production ==="
echo "  npm start   # serve on port \${PORT:-3456}"
echo ""
