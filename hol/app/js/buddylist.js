/*
 * Holden On Line — browser client: sign-on + buddy list controller (the shell page).
 * Owns the one real WebSocket (via HolWsClient) and the HolRouter that relays frames to
 * popup windows. Ported behavior from holden-im/renderer/buddylist.html; no custom
 * credential store (Tier 1 decision — rely on the browser's own password manager).
 */
(function () {
  'use strict';

  var CFG = window.HOL_CONFIG;
  var $ = function (id) { return document.getElementById(id); };

  var signonView = $('signonView'), buddyView = $('buddyView');
  var signonForm = $('signonForm'), fScreenName = $('fScreenName'), fPassword = $('fPassword');
  var signonErr = $('signonErr'), signonStatus = $('signonStatus'), btnSignOn = $('btnSignOn');
  var blMe = $('blMe'), blList = $('blList'), blStatus = $('blStatus');
  var blRoomEntry = $('blRoomEntry'), blSignOff = $('blSignOff'), blTitle = $('blTitle');

  var me = null;              // { screenName }
  var e2e = null;             // 0.2.0 — hol-e2e-session.js session, or null (plaintext)
  var myDevice = null;        // 0.2.0 — this browser's PUBLIC device key {d,k}
  var roster = [];            // last roster from the server
  var rooms = {};             // roomId -> { title, count }
  var HOLDEN_ALL_ID = 'holden/all';
  var everSignedOn = false;

  // Prefill after a successful newuser.html registration (?sn=ScreenName) so nobody has
  // to retype the name they just picked. Never prefills the password — that never
  // crosses a URL.
  (function prefillFromRegistration() {
    var sn = new URLSearchParams(location.search).get('sn');
    if (sn) fScreenName.value = sn;
  })();

  var ws = new HolWsClient(CFG.SERVER_WS_URL);
  var router = new HolRouter(ws, function () { return { screenName: me && me.screenName }; });

  // ---------------------------------------------------------------- sign-on
  signonForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var screenName = fScreenName.value.trim();
    var password = fPassword.value;
    if (!screenName || !password) return;
    signonErr.textContent = '';
    btnSignOn.disabled = true;
    signonStatus.textContent = 'Signing on…';

    fetch(CFG.SERVER_HTTP_BASE + '/api/signon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenName: screenName, password: password, clientVersion: CFG.CLIENT_VERSION })
    }).then(function (r) { return r.json(); }).then(function (res) {
      btnSignOn.disabled = false;
      if (!res || !res.ok) {
        signonStatus.textContent = 'Not connected.';
        signonErr.textContent = (res && res.error) || 'Could not sign on.';
        return;
      }
      me = { screenName: res.screenName };
      fPassword.value = '';
      /* 0.2.0 — the saved keys must be in memory BEFORE the socket connects, or queued
       * encrypted messages delivered right after signon-ok would find no key. HolE2EWeb
       * never rejects; null = plaintext, labeled. The identity is what the SERVER said. */
      var e2eReady = (window.HolE2EWeb && window.HolE2EWeb.ready) || Promise.resolve(null);
      e2eReady.then(function (session) {
        // Re-read the saved keys first: another tab of this browser may have changed them
        // since this page loaded (review F9).
        return (session && window.HolE2EWeb.reload) ? window.HolE2EWeb.reload().then(function () { return session; }) : session;
      }).then(function (session) {
        e2e = session;
        if (e2e) e2e.setIdentity(res.screenName);
        if (typeof router.setE2E === 'function') router.setE2E(e2e);
      }).catch(function (err) {
        console.warn('[hol-e2e] setup failed; continuing without encryption', err);
        e2e = null;
      }).then(function () {
        // ⚠ ALWAYS connect (review F10): a failure above means plaintext, never a page
        // stuck on "Signing on…".
        ws.connect(res.token, res.screenName);
      });
    }).catch(function () {
      btnSignOn.disabled = false;
      signonStatus.textContent = 'Not connected.';
      signonErr.textContent = 'Could not reach the Holden On Line server.';
    });
  });

  // ---------------------------------------------------------------- ws events
  ws.on('conn-state', function (state) {
    if (state === 'connecting') blStatus.textContent = 'Connecting…';
    else if (state === 'reconnecting') blStatus.textContent = 'Reconnecting…';
    else if (state === 'signing-on') blStatus.textContent = 'Signing on…';
    else if (state === 'offline') blStatus.textContent = 'Disconnected. Reconnecting…';
  });

  ws.on('frame:signon-ok', function (frame) {
    HOLClock.setFromServer(frame.serverTime);
    signonView.style.display = 'none';
    buddyView.style.display = '';
    blTitle.textContent = frame.screenName;
    blMe.textContent = 'Signed on as ' + frame.screenName;
    blStatus.textContent = 'Online.';

    rooms = {};
    (frame.rooms || []).forEach(function (r) { rooms[r.room] = { title: r.title, count: r.count }; });
    if (!rooms[HOLDEN_ALL_ID]) rooms[HOLDEN_ALL_ID] = { title: 'Holden/All', count: 0 };
    paintRoomEntry();

    if (!everSignedOn) { HOLSound.play('welcome'); everSignedOn = true; }
    // 0.2.0 — this account's devices FIRST, then the roster (everyone else's keys), then
    // publish this browser's PUBLIC key. Every sign-on, reconnects included: an unchanged
    // key is only a last-seen touch on the server.
    if (e2e) e2e.setMyKeys(Array.isArray(frame.myKeys) ? frame.myKeys : []);
    applyRoster(frame.roster || frame.buddies || []);
    if (e2e) {
      var dev = e2e.deviceFor(frame.screenName || (me && me.screenName));
      myDevice = (dev && dev.d && dev.k) ? dev : null;
      if (myDevice) ws.send({ t: 'key-publish', d: dev.d, k: dev.k });
      router.pushE2eStatusAll();
    }
  });

  // 0.2.0 — this account's device list changed (added / evicted / replaced).
  ws.on('frame:my-keys', function (frame) {
    var keys = Array.isArray(frame.keys) ? frame.keys : [];
    if (e2e && e2e.setMyKeys(keys)) router.pushE2eStatusAll();
    // No longer listed (evicted/pruned)? Publish again, or every send is refused (review F1).
    if (myDevice && !keys.some(function (k) { return k && k.d === myDevice.d; })) {
      ws.send({ t: 'key-publish', d: myDevice.d, k: myDevice.k });
    }
  });

  // A refused or queued IM belongs IN its conversation, not only in this status bar
  // (review F1 / P-c — this page never handled im-error at all before 0.2.0).
  ws.on('frame:im-error', function (frame) {
    blStatus.textContent = frame.error || 'Message could not be delivered.';
    router.imError(frame);
  });
  ws.on('frame:error', function (frame) {
    if (frame && frame.error) blStatus.textContent = 'Server: ' + frame.error;
  });
  router.onUnshown = function (from) {
    blStatus.textContent = 'New message from ' + from + ' — double-click their name to read it.';
    if (window.HOLSound) HOLSound.play('message');
  };

  ws.on('frame:signon-err', function (frame) {
    // A stale-but-still-open tab whose 12h token finally expired: no saved-password
    // retry in the browser client (Tier 1 decision) — just surface it plainly.
    buddyView.style.display = 'none';
    signonView.style.display = '';
    signonStatus.textContent = 'Not connected.';
    signonErr.textContent = frame.error || 'Sign-on failed. Please sign on again.';
  });

  ws.on('frame:roster', function (frame) { applyRoster(frame.buddies || []); });
  ws.on('frame:presence', function (frame) {
    var idx = roster.findIndex(function (b) { return sameKey(b.screenName, frame.screenName); });
    var row = {
      screenName: frame.screenName, online: frame.online, status: frame.status,
      awayMessage: frame.awayMessage, idleMinutes: frame.idleMinutes,
      avatarPath: idx >= 0 ? roster[idx].avatarPath : null,
      group: idx >= 0 ? roster[idx].group : 'Buddies',
      // 0.2.0 — a presence frame carries no keys; keep the ones we had.
      keys: idx >= 0 ? roster[idx].keys : undefined,
      bot: idx >= 0 ? roster[idx].bot : undefined
    };
    if (idx >= 0) roster[idx] = row; else roster.push(row);
    paintRoster();
  });
  ws.on('frame:room-counts', function (frame) {
    Object.keys(frame.counts || {}).forEach(function (id) {
      if (!rooms[id]) rooms[id] = { title: id, count: 0 };
      rooms[id].count = frame.counts[id];
    });
    paintRoomEntry();
  });

  // Everything popup-shaped (im, room-*, im-history) goes to the router.
  ['frame:im', 'frame:room-state', 'frame:room-msg', 'frame:room-joined',
   'frame:room-left', 'frame:room-error', 'frame:im-history'].forEach(function (evt) {
    ws.on(evt, function (frame) { router.routeServerFrame(frame); });
  });

  // ---------------------------------------------------------------- roster render
  function sameKey(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

  var prevOnline = {}; // screenName(lower) -> bool, for buddy-in/buddy-out sounds

  function applyRoster(buddies) {
    roster = buddies;
    paintRoster();
    // 0.2.0 — roster rows carry each buddy's PUBLIC keys and `bot`; re-label any open
    // conversation whose encryption state just changed.
    if (e2e && e2e.setRoster(buddies)) router.pushE2eStatusAll();
  }

  function paintRoster() {
    var nowOnline = {};
    roster.forEach(function (b) { nowOnline[String(b.screenName).toLowerCase()] = !!b.online; });
    if (everSignedOn) {
      Object.keys(nowOnline).forEach(function (k) {
        var was = prevOnline[k];
        if (was === undefined) return; // first paint after sign-on — no arrival sound
        if (!was && nowOnline[k]) HOLSound.play('buddy-in');
        if (was && !nowOnline[k]) HOLSound.play('buddy-out');
      });
    }
    prevOnline = nowOnline;

    var groups = {};
    roster.forEach(function (b) {
      var g = b.group || 'Buddies';
      (groups[g] || (groups[g] = [])).push(b);
    });

    blList.textContent = '';
    Object.keys(groups).sort().forEach(function (g) {
      var head = document.createElement('div');
      head.className = 'group';
      var onlineCount = groups[g].filter(function (b) { return b.online; }).length;
      head.textContent = g + ' (' + onlineCount + '/' + groups[g].length + ')';
      blList.appendChild(head);

      groups[g]
        .slice()
        .sort(function (a, b) {
          if (!!a.online !== !!b.online) return a.online ? -1 : 1;
          return String(a.screenName).toLowerCase() < String(b.screenName).toLowerCase() ? -1 : 1;
        })
        .forEach(function (b) {
          var row = document.createElement('div');
          row.className = 'buddy' + (b.online ? '' : ' offline') +
            (b.status === 'idle' ? ' idle' : '');
          var avatarUrl = HOLShared.resolveAvatarUrl(CFG.SERVER_WS_URL, b.avatarPath);
          row.appendChild(HOLShared.buddyIconEl(b.screenName, 16, avatarUrl));
          var label = document.createTextNode(' ' + b.screenName +
            (b.status === 'away' ? ' (Away)' : b.status === 'idle' ? ' (Idle)' : ''));
          row.appendChild(label);
          row.title = b.online ? (b.awayMessage || b.status || 'Online') : 'Offline';
          row.addEventListener('dblclick', function () {
            // ⚠ Must be synchronous, inside this real gesture — router.openIm() calls
            // window.open() as its first line, before any network activity.
            router.openIm(b.screenName);
          });
          blList.appendChild(row);
        });
    });
  }

  function paintRoomEntry() {
    var r = rooms[HOLDEN_ALL_ID] || { title: 'Holden/All', count: 0 };
    blRoomEntry.textContent = r.title + ' (' + r.count + ')';
  }

  blRoomEntry.addEventListener('click', function () {
    var r = rooms[HOLDEN_ALL_ID] || { title: 'Holden/All' };
    router.openRoom(HOLDEN_ALL_ID, r.title, true);
  });

  // ---------------------------------------------------------------- sign off
  blSignOff.addEventListener('click', function () {
    router.suppressRoomLeaves();
    HOLSound.play('goodbye');
    ws.signOff();
    router.closeAllPopups();       // review P-d: no window outlives the account it belongs to
    if (e2e) e2e.reset();          // 0.2.0 — the secret key leaves memory with the session
    myDevice = null;
    everSignedOn = false;
    prevOnline = {};
    buddyView.style.display = 'none';
    signonView.style.display = '';
    signonStatus.textContent = 'Not connected.';
    signonErr.textContent = '';
  });

  window.addEventListener('beforeunload', function () {
    // Best-effort — the closed-tab case (no beforeunload at all, e.g. OS kill) is why
    // the server tears down membership on socket drop regardless (SPEC-chat-rooms §4).
    if (ws.connected) ws.send({ t: 'signoff' });
  });
})();
