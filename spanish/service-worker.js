// Maestra Lupita service worker
// Bumped version → forces refresh of cached files on update.

const VERSION = 'lupita-v6';
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
  './js/medical.js',
  './js/vocab.js',
  './js/firebase-config.js',
  './data/scenarios.json',
  './data/medical-topics.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

// ── Install: precache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
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

// ── Fetch
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cross-origin (Firebase, Worker, etc.) — pass through. Critical: do NOT
  // intercept Firebase auth / Google identitytoolkit / gstatic CDN requests.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  // Skip caching for any path under firebase or auth concerns
  if (url.pathname.startsWith('/__/auth') || url.pathname.includes('firebase')) return;

  // Network-first for HTML so updates show up promptly
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match(event.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Background revalidate
        fetch(event.request).then((fresh) => {
          if (fresh.ok) caches.open(SHELL_CACHE).then((c) => c.put(event.request, fresh));
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then((resp) => {
        if (resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => {
        // For navigation, fall back to cached index. For asset 404s, return a real 404
        // (avoid serving HTML in place of missing JS — that breaks module loading).
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('Not found', { status: 404 });
      });
    })
  );
});
