// KJ7DTS DMR Monitor — service worker (installable PWA + faster loads).
// Network-first for the page (deploys show immediately), cache-first for static
// assets/SDKs, and NEVER intercept Firebase realtime traffic.
const C = 'dmrmon-v2';
const SHELL = [
  '/svr/dmr/', '/svr/dmr/index.html', '/svr/dmr/manifest.webmanifest',
  '/svr/dmr/icon-192.png', '/svr/dmr/icon-512.png', '/svr/dmr/apple-touch-icon.png',
  '/portal-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(SHELL).catch(()=>{})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  // live data + auth backends: let them go straight to network (never cache)
  if (u.hostname.endsWith('firebaseio.com') || u.hostname.endsWith('googleapis.com') ||
      u.hostname.endsWith('firebaseapp.com') || u.hostname.includes('google')) return;
  // the page itself: network-first (fresh deploys), fall back to cache offline
  if (req.mode === 'navigate' || u.pathname === '/svr/dmr/' || u.pathname.endsWith('/svr/dmr/index.html')) {
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(req, cp)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('/svr/dmr/index.html'))));
    return;
  }
  // everything else (SDKs, icons, css): cache-first, then network
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(resp => {
    if (resp && resp.status === 200) { const cp = resp.clone(); caches.open(C).then(c => c.put(req, cp)); }
    return resp;
  }).catch(function(){})));
});
