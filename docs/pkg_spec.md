# Feature: Medusa Distribution & Install Experience (PKG)

**Priority:** P1
**Assigned to:** Backend Dev (packaging), Full Stack Dev (setup wizard UI)
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

A new user who discovers Medusa on GitHub has no clear path to getting it running. The install process currently requires technical knowledge (Node.js, npm, Xcode, build steps) and has no first-run setup for auth tokens. This is a significant barrier to adoption. The experience should be Apple-quality: download, open, done.

## Proposed Solution

A polished distribution package (DMG) with a first-run setup wizard that handles everything — auth token configuration, dependency checking, and getting the user to a working Medusa in as few steps as possible. No requirement to install Xcode, Android Studio, or VS Code unless truly unavoidable.

## Success Criteria

- A new user can go from GitHub download to a working Medusa session in under 5 minutes
- No terminal commands required for standard install
- Auth token setup is guided and clear
- The experience feels polished and intentional — not a developer tool cobbled together

---

## Scope

**In (v1 — must ship):**
- Distributable DMG with drag-to-Applications install
- First-run setup wizard: auth token input, validation, and save
- Dependency bundling: Node.js runtime bundled OR auto-install via a one-click script
- Clear error messages if something goes wrong during setup
- "Check for updates" hook (basic — can link to GitHub releases page)

**In (nice-to-have, if effort allows):**
- Support for additional AI providers during setup (OpenAI, etc.)
- Auto-start on login option during setup
- Light onboarding within the setup wizard itself

**Out:**
- Auto-updater (Sparkle framework integration) — v2
- Code signing / App Store distribution — separate track
- Windows / Linux packaging — v2

---

## Key Constraints

- Node.js must not require a separate install by the user. Options:
  - Bundle Node.js runtime inside the app (using `pkg`, `nexe`, or Electron's built-in Node)
  - OR ship a minimal shell script that installs Node via Homebrew with user consent (one click)
- Xcode NOT required. Build-app.sh is for devs only — end users get a pre-built binary in the DMG
- The shipped DMG must contain a pre-built `Medusa.app` — no compilation on user's machine

---

## Setup Wizard Flow

1. **Welcome screen** — "Welcome to Medusa. Let's get you set up."
2. **Auth token input** — "Enter your Claude API key" (or other provider). Masked input. Validation step (ping API to confirm key works).
3. **Success screen** — "You're all set. Opening Medusa…" → launch main app
4. **Error handling** — if token invalid: show clear error, let user retry. If network unavailable: allow "skip for now" with reminder to add token in Settings.

---

## Technical Notes

### DMG Creation
- Use `create-dmg` npm package or `hdiutil` script to package `app/Medusa.app` into a distributable DMG
- DMG should include: `Medusa.app` + Applications symlink (standard drag-to-install UX)
- Background image optional but adds polish (Medusa branding)
- Add `scripts/package.sh` to automate DMG creation for each release

### First-Run Setup Wizard
- Detect first run via absence of `~/.claude-chat/settings.json`
- Wizard can be: a separate native Swift window before main app launches OR a full-screen React overlay within the app
- Token validation: `POST /api/validate-token` (new endpoint) — attempts a minimal API call to verify
- On success: write token to `~/.claude-chat/settings.json`, launch main UI

### Dependency Handling
- Check if Node.js is available: `which node`
- If not: prompt user with one-click Homebrew install option OR bundle Node runtime
- npm dependencies: pre-install and bundle in the distributed package (no `npm install` on user machine)
- Server must start automatically when Medusa.app launches — no manual `npm start`

### Token Validation Endpoint (new)
- `POST /api/validate-token` — accepts `{ token: string, provider: string }`
- Makes minimal API call (e.g., list models) to confirm token is valid
- Returns `{ valid: boolean, error?: string }`

---

## Acceptance Criteria

- [ ] Given a user downloads the DMG and drags Medusa.app to Applications, the app opens without requiring terminal commands
- [ ] Given first launch, a setup wizard appears prompting for an auth token before the main UI
- [ ] Given a valid auth token is entered, validation confirms it works and the main UI opens
- [ ] Given an invalid token, a clear error is shown with instructions to get a valid token
- [ ] Given Node.js is not installed, the app handles this gracefully (installs it or shows clear instructions)
- [ ] Given setup is complete, subsequent launches go directly to the main UI (no wizard)
- [ ] The DMG opens with a standard drag-to-Applications install window
- [ ] Total time from DMG download to working Medusa session: under 5 minutes for a non-technical user

## Open Questions

1. Bundle Node.js runtime (larger DMG, zero dependency) vs. one-click Homebrew install (smaller DMG, requires internet)?
2. Code signing: without notarization, macOS Gatekeeper will block the app for most users. Should we prioritize notarization in v1?
3. What AI providers to support in v1 setup wizard? (Claude only, or Claude + OpenAI?)

## Build Notes

- Native build + packaging work — requires user's macOS environment for final DMG creation
- Backend Dev: implement `package.sh` and token validation endpoint
- Full Stack Dev: implement setup wizard UI
- Tag @You for review of DMG before publishing — user approves distribution artifacts
