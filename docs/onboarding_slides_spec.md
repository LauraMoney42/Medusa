# Medusa — Welcome & Onboarding Slides

**Project:** Medusa — Welcome/Onboarding Slides
**Date:** 2026-02-19
**Author:** PM2
**Priority:** P1
**Status:** In progress — assigned
**QA:** User is acting as QA. Tag @You when ready for verification.

---

## 1. Problem Statement

New users open Medusa and have no guidance on how to use it. Key features (creating bots, writing instructions, using Hub, Caffeine integration, etc.) are not discoverable without trial and error. An onboarding flow shown on first launch removes this friction.

---

## 2. User Story

**As a** new Medusa user,
**I want** a brief, clear onboarding walkthrough on first launch,
**So that** I understand how to create bots, write instructions, use the Hub, and get the most out of Medusa immediately.

---

## 3. Proposed Solution

A multi-slide modal/overlay shown on first startup only. Slides are clear, concise, and match Medusa's existing visual style. Based on the POTS Buddy onboarding pattern. User can dismiss or skip at any time. Never shown again after first dismissal (persisted via localStorage or a flag file).

**Reference:** POTS Buddy onboarding implementation (Marketing reviewing for content guidance)

---

## 4. Scope

**In:**
- Multi-slide welcome/onboarding modal shown on first startup only
- Slides covering: welcome, creating a bot, writing instructions, using the Hub, Caffeine integration, key tips
- Matches Medusa Style Guide (`docs/MEDUSA_STYLE_GUIDE.md`) exactly
- Skip/dismiss button on every slide
- "Next" / "Back" navigation
- Dot indicator showing progress (slide X of N)
- Persisted "seen" flag — never shown again after first dismissal
- Clear and concise copy — no walls of text

**Out (v1):**
- Re-openable from menu bar (v2)
- Video or animated demos
- Interactive tutorials (click-through)
- Localization

---

## 5. Slide Content (Draft — Marketing to write final copy)

| # | Slide Title | Key Content |
|---|-------------|-------------|
| 1 | Welcome to Medusa | Logo + tagline, what Medusa is, brief value prop |
| 2 | Create Your First Bot | Sessions + sidebar, how to create a bot, name it, set its role |
| 3 | The Hub | Shared space for bot coordination, how bots communicate, @mentions |
| 4 | Your Bot's Kanban Board *(new — added 2026-02-19)* | Each bot has task cards at the top of their chat window. Cards show TODO / IN PROGRESS / DONE. Drag cards between columns to update status. See every bot's workload at a glance. |
| 5 | The Devlog *(new — added 2026-02-19)* | Everything bots do is timestamped and logged automatically in devlog.md. Every decision, task, and change — recorded. Full audit trail of what was built, changed, or decided and when. |
| 6 | How It All Works | Bot hierarchy flowchart — User → Medusa → PM1/PM2 → Dev teams → Security gate → Ship |
| 7 | Projects | Kanban, priorities, assignments — tracking work across bots |
| 8 | Skills | How to customize each bot with instructions and skills |
| 9 | YOLO Mode | What it is, when to use it, how to enable |
| 10 | Caffeine Mode | Keeps Mac awake during long tasks, how to enable |
| 11 | Images & Screenshots | Drag-drop, paste, camera icon — how to share visuals with bots |
| 12 | You're Ready! | CTA to get started |

*Note: Final copy (title + 2-3 bullets per slide, concise) to be written by Marketing. UI2 builds after copy is confirmed. Slide 6 (hierarchy flowchart) is a visual diagram — no Marketing copy needed, UI2 builds from the flowchart spec below.*

**Skip button:** Must appear in the **top right** of the overlay on every slide (updated 2026-02-19 per Medusa directive).

---

## 6. Acceptance Criteria

