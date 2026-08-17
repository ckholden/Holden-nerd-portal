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
  var roster = [];            // last roster from the server
  var rooms = {};             // roomId -> { title, count }
  var HOLDEN_ALL_ID = 'holden/all';
  var everSignedOn = false;

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
      ws.connect(res.token, res.screenName);
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
    applyRoster(frame.roster || frame.buddies || []);
  });

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
      group: idx >= 0 ? roster[idx].group : 'Buddies'
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
