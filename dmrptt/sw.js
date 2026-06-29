// DMR PTT — minimal service worker (enables install / add-to-home-screen).
// No offline caching of the app shell on purpose: it needs the live WSS to function.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', () => {});
