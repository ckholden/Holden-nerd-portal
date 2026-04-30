// Maestra Lupita service worker
// Strategy: cache-first for app shell, network-only for API + Firebase calls.
// Bumped version → forces refresh of cached files on update.

const VERSION = 'lupita-v3';
const SHELL_CACHE = `lupita-shell-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/auth.js',
  './js/api.js',
  './js/chat.js',
  './js/voice.js',
  './js/scenarios.js',
  './js/firebase-config.js',
  './data/scenarios.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// ── Install: precache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Don't fail install if some optional files 404
      Promise.all(SHELL_FILES.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for shell, network for everything else
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip cross-origin (Firebase, Anthropic Worker, etc.) — always go to network
  if (url.origin !== self.location.origin) return;

  // Skip non-GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Background revalidate so the next visit gets fresh content
        fetch(event.request).then((fresh) => {
          if (fresh.ok) {
            caches.open(SHELL_CACHE).then((c) => c.put(event.request, fresh));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then((resp) => {
        if (resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
