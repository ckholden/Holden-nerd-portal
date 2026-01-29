/**
 * HOSCAD Field Service Worker
 * Caches app shell for offline resilience, handles push notifications.
 */

const CACHE_NAME = 'hoscadfield-v1';
const APP_SHELL = [
  './',
  './index.html',
  './api.js',
  './icon-cadradio.svg',
  './download.png',
  './manifest.json',
  './tone-urgent.wav'
];

// Install — cache app shell
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL).catch(function() {});
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', function(event) {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Network-first for API calls (never cache these)
  var url = event.request.url;
  if (url.includes('script.google.com') || url.includes('googleapis')) {
    event.respondWith(fetch(event.request).catch(function() { return caches.match(event.request); }));
    return;
  }

  // Network-first with cache update for app shell
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return response;
      })
      .catch(function() { return caches.match(event.request); })
  );
});

// Push notifications
self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { data: { title: event.data.text() } }; } catch (e2) {}
  }

  var payload = data.data || data.notification || data;
  var title = payload.title || 'HOSCAD Field Alert';
  var body = payload.body || 'Dispatch alert received';
  var isUrgent = payload.urgent === 'true' || payload.urgent === true;
  var tag = payload.tag || ('hoscadfield-alert-' + Date.now());

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: 'icon-cadradio.svg',
      badge: 'icon-cadradio.svg',
      tag: tag,
      requireInteraction: isUrgent,
      vibrate: [300, 100, 300, 100, 300],
      data: payload
    })
  );
});

// Notification click — focus or open app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url) {
          return clients[i].focus();
        }
      }
      return self.clients.openWindow('/hoscadfield/');
    })
  );
});
