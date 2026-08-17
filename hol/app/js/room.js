/*
 * Holden On Line — browser client: chat room popup controller (Holden/All in v1).
 * No socket of its own — relays through window.opener (js/router.js). Sends its OWN
 * room-join once on init (CONTRACT-ipc.md §9 — "one join per window keeps the occupant
 * count honest"); sends no room-leave — closing the window IS how you leave (router.js's
 * closed-window sweep does that, mirroring main.js's guaranteed on('closed') handler).
 *
 * ⚠ Unlike IM, the server DOES echo your own room-msg back to you (marked mine:true) —
 * do not locally echo on send, or your own lines would double.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var roomTitle = $('roomTitle'), roomLog = $('roomLog'), roomCompose = $('roomCompose'),
      roomSend = $('roomSend'), roomStatus = $('roomStatus'), roomOccList = $('roomOccList'),
      roomOccHdr = $('roomOccHdr'), roomMax = $('roomMax'), roomClose = $('roomClose');

  var params = new URLSearchParams(location.search);
  var roomId = params.get('room') || '';
  var initialTitle = params.get('title') || roomId;
  var me = null;
  var occupants = []; // screen names currently in the room
  var everEntered = false;

  roomTitle.textContent = initialTitle;
  roomStatus.textContent = 'Connecting…';

  if (window.opener) {
    window.opener.postMessage({ t: 'hol:room-ready', room: roomId, title: initialTitle }, location.origin);
  } else {
    roomStatus.textContent = 'This window was not opened by Holden On Line.';
  }

  window.addEventListener('message', function (ev) {
    if (ev.origin !== location.origin || ev.source !== window.opener) return;
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hol:room-init') {
      me = m.me;
      roomTitle.textContent = m.title || initialTitle;
      roomStatus.textContent = 'Ready.';
      return;
    }
    if (m.t === 'hol:room-frame') { handleFrame(m.frame); return; }
  });

  function handleFrame(frame) {
    if (!frame || !frame.t) return;
    switch (frame.t) {
      case 'room-state':
        occupants = (frame.occupants || []).slice();
        paintOccupants();
        (frame.history || []).forEach(function (h) { appendLine(h.from, h.text, h.ts, false); });
        if (frame.history && frame.history.length) {
          var divider = document.createElement('div');
          divider.className = 'histdivider';
          divider.textContent = '--- End of recent messages ---';
          roomLog.appendChild(divider);
        }
        if (!everEntered) {
          everEntered = true;
          appendSys('You have entered the room.');
        }
        return;
      case 'room-msg':
        appendLine(frame.from, frame.text, frame.ts, false);
        if (!frame.mine && !document.hasFocus() && window.HOLSound) HOLSound.play('message');
        return;
      case 'room-joined':
        if (occupants.indexOf(frame.sn) === -1) occupants.push(frame.sn);
        paintOccupants();
        appendSys(frame.sn + ' has entered the room.');
        return;
      case 'room-left':
        occupants = occupants.filter(function (s) { return s !== frame.sn; });
        paintOccupants();
        appendSys(frame.sn + ' has left the room.');
        return;
      case 'room-error':
        appendSys(frame.error || 'Room error.');
        return;
      default:
        return;
    }
  }

  function paintOccupants() {
    roomOccHdr.textContent = 'In this room (' + occupants.length + ')';
    roomOccList.textContent = '';
    occupants.slice().sort(function (a, b) {
      return String(a).toLowerCase() < String(b).toLowerCase() ? -1 : 1;
    }).forEach(function (sn) {
      var row = document.createElement('div');
      row.className = 'occ';
      row.textContent = sn;
      roomOccList.appendChild(row);
    });
  }

  function appendLine(from, text, ts, isSys) {
    var line = document.createElement('div');
    if (isSys) {
      line.className = 'sys';
      line.textContent = text;
    } else {
      var mine = me && from && from.toLowerCase() === me.screenName.toLowerCase();
      var nameSpan = document.createElement('span');
      nameSpan.className = mine ? 'me' : 'them';
      nameSpan.textContent = (from || '') + ': ';
      var stampSpan = document.createElement('span');
      stampSpan.className = 'stamp';
      stampSpan.textContent = ' ' + (window.HOLClock ? HOLClock.stamp(ts) : '');
      line.appendChild(nameSpan);
      var body = HOLShared.messageToElement({ html: text });
      body.style.display = 'inline';
      line.appendChild(body);
      line.appendChild(stampSpan);
    }
    roomLog.appendChild(line);
    roomLog.scrollTop = roomLog.scrollHeight;
  }

  function appendSys(text) { appendLine(null, text, null, true); }

  function doSend() {
    var raw = roomCompose.value;
    if (!raw || !raw.trim()) return;
    var escaped = HOLShared.escapeText(raw);
    if (window.opener) {
      window.opener.postMessage({ t: 'hol:room-send', frame: { t: 'room-msg', room: roomId, text: escaped } }, location.origin);
    }
    roomCompose.value = ''; // no local echo — the server echoes our own room-msg (mine:true)
  }

  roomSend.addEventListener('click', doSend);
  roomCompose.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
  });

  roomMax.addEventListener('click', function () {
    try { window.resizeTo(screen.availWidth, screen.availHeight); } catch (e) {}
  });
  roomClose.addEventListener('click', function () { window.close(); });
})();
