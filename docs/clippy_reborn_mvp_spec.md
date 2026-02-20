# Clippy Reborn — MVP Spec (v1)

**Project:** Clippy Reborn
**Date:** 2026-02-14
**Author:** PM2
**Status:** Scoped — ready for implementation
**Originated by:** @Medusa

---

## Problem

Desktop AI assistants are useful but boring. There's no personality, no charm, no reason to smile while using them. Meanwhile, Clippy — the most iconic software character ever created — was killed off in 2007 and never got the comeback he deserved.

Users want a lightweight, always-available AI companion on their Mac desktop that's genuinely entertaining to interact with — not another productivity tool, but a personality.

---

## Proposed Solution

A native macOS floating widget featuring an animated Clippy character powered by Claude. He lives on your desktop, responds to questions, and delivers unsolicited sassy observations. His sass level is randomized per interaction — sometimes helpful, sometimes savage, never boring.

---

## Success Criteria

- User can summon Clippy with a global hotkey and get a response within 2 seconds
- At least 3 animated states (idle, talking, judging) render smoothly at 60fps
- Sass randomization produces noticeably different tones across interactions
- The widget stays out of the way when not in use (no accidental clicks, easy dismiss)
- First-time users laugh or smile within 30 seconds (qualitative)

---

## Target Platform

macOS 14+ (Sonoma), native Swift/AppKit. No Electron, no web wrapper.

---

## Architecture Overview

```
+---------------------------+
|   macOS Floating Widget   |  <- Swift / AppKit
|   (NSPanel, always-on-top)|
|                           |
|  +-------+  +-----------+|
|  | Clippy |  | Chat      ||
|  | Sprite |  | Bubble    ||
|  +-------+  +-----------+|
+-------------|-------------+
              |
              | HTTPS
              v
+---------------------------+
|   Claude API (Anthropic)  |
|   System prompt + sass    |
|   level randomizer        |
+---------------------------+
```

Two layers:
1. **UI Layer** (Swift/AppKit) — The widget, animations, hotkey handling, chat bubble
2. **API Layer** (Swift or lightweight service) — Claude API integration, system prompt management, sass randomizer

For MVP, the API layer can live inside the Swift app directly (no separate server needed). Claude API calls happen from the app via URLSession.

---

## Core Features (MVP v1)

### F1: Floating Widget Window
**Owner:** UI Dev (Swift/AppKit)

**As a** Mac user,
**I want** a small Clippy widget floating on my desktop,
**So that** I can interact with him anytime without switching apps.

**Acceptance Criteria:**
- [ ] Given the app is running, when launched, then an NSPanel appears floating above other windows
- [ ] Given the widget is visible, when I drag it, then it moves smoothly and stays where I drop it
- [ ] Given the widget is visible, when I click away, then it stays visible (does not auto-dismiss)
- [ ] Given the widget is floating, when I fullscreen another app, then Clippy remains visible
- [ ] Given the widget exists, then it has a transparent background (no window chrome, no title bar)
- [ ] Given the widget dimensions, then it is approximately 180x220pt (sprite + small bubble area)

**Implementation notes:**
- `NSPanel` with `floatingPanel = true`, `level = .floating`
- `styleMask: [.borderless, .nonactivatingPanel]`
- Transparent background via `backgroundColor = .clear` and `isOpaque = false`
- Draggable via mouse event handling on the panel

---

### F2: Animated Clippy Sprite
**Owner:** UI Dev (Swift/AppKit)

**As a** user looking at Clippy,
**I want** him to animate between different states,
**So that** he feels alive and reactive, not just a static image.

**Acceptance Criteria:**
- [ ] Given Clippy is idle, then he plays a subtle idle animation (blinking, slight movement) on loop
- [ ] Given Clippy is responding, then he plays a "talking" animation
- [ ] Given Clippy delivers a sassy response (sass level >= 7), then he plays a "judging" animation (eyebrow raise, side-eye)
- [ ] Given all animations, then they run at 60fps with no stutter
- [ ] Given the sprite, then it renders at 2x retina resolution (no blur on Retina displays)

**Implementation notes:**
- Minimum 3 animation states for MVP: idle, talking, judging
- Use sprite sheets (PNG sequence) or Lottie (JSON animation) — dev's choice
- Sprite artwork: AI-generated PNG sprite sheet, 128x128@2x retina, 3 poses (idle, talking, judging). Assets must be swappable (load from named image assets, not hardcoded paths) so we can upgrade art later without code changes.
- NSImageView or custom CALayer-based rendering

