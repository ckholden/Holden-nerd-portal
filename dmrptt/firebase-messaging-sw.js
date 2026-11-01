// HoldenDMR — Firebase Cloud Messaging service worker (push when app is closed) + PWA install.
// Shared by both apps: the listener app (dmrptt/rx/push.js) registers this same worker with scope /dmrptt/.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyArDL_Cd-xDlmA_92xiaDKXXrSLHPbFUNU",
  authDomain: "holden-portal.firebaseapp.com",
  projectId: "holden-portal",
  messagingSenderId: "659387054117",
  appId: "1:659387054117:web:cf420bfd3a348e5aa6a7cc"
});
const messaging = firebase.messaging();   // notification-payload messages are auto-displayed by the SDK

// App-icon badge (hd2, 2026-11-01), for a FUTURE gateway field: a push whose data carries `badge` sets (n > 0, capped
// at 99) or clears (0) the home-screen icon badge. It only touches the badge when data.badge is present, and it never
// calls showNotification -- the SDK keeps displaying notification payloads exactly as before.
messaging.onBackgroundMessage(function (p) {
  if (!(p && p.data && p.data.badge !== undefined && p.data.badge !== null && p.data.badge !== '')) return;
  const b = parseInt(p && p.data && p.data.badge, 10);
  if (isNaN(b)) return;
  try {
    const nav = self.navigator;
    if (b > 0) { if (nav && nav.setAppBadge) return nav.setAppBadge(Math.min(b, 99)).catch(function () {}); }
    else if (nav && nav.clearAppBadge) return nav.clearAppBadge().catch(function () {});
  } catch (e) {}
});

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', () => {});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(function (cl) {
    for (const c of cl) { if (c.url.includes('/dmrptt')) return c.focus(); }
    return clients.openWindow('/dmrptt/');
  }));
});
