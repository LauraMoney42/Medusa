#!/usr/bin/env bash
# build-sidecar.sh -- Build server/ and compile it into a single Tauri
# sidecar binary at desktop/src-tauri/binaries/medusa-server-<target-triple>.
#
# Tauri requires externalBin binaries to be named with the host's Rust
# target triple suffix (see desktop/src-tauri/tauri.conf.json ->
# bundle.externalBin). This script figures out the triple, builds the
# Node/TS server, and compiles server/dist into one binary:
#   - bun build --compile (bun is required; pkg cannot run this ESM server).
#
# Usage:
#   bash desktop/scripts/build-sidecar.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
CLIENT_DIR="$ROOT_DIR/client"
BIN_DIR="$DESKTOP_DIR/src-tauri/binaries"
RESOURCES_DIR="$DESKTOP_DIR/src-tauri/resources"

mkdir -p "$BIN_DIR" "$RESOURCES_DIR"

# --- 1. Determine the Rust target triple Tauri expects for this host -------
# Prefer `rustc -vV`; this matches exactly what `tauri build`/`tauri dev`
# look for when resolving `bundle.externalBin` entries. Fall back to
# `rustup show` if rustc isn't on PATH yet (e.g. dev machine setup order).
if command -v rustc >/dev/null 2>&1; then
  TARGET_TRIPLE="$(rustc -vV | awk '/^host:/ { print $2 }')"
elif command -v rustup >/dev/null 2>&1; then
  TARGET_TRIPLE="$(rustup show active-toolchain 2>/dev/null | awk '{ print $1 }' | sed -E 's/^[^-]+-//')"
else
  echo "error: neither rustc nor rustup found on PATH; cannot determine target triple." >&2
  echo "       install Rust via https://rustup.rs first." >&2
  exit 1
fi

if [ -z "$TARGET_TRIPLE" ]; then
  echo "error: could not determine target triple." >&2
  exit 1
fi

OUT_BIN="$BIN_DIR/medusa-server-$TARGET_TRIPLE"
echo "=== Building Medusa server sidecar for $TARGET_TRIPLE ==="

# --- 2. Build server/ TypeScript --------------------------------------------
echo "Installing server dependencies..."
(cd "$SERVER_DIR" && npm install)

echo "Building server (tsc)..."
(cd "$SERVER_DIR" && npm run build)

if [ ! -f "$SERVER_DIR/dist/index.js" ]; then
  echo "error: server/dist/index.js not found after build." >&2
  exit 1
fi

# --- 3. Build the client and copy it into server/dist/public ---------------
# The server (server/src/index.ts) serves its static UI from
# path.resolve(__dirname, "public"), same as scripts/build.sh's production
# layout. We reuse that convention so the sidecar serves the exact same
# client bundle Tauri's own frontendDist points at (see
# desktop/src-tauri/tauri.conf.json).
echo "Building client..."
(cd "$CLIENT_DIR" && npm install && npm run build)

echo "Copying client build into server/dist/public..."
rm -rf "$SERVER_DIR/dist/public"
mkdir -p "$SERVER_DIR/dist/public"
cp -r "$CLIENT_DIR/dist/." "$SERVER_DIR/dist/public/"

# Also stage a real copy next to the sidecar binary as a Tauri bundle
# resource (desktop/src-tauri/tauri.conf.json -> bundle.resources). See
# desktop/src-tauri/sidecar-src/entry.mjs for why the compiled binary reads
# its static assets from here instead of embedding them.
rm -rf "$RESOURCES_DIR/public"
mkdir -p "$RESOURCES_DIR"
cp -r "$SERVER_DIR/dist/public" "$RESOURCES_DIR/public"

# --- 4. Compile dist/ into a single binary ----------------------------------
# Compiles server/dist/index.js directly. server/src/config.ts resolves its
# runtime paths (.env, uploads/default-bots.json, the static client dir)
# through MEDUSA_ENV_FILE / MEDUSA_DATA_DIR / MEDUSA_STATIC_DIR when set,
# falling back to __dirname-relative paths otherwise. desktop/src-tauri/src/
# main.rs always sets those three env vars before spawning the sidecar, so
# there's no need for a shim entrypoint that patches fs to redirect
# bun's flattened import.meta.url paths (a previous version of this script
# used desktop/src-tauri/sidecar-src/entry.mjs for exactly that; it's no
# longer needed now that the paths are overridable directly).
ENTRY="$SERVER_DIR/dist/index.js"

# bun is required: pkg cannot run this ESM server (import.meta.url is lost).
# Look on PATH first, then in bun's default install location.
BUN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN" ]; then
  echo "error: bun not found (PATH or ~/.bun/bin). Install it: https://bun.sh/install" >&2
  exit 1
fi
echo "compiling sidecar with $BUN ($("$BUN" --version))..."
"$BUN" build --compile --target=bun "$ENTRY" --outfile "$OUT_BIN"

if [ ! -f "$OUT_BIN" ]; then
  echo "error: sidecar binary was not produced at $OUT_BIN" >&2
  exit 1
fi

chmod +x "$OUT_BIN"
echo ""
echo "Sidecar built: $OUT_BIN"
echo "Public assets staged at: $RESOURCES_DIR/public"
echo "Registered in desktop/src-tauri/tauri.conf.json as bundle.externalBin: [\"binaries/medusa-server\"]"
echo "                                                and bundle.resources: [\"resources/public\"]"
