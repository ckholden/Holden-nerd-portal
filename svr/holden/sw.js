/* svr/holden service worker: scope /svr/holden/ only (never /dmrptt/ or /svr/dmr/).
   Caches the page shell so the app opens; NEVER caches live data. Only same-origin GETs under
   /svr/holden/ plus the shared theme are touched; the feed, Firebase and everything else go straight
   to the network untouched. Navigations are network-first, so a deploy shows up on the next open. */
const C = 'svr-holden-shell-v2';
const SHELL = ['/svr/holden/', '/svr/holden/recordings.js', '/svr/hd-theme.css', '/svr/holden/manifest.webmanifest',
  '/svr/holden/icon-192.png', '/svr/holden/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('svr-holden-') && k !== C)
    .map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Offline</title><body style="margin:0;background:#0b1622;color:#eef3f8;font:17px/1.4 system-ui,sans-serif;padding:32px 20px">' +
  '<h1 style="font-size:21px">Offline</h1><p style="color:#b4c3d4">Status is unavailable without a connection. ' +
  'Nothing here is cached, so nothing shown would be live.</p><p><a style="color:#85B7EB" href="/svr/holden/">Try again</a></p>';
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  const shell = u.pathname.startsWith('/svr/holden/') || u.pathname === '/svr/hd-theme.css';
  if (!shell) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put('/svr/holden/', cp)); } return r; })
      .catch(() => caches.match('/svr/holden/').then(r => r || new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
    return;
  }
  e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(req, cp)); } return r; })
    .catch(() => caches.match(req)));
});
