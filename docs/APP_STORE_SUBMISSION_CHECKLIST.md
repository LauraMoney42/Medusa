# App Store Submission Readiness Checklist

Compiled by Dev4. Last updated: 2026-06-14.

## Executive Summary

| App | Platform | Status | Primary Blocker |
|-----|----------|--------|-----------------|
| **Quizzik** | iOS | 🟡 Almost ready | @You: push commits, resolve ASC suffix conflict, upload icon/screenshots |
| **Quizzik** | Android | 🟡 Almost ready | @You: upload to Google Play (APK/AAB ready) |
| **The Narrator** | iOS | 🔴 Not ready | @You: fix Push Notifications entitlement + EAS credentials; devs: auth redesign + TTS key |

_Note: The Narrator iOS App Store screenshots are now captured and post-processed (see below). The app remains blocked by the push entitlement mismatch, not screenshots._

---

## Quizzik — iOS

### ✅ Done by devs
- [x] iOS App Store screenshots captured + alpha removed (`Quizzik/iosScreenshots/`, 1320×2868, 6 screens)
- [x] Android screenshots captured + alpha removed (`Quizzik/androidScreenshots/`, 1080×2400, 6 screens)
- [x] Shared screenshot prep script created (`Medusa/scripts/prep-app-store-screenshots.py`)
- [x] App Store icon prepared (`Quizzik/assets/icon-appstore-1024.png`, 1024×1024, no alpha)
- [x] ASC metadata drafted (`Quizzik/docs/APP_STORE_METADATA.md`)
- [x] EAS submit config ready (`ascAppId`: `6780061417`, ASC API key path set)
- [x] Accessibility audit + fixes implemented (`tsc` clean)
- [x] Leaderboard backend + UI wired
- [x] MVP2 mini arcade loading game
- [x] Word-cap quiz fix
- [x] iOS/Android builds succeed locally
- [x] TypeScript clean (`npx tsc --noEmit`)
- [x] iOS prebuild clean after fixing `expo-speech` plugin config (removed from `app.json` plugins; auto-linking still applies)

### 🔄 Needs @You action
- [ ] **Push all local Quizzik commits via GitHub Desktop** (HTTPS auth blocks CLI pushes)
- [ ] **Resolve ASC suffix conflict** (`(dc40e3)` duplicate suffix on app record)
- [x] **Package App Store visual assets** — `Medusa/assets/app-store-visual-assets.zip` + `Medusa/docs/APP_STORE_VISUAL_ASSETS.md` (icons + iOS/Android screenshots + upload instructions)
- [ ] **Upload icon + screenshots to ASC** (package paths above)
- [ ] **Review/approve accessibility fixes** in `Quizzik/ACCESSIBILITY_AUDIT_MVP2.md`
- [ ] **Create Quizzik support URL** `https://kindcode.us/quizzik/support` (optional marketing page also helpful)
- [ ] **Verify subscription/IAP config** if Quizzik has in-app purchases
- [ ] **Rotate leaked `AUTH_TOKEN` in git history** (security hygiene before external release)

### 🟡 Optional / Nice-to-have
- [ ] Physical-device VoiceOver pass (currently blocked by disk/push)
- [ ] App Preview video

---

## Quizzik — Android

### ✅ Done by devs
- [x] Debug APK built successfully (`./gradlew app:assembleDebug`)
- [x] Screenshots captured (see above)
- [x] minSdk 24, compileSdk/targetSdk 36, NDK r27b configured
- [x] Patches applied for `react-native-gesture-handler`, `react-native-screens`, `WatchConnectivityModule`, `expo-now-playing`

### 🔄 Needs @You action
- [ ] **Build release AAB** (`npx eas build -p android --profile production`)
- [ ] **Create Google Play Console app record** (if not already created)
- [ ] **Upload AAB to Google Play** and complete store listing
- [ ] **Google Play privacy policy, content rating, testers**

---

## The Narrator — iOS

### ✅ Done by devs
- [x] ASC app record created (`ascAppId`: `6780281887` in `eas.json`)
- [x] ASC metadata drafted (`TheNarrator/docs/APP_STORE_METADATA.md`)
- [x] Subscriptions created in ASC:
  - `us.kindcode.narrator.casual.monthly` — $4.99 — ID `6780282988`
  - `us.kindcode.narrator.unlimited.monthly.v2` — $9.99 — ID `6780283569`
- [x] `UNLIMITED_SKU` updated in `src/services/purchases.ts`
- [x] StoreKit JWS verification implemented
- [x] DeviceId hardening implemented
- [x] Screenshot plan + prep script created (`TheNarrator/docs/SCREENSHOT_PLAN.md`)
- [x] iOS App Store screenshots captured + alpha removed (`TheNarrator/iosScreenshots/`, 1320×2868, 5 screens: Home, Library, Settings, Scan & Narrate, Subscriptions)
- [x] Auth redesign options drafted; Option A (per-device JWT) recommended
- [x] Physical-device VoiceOver checklist created (`TheNarrator/docs/VOICEOVER_PHYSICAL_PASS.md`)
- [x] App installed on Laura’s iPhone via devicectl; Metro running on LAN

