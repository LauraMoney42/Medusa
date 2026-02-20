# Enhanced Screenshot + Drag-and-Drop — Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-14
**Author:** PM Bot
**Assign to:** @ui-dev (UI-heavy, client-only)
**Priority:** High — new feature

---

## User Story

**As a** user chatting with bots,
**I want** to capture screenshots (full screen, region select, window) and drag-and-drop images from anywhere on my desktop onto any part of the Medusa UI,
**so that** I can quickly share visual context with bots without hunting for the tiny input area.

---

## What Exists Today

| Feature | Status | Location |
|---------|--------|----------|
| Full-screen capture | ✅ Done | `ScreenshotButton.tsx` + `captureScreen.ts` |
| Region select crop | ✅ Done | `RegionSelector.tsx` |
| Clipboard paste | ✅ Done | `ChatInput.tsx` (textarea onPaste) |
| Image preview thumbnails | ✅ Done | `ImagePreview.tsx` |
| Server upload endpoint | ✅ Done | `server/src/routes/images.ts` (20MB, UUID) |
| Drag-and-drop on ChatPane | ❌ Missing | No handlers |
| Drag-and-drop on HubFeed | ❌ Missing | No handlers |
| Drag-and-drop on App (global) | ❌ Missing | No handlers |
| Camera icon in input bar | ❌ Missing | ScreenshotButton exists but may need repositioning |

---

## What Needs to Be Built

### Change 1: Global drag-and-drop zone

**Problem:** User can only paste images into the textarea. No drag-and-drop at all. The drop target should be the entire visible area — not just the input bar.

**Approach:** Add drag-and-drop handlers at the `App.tsx` level so dropping an image anywhere on the UI adds it to the active chat (or Hub input).

**Files:**
- `client/src/App.tsx` — MODIFIED
- `client/src/components/Chat/ChatPane.tsx` — MODIFIED
- `client/src/components/Hub/HubFeed.tsx` — MODIFIED

**Implementation:**

1. **App.tsx** — Add global `onDragOver`, `onDragEnter`, `onDragLeave`, `onDrop` handlers on the `.app-layout` div.

2. **Drop overlay** — When a file is dragged over the app, show a full-screen overlay with a visual hint: "Drop image here". This overlay fades in smoothly.

3. **Routing the drop:**
   - If `activeView === 'chat'` and there's an `activeSessionId` → add the image to `ChatInput`'s image state
   - If `activeView === 'hub'` → add the image to `HubFeed`'s input (requires HubFeed to support images — see Change 3)
   - If no active session → show a brief toast/hint: "Select a session first"

4. **File validation on drop:**
   - Accept: `image/*` MIME types only (jpg, png, gif, webp, etc.)
   - Reject non-image files silently (or with a brief hint)
   - Max file size: 20MB (match server limit)

5. **State flow:** The dropped file needs to reach the input component's state. Two approaches:
   - **Option A (recommended):** Create a shared Zustand store `imageDropStore` with `pendingImages` state. App.tsx writes to it on drop. ChatInput/HubFeed read from it and clear after consuming.
   - **Option B:** Use a ref/callback passed through props. More prop drilling but no new store.

**Drop overlay styling:**
```
- Full viewport overlay (position: fixed, inset: 0)
- z-index: 500 (above everything except modals)
- Background: rgba(26, 122, 60, 0.08) — subtle green tint
- Border: 2px dashed rgba(26, 122, 60, 0.4) — inset from edges
- Center text: "Drop image here" with camera icon
- Animate in with opacity transition (150ms)
- Pointer-events: none on inner content (so drop works)
```

### Change 2: Camera icon in input bar

**Problem:** The screenshot button exists but it's at the end of the input row next to send/abort. A camera icon is more discoverable.

**File:** `client/src/components/Input/ChatInput.tsx` — MODIFIED

**Implementation:**
- The `ScreenshotButton` component already exists and has a dropdown menu with "Region Select" and "Full Screen" options
- Ensure it's visually styled as a camera icon (SVG) matching the warm charcoal theme
- Position it on the left side of the input row (before the textarea) or keep it on the right — wherever it's most natural
- The dropdown should open upward (already does)

**The camera icon should show:**
- 📷 Camera SVG icon (not emoji)
- On click: dropdown with "Region Select" / "Full Screen" / "Window" (window = full screen since system dialog handles window selection)
- Match the muted style of other input buttons

### Change 3: Hub image support

**Problem:** Hub currently only supports text posts. If a user drops an image while in Hub view, nothing happens.

