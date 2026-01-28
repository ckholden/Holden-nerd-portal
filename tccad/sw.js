/**
 * HOSCAD Service Worker
 * Handles FCM push notifications, notification clicks,
 * and caches app shell for offline resilience.
 */

const CACHE_NAME = 'hoscad-v2';
const APP_SHELL = [
  './index.html',
  './radio.html',
  './styles.css',
  './app.js',
  './radio.js',
  './api.js',
  './download.png'
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // Individual failures are OK, best effort
      });
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
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for app shell URLs
        if (response.ok) {
          const url = new URL(event.request.url);
          const path = './' + url.pathname.split('/').pop();
          if (APP_SHELL.includes(path)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// ============================================================
// FCM Push — show OS notification for background alerts
// ============================================================
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { data: { title: event.data.text() } }; } catch (e2) {}
  }

  // FCM data-only messages come in data.data
  const payload = data.data || data.notification || data;
  const title = payload.title || 'CADRadio Alert';
  const body = payload.body || payload.channel || 'Dispatch alert received';
  const channel = payload.channel || '';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: 'download.png',
      badge: 'download.png',
      tag: 'cadradio-alert',
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
      data: { channel: channel, type: 'ALERT_TAP' }
    })
  );
});

// ============================================================
// Notification click — post ALERT_TAP to client or open radio.html
// ============================================================
self.addEventListener('notificationclick', (event) => {
  const notifData = event.notification.data || {};
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Try to find and focus an existing window, then post the alert message
      for (const client of clients) {
        if (client.url) {
          return client.focus().then((focused) => {
            if (focused && notifData.type === 'ALERT_TAP') {
              focused.postMessage({
                type: 'ALERT_TAP',
                channel: notifData.channel || ''
              });
            }
            return focused;
          });
        }
      }
      // No existing window — cold start: open radio.html with hash
      const channel = notifData.channel || '';
      const url = channel ? './radio.html#alert=' + encodeURIComponent(channel) : './radio.html';
      return self.clients.openWindow(url);
    })
  );
});
