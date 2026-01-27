const CACHE_NAME = 'holdenptt-v1';
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

self.addEventListener('fetch', (e) => {
    // Network-first for API/Firebase calls, cache-first for app assets
    if (e.request.url.includes('firebasejs') || e.request.url.includes('firebaseio') || e.request.url.includes('googleapis')) {
        e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    } else {
        e.respondWith(
            caches.match(e.request).then((cached) => cached || fetch(e.request))
        );
    }
});