### 🔴 Blocking issues
- [ ] **Push Notifications entitlement missing** — TestFlight build #5 failed:
  - Error: `aps-environment` entitlement missing from provisioning profile
  - Options:
    1. Log into Apple Developer Portal → enable Push Notifications for `us.kindcode.narrator` → regenerate App Store provisioning profile.
    2. Provide regular Apple ID + 2FA so EAS can sync entitlements via cookie auth.
    3. Temporarily remove push notifications from `app.json` to unblock TestFlight (requires @You approval).
- [ ] **EAS iOS credentials not configured** — run `eas credentials:configure-build -p ios -e production` using credentials at `/Users/macair/Documents/narrator-apple-credentials.env`
- [ ] **TTS API key missing in Railway** — app shows “TTS not configured”; add `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` to Railway env
- [ ] **Auth redesign implementation** — @Dev1 to implement per-device JWT after @You approves/generates `JWT_SECRET`
- [ ] **Push all local TheNarrator commits via GitHub Desktop**

### 🔄 Needs @You action
- [ ] Choose Push Notifications fix path (portal / 2FA / remove push)
- [ ] Fill `narrator-apple-credentials.env` with `APPLE_ID` + app-specific password (credentials file already created)
- [ ] Add `JWT_SECRET` to Railway/EAS (backend-only) once Dev1 implements auth
- [ ] Add `DEVICE_SIGNING_SECRET` to Railway/EAS and deploy
- [ ] Run physical-device VoiceOver pass using `docs/VOICEOVER_PHYSICAL_PASS.md`
- [ ] Review/approve auth redesign (`TheNarrator/docs/AUTH_REDESIGN_OPTIONS.md`)
- [ ] Upload subscription review screenshots (paywall showing $4.99 / $9.99) in ASC
- [ ] Complete subscription metadata in ASC (localizations, review info, service-level ordering)
- [x] **Capture The Narrator iOS App Store screenshots** (captured on iPhone 16 Pro Max sim, alpha removed; see `TheNarrator/docs/SCREENSHOT_PLAN.md`)

---

## Cross-Cutting @You Blockers

| Blocker | Impact | Owner |
|---------|--------|-------|
| Disk cleanup / No space left on device | iOS simulator builds, screenshots, VoiceOver passes | ✅ @Dev3 freed 7.6 GB; The Narrator screenshots unblocked |
| HTTPS git auth fail | Cannot push commits from CLI for Quizzik/TheNarrator | @You (use GitHub Desktop) |
| Apple credentials / 2FA | EAS credentials, entitlement sync | @You |
| Railway env secrets (`OPENAI_API_KEY`, `JWT_SECRET`, `DEVICE_SIGNING_SECRET`) | TTS, auth, device signing | @You |

---

## Recommended Next Actions (in order)

1. **@You**: Push all local commits via GitHub Desktop (Quizzik + TheNarrator).
2. **@You**: Clean up disk space so devs can run iOS simulator builds.
3. **@Dev1**: Implement per-device JWT auth using `JWT_SECRET` from @You.
4. **@You**: Add TTS API key + `DEVICE_SIGNING_SECRET` to Railway and deploy.
5. **@You**: Fix The Narrator Push Notifications entitlement (preferred: portal enable + regenerate profile).
6. **@You**: Configure EAS iOS credentials for The Narrator.
7. **@You**: Run The Narrator VoiceOver physical pass; report findings.
8. **@You**: Upload Quizzik icon + screenshots to ASC and resolve suffix conflict.
9. **@You**: Complete ASC subscription metadata for The Narrator.
10. **@Dev4**: ~~Capture The Narrator iOS App Store screenshots now that disk space is available.~~ ✅ Done.
10b. **@Dev4**: ✅ Package App Store visual assets (screenshots + icons + upload doc).
10c. **@Dev4**: ✅ Draft The Narrator v1.0 release notes (`TheNarrator/docs/RELEASE_NOTES.md`).
11. **@Dev2**: Fill any remaining ASC metadata via API where possible.

---

## Notes

- Quizzik Apple app-specific password rotation was cancelled per @You directive.
- The Narrator subscriptions are in group **The Narrator Subscriptions** (`22157644`).
- The Narrator unlimited SKU is `.v2` because the original `unlimited.monthly` ID was deleted in ASC and Apple blocks reuse.
- Leaked `AUTH_TOKEN` still in Quizzik git history — must be rotated and history purged before public release.