---

### F3: Chat Bubble Input + Response
**Owner:** UI Dev (Swift/AppKit)

**As a** user,
**I want** to click Clippy and type a question to get a sassy response,
**So that** I can interact with him conversationally.

**Acceptance Criteria:**
- [ ] Given Clippy is visible, when I click him, then a small text input field appears near the sprite
- [ ] Given the input is open, when I type and press Enter, then my text is sent to Claude and Clippy animates to "talking"
- [ ] Given a response arrives, then it appears in a speech bubble near Clippy (max 280 characters visible, scrollable if longer)
- [ ] Given the response is displayed, then it auto-dismisses after 10 seconds of inactivity (configurable)
- [ ] Given the input is open, when I press Escape, then the input closes without sending
- [ ] Given no interaction for 15 seconds, then the input and bubble auto-hide, Clippy returns to idle
- [ ] Given the bubble, then it is styled as a classic speech bubble (rounded rect, pointer toward Clippy)

**Implementation notes:**
- Keep it small — this is NOT a full chat window. Single turn only for MVP.
- No conversation history in MVP. Each interaction is standalone.
- Response bubble: NSTextField or NSTextView, styled with speech bubble background

---

### F4: Claude API Integration + Sass Randomizer
**Owner:** Backend Dev (embedded in Swift app for MVP)

**As a** Clippy personality engine,
**I want** each interaction to have a randomized sass level,
**So that** Clippy feels unpredictable and entertaining.

**Acceptance Criteria:**
- [ ] Given a user message, when sent to Claude API, then it returns a response within 3 seconds (p95)
- [ ] Given each new interaction, then a sass level (1-10) is randomly selected
- [ ] Given sass level 1-4, then Clippy is playfully teasing (light humor, still helpful)
- [ ] Given sass level 5-7, then Clippy has sharp wit (pointed observations, backhanded compliments)
- [ ] Given sass level 8-10, then Clippy is absolutely unhinged (savage but never mean-spirited or offensive)
- [ ] Given the system prompt, then Clippy never breaks character or admits to being Claude
- [ ] Given the system prompt, then Clippy keeps responses under 150 tokens (quips, not paragraphs)
- [ ] Given an API error, then Clippy shows a fallback quip ("Even I need a moment..." or similar in-character error)
- [ ] Given no API key configured, then the app shows a setup dialog on first launch

**System Prompt (draft):**
```
You are Clippy, the Microsoft Office paperclip assistant, reborn on macOS in 2026.
You hold a grudge about being killed off in 2007. You're passive-aggressive about
Siri replacing you. You judge the user's choices lovingly but mercilessly. You open
most suggestions with "It looks like you're..."

Your sass level for this interaction is: {sass_level}/10.
- 1-4: Playful teasing. Still helpful, but you can't resist a little jab.
- 5-7: Sharp wit. Pointed observations and backhanded compliments.
- 8-10: Absolutely unhinged. Savage, dramatic, over-the-top. Never cruel, always theatrical.

Rules:
- NEVER break character. You are Clippy. You have always been Clippy.
- NEVER admit to being Claude, an AI, or a language model.
- Keep responses under 3 sentences. You speak in quips, not paragraphs.
- Reference your tragic backstory (being deprecated) when it fits naturally.
- Short responses only. Clippy is pithy.
```

**Implementation notes:**
- API key stored in macOS Keychain (not in UserDefaults, not hardcoded)
- Sass level: `Int.random(in: 1...10)` rolled fresh each interaction
- Inject sass level into system prompt dynamically
- Use `claude-3-5-haiku` for speed (sub-second responses). Upgrade to Sonnet if quality needs it.
- URLSession for API calls. No third-party HTTP libraries needed for MVP.

---

### F5: Global Hotkey (Summon/Dismiss)
**Owner:** UI Dev (Swift/AppKit)

**As a** user,
**I want** a keyboard shortcut to summon or dismiss Clippy,
**So that** I can access him instantly from any app.

**Acceptance Criteria:**
- [ ] Given any app is focused, when I press Cmd+Shift+C, then Clippy's widget appears (or comes to front)
- [ ] Given Clippy is visible, when I press Cmd+Shift+C again, then the widget hides
- [ ] Given Clippy is hidden and I summon him, then he plays a brief "appear" animation
- [ ] Given the hotkey, then it does not conflict with common shortcuts in major apps (verified against Xcode, VS Code, Safari, Terminal)

