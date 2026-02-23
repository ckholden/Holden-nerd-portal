/**
 * HOSCAD Service Worker
 * Caches app shell for offline resilience, handles push notifications.
 */

const CACHE_NAME = 'hoscad-v73';
const APP_SHELL = [
  './',
  './index.html',
  './admin.html',
  './help.html',
  './app.js',
  './styles.css',
  './api.js',
  './download.png',
  './manifest.json',
  './lapd_priority_call.mp3'
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // Skip non-http(s) requests (e.g. chrome-extension://) — Cache API rejects them
  if (!url.startsWith('http')) return;

  // Network-first for API calls (never cache these)
  if (url.includes('supabase.co') || url.includes('script.google.com') || url.includes('googleapis')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Network-first with cache update for app shell
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only cache full 200 responses — partial (206) and error responses must not be cached
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { data: { title: event.data.text() } }; } catch (e2) {}
  }

  const payload = data.data || data.notification || data;
  const title = payload.title || 'HOSCAD Alert';
  const body = payload.body || 'Dispatch alert received';
  const isUrgent = payload.urgent === 'true' || payload.urgent === true;
  const tag = payload.tag || ('hoscad-alert-' + Date.now());

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: 'download.png',
      badge: 'download.png',
      tag: tag,
      requireInteraction: isUrgent,
      vibrate: [300, 100, 300, 100, 300],
      data: payload
    })
  );
});

// Notification click — focus or open app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/hoscad/');
    })
  );
});
