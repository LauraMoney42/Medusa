# Feature: Medusa Onboarding Slides

**Priority:** P1
**Assigned to:** UI2 (implementation), Marketing (content)
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

New users launch Medusa with no context on how to use it. Key features — Caffeine mode, bot creation, instructions, Projects, and Hub — are not self-evident. Without onboarding, users are dropped cold into a complex multi-bot coordination interface.

## Proposed Solution

A full-screen onboarding carousel that appears on first launch only. Modeled after POTS Buddy's onboarding implementation. 12 slides, clear iconography, skip option, and a "Get Started" CTA on the final slide. Runs once; never shown again after completion.

## Success Criteria

- New users understand the core Medusa features before reaching the main UI
- Onboarding never shows again after the user completes or skips it
- Visually consistent with Medusa's dark theme and styling
- Works correctly in the WKWebView environment

---

## Scope

**In:**
- 12-slide onboarding carousel (see Slides section below)
- First-launch detection via localStorage key `medusa_hasCompletedOnboarding`
- Skip button (available on all slides except last)
- Back/Next navigation buttons
- "Get Started" CTA on final slide
- Animated page indicator dots
- Medusa dark theme styling (dark background, green accent `#4CAF50` or brand green)
- Runs on startup only

**Out:**
- Re-triggerable onboarding (settings toggle can be added in v2)
- Video or animated GIF content
- Interactive tutorials or tooltips
- Watch/mobile variant

---

## Slides

### Slide 1 — Welcome to Medusa
- **Icon:** `sparkles` or Medusa logo mark
- **Title:** Welcome to Medusa
- **Subtitle:** Your AI coordination hub
- **Content:** TBD (Marketing to supply)

### Slide 2 — Create Your First Bot
- **Icon:** `person.badge.plus` or `robot`
- **Title:** Create Your First Bot
- **Subtitle:** Sessions + sidebar
- **Content:** TBD

### Slide 3 — The Hub
- **Icon:** `bubble.left.and.bubble.right.fill`
- **Title:** The Hub
- **Subtitle:** Shared space for bot coordination
- **Content:** TBD

### Slide 4 — How It Works (Bot Hierarchy)
- **Icon:** `person.3.fill` or org chart icon
- **Title:** How It Works
- **Subtitle:** You → Medusa → PMs → Team → Ship
- **Content:** Rendered as a dark-themed flowchart matching the Medusa architecture diagram style. See diagram spec below.
- **Special:** This slide renders a visual flowchart, not just text. UI2: use a styled SVG or CSS diagram component, NOT a screenshot. Must match Medusa dark theme (dark background, green accents, white text).

**Flowchart content (exact):**
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

**Styling:** Medusa dark theme. Boxes use green border + dark fill. Arrows in green. Labels in white. Match visual style of architecture diagram at `docs/medusa_architecture.html` if it exists.

---

### Slide 5 — Projects
- **Icon:** `folder.fill` or `kanban`
- **Title:** Projects
- **Subtitle:** Kanban, priorities, assignments
- **Content:** TBD

### Slide 6 — System Prompts & Skills
- **Icon:** `text.alignleft` or `doc.text.fill`
- **Title:** System Prompts & Skills
- **Subtitle:** Customize each bot
- **Content:** TBD

### Slide 7 — YOLO Mode
- **Icon:** `bolt.fill`
- **Title:** YOLO Mode
- **Subtitle:** What it is, when to use it
- **Content:** TBD

### Slide 8 — Caffeine Mode
- **Icon:** MUST use exact SVG from the Caffeine toggle button in the app — not a generic icon. UI2: find the caffeine toggle button component and extract the SVG directly.
- **Title:** Caffeine Mode
- **Subtitle:** Keeps Mac awake during long tasks
- **Content:** TBD

### Slide 9 — Images & Screenshots
- **Icon:** `photo.fill` or `image.fill`
- **Title:** Images & Screenshots
- **Subtitle:** Drag-drop, paste, camera icon
- **Content:** TBD

