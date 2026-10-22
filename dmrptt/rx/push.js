/* dmrptt/rx/push.js -- notifications for the listen-only page (2026-10-21, lpush).
 *
 * One clear "Turn on notifications" button. It disappears once the gateway has acknowledged a live token for
 * THIS device, and on every later launch (permission already granted) the token is re-registered silently, so a
 * rotated token heals itself: the random device id below lets the gateway replace this device's old token.
 *
 * Wiring (see INTEGRATION.md): load this file, then call HoldenPush.ready() when the gateway's hello says
 * listen_only:true. It needs the firebase app + auth already on the page and loads firebase-messaging on demand.
 * Nothing here can transmit: it only talks to /pushtoken (HTTP) on the gateway.
 */
(function () {
  'use strict';
  var GW = 'https://kj7dts-server.tail34c6a5.ts.net';
  var VAPID = 'BLA38pfG7h8fejxarddEIMvnaLctPcD6C81r0Jl19OVwJvWpVnO8_QcAbDbuDpEsTgECfZ4o3dQBrYNWi1mbB3Y';
  var SW_URL = '/dmrptt/firebase-messaging-sw.js', SW_SCOPE = '/dmrptt/';   // the PTT app's worker, shared
  var MSG_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js';
  var K_DID = 'dmrptt_push_did', K_ACK = 'dmrptt_rx_pushack';
  var started = false, busy = false, sdk = null, bar = null;

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function log(s) { try { if (typeof window.log === 'function') window.log('push: ' + s); } catch (e) {} }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); }
  function standalone() { return !!(window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); }
  function plat() { return isIOS() ? 'ios' : (/android/i.test(navigator.userAgent) ? 'android' : 'desktop'); }
  function supported() { return ('Notification' in window) && ('serviceWorker' in navigator) && ('PushManager' in window); }
  function deviceId() {
    var d = ls(K_DID);
    if (!d || !/^[A-Za-z0-9_-]{8,64}$/.test(d)) {
      var a = new Uint8Array(16); crypto.getRandomValues(a);
      d = 'd' + Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      ls(K_DID, d);
    }
    return d;
  }

  // ---- the bar: one button + one line of text, built here so the page only needs a hook ----
  function ui() {
    if (bar) return bar;
    var app = document.getElementById('app'); if (!app) return null;
    bar = document.createElement('div'); bar.id = 'pushbar';
    bar.style.cssText = 'margin:8px 0 4px;text-align:center';
    bar.innerHTML = '<button class="b" id="pushbtn" type="button" style="width:100%;color:var(--green,#3fd07a);border:1px solid var(--green,#3fd07a);display:none">' +
      '&#128276; Turn on notifications</button><div id="pushmsg" style="font-size:12px;color:var(--mut,#8aa6bb);margin-top:6px;min-height:0"></div>';
    var after = document.getElementById('nethelp') || document.getElementById('netsw');
    if (after && after.parentNode === app) app.insertBefore(bar, after.nextSibling); else app.insertBefore(bar, app.firstChild);
    bar.querySelector('#pushbtn').addEventListener('click', onTap);
    return bar;
  }
  function show(btnText, msg) {
    if (!ui()) return;
    var b = bar.querySelector('#pushbtn'), m = bar.querySelector('#pushmsg');
    if (btnText) { b.textContent = btnText; b.disabled = false; b.style.display = ''; } else b.style.display = 'none';
    m.textContent = msg || '';
  }

  function loadSdk() {
    if (sdk) return sdk;
    sdk = new Promise(function (ok, bad) {
      if (window.firebase && firebase.messaging) return ok();
      var s = document.createElement('script'); s.src = MSG_SDK; s.async = true;
      s.onload = function () { ok(); }; s.onerror = function () { sdk = null; bad(new Error('messaging SDK did not load')); };
      document.head.appendChild(s);
    });
    return sdk;
  }
  function active(reg) {           // getToken needs an ACTIVE worker on a first install
    if (reg.active) return Promise.resolve(reg);
    return new Promise(function (ok) {
      var w = reg.installing || reg.waiting, t = setTimeout(function () { ok(reg); }, 10000);
      if (!w) { clearTimeout(t); return ok(reg); }
      w.addEventListener('statechange', function () { if (w.state === 'activated') { clearTimeout(t); ok(reg); } });
    });
  }

  // permission already granted -> getToken -> POST /pushtoken (bare token body, like the PTT app) -> ack
  function register(why) {
    if (busy) return Promise.resolve(false);
    busy = true;
    var tok = null;
    return loadSdk().then(function () {
      return navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
    }).then(active).then(function (reg) {
      var msg = firebase.messaging();
      if (!window._hpFg) {           // a push that arrives while this page is open: show it here (FCM won't)
        window._hpFg = 1;
        try { msg.onMessage(function (p) { var n = (p && p.notification) || {}; show(null, '📣 ' + (n.title || '') + (n.body ? ' — ' + n.body : '')); setTimeout(function () { show(null, ''); }, 15000); }); } catch (e) {}
      }
      return msg.getToken({ vapidKey: VAPID, serviceWorkerRegistration: reg });
    }).then(function (t) {
      if (!t) throw new Error('no token');
      tok = t;
      var u = firebase.auth().currentUser; if (!u) throw new Error('not signed in');
      return u.getIdToken();
    }).then(function (idt) {
      var url = GW + '/pushtoken?token=' + encodeURIComponent(idt) + '&d=' + encodeURIComponent(deviceId()) + '&p=' + plat();
      return fetch(url, { method: 'POST', body: tok });     // text/plain body: a "simple" CORS request, no preflight
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      busy = false;
      if (res.status === 200 && res.j && res.j.ok) {
        ls(K_ACK, tok); show(null, why === 'tap' ? '✓ Notifications are on for this device.' : '');
        if (why === 'tap') setTimeout(function () { show(null, ''); }, 6000);
        log('registered (' + why + ', ' + (res.j.devices || '?') + ' device(s))');
        return true;
      }
      log('gateway said ' + res.status);
      if (ls(K_ACK) === tok) { show(null, ''); return true; }     // same token, already acknowledged earlier
      show('🔔 Try again', res.status === 403 ? 'Notifications need an approved listen account.' :
        'Couldn’t turn notifications on (' + res.status + '). Try again in a moment.');
      return false;
    }).catch(function (e) {
      busy = false;
      log('error ' + (e && e.message ? e.message : e));
      if (tok && ls(K_ACK) === tok) { show(null, ''); return true; }
      show('🔔 Try again', 'Couldn’t turn notifications on: ' + (e && e.message ? e.message : 'error') + '.');
      return false;
    });
  }

  function onTap() {
    var b = bar && bar.querySelector('#pushbtn'); if (b) b.disabled = true;
    // requestPermission FIRST, straight from the tap (Safari only prompts inside a user gesture)
    var p;
    try { p = Notification.requestPermission(); } catch (e) { p = null; }
    Promise.resolve(p).then(function (perm) {
      perm = perm || Notification.permission;
      if (perm === 'granted') { show(null, 'Turning on…'); return register('tap'); }
      if (perm === 'denied') show(null, 'Notifications are blocked for this site. Allow them in your browser’s site settings, then reopen this page.');
      else show('🔔 Turn on notifications', '');
    });
  }

  window.HoldenPush = {
    /* call on every listen-only hello; does real work once per page load (and again after a failure) */
    ready: function () {
      if (!ui()) return;
      if (!supported()) {
        if (isIOS() && !standalone()) show(null, 'To get notifications on iPhone: tap Share ↑ then Add to Home Screen, and open HOLDEN DMR from your Home Screen.');
        else show(null, '');
        return;
      }
      var perm = Notification.permission;
      if (perm === 'denied') { show(null, 'Notifications are blocked for this site. Allow them in your browser’s site settings, then reopen this page.'); return; }
      if (perm !== 'granted') { show('🔔 Turn on notifications', 'Get a ping when someone is on the radio.'); loadSdk().catch(function () {}); return; }
      if (started) return;
      started = true;
      register('launch').then(function (ok) { if (!ok) started = false; });   // silent re-register; retried next hello if it failed
    },
    _register: register
  };
})();
