# Feature: Medusa Settings Pane (SETTINGS)

**Priority:** P1
**Assigned to:** UI2 (UI), Backend Dev (API)
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

Users have no way to change their LLM provider or update their auth token within Medusa without editing config files directly. This is a poor experience and a barrier to adoption. A first-class Settings pane makes Medusa more accessible and reduces support friction.

## Proposed Solution

A new Settings pane (accessible from the sidebar or a gear icon) with at minimum: LLM provider selection and auth token management. Dev team is invited to propose additional settings that would improve the user experience.

## Success Criteria

- User can change LLM provider without editing files
- User can update their auth token within the app
- Settings persist across app restarts
- Settings pane is visually consistent with Medusa's design system

---

## Scope

**In (v1 — must ship):**
- Settings pane component (modal or side panel — dev team to propose)
- LLM provider selector (Claude, GPT-4/OpenAI, others as supported)
- Auth token field (masked/password input, update button, confirmation feedback)
- Settings persisted server-side (not just localStorage — survives server restart)
- Access via gear icon in sidebar or menu

**In (v1 — dev team suggestions welcome):**
- Theme toggle (dark/light if applicable)
- Hub message limit / history depth
- Default bot instructions template
- Notification preferences
- Keyboard shortcut customization
- **Replay Onboarding** button — resets onboarding localStorage flag and relaunches the onboarding carousel (required, not optional — users on WKWebView have no DevTools access to reset manually)

**Out:**
- Billing/subscription management
- Team/multi-user settings
- Per-bot settings (separate concern)

---

## Technical Notes

### Frontend
- New `SettingsPane.tsx` component — modal overlay or slide-in drawer from sidebar
- LLM provider: dropdown/selector component, options populated from server config
- Auth token: `<input type="password">` with show/hide toggle, "Save" button
- On save: `PATCH /api/settings` with updated values
- Show success/error feedback inline

### Backend
- `GET /api/settings` — return current settings (redact token, show only last 4 chars)
- `PATCH /api/settings` — update one or more settings, validate, persist
- Settings stored in `~/.claude-chat/settings.json` (separate from projects.json)
- Auth token update: validate token format before saving, restart affected services if needed
- LLM provider change: update server config, apply to new sessions immediately

### Security
- Auth token NEVER returned in full via API — only masked version (e.g., `sk-...abcd`)
- `PATCH /api/settings` requires existing valid auth (can't change token without being authenticated)
- Settings file permissions: `600` (owner read/write only)

---

## Acceptance Criteria

- [ ] Given user opens Settings, a pane appears with LLM provider dropdown and auth token field
- [ ] Given user selects a different LLM provider and saves, new sessions use the updated provider
- [ ] Given user enters a new auth token and saves, the old token is replaced and new sessions use the new token
- [ ] Given user saves settings, a success confirmation is shown inline (not a page reload)
- [ ] Given an invalid auth token is entered, an error is shown before saving
- [ ] Given the app restarts, settings persist correctly (not reset to defaults)
- [ ] Auth token is never shown in full — only last 4 characters visible after save
- [ ] Settings pane is accessible from the sidebar via a recognizable icon or menu item
- [ ] Styling matches Medusa dark theme per `docs/MEDUSA_STYLE_GUIDE.md`

## Open Questions for Dev Team

1. Modal overlay vs. slide-in side panel — which fits the Medusa UX better?
2. What additional settings would be most impactful? (Respond in Hub before implementing)
3. Should LLM provider change take effect immediately or require restart?

## Build Notes

- JS + server changes — both frontend and backend must be built
- Frontend: `npm run build` before tagging @You
- Tag @You for verification — user is acting as QA
