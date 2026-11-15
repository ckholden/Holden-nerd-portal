// Talk to Christian (/talk/) — Firebase Cloud Messaging service worker (push when the app is closed) + PWA install.
// A copy of /dmrptt/firebase-messaging-sw.js (2026-11-15), scope /talk/. Only /talk/ pages can be opened from a tap.

// Push tap: registered BEFORE the Firebase SDK loads, so it runs first and stops the SDK's own tap handler (which
// focuses ANY open holdenportal.com window). A tap opens or focuses the /talk/ page. It still posts
// 'notification-clicked' to the page, as the SDK did. WIRE CONTRACT: every push link gw sends to Matthew
// (page, missed call) is https://holdenportal.com/talk/; anything else falls back to /talk/.
var HD_PAGES = ['/talk/', '/talk/index.html'];
function hdApp(path) { return '/talk/'; }
function hdTarget(link) {                         // the push's link, kept only if it is a HoldenDMR page on this site
  var home = new URL('/talk/', self.location.href), u;
  try { u = new URL(link || '/talk/', self.location.href); } catch (err) { return home; }
  if (u.pathname === '/talk') u.pathname += '/';   // same pages, slash form
  return (u.origin === self.location.origin && HD_PAGES.indexOf(u.pathname) >= 0) ? u : home;
}
function hdOpen(want, msg) {                      // focus an open page of the same app, else open the link
  var app = hdApp(want.pathname);
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cl) {
    for (var i = 0; i < cl.length; i++) {
      var u; try { u = new URL(cl[i].url); } catch (err) { continue; }
      if (u.origin === self.location.origin && HD_PAGES.indexOf(u.pathname) >= 0 && hdApp(u.pathname) === app) {
        var hit = cl[i];
        return hit.focus().then(function (c) { if (msg) { try { (c || hit).postMessage(msg); } catch (err) {} } },
                                function () { return clients.openWindow(want.href); });   // focus refused: open it
      }
    }
    return clients.openWindow(want.href).then(function (c) {
      if (!c || !msg) return;
      return new Promise(function (r) { setTimeout(r, 3000); }).then(function () {   // the SDK's 3 s wait for the new page
        try { c.postMessage(msg); } catch (err) {}
      });
    });
  });
}
self.addEventListener('notificationclick', function (e) {
  // An action-button tap (none are sent today) is treated like a tap on the notification body; the SDK ignores them.
  var d = e.notification && e.notification.data, p = d && d.FCM_MSG, msg = null, link = '/talk/';
  if (p) {
    link = (p.fcmOptions && p.fcmOptions.link) || (p.notification && p.notification.click_action) || '/talk/';
    try { msg = JSON.parse(JSON.stringify(p)); msg.messageType = 'notification-clicked'; msg.isFirebaseMessaging = true; }
    catch (err) { msg = null; }
  }
  e.stopImmediatePropagation();
  e.notification.close();
  e.waitUntil(hdOpen(hdTarget(link), msg));
});
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

// (Push taps are handled at the top of this file, before the SDK loads.)
