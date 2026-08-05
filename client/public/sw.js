// Minimal service worker: exists only to satisfy PWA installability criteria.
// Deliberately does NOT cache anything — this is a live app (chat, sockets, auth)
// where stale cached responses would cause real bugs. A future iteration can add
// scoped caching for static assets (JS/CSS bundles) if offline support is wanted.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// No fetch handler — all requests (API calls, Socket.IO, auth) pass through
// to the network untouched. Adding one here would risk intercepting/caching
// live traffic this app depends on.
