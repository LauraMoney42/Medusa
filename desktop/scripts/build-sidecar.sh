#!/usr/bin/env bash
# build-sidecar.sh -- Build server/ and compile it into a single Tauri
# sidecar binary at desktop/src-tauri/binaries/medusa-server-<target-triple>.
#
# Tauri requires externalBin binaries to be named with the host's Rust
# target triple suffix (see desktop/src-tauri/tauri.conf.json ->
# bundle.externalBin). This script figures out the triple, builds the
# Node/TS server, and compiles server/dist into one binary:
#   - bun build --compile, if bun is installed (fast, small binary), else
#   - npx pkg, as a fallback (works anywhere Node/npm is available).
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
# The entry point is desktop/src-tauri/sidecar-src/entry.mjs, not
# server/dist/index.js directly -- it patches a handful of filesystem calls
# before dynamically importing the real server so the compiled binary
# doesn't crash on startup. See that file's header comment for the full
# story (bun's standalone --compile mode flattens every bundled module's
# import.meta.url, which server/src/config.ts and friends rely on for
# __dirname-relative paths).
ENTRY="$DESKTOP_DIR/src-tauri/sidecar-src/entry.mjs"

if command -v bun >/dev/null 2>&1; then
  echo "bun found -- compiling with 'bun build --compile'..."
  bun build --compile --target=bun "$ENTRY" --outfile "$OUT_BIN"
else
  echo "bun not found -- falling back to 'npx pkg'..."
  echo "warning: pkg cannot load this server's ESM output at all (fails with" >&2
  echo "         MODULE_NOT_FOUND on the compiled binary) -- install bun instead:" >&2
  echo "         https://bun.sh/install" >&2
  # Best-effort attempt anyway, bundled to CJS first via esbuild so pkg has
  # something it can at least try to snapshot.
  BUNDLE="$(mktemp -d)/bundle.cjs"
  (cd "$SERVER_DIR" && npx --yes esbuild dist/index.js --bundle --platform=node --format=cjs --outfile="$BUNDLE")
  npx --yes pkg "$BUNDLE" --targets node18 --output "$OUT_BIN"
fi

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
