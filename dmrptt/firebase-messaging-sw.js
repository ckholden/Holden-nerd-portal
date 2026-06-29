// DMR PTT — Firebase Cloud Messaging service worker (push when app is closed) + PWA install.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyArDL_Cd-xDlmA_92xiaDKXXrSLHPbFUNU",
  authDomain: "holden-portal.firebaseapp.com",
  projectId: "holden-portal",
  messagingSenderId: "659387054117",
  appId: "1:659387054117:web:cf420bfd3a348e5aa6a7cc"
});
firebase.messaging();   // notification-payload messages are auto-displayed by the SDK

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
