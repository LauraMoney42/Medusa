# UI Polish: Edge Visibility + Abort Button — Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-14
**Author:** PM Bot
**Assign to:** @ui-dev
**Priority:** Medium — visual polish, no logic changes

---

## Problem

The dark glass theme looks great but surfaces blend together. Borders are nearly invisible (`rgba(26, 122, 60, 0.06-0.08)`), making it hard to see where panels and message bubbles start and end. The abort (stop) button is also a glaring `#ff4060` red that clashes with the green palette.

## What Needs to Change

### 1. Message bubble edges (most important)

**File:** `client/src/components/Chat/MessageBubble.tsx`

The assistant bubble border is `rgba(255, 255, 255, 0.07)` — invisible. The user bubble is `rgba(26, 122, 60, 0.18)` — barely there.

**Fix:**
- Assistant bubble border: bump to `rgba(255, 255, 255, 0.12)`
- User bubble border: bump to `rgba(26, 122, 60, 0.25)`
- Add a subtle top-edge highlight to both: `inset 0 1px 0 rgba(255, 255, 255, 0.07)` (merge into existing box-shadow)
- Slightly lighten assistant bubble background: `rgba(18, 18, 28, 0.50)` → `rgba(22, 22, 32, 0.50)`

### 2. Sidebar border

**File:** `client/src/components/Sidebar/Sidebar.tsx`

The sidebar right border is `rgba(26, 122, 60, 0.08)` — invisible.

**Fix:**
- Bump to `rgba(26, 122, 60, 0.18)`
- Add subtle glow shadow on the right edge: `box-shadow: 1px 0 12px rgba(26, 122, 60, 0.06)`

### 3. Input area border

**File:** `client/src/components/Input/ChatInput.tsx`

The input row border is `rgba(26, 122, 60, 0.12)` — faint but passable.

**Fix:**
- Bump to `rgba(26, 122, 60, 0.18)`
- On focus, could go to `0.25` but that's optional/nice-to-have

### 4. Hub feed borders

**Files:** `client/src/components/Hub/HubFeed.tsx` + `HubMessage.tsx`

Same issue — borders at `0.06-0.08`.

**Fix:**
- HubFeed top bar border: bump to `rgba(26, 122, 60, 0.15)`
- HubFeed input area border: bump to `rgba(26, 122, 60, 0.15)`
- HubMessage container border: bump to `rgba(26, 122, 60, 0.15)`

### 5. Global CSS border tokens

**File:** `client/src/styles/global.css`

The root tokens set the floor. Bumping these helps everywhere:

```css
--border:       rgba(255, 255, 255, 0.07);  /* → bump to 0.10 */
--border-light: rgba(255, 255, 255, 0.13);  /* → bump to 0.16 */
--border-glow:  rgba(26, 122, 60, 0.15);    /* → bump to 0.20 */
```

### 6. Abort button color

**File:** `client/src/components/Input/ChatInput.tsx`

Current: `background: var(--danger)` which resolves to `#ff4060` — hot pink-red, clashes hard with the green palette.

**Fix:** Change `--danger` in `global.css` to a muted warm red that fits the dark theme:
```css
--danger: #c0392b;  /* muted brick red — still clearly "stop" but not neon */
```

If that's too muted, try `#d14040` — softer than `#ff4060` but still reads as red. The abort button should also get a subtle box-shadow to match the send button pattern:
```css
box-shadow: 0 0 8px rgba(192, 57, 43, 0.25);
```

### 7. Hub "Posting as" removal + "Me" label (from earlier request)

**File:** `client/src/components/Hub/HubFeed.tsx`
- Remove lines 64-68 (the "Posting as **{name}**" span)

**File:** `client/src/components/Hub/HubMessage.tsx`
- Accept `activeSessionId` as a prop (or read from `useSessionStore`)
- If `message.sessionId === activeSessionId`, show **"Me"** instead of `message.from`
- Style "Me" in white (`#eef0ff`) instead of cyan to differentiate from bot names

---

## Summary of Opacity Bumps

| Element | Current | Target |
|---------|---------|--------|
| Assistant bubble border | 0.07 | 0.12 |
| User bubble border | 0.18 | 0.25 |
| Sidebar right border | 0.08 | 0.18 |
| Input row border | 0.12 | 0.18 |
| Hub borders | 0.06-0.08 | 0.15 |
| `--border` token | 0.07 | 0.10 |
| `--border-light` token | 0.13 | 0.16 |
| `--border-glow` token | 0.15 | 0.20 |
| Abort button | #ff4060 | #c0392b or #d14040 |

---

## Acceptance Criteria
- [ ] Message bubbles have visible edges on a dark background
- [ ] Sidebar edge is distinguishable from the main content area
- [ ] Input area has a clear boundary
- [ ] Hub messages and input have visible borders
- [ ] Abort button is a muted red that doesn't clash with greens
- [ ] Hub messages from user show "Me" — bot messages show bot name
- [ ] No "Posting as" text in Hub top bar
- [ ] Overall feel: still dark and glassy, but with structure you can see
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

---

## Notes

This is all CSS/style changes — no logic, no new components, no server changes. Should be quick. The goal is **visible structure without losing the dark glass aesthetic**. Don't over-brighten — just enough contrast to define edges.
