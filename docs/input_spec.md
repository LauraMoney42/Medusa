# Feature: Dynamic Auto-Expanding Text Input (INPUT)

**Priority:** P2
**Assigned to:** UI Dev
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

The Hub and chat text input bar is a fixed-height single line. When users type longer messages (multi-line instructions, code snippets, detailed prompts), they're forced to scroll within a tiny box — or can't see what they've written at all. This feels cramped and discourages detailed communication with bots.

## Proposed Solution

Replace the fixed-height input with an auto-expanding textarea that grows dynamically as the user types. Set a sensible maximum height so it doesn't take over the screen. Above the max height, the textarea scrolls internally.

## Success Criteria

- Input starts at single-line height (or comfortable 1-2 line minimum)
- Grows smoothly as user types multi-line content
- Stops growing at a max height (~5 lines / ~150px) and scrolls internally above that
- Shrinks back when user deletes content
- No layout breaking or content overlap when expanded
- Works in both Hub and chat input areas

---

## Scope

**In:**
- Auto-resize behavior on the main chat/Hub text input component
- Smooth height transition (CSS transition or JavaScript resize)
- Max height cap with internal scroll above cap
- Min height: 1 line (comfortable single-line appearance)
- Shrinks on content delete (no stuck expanded state)

**Out:**
- Markdown preview mode
- Rich text / WYSIWYG editor
- Toolbar (bold, italic, etc.)

---

## Technical Notes

- Find the current input component in `client/src/components/Input/` or `client/src/components/Chat/`
- Replace `<input type="text">` with `<textarea>` if not already (or use `contenteditable` div)
- Auto-resize pattern:
  ```javascript
  const handleInput = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, MAX_HEIGHT) + 'px';
  };
  ```
- CSS: `resize: none; overflow-y: auto; max-height: 150px; min-height: 40px;`
- Alternatively use a library like `react-textarea-autosize` if already in project dependencies — check `package.json` first
- Ensure `Enter` key still submits (not creates new line) — use `Shift+Enter` for newline, or check existing behavior and preserve it
- Apply to both Hub input and per-session chat input if they share a component

---

## Acceptance Criteria

- [ ] Given a single short message, the input displays at default single-line height
- [ ] Given the user types a message that wraps to 2+ lines, the input grows to show all lines without scrolling
- [ ] Given the user types more than ~5 lines, the input stops growing and scrolls internally
- [ ] Given the user deletes content, the input shrinks back to fit the remaining text
- [ ] Given the user presses Enter, the message submits (existing behavior preserved)
- [ ] Given the user presses Shift+Enter, a new line is inserted in the input
- [ ] The expanded input does not overlap or obscure other UI elements (message list, buttons)
- [ ] Behavior is identical in both Hub and chat session input areas

## Build Notes

- JS/React change — run `npm run build` before tagging @You
- Tag @You for verification — user is acting as QA
- Test with: short message, 3-line message, 10-line message, then delete back to 1 line