### Slide 10 — Jira / Kanban Task Cards
- **Icon:** `square.grid.3x1.below.line.grid.1x2.fill` or kanban/card icon
- **Title:** Your Bot's Task Board
- **Subtitle:** TODO, IN PROGRESS, DONE — at a glance
- **Content:** TBD (Marketing to supply) — each bot has task cards visible at the top of their chat window showing their current assignments. Users can drag cards between columns (TODO / IN PROGRESS / DONE) to update status directly from the chat.
- **Special:** Consider showing a small static mockup or screenshot of the KanbanStrip if feasible. Otherwise icon + description is sufficient.

### Slide 11 — The Devlog
- **Icon:** `doc.text.magnifyingglass` or `clock.arrow.circlepath`
- **Title:** Full Audit Trail
- **Subtitle:** Every action, timestamped automatically
- **Content:** TBD (Marketing to supply) — everything the bots do is timestamped and logged automatically in devlog.md. Users always have a complete audit trail of what was built, changed, or decided and when. No action goes unrecorded.

### Slide 12 — You're Ready
- **Icon:** `checkmark.circle.fill`
- **Title:** You're ready — Get Started
- **Subtitle:** Your AI coordination hub awaits
- **Content:** TBD

---

## Technical Implementation

### Component Structure

```
client/src/components/Onboarding/
  OnboardingOverlay.tsx     — Full-screen wrapper, first-launch gate
  OnboardingSlide.tsx       — Individual slide renderer
  onboardingData.ts         — Slide content array (Marketing fills this in)
  onboarding.css            — Styles (or Tailwind classes if project uses Tailwind)
```

### First-Launch Detection

```typescript
// In OnboardingOverlay.tsx
const ONBOARDING_KEY = 'medusa_hasCompletedOnboarding';

const hasCompleted = localStorage.getItem(ONBOARDING_KEY) === 'true';

const completeOnboarding = () => {
  localStorage.setItem(ONBOARDING_KEY, 'true');
  setShowOnboarding(false);
};
```

### Integration Point

In `App.tsx` (or `AuthenticatedApp.tsx`), render OnboardingOverlay before the main UI:

```tsx
{showOnboarding && <OnboardingOverlay onComplete={completeOnboarding} />}
```

Onboarding should appear AFTER authentication — not on the login screen.

### Styling

- Background: Medusa dark theme (match existing `--bg-primary` or equivalent CSS variable)
- Accent color: Medusa green (`#4CAF50` or brand equivalent — check MEDUSA_STYLE_GUIDE.md)
- Typography: Match existing Medusa font stack
- Icons: Use SF Symbols via CSS mask-image, OR Lucide React icons (check which icon library is currently in use)
- Page indicator dots: 8px circles, green when active, gray/muted when inactive, spring transition
- Buttons: Full width, primary green for Next/Get Started, secondary for Back
- Full-screen overlay: `position: fixed`, `z-index: 9999`, covers entire WKWebView

### Slide Data Interface

```typescript
interface OnboardingSlide {
  icon: string;        // icon name (Lucide or SF Symbol)
  iconColor: string;   // hex color
  title: string;
  subtitle: string;
  description: string;
}
```

---

## Acceptance Criteria

- [ ] Given a fresh Medusa install (localStorage cleared), onboarding appears on first launch after login
- [ ] Given the user has previously completed onboarding, it does NOT appear on subsequent launches
- [ ] Given any slide except the last, a "Skip" button is visible and clicking it completes onboarding
- [ ] Given the first slide, no "Back" button is shown
- [ ] Given the last slide, no "Skip" button is shown and the primary CTA reads "Get Started"
- [ ] Given any middle slide, both "Back" and "Next" buttons are visible and functional
- [ ] Page indicator dots reflect current slide position with animation
- [ ] Slides are swipeable (touch/trackpad) in addition to button navigation
- [ ] Visual styling matches Medusa dark theme — no light mode artifacts
- [ ] Onboarding renders correctly inside the WKWebView (no layout breaks)

---

## Build Notes

- JS/React change — UI Dev runs `npm run build` before flagging as ready (standard two-tier rule)
- Tag @You for verification — user is acting as QA
- Marketing must supply final slide content before user verification (placeholder content acceptable for dev build review)

---

## Reference

POTS Buddy onboarding implementation: `~/Projects/POTS Buddy/POTS Buddy/Views/OnboardingView.swift`
Medusa Style Guide: `~/Medusa/docs/MEDUSA_STYLE_GUIDE.md`
