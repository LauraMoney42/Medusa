/**
 * Registers the PWA service worker. No-op in dev (Vite's dev server doesn't
 * need it) and fails silently if unsupported — this must never block app boot.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] Service worker registration failed:', err);
    });
  });
}
