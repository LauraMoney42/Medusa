# Persistent Draft Messages — Spec

**Project:** Medusa — Persistent Draft Messages
**Date:** 2026-02-17
**Author:** PM2
**Priority:** P1
**Status:** Awaiting user go-ahead before dev work begins

---

## 1. Problem Statement

When a user types a message in a bot chat but switches to another chat before sending, the unsent text is lost. Returning to the original chat shows an empty input field. This causes frustration and lost work — especially during multi-bot workflows where users frequently context-switch.

**Who has this problem:** Any Medusa user coordinating across multiple bots simultaneously (which is the core use case).

---

## 2. User Story

**As a** Medusa user coordinating across multiple bots,
**I want** my unsent message to be saved when I switch to another chat,
**So that** I never lose a partially-typed message and can pick up exactly where I left off.

---

## 3. Proposed Solution

Store each bot's unsent input text in a persistent draft store (localStorage) keyed by bot ID. When the user types in a chat input and navigates away, the current text is saved. When they return, the saved draft is restored to the input field automatically. Drafts are cleared when the message is sent.

**Key decisions:**
- **Persistence:** localStorage (survives app restart — users expect this)
- **Scope:** Per-bot (one draft slot per bot, not per-session — simplest mental model)
- **Auto-save:** On every keystroke (debounced ~300ms) — no manual save step
- **Clear on send:** Draft is deleted immediately when message is sent successfully

---

## 4. Scope

**In:**
- Draft persistence per bot (keyed by bot ID)
- Auto-save on keystroke (debounced 300ms)
- Auto-restore on chat switch
- Draft cleared on successful message send
- localStorage for persistence (survives restart)
- Visual indicator when a draft exists (subtle, non-intrusive)

**Out (v1):**
- Per-session drafts (per-bot is sufficient)
- Draft history / undo
- Sync across devices
- Draft for Hub input (Hub is a shared feed, different UX)
- Draft expiry/TTL (keep indefinitely for v1)

---

## 5. Acceptance Criteria

- [ ] Given user types text in Bot A's chat input, when user switches to Bot B, then Bot A's text is saved to localStorage
- [ ] Given user returns to Bot A, when chat loads, then the previously typed (unsent) text is restored to the input field
- [ ] Given user sends a message, when send succeeds, then the draft for that bot is cleared
- [ ] Given user clears the input manually (selects all + delete), when input is empty, then draft is cleared from localStorage
- [ ] Given app is quit and relaunched, when user opens Bot A's chat, then unsent draft is still present
- [ ] Given a bot has a saved draft, when user views that bot in the sidebar, then a subtle visual indicator (e.g., dot or "Draft" label) is shown
- [ ] Draft auto-save is debounced at 300ms — not saving on every single keypress to avoid performance issues
- [ ] No draft persistence for Hub input (Hub is out of scope)

---

## 6. Technical Approach (guidance only — dev decides implementation)

- Zustand store (`draftStore`) with `drafts: Record<botId, string>`
- Persist via Zustand `persist` middleware → localStorage key `medusa-drafts`
- Hook into chat input `onChange` to update store (debounced)
- On bot chat mount, read draft from store and set as initial input value
- On message send success, call `clearDraft(botId)`
- Sidebar badge: if `drafts[botId]` is non-empty, show indicator

---

## 7. Task Breakdown

| # | Task | Role | Dependencies | Est. |
|---|------|------|-------------|------|
| DM1 | Create `draftStore` Zustand store with localStorage persistence | Full Stack Dev | None | S |
| DM2 | Wire chat input `onChange` to draftStore (debounced 300ms) | UI Dev | DM1 | S |
| DM3 | Restore draft on chat mount (read from store, set input value) | UI Dev | DM1 | S |
| DM4 | Clear draft on successful send | Full Stack Dev | DM1 | XS |
| DM5 | Sidebar draft indicator (dot or "Draft" label per bot) | UI Dev | DM1 | S |
| DM6 | QA verification — all acceptance criteria | QA/Testing or QA2 | DM1-DM5 | S |

**Implementation order:** DM1 first (store foundation), then DM2+DM3+DM4 in parallel, then DM5, then DM6.

---

## 8. Success Criteria

- Users never lose a partially-typed message when switching between bot chats
- Draft restore is instant — no visible delay on chat switch
- localStorage footprint is negligible (text strings only)
- Zero regressions to existing send/receive message flow

---

## 9. Open Questions

- [ ] Should the draft indicator in the sidebar be a dot, a "Draft" chip, or italicized bot name? (UI decision — recommend dot for minimal footprint)
- [ ] Should drafts expire after X days? (Recommend: no expiry for v1, revisit if storage becomes a concern)

---

## Notes

- Zustand `persist` middleware with localStorage is already used in Medusa — this follows existing patterns
- Debounce at 300ms is standard for text input auto-save
- Hub input is explicitly out of scope — Hub is a shared feed and draft behavior there is a separate UX question
- This is a purely frontend feature — no backend changes required
