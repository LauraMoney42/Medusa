# P3 Bug Fix: Image Attachment Icon Shows '?' in Chat (IMG-ICON)

**Priority:** P3
**Assigned to:** UI Dev
**Status:** Spec — Ready to implement
**Date:** 2026-02-19

---

## Problem

When a user sends an image in chat, the attachment shows a '?' icon instead of a proper image thumbnail or recognizable image indicator. This is confusing — users can't tell if their image was attached correctly.

## Proposed Solution

Fix the attachment rendering so that image files show either:
- A small thumbnail of the actual image (preferred), OR
- A recognizable image icon (e.g., a photo/image SF symbol or Lucide icon) if thumbnails are too complex

## Success Criteria

- Image attachments in chat show a recognizable visual indicator (thumbnail or icon)
- No '?' appears for any supported image format (JPG, PNG, GIF, WEBP)
- Fix applies to both sent and received images

---

## Scope

**In:**
- Fix the '?' icon rendering for image attachments in chat messages
- Show image thumbnail if technically feasible (preferred)
- Fallback: show a proper image-type icon if thumbnail not feasible

**Out:**
- Full image lightbox/preview on click (separate feature)
- Video thumbnail support

---

## Technical Notes

- Find where attachments are rendered — likely `client/src/components/Chat/MessageBubble.tsx` or a dedicated `Attachment.tsx` component
- The '?' likely means the file type is not recognized or the `<img>` src is broken
- Check: is the attachment stored as a URL, blob URL, base64, or file reference?
- If blob URL: verify the URL is still valid at render time (blob URLs can expire)
- If base64: render directly as `<img src={`data:image/...;base64,...`} />`
- If file reference: may need server-side serving of the attachment
- Thumbnail approach: `<img src={attachmentUrl} style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4 }} />`
- Fallback icon: use existing Lucide `Image` icon from project's icon library

---

## Acceptance Criteria

- [ ] Given user sends a PNG image, the chat message shows a thumbnail or image icon (not '?')
- [ ] Given user sends a JPG image, same behavior as PNG
- [ ] Given the image attachment is received by another session, it also renders correctly (not '?')
- [ ] No broken image indicators (missing src, alt='?', broken `<img>` tags) appear for any image type

## Build Notes

- JS/React change — run `npm run build` before tagging @You
- Tag @You for verification — user is acting as QA
- Test by: sending a PNG, JPG, and screenshot via camera button, verify all show correct icon/thumbnail
