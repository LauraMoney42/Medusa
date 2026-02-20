#!/usr/bin/env bash
# build-app.sh — Compile the Medusa macOS app from Swift sources.
# Creates Medusa.app in the same directory as this script.
#
# Usage:
#   bash app/build-app.sh          # from project root
#   bash build-app.sh              # from app/ directory
#   open app/Medusa.app        # launch the app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Medusa"
APP_BUNDLE="$SCRIPT_DIR/$APP_NAME.app"
SOURCES_DIR="$SCRIPT_DIR/Sources"
RESOURCES_DIR="$SCRIPT_DIR/Resources"

echo "=== Building $APP_NAME.app ==="

# Clean previous build
rm -rf "$APP_BUNDLE"

# Create .app bundle directory structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Copy Info.plist
cp "$RESOURCES_DIR/Info.plist" "$APP_BUNDLE/Contents/"

# Generate app icon from PNG if available
ICON_PNG="$(cd "$SCRIPT_DIR/.." && pwd)/Pictures/MedusaIcon.png"
if [ ! -f "$ICON_PNG" ]; then
    ICON_PNG="$HOME/Pictures/MedusaIcon.png"
fi
if [ -f "$ICON_PNG" ]; then
    echo "Generating app icon..."
    ICONSET=$(mktemp -d)/Medusa.iconset
    mkdir -p "$ICONSET"

    # Make the source square first (pad to equal dimensions) so logo fills canvas edge-to-edge
    TMPDIR_ICON=$(mktemp -d)
    SQUARED="$TMPDIR_ICON/icon_squared.png"
    sips -z 888 888 "$ICON_PNG" --out "$SQUARED" > /dev/null 2>&1 || cp "$ICON_PNG" "$SQUARED"

    for size in 16 32 64 128 256 512; do
        sips -z $size $size "$SQUARED" --out "$ICONSET/icon_${size}x${size}.png" > /dev/null 2>&1
    done
    for size in 16 32 128 256 512; do
        double=$((size * 2))
        sips -z $double $double "$SQUARED" --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null 2>&1
    done
    iconutil -c icns "$ICONSET" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
    rm -rf "$(dirname "$ICONSET")" "$TMPDIR_ICON"
fi

echo "Compiling Swift sources..."

# Compile all Swift files into a single binary.
# Uses system frameworks only — no SPM or Xcode needed.
swiftc \
    -o "$APP_BUNDLE/Contents/MacOS/$APP_NAME" \
    -framework Cocoa \
    -framework WebKit \
    -framework ScreenCaptureKit \
    -target arm64-apple-macosx13.0 \
    -O \
    "$SOURCES_DIR/ServerManager.swift" \
    "$SOURCES_DIR/WebViewController.swift" \
    "$SOURCES_DIR/WindowPickerController.swift" \
    "$SOURCES_DIR/RegionPickerController.swift" \
    "$SOURCES_DIR/main.swift"

# Re-sign the bundle so that:
# 1. Info.plist is bound to the signature (fixes "Info.plist=not bound" — required for TCC persistence)
# 2. The code signing identifier is derived from CFBundleIdentifier (com.claudechat.app),
#    not the app bundle directory name ("Medusa"). macOS TCC keys permissions to bundle ID —
#    a consistent bundle ID across rebuilds means Screen Recording permission survives rebuilds.
echo "Signing bundle..."
codesign --force --sign - --deep --timestamp=none "$APP_BUNDLE"

echo ""
echo "Built successfully: $APP_BUNDLE"
echo ""
echo "To run:"
echo "  open $APP_BUNDLE"
echo ""
echo "NOTE: After relaunching, if Screen Recording prompt does not appear,"
echo "  go to System Settings → Privacy & Security → Screen Recording"
echo "  and toggle Medusa off then back on."
