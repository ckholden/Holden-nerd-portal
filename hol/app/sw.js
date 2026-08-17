// Holden On Line — minimal service worker (enables install / Add to Home Screen).
// No offline caching of the app shell on purpose, same reasoning as dmrptt: this is a
// real-time chat app that needs the live WSS to function — there's nothing useful to do
// offline, and a cached-but-stale shell would be actively misleading (e.g. a stale sign-on
// page pointed at an outdated server address). A registered fetch handler (even a no-op
// pass-through) is still part of Chrome's install-prompt criteria, so it stays.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('fetch', () => {});