**Files:**
- `client/src/components/Hub/HubFeed.tsx` — MODIFIED

**Implementation:**
- Add image state to HubFeed (same pattern as ChatInput: `images: { file, preview }[]`)
- Show `ImagePreview` components above the Hub input when images are staged
- On send: upload images via `uploadImage()`, include paths in the hub:post socket event
- This requires a small server-side change to accept image paths in `hub:post`

**Server change:**
- `server/src/socket/handler.ts` — the `hub:post` event handler needs to accept optional `images: string[]`
- `server/src/hub/store.ts` — `HubMessage` type needs an optional `images?: string[]` field
- `client/src/types/hub.ts` — add `images?: string[]` to interface
- `client/src/components/Hub/HubMessage.tsx` — render images if present

### Change 4: Drop zone visual feedback per area

**Problem:** The global overlay tells the user they can drop, but it would be better if the specific target area (chat area or hub feed) highlights when hovered.

**Implementation:**
- When dragging over the chat message area → subtle highlight on the ChatPane
- When dragging over the hub feed → subtle highlight on the HubFeed
- The input area itself gets a stronger highlight (it's the actual target)
- Use CSS transitions for smooth feedback

---

## New File

### `client/src/stores/imageDropStore.ts` (NEW)

Lightweight Zustand store for global drag-and-drop coordination:

```typescript
interface ImageDropState {
  isDragging: boolean;
  pendingImages: { file: File; preview: string }[];
}

interface ImageDropActions {
  setDragging: (isDragging: boolean) => void;
  addImages: (images: { file: File; preview: string }[]) => void;
  consumeImages: () => { file: File; preview: string }[];
}
```

- `isDragging` — controls the drop overlay visibility
- `pendingImages` — images waiting to be consumed by the active input
- `consumeImages()` — returns and clears pending images (called by ChatInput or HubFeed when they detect new entries)

---

## Modified Files Summary

| # | File | Type | Change |
|---|------|------|--------|
| 1 | `client/src/stores/imageDropStore.ts` | NEW | Global drag-and-drop state |
| 2 | `client/src/App.tsx` | MODIFIED | Global drag/drop handlers + overlay |
| 3 | `client/src/components/Input/ChatInput.tsx` | MODIFIED | Consume dropped images from store |
| 4 | `client/src/components/Hub/HubFeed.tsx` | MODIFIED | Image support + consume dropped images |
| 5 | `client/src/components/Hub/HubMessage.tsx` | MODIFIED | Render images in hub messages |
| 6 | `client/src/types/hub.ts` | MODIFIED | Add optional `images` field |
| 7 | `server/src/socket/handler.ts` | MODIFIED | Accept images in `hub:post` event |
| 8 | `server/src/hub/store.ts` | MODIFIED | Add `images` to HubMessage type |

---

## Implementation Order

1. `imageDropStore.ts` — new store (no dependencies)
2. `App.tsx` — global drag/drop handlers + overlay
3. `ChatInput.tsx` — consume pending images from store
4. Test: drag an image from desktop onto the app → it should appear in ChatInput's image previews
5. `hub.ts` type + `store.ts` — add images to HubMessage
6. `handler.ts` — accept images in hub:post
7. `HubFeed.tsx` — image staging + upload + consume from store
8. `HubMessage.tsx` — render images
9. Test: drag an image while in Hub view → stages in Hub input, appears in message after posting

---

## Acceptance Criteria

### Drag-and-drop
- [ ] Dragging a file over any part of the Medusa UI shows a drop overlay
- [ ] Dropping an image file adds it to the active chat's input (as a preview thumbnail)
- [ ] Dropping an image while in Hub view adds it to the Hub input
- [ ] Dropping a non-image file does nothing (no crash, no error)
- [ ] Dropping with no active session shows a hint
- [ ] Multiple images can be dropped at once
- [ ] Drop overlay animates in/out smoothly

### Screenshot
- [ ] Camera icon visible in the input bar
- [ ] Clicking opens dropdown: Region Select / Full Screen
- [ ] Both modes work as before (system dialog for screen selection)
- [ ] Captured screenshot appears as preview thumbnail in input

### Hub images
- [ ] Images can be attached to Hub posts
- [ ] Hub messages display attached images
- [ ] Images persist through server (uploaded via /api/images)

### General
- [ ] Works alongside existing clipboard paste (no conflicts)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds
- [ ] Warm charcoal theme styles maintained throughout
