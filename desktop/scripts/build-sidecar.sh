#!/usr/bin/env bash
# build-sidecar.sh -- Build server/ and compile it into two Tauri sidecar
# binaries: desktop/src-tauri/binaries/medusa-server-<target-triple> and
# medusa-mcp-shim-<target-triple>.
#
# Tauri requires externalBin binaries to be named with the host's Rust
# target triple suffix (see desktop/src-tauri/tauri.conf.json ->
# bundle.externalBin). This script figures out the triple, builds the
# Node/TS server, and compiles server/dist into one binary:
#   - bun build --compile (bun is required; pkg cannot run this ESM server).
# It then does the same for server/dist/mcp/medusa-mcp-shim.js, so the MCP
# shim engines spawn to reach Medusa's subagent tools also has a real,
# standalone binary rather than a `node <script>` pair whose script path
# would otherwise resolve inside the server binary's own virtual filesystem.
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
TMPDIR_GUARD="$(mktemp -d)"
# Guard: the server bundle must not contain the MCP SDK. Its zod schemas do
# not initialize inside a bun single-file bundle (crash at startup); only the
# shim binary may import the SDK.
if "$BUN" build --target=bun "$ENTRY" --outfile "$TMPDIR_GUARD/server-bundle.js" >/dev/null 2>&1 \
   && grep -q "@modelcontextprotocol/sdk" "$TMPDIR_GUARD/server-bundle.js"; then
  echo "error: server bundle imports @modelcontextprotocol/sdk (see server/src/mcp/client.ts note)" >&2
  exit 1
fi
"$BUN" build --compile --target=bun "$ENTRY" --outfile "$OUT_BIN"

if [ ! -f "$OUT_BIN" ]; then
  echo "error: sidecar binary was not produced at $OUT_BIN" >&2
  exit 1
fi

chmod +x "$OUT_BIN"

# --- 5. Compile the MCP shim into its own sidecar binary --------------------
# server/src/mcp/descriptor.ts's resolveShimPath() resolves the shim script's
# path relative to import.meta.url. Inside THIS compiled binary that resolves
# inside the bun binary's own virtual filesystem (there is no real
# server/dist/mcp/medusa-mcp-shim.js on disk), so `node <that path>` fails and
# the shim never starts -- every engine's MCP connection then fails outright
# and Kimi/Claude fail their whole turn ("Failed to connect MCP servers").
# The fix is the same one step 4 above already applies to the server itself:
# compile the shim too, as its own standalone binary that needs no `node` and
# no on-disk script file. desktop/src-tauri/src/main.rs resolves this
# binary's bundled path and passes it to the server sidecar as
# MEDUSA_MCP_SHIM_BIN; server/src/mcp/descriptor.ts then runs it directly
# instead of `node <shim path>` (see its MEDUSA_MCP_SHIM_BIN handling).
SHIM_ENTRY="$SERVER_DIR/dist/mcp/medusa-mcp-shim.js"
SHIM_OUT_BIN="$BIN_DIR/medusa-mcp-shim-$TARGET_TRIPLE"

if [ ! -f "$SHIM_ENTRY" ]; then
  echo "error: $SHIM_ENTRY not found after server build." >&2
  exit 1
fi

echo "compiling MCP shim sidecar with $BUN..."
"$BUN" build --compile --target=bun "$SHIM_ENTRY" --outfile "$SHIM_OUT_BIN"

if [ ! -f "$SHIM_OUT_BIN" ]; then
  echo "error: MCP shim sidecar was not produced at $SHIM_OUT_BIN" >&2
  exit 1
fi

chmod +x "$SHIM_OUT_BIN"

echo ""
echo "Sidecar built: $OUT_BIN"
echo "MCP shim sidecar built: $SHIM_OUT_BIN"
echo "Public assets staged at: $RESOURCES_DIR/public"
echo "Registered in desktop/src-tauri/tauri.conf.json as bundle.externalBin: [\"binaries/medusa-server\", \"binaries/medusa-mcp-shim\"]"
echo "                                                and bundle.resources: [\"resources/public\"]"
