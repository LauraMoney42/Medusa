# SC6 — System-Wide Region Select for Screenshot Tool

**Priority:** P1
**Assigned to:** Full Stack 2
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

The current "Region Select" mode in the screenshot tool is confined to the Medusa window only. The drag-to-select overlay (RegionSelector.tsx) is a React component rendered inside the WKWebView — it is physically bounded by the Medusa app window. Users cannot select a region that extends outside the Medusa window or capture content from other apps.

The user needs true system-wide region selection that mirrors native macOS cmd+shift+4 behavior: a crosshair cursor, draggable selection box that spans any content on any screen.

## Proposed Solution

Replace the web-based RegionSelector.tsx region capture path with a native Swift fullscreen overlay window that handles region selection at the OS level. The selected region's PNG data is returned to WKWebView via JS message handler (same IPC pattern as SC4/SC5).

The React RegionSelector.tsx component can remain as a visual post-capture crop tool if desired, but the initial capture must be native.

## Success Criteria

- User can drag-select any region anywhere on their screen(s), including areas outside the Medusa window
- Crosshair cursor appears during selection (macOS standard behavior)
- Selection rectangle is visible during drag
- Captured region is delivered to chat input as an attachment
- Escape cancels without capturing
- Works across multiple monitors (selection can span monitors or be on secondary monitor)

## Scope

**In:**
- Native Swift fullscreen transparent overlay (NSWindow spanning all screens)
- Crosshair cursor during overlay
- Mouse down → drag → mouse up selection gesture (NSEvent tracking)
- Visual selection rectangle drawn via Core Graphics during drag
- On mouse up: capture the selected CGRect using ScreenCaptureKit or CGWindowListCreateImage
- Pass PNG data back to WKWebView via WKScriptMessageHandler
- Escape key cancels

**Out:**
- Post-capture crop/edit UI (existing RegionSelector.tsx handles crop if needed)
- Magnifier loupe during selection (nice-to-have, v2)
- Selection snap-to-window behavior

## Technical Notes

- Overlay: `NSWindow` with `styleMask: .borderless`, `level: .screenSaver`, `backgroundColor: .clear`, `isOpaque: false`, `alphaValue: 0.001` (fully transparent but receives mouse events)
- Use `NSScreen.screens` to get all screens; set overlay window frame to union of all screen frames
- Track `mouseDown`, `mouseDragged`, `mouseUp` via custom `NSView` subclass (or global event monitor)
- Draw selection rect in `NSView.draw(_:)` using `NSBezierPath` with dimming mask outside selection (semi-transparent black overlay with clear selection rect cutout — standard macOS style)
- On `mouseUp`: compute final `CGRect` in screen coordinates, capture via `SCScreenshotManager.captureImage` with `SCContentFilter` for the display + crop rect, OR use `CGWindowListCreateImage` with the rect
- Return PNG via existing `WKScriptMessageHandler` IPC bridge established in SC4
- Cursor: set `NSCursor.crosshair` on overlay window activation

## Acceptance Criteria

- [ ] Given the user clicks "Region Select" in the screenshot dropdown, a fullscreen transparent overlay appears with a crosshair cursor
- [ ] Given the overlay is active, clicking and dragging draws a visible selection rectangle
- [ ] Given a selection is complete (mouse up), the selected region is captured and attached to chat input
- [ ] Given the overlay is active, pressing Escape cancels and returns to normal Medusa state
- [ ] Given content exists outside the Medusa window, the user can select and capture it
- [ ] Given multiple monitors, the user can select a region on any monitor
- [ ] The captured image accurately reflects the pixels in the selected region
- [ ] Selection rectangle shows dimming outside the selected area (standard macOS UX)

## Build Notes

- Native Swift change — requires `bash app/build-app.sh` after implementation (two-tier build rule)
- Tag @You with build command before claiming done — do NOT self-certify
- After rebuild: System Settings → Privacy & Security → Screen Recording → toggle Medusa OFF/ON (macOS TCC requirement)
- Tag @You for verification — user is acting as QA
- Screen Recording permission required — already granted from SC4, but TCC re-grant needed after rebuild
