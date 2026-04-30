// Maestra Lupita service worker
// Bumped version → forces refresh of cached files on update.

const VERSION = 'lupita-v9';
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

// ── Install: precache app shell with cache: 'no-store' to bypass browser HTTP cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Force fresh fetches from network (not browser HTTP cache)
      for (const url of SHELL_FILES) {
        try {
          const resp = await fetch(url, { cache: 'no-store' });
          if (resp.ok) await cache.put(url, resp);
        } catch {}
      }
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: nuke ALL old caches (defensive — recover from prior broken deploys)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k))) // delete EVERY cache, not just old versions
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

  // Network-first for EVERYTHING — bypasses browser HTTP cache via cache:'no-store'.
  // Cache only used as offline fallback. Slower than cache-first but eliminates
  // stale-cache disasters when shipping updates.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then((resp) => {
      if (resp.ok && resp.type === 'basic') {
        const clone = resp.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(event.request, clone));
      }
      return resp;
    }).catch(() => {
      // Offline — fall back to cache
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
