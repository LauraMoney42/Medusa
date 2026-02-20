# Feature: First-Launch Permissions Flow (PERMS)

**Priority:** P1
**Assigned to:** Full Stack 2
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

Medusa requires multiple macOS privacy permissions (Screen Recording, Photos, File/Folder Access) to function properly. Currently, these are requested mid-session when the user first tries to use a feature — creating surprise interruptions and eroding trust. Users should know upfront what Medusa needs and why.

## Proposed Solution

On very first Medusa launch, present a single native permission-request flow that asks for ALL required permissions at once before the user reaches the main UI. Each permission is explained clearly. User grants them all in one go — no mid-session surprises.

## Success Criteria

- All required permissions requested on first launch, before main UI
- Each permission has a clear human-readable explanation of why it's needed
- User can see which permissions are granted vs. pending
- If user denies a permission, app does not crash — gracefully shows what will be limited
- Never shown again after first launch (same localStorage/UserDefaults gate as onboarding)
- Works alongside the onboarding carousel (permissions flow runs after onboarding OR integrated into it as a final step)

---

## Permissions to Request

| Permission | API | Why Needed |
|-----------|-----|-----------|
| Screen Recording | `ScreenCaptureKit` / `CGRequestScreenCaptureAccess()` | Screenshot tool — capture screen content |
| Photos / Screenshots | `PHPhotoLibrary.requestAuthorization()` | Attach photos from library to chat |
| File/Folder Access | `NSOpenPanel` / Powerbox | Drag-and-drop files, file picker attachment |

---

## Scope

**In:**
- Native Swift permission request flow in `WebViewController.swift` or `AppDelegate.swift`
- Check each permission status before requesting (avoid re-requesting already-granted)
- Simple UI: list of permissions with icon + name + explanation + status indicator
- "Grant Permissions" button triggers each request in sequence
- "Skip for Now" option (with warning that features will be limited)
- Runs on first launch only — `UserDefaults` key `medusa_hasRequestedPermissions`
- Graceful degradation if permission denied (screenshot tool falls back to file picker, etc.)

**Out:**
- Custom permission explanation screens (native macOS dialogs are sufficient)
- Forcing permissions (macOS does not allow this — user always has final say)
- Re-requesting denied permissions (direct user to System Settings instead)

---

## Technical Notes

- Check permission status first: `CGPreflightScreenCaptureAccess()`, `PHPhotoLibrary.authorizationStatus()`, check entitlements for file access
- Request via `CGRequestScreenCaptureAccess()` for Screen Recording
- Request via `PHPhotoLibrary.requestAuthorization(for: .readWrite)` for Photos
- File/Folder access is handled via NSOpenPanel — no explicit pre-request needed; just ensure correct entitlements in build
- Sequence: check → request only if not determined → handle result
- Bridge result to WKWebView via `WKScriptMessageHandler` if UI needs to show confirmation
- Store completion: `UserDefaults.standard.set(true, forKey: "medusa_hasRequestedPermissions")`

## Sequencing with Onboarding

- Option A: Run permissions flow AFTER onboarding carousel completes (recommended — user knows what app does before granting permissions)
- Option B: Add as final slide in onboarding carousel
- Default: Option A unless user/team prefers Option B

---

## Acceptance Criteria

- [ ] Given a fresh Medusa install, permissions flow appears before main UI (after onboarding if applicable)
- [ ] Given all permissions are already granted, flow is skipped silently
- [ ] Given the flow runs, all 3 permissions are explained with a clear reason before requesting
- [ ] Given user grants Screen Recording, `CGPreflightScreenCaptureAccess()` returns true immediately after
- [ ] Given user denies a permission, app launches normally with affected features gracefully degraded (no crash)
- [ ] Given user has completed the flow once, it never appears again on subsequent launches
- [ ] Given a permission was denied, app shows a non-blocking notice pointing to System Settings

## Build Notes

- Native Swift change — requires `bash app/build-app.sh` (two-tier build rule)
- Tag @You with build command before claiming done — do NOT self-certify
- After rebuild: test on a fresh user account or reset permissions via `tccutil reset All` for testing
- Tag @You for verification — user is acting as QA
