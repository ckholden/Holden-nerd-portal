const CACHE_NAME = 'holdenptt-v5';
const ASSETS = [
    './',
    './index.html',
    './css/style.css',
    './js/config.js',
    './js/auth.js',
    './js/channels.js',
    './js/chat.js',
    './js/audio.js',
    './js/alerts.js',
    './js/recording.js',
    './js/app.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Focus existing window if found
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open a new window
            return clients.openWindow('./');
        })
    );
});

self.addEventListener('fetch', (e) => {
    // Network-first for API/Firebase calls, cache-first for app assets
    if (e.request.url.includes('firebasejs') || e.request.url.includes('firebaseio') || e.request.url.includes('googleapis')) {
        e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    } else {
        // Network-first for app assets so updates are always seen
        e.respondWith(
            fetch(e.request)
                .then((response) => {
                    // Cache the fresh response for offline use
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
                    return response;
                })
                .catch(() => caches.match(e.request))
        );
    }
});