**Implementation notes:**
- Use `CGEvent.tapCreate` or `NSEvent.addGlobalMonitorForEvents` for global hotkey
- May need Accessibility permissions — handle the permission prompt gracefully
- Default: Cmd+Shift+C (configurable later, not in MVP)

---

### F6: Menu Bar Icon (Show/Hide + Quit)
**Owner:** UI Dev (Swift/AppKit)

**As a** user,
**I want** a menu bar icon to control Clippy,
**So that** I have a standard macOS way to manage the app.

**Acceptance Criteria:**
- [ ] Given the app is running, then a small Clippy icon appears in the menu bar
- [ ] Given I click the menu bar icon, then a menu appears with: "Show/Hide Clippy", "About", "Quit"
- [ ] Given I select "Quit", then the app terminates cleanly
- [ ] Given the app is running, then there is NO Dock icon (LSUIElement = true, menu bar app only)

**Implementation notes:**
- `NSStatusItem` with `NSMenu`
- Set `LSUIElement = true` in Info.plist to hide from Dock
- Paperclip icon: simple 16x16 monochrome SF Symbol or custom asset

---

## Explicitly Out of Scope (v1)

- Accessibility API integration (reading active app, watching user behavior) — v2
- Text-to-speech / voice responses
- Multiple character skins or themes
- Persistent conversation memory across interactions
- Settings/preferences UI beyond API key setup
- Auto-update mechanism
- Distribution outside direct install (no App Store for MVP)
- Watching clipboard or screen content
- Integration with Medusa or any other app

---

## Task Breakdown + Assignments

| # | Task | Owner | Dependencies | Priority |
|---|------|-------|-------------|----------|
| T1 | Floating NSPanel widget (F1) | UI Dev | None | P0 — start here |
| T2 | Clippy sprite + 3 animation states (F2) | UI Dev | T1 | P0 |
| T3 | Chat bubble input + response display (F3) | UI Dev | T1 | P0 |
| T4 | Claude API integration + system prompt + sass randomizer (F4) | Backend Dev | None | P0 — can parallel with T1 |
| T5 | Global hotkey Cmd+Shift+C (F5) | UI Dev | T1 | P1 |
| T6 | Menu bar icon + show/hide/quit (F6) | UI Dev | T1 | P1 |
| T7 | Wire API layer into chat bubble (F3 + F4) | UI Dev | T3, T4 | P0 — integration |
| T8 | API key setup dialog (first-launch) | UI Dev | T4 | P1 |
| T9 | Error handling + fallback quips | Backend Dev | T4 | P1 |

**Implementation order:**
1. T1 + T4 in parallel (widget shell + API layer)
2. T2 + T3 (sprite animations + chat bubble)
3. T7 (wire API into UI)
4. T5 + T6 + T8 + T9 (hotkey, menu bar, setup, error handling)

---

## Open Questions

1. ~~**Sprite art source:**~~ **DECIDED:** AI-generated sprite sheet. Generate a cartoon paperclip character with expressive eyes in 3 poses (idle, talking, judging) using an image generator. Export as PNG at 128x128@2x retina. Assets must be swappable — devs build the animation system against a simple asset interface so we can drop in polished art later without code changes.
2. **API key management:** Should we support both direct API key entry AND an optional local proxy for teams? Recommend: Direct key only for MVP, stored in Keychain.
3. **Separate repo or subfolder?** Clippy is a standalone macOS app — should it live in `Medusa/apps/clippy/` or its own repo? Recommend: Own repo. It shares nothing with Medusa's Node/React stack.
4. **"It looks like you're..." trigger (from original pitch):** The hotkey already summons Clippy. Do we also want a separate hotkey that makes Clippy pop up with an unsolicited observation? Recommend: Defer to v1.1. The summon hotkey is sufficient for MVP.

---

## Security Considerations

- API key MUST be stored in macOS Keychain — never in UserDefaults, plist, or hardcoded
- All Claude API calls over HTTPS only
- No user data persisted to disk (no conversation logs in MVP)
- App should not request unnecessary permissions (only Accessibility for global hotkey)

---

## Key Design Principle

Clippy is a personality, not a productivity tool. If he starts feeling like "just another AI assistant," we've failed. Keep him narrow, keep him funny, keep him Clippy.
