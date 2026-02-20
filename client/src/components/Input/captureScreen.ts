/**
 * Utility to capture a single frame from the user's screen.
 *
 * Strategy (in priority order):
 *  1. Medusa.app (WKWebView) — native ScreenCaptureKit bridge via window.webkit.messageHandlers.
 *     Swift captures the display, encodes as PNG base64, fires 'medusaNativeCapture' CustomEvent.
 *  2. Browser — navigator.mediaDevices.getDisplayMedia (standard web API).
 *  3. Fallback — file picker (<input type="file">) for environments that support neither.
 *
 * Requires macOS 14+ for ScreenCaptureKit path; macOS 13.x uses CGWindowListCreateImage fallback
 * in the Swift layer (transparent to JS — same bridge, same event).
 */

// ---------------------------------------------------------------------------
// WKWebView native bridge (SC4 / SC5)
// ---------------------------------------------------------------------------

/** True when running inside Medusa.app's WKWebView with the captureScreen handler registered. */
function isWKWebView(): boolean {
  return typeof (
    window as unknown as {
      webkit?: { messageHandlers?: { captureScreen?: { postMessage: (m: unknown) => void } } };
    }
  ).webkit?.messageHandlers?.captureScreen !== 'undefined';
}

/** Shared helper: post a message to the Swift captureScreen handler and await the result event. */
function captureViaBridge(
  payload: Record<string, unknown>,
  tag: string,
  timeoutMs: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const handleResult = (e: Event) => {
      clearTimeout(timer);
      const { data, error } = (e as CustomEvent<{ data?: string; error?: string }>).detail;
      if (!data) {
        if (error) console.warn(`[${tag}] Native capture failed:`, error);
        resolve(null);
        return;
      }
      // Convert base64 PNG → Blob
      try {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (err) {
        console.error(`[${tag}] Failed to decode base64 PNG:`, err);
        resolve(null);
      }
    };

    const timer = setTimeout(() => {
      window.removeEventListener('medusaNativeCapture', handleResult);
      console.warn(`[${tag}] Native capture timed out after ${timeoutMs / 1000} s`);
      resolve(null);
    }, timeoutMs);

    window.addEventListener('medusaNativeCapture', handleResult, { once: true });

    (
      window as unknown as {
        webkit: { messageHandlers: { captureScreen: { postMessage: (m: unknown) => void } } };
      }
    ).webkit.messageHandlers.captureScreen.postMessage(payload);
  });
}

/**
 * SC4: Full-screen capture via the Swift WKScriptMessageHandler bridge.
 * Swift captures the primary display, encodes as PNG base64, and fires 'medusaNativeCapture'.
 * Returns a PNG Blob, or null if the capture fails or times out.
 */
function captureViaWKBridge(): Promise<Blob | null> {
  // 30 s timeout — first-time use may pause while the OS prompts for Screen Recording permission.
  return captureViaBridge({}, 'SC4', 30_000);
}

/**
 * SC5: Window picker — lets the user click any visible window to capture it.
 * Swift presents a native overlay, user clicks a window, Swift fires 'medusaNativeCapture'.
 * 60 s timeout to give the user time to interact with the picker overlay.
 */
function captureViaWindowPicker(): Promise<Blob | null> {
  return captureViaBridge({ mode: 'windowPicker' }, 'SC5', 60_000);
}

/**
 * SC6: Region picker — Swift presents a fullscreen drag-to-select overlay.
 * Returns the cropped region directly (no React crop step needed).
 * 60 s timeout to give the user time to drag the selection.
 */
function captureViaRegionPicker(): Promise<Blob | null> {
  return captureViaBridge({ mode: 'regionPicker' }, 'SC6', 60_000);
}

/**
 * True when running inside Medusa.app's WKWebView where the native region
 * picker is available. Use this to decide whether to skip the React crop overlay.
 */
export function isNativeRegionPickerAvailable(): boolean {
  return isWKWebView();
}

// ---------------------------------------------------------------------------
// Web (getDisplayMedia) path
// ---------------------------------------------------------------------------

/** Returns true when the screen capture API is available in this environment. */
export function supportsGetDisplayMedia(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** Shared logic: capture one frame from an active MediaStream, then stop it. */
async function captureFrameFromStream(stream: MediaStream): Promise<Blob | null> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }

  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;

    // Race: either the video loads or the track ends prematurely
    const loaded = await Promise.race([
      new Promise<boolean>((resolve) => {
        video.onloadeddata = () => resolve(true);
      }),
      new Promise<boolean>((resolve) => {
        track.addEventListener('ended', () => resolve(false), { once: true });
      }),
    ]);

    if (!loaded) return null;

    await video.play();

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0);
    video.pause();

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png');
    });
  } finally {
    // Always stop tracks to dismiss the browser "sharing" indicator
    stream.getTracks().forEach((t) => t.stop());
  }
}

// ---------------------------------------------------------------------------
// File picker fallback
// ---------------------------------------------------------------------------

/** Fallback: open a file picker and return the selected image as a Blob. */
export function pickImageFile(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ?? null);
    };
    // Resolve null if the user dismisses without picking
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * SC6: Capture a user-defined region via the native drag-to-select overlay.
 *  - Medusa.app: native fullscreen region picker (returns the cropped region directly)
 *  - Browser/fallback: full-screen capture (caller should show React crop overlay)
 *
 * Use `isNativeRegionPickerAvailable()` to decide whether the result is already
 * cropped (native) or needs the React RegionSelector crop step (browser fallback).
 */
export async function captureRegionFrame(): Promise<Blob | null> {
  if (isWKWebView()) return captureViaRegionPicker();
  // Browser: return the full screen — ScreenshotButton will show the crop overlay.
  return captureScreenFrame();
}

/**
 * Capture the full screen.
 *  - Medusa.app: native ScreenCaptureKit via Swift bridge
 *  - Browser: getDisplayMedia
 *  - Fallback: file picker
 */
export async function captureScreenFrame(): Promise<Blob | null> {
  if (isWKWebView()) return captureViaWKBridge();
  if (!supportsGetDisplayMedia()) return pickImageFile();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      return null; // User cancelled the share dialog
    }
    return pickImageFile(); // API defined but unusable at runtime
  }
  return captureFrameFromStream(stream);
}

/**
 * SC5: Capture a user-selected window.
 *  - Medusa.app: native window picker overlay via Swift bridge (user clicks any visible window)
 *  - Browser: getDisplayMedia with preferCurrentTab hint
 *  - Fallback: file picker
 */
export async function captureWindowFrame(): Promise<Blob | null> {
  if (isWKWebView()) return captureViaWindowPicker();
  if (!supportsGetDisplayMedia()) return pickImageFile();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      // Hints the browser to offer the current window/tab first (Chromium-based browsers).
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      return null; // User cancelled
    }
    return pickImageFile(); // API defined but unusable at runtime
  }
  return captureFrameFromStream(stream);
}
