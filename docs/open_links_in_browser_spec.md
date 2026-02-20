# Feature: Open Links in Default Browser

## Kickoff Checklist

**Platform:** Web (React + Vite) + packaged desktop app (Medusa.app via Tauri or similar)
**Tech stack:** React 19.2, TypeScript, react-markdown v10.1.0, remark-gfm, rehype-highlight
**Vibe/tone:** Consistent with existing Medusa behavior — no new UI chrome, invisible to user unless they click a link
**Dark/light mode:** N/A — no visual change
**Existing codebase:** Yes — modifying `MessageBubble.tsx` and potentially `ProjectPane.tsx`
**Third-party services:** None
**Hard constraints:** Must verify in both browser (dev server) AND desktop app (Medusa.app) — mandatory per project policy

---

## Problem

Links clicked inside Medusa chat messages open in the same browser tab, navigating the user away from the app entirely. This is disruptive — the user loses their Medusa session and has to navigate back. Links should open in the user's default browser (or a new tab) without leaving the app.

**Who has this problem:** Any Medusa user who clicks a URL in a chat message, Hub post, or project plan.

---

## Proposed Solution

Override the default `<a>` tag renderer in react-markdown to add `target="_blank"` and `rel="noopener noreferrer"` on all rendered links. This is a one-line config change to `MessageBubble.tsx` and requires no new dependencies.

Apply the same fix to `HubMessage.tsx` if Hub messages render markdown links.

The custom markdown parser in `ProjectPane.tsx` does not currently support links — leave it as-is unless user requests link support in project plans (out of scope for v1).

---

## Success Criteria

- Clicking any link in a chat message opens the URL in a new browser tab / default browser without navigating away from Medusa
- The Medusa session remains intact after clicking a link
- Links are visually unchanged (same green styling, underline on hover)
- No regression on existing markdown rendering (code blocks, bold, lists, etc.)

---

## Scope

**In:**
- Links in chat messages (`MessageBubble.tsx` — react-markdown component)
- Links in Hub messages if rendered via react-markdown
- Security attributes: `rel="noopener noreferrer"` on all external links

**Out (v1):**
- Link support in project plan markdown (`ProjectPane.tsx` custom parser) — separate ticket if needed
- Any custom link preview UI
- Link whitelisting or domain filtering
- In-app browser / iframe behavior

---

## Open Questions

None — approach is clear and low-risk.

---

## Technical Notes

**Root cause:** react-markdown renders `[text](url)` as a plain `<a href="url">text</a>` with no `target` attribute. Without `target="_blank"`, clicks navigate the current tab.

**Fix location:** `MessageBubble.tsx` — pass a `components` prop to the `<Markdown>` component:

```tsx
components={{
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}}
```

This is the react-markdown v10 recommended pattern for custom renderers. No new dependencies required.

**Existing correct patterns to preserve:**
- `LoginScreen.tsx` already uses `target="_blank"` + `rel="noopener noreferrer"` correctly — no change needed
- `HubMessage.tsx` image click already uses `window.open(src, '_blank')` — no change needed

---

## Tasks

| ID | Description | Assigned To | Notes |
|----|-------------|-------------|-------|
| LB1 | Add custom `<a>` renderer to react-markdown in `MessageBubble.tsx` | Full Stack Dev | Pass `components` prop, add `target="_blank"` + `rel="noopener noreferrer"` |
| LB2 | Check Hub message rendering — apply same fix if markdown links present | Full Stack Dev | Bundled with LB1, same session |
| LB3 | QA verify — both browser + desktop app | QA/Testing or QA2 | See acceptance criteria below |

---

## Acceptance Criteria

**LB1/LB2 (Dev):**
- [ ] Build GREEN before claiming done
- [ ] No self-certification — tag QA when done

**LB3 (QA — verify in BOTH browser AND desktop app):**
- [ ] Send a message containing a markdown link (e.g., `[Google](https://google.com)`) — clicking it opens in new tab, does NOT navigate away from Medusa
- [ ] Send a message containing a bare URL — behavior consistent (opens externally or in new tab)
- [ ] Medusa session intact after clicking link — no navigation away
- [ ] Link styling unchanged — green color, underline on hover
- [ ] No markdown regression — code blocks, bold, italic, lists all render correctly
- [ ] Verified in browser (Vite dev server) AND Medusa.app desktop — both must pass

---

## Status

**Spec:** Complete
**Dev work:** COMPLETE — implemented by Full Stack 2, 2026-02-19
**Priority:** P1 (per PM2 assignment)