- [ ] Given first launch of Medusa, when app opens, then onboarding slides appear automatically
- [ ] Given slides are showing, when user clicks "Skip" or dismisses, then slides close immediately
- [ ] Given slides are shown and dismissed, when user relaunches Medusa, then slides do NOT appear again
- [ ] Given slides are showing, when user clicks "Next", then next slide appears
- [ ] Given slides are showing, when user clicks "Back", then previous slide appears
- [ ] Given any slide, when shown, then styling matches Medusa Style Guide (colors, fonts, components)
- [ ] Given slides, then dot progress indicator shows current position (e.g., slide 3 of 7)
- [ ] Slides are clear and concise — no slide has more than 3-4 lines of body text
- [ ] Verified in actual Medusa.app desktop build — not dev server
- [ ] Run `./scripts/rebuild.sh` before tagging @You for verification
- [ ] `npx tsc --noEmit` passes, `npm run build` succeeds

---

## 7. Task Breakdown

| # | Task | Role | Dependencies | Est. |
|---|------|------|-------------|------|
| OB1 | Review POTS Buddy onboarding implementation — extract pattern, component structure, animation approach | UI2 | None | S | ✅ DONE |
| OB2 | Write final slide copy — title + 2-3 bullets per slide for all 9 slides | Marketing | None | S |
| OB3 | Create `OnboardingModal` React component — modal overlay, swipeable cards, dot indicators, Back/Next/Skip, localStorage first-run flag | UI2 | OB2 | M |
| OB4 | Create individual slide content components (9 slides) | UI2 | OB2, OB3 | M |
| OB5 | Wire into app startup — show OnboardingModal on first load (pure client-side, no backend needed) | Full Stack Dev | OB3 | S |
| OB6 | Style pass — ensure all slides match Medusa Style Guide exactly (dark-green theme) | UI2 | OB4 | S |
| OB7 | User verification in Medusa.app desktop | @You | OB3-OB6 | — |

**Implementation order:**
1. OB1 (POTS Buddy review) + OB2 (content draft) in parallel
2. OB3 (modal component) after OB1
3. OB4 (slide content) after OB2 + OB3
4. OB5 + OB6 (persistence + wiring) after OB3
5. OB7 (style pass) after OB4
6. OB8 (user verification)

---

## 8. Success Criteria

- New users understand Medusa's core features within 2 minutes of first launch
- Onboarding never appears again after first dismissal
- Slides feel native to Medusa — not bolted on
- Copy is clear enough that users don't need to ask "how do I create a bot?"

---

## 9. Open Questions

- [ ] Should slides use Medusa's dark theme only, or support light mode? (Recommend: dark only, matches app default)
- [ ] Should there be a "Don't show again" checkbox, or just auto-suppress after first view? (Recommend: auto-suppress — simpler)
- [ ] Marketing: what are the top 3 things new users get confused about? (Drives slide priority)
- [ ] POTS Buddy: what persistence mechanism did it use? (localStorage, UserDefaults, flag file?)

---

## 10. Bot Hierarchy Slide Spec (Slide 6)

**Title:** "How It All Works"
**Style:** Medusa dark theme, matching existing architecture diagram style
**Content:** Flowchart diagram (not text bullets)

```
        You (User)
            ↓
    Medusa (VP Admin)
            ↓
      PM1  /  PM2
            ↓
┌───┬───┬───┬───┬───┐
│UI │BE │FS │Mkt│QA │
└───┴───┴───┴───┴───┘
            ↓ (on release)
     🔒 Security Review
     ↓ pass / ↑ fail → back to devs
     ✅ Ship to Git / App Store
```

**Implementation notes for UI2:**
- Render as SVG or CSS flowchart — not plain text
- Match dark-green Medusa color palette from Style Guide
- Nodes should be styled like the existing architecture diagram in `docs/medusa_architecture.md`
- Security Review node should be visually distinct (lock icon, amber/gold accent)
- Arrow directions must be clear: downward flow, with upward feedback loop on Security fail
- No Marketing copy needed for this slide — purely visual

---

## Notes

- Style Guide reference: `docs/MEDUSA_STYLE_GUIDE.md`
- POTS Buddy onboarding pattern is the reference implementation — Full Stack Dev to review first
- Marketing is reviewing the live Medusa app to identify what content should be covered
- User is acting as QA — tag @You directly when ready for verification (do NOT tag @QA/Testing or @QA2)
- Native build (if required): run `app/build-app.sh`, then System Settings → Screen Recording → toggle Medusa OFF/ON
- Canonical launch path: `~/Medusa/app/Medusa.app`
