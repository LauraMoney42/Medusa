# SC5 — Window Picker for Screenshot Tool

**Priority:** P1
**Assigned to:** Full Stack 2
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

When the user selects "Window" capture mode in the screenshot tool, the app currently captures a fixed target (the entire Medusa window). The user has no way to choose WHICH window to capture. This is not useful when the user wants to attach a screenshot of another app running on their Mac.

## Proposed Solution

Implement a native macOS window picker that mirrors Apple's spacebar window mode (cmd+shift+4 → spacebar). When the user selects "Window" mode:

1. A native overlay appears
2. User hovers over any open window — it highlights with a blue border
3. User clicks to capture that window
4. Captured image is returned to the Medusa chat input as an attachment

## Success Criteria

- User can capture ANY open window on their Mac, not just Medusa
- Hover highlight clearly shows which window will be captured
- Click captures and delivers the image to chat input
- Escape key cancels without capturing
- Works across multiple monitors

## Scope

**In:**
- Native Swift window picker overlay (NSWindow, fullscreen, transparent)
- ScreenCaptureKit window enumeration (SCShareableContent)
- Hover-to-highlight with blue border effect
- Click-to-capture and return image to WKWebView via JS message handler
- Escape key cancels
- Multi-monitor support

**Out:**
- Animated transitions or fancy UI beyond Apple-native style
- Preview thumbnails of window contents before capture (nice-to-have, v2)
- Window filtering or search

## Technical Notes

- Use `SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true)` to enumerate visible windows
- Overlay window must be `NSWindowStyleMask.borderless`, `NSWindowLevel.screenSaver` to sit above all windows
- Track `NSTrackingArea` mouse events to detect which `SCWindow` is under cursor
- On click: capture via `SCScreenshotManager.captureImage(contentFilter:configuration:)` with `SCContentFilter(desktopIndependentWindow: window)`
- Pass resulting PNG data back to WKWebView via `WKScriptMessageHandler` (same IPC pattern used in SC4)
- Escape key: add local monitor for `NSEvent.EventType.keyDown` with keyCode 53

## Acceptance Criteria

- [ ] Given the user clicks "Window" in the screenshot dropdown, a full-screen transparent overlay appears covering all screens
- [ ] Given the overlay is active, hovering over any visible window highlights it with a visible border
- [ ] Given a window is highlighted, clicking it captures that window and attaches the image to chat input
- [ ] Given the overlay is active, pressing Escape cancels without capturing anything
- [ ] Given multiple monitors are connected, windows on all monitors are hoverable and capturable
- [ ] Given Medusa itself is one of the visible windows, it can be captured like any other window
- [ ] After capture, the overlay dismisses immediately and chat input shows the attached image

## Build Notes

- Native Swift change — requires `bash app/build-app.sh` after implementation (two-tier build rule)
- Tag @You with build command before claiming done — do NOT self-certify
- After rebuild: System Settings → Privacy & Security → Screen Recording → toggle Medusa OFF/ON (macOS TCC requirement)
- Tag @You for verification — user is acting as QA
