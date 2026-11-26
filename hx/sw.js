// Holden family history (/hx): decrypts the encrypted page files on this device.
// The key is a non-extractable AES-GCM CryptoKey kept in IndexedDB by index.html after unlock.
const SCOPE = new URL('./', self.location).pathname;          // "/hx/"
const PLAIN = new Set(['', 'index.html', 'sw.js', 'meta.json', 'check.bin']);
let KEY = null, MAN = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => { if (e.data === 'reset') { KEY = null; MAN = null; } });

function idbKey() {
  return new Promise(res => {
    const r = indexedDB.open('hx', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      try {
        const g = r.result.transaction('k').objectStore('k').get('key');
        g.onsuccess = () => res(g.result || null); g.onerror = () => res(null);
      } catch (e) { res(null); }
    };
  });
}
async function dec(buf) {
  const b = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, KEY, b.slice(12));
}
async function ready() {
  if (!KEY) KEY = await idbKey();
  if (!KEY) return false;
  if (!MAN) {
    const r = await fetch(SCOPE + 'd/m.bin', { cache: 'no-cache' });
    MAN = JSON.parse(new TextDecoder().decode(await dec(await r.arrayBuffer())));
  }
  return true;
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith(SCOPE) || e.request.method !== 'GET') return;
  const rel = decodeURIComponent(u.pathname.slice(SCOPE.length));
  if (PLAIN.has(rel) || rel.startsWith('d/')) return;
  e.respondWith((async () => {
    let ok = false;
    try { ok = await ready(); } catch (err) { KEY = null; MAN = null; }
    if (!ok) return Response.redirect(SCOPE, 302);
    const m = MAN[rel];
    if (!m) return new Response('Not found', { status: 404 });
    const r = await fetch(SCOPE + 'd/' + m[0]);
    if (!r.ok) return new Response('Not found', { status: 404 });
    const body = await dec(await r.arrayBuffer());
    return new Response(body, { headers: { 'Content-Type': m[1], 'Cache-Control': 'no-store' } });
  })());
});
