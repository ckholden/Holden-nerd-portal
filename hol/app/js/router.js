/*
 * Holden On Line — browser client router
 *
 * Replaces main.js's IPC-postman role (openIm/openRoom, room-init/room-frame ordering,
 * imWins/roomWins closed-cleanup — see holden-im/main.js ~1141-1414 and CONTRACT-ipc.md §9).
 * Only the shell page (buddylist.js) constructs this; it owns the one real WebSocket via
 * ws-client.js. Popups (im.html/room.html) never touch the socket — everything crosses via
 * postMessage, targeted at location.origin, validated on receipt.
 *
 * Security boundary: the bearer token never leaves the shell page. Popups only ever receive
 * `me` (screen name), presence/roster snippets, and message frames.
 */
(function (global) {
  'use strict';

  var SWEEP_MS = 750;
  // Mirrors holden-im/main.js ROOM_FRAMES_OUT — what a room window may put on the socket.
  var ROOM_FRAMES_OUT = ['room-join', 'room-leave', 'room-msg', 'chat-invite'];

  function HolRouter(wsClient, meProvider) {
    this.ws = wsClient;
    this.meProvider = meProvider;
    this.imPopups = new Map();   // lowerScreenName -> WindowProxy
    this.imReady = new Map();    // lowerScreenName -> the WindowProxy that said hol:im-ready
    this.roomPopups = new Map(); // roomId -> { win, inited, pending: [] }
    this.roomLeaving = new Set(); // roomId currently tearing down — suppress double room-leave
    /* 0.2.0 — the E2E session (hol-e2e-session.js), or null = plaintext, labeled.
     * ⚠ It lives HERE, in the shell page. Popups get plaintext in and hand plaintext out;
     * they never see a key or an envelope (holden-im CONTRACT-ipc.md §27c). */
    this.e2e = null;

    var self = this;
    global.addEventListener('message', function (ev) { self._onMessage(ev); });
    setInterval(function () { self._sweep(); }, SWEEP_MS);
  }

  // -------------------------------------------------------------- server -> popups
  /** Call this from buddylist.js's ws.on('frame', ...) for every frame that might
   *  belong to a popup (im, room-state, room-msg, room-joined, room-left, room-error). */
  HolRouter.prototype.routeServerFrame = function (frame) {
    if (!frame || typeof frame !== 'object') return;
    switch (frame.t) {
      case 'im':
        this._routeIm(frame);
        return;
      case 'room-state':
      case 'room-msg':
      case 'room-joined':
      case 'room-left':
      case 'room-error':
        this._routeRoom(frame);
        return;
      case 'im-history':
        this._routeImHistory(frame);
        return;
      default:
        return;
    }
  };

  HolRouter.prototype._routeImHistory = function (frame) {
    var key = String(frame.screenName || '').toLowerCase();
    var win = this.imPopups.get(key);
    if (!win || win.closed) return; // the window that asked may have closed already
    // 0.2.0 — every encrypted entry is opened HERE; the popup only ever sees plaintext.
    var messages = frame.messages || [];
    if (this.e2e) {
      var r = this.e2e.history(frame);
      messages = (r.payload && r.payload.messages) || [];
      if (r.dirChanged) this.pushE2eStatus(frame.screenName);
    } else {
      messages = messages.map(e2eUnavailable);
    }
    this._post(win, { t: 'hol:im-history', screenName: frame.screenName, messages: messages });
  };

  // An encrypted entry this browser can't open because libsodium/IndexedDB never loaded.
  function e2eUnavailable(m) {
    if (!m || !m.e2e) return m;
    return { from: m.from, to: m.to, ts: m.ts, e2eFailed: true, sys: true,
      text: '(An encrypted message arrived, but encryption is not working in this browser.)' };
  }

  // -------------------------------------------------------------- end-to-end encryption
  HolRouter.prototype.setE2E = function (session) { this.e2e = session || null; };

  /** Tell one open IM popup whether its conversation is encrypted (+ one-shot notices).
   *  ⚠ Only to a popup that has said hol:im-ready: statusFor() drains the notices, and a
   *  post to a popup still loading is lost along with them. */
  HolRouter.prototype.pushE2eStatus = function (screenName) {
    var key = String(screenName || '').toLowerCase();
    var win = this.imReady.get(key);
    if (!win || win.closed) return;
    var status = this.e2e ? this.e2e.statusFor(screenName) : { withUser: screenName, state: 'no-local-key' };
    this._post(win, { t: 'hol:im-e2e-status', status: status });
  };
  HolRouter.prototype.pushE2eStatusAll = function () {
    var self = this;
    this.imReady.forEach(function (win, key) { self.pushE2eStatus(key); });
  };

  HolRouter.prototype._routeIm = function (frame) {
    var me = this.meProvider();
    // A frame FROM someone else, addressed TO us: the popup keyed by that someone.
    var peer = (String(frame.from || '').toLowerCase() === String(me.screenName || '').toLowerCase())
      ? String(frame.to || '').toLowerCase()
      : String(frame.from || '').toLowerCase();
    if (!peer) return;
    var win = this.imPopups.get(peer);
    if (!win || win.closed) {
      // Incoming message with no open window yet: open one, matching openIm()'s own
      // behavior of surfacing a window for an arriving message.
      if (String(frame.from || '').toLowerCase() !== String(me.screenName || '').toLowerCase()) {
        win = this.openIm(frame.from);
      } else {
        return;
      }
      /* ⚠ A popup opened from a socket event (no click) is usually BLOCKED by the browser
       * (review P-b): the message then went nowhere, silently. Say so on the buddy list; the
       * message is in the conversation's history when they double-click the name. */
      if (!win) {
        if (this.onUnshown) { try { this.onUnshown(frame.from); } catch (e) {} }
        // Still run an encrypted one through the session, so the directory stays current.
        if (frame.e2e && this.e2e && Array.isArray(frame.fromKeys)) this.e2e.observe(frame.from, frame.fromKeys);
        return;
      }
    }
    if (frame.e2e) {
      // 0.2.0 — decrypt BEFORE anything reaches the popup.
      var msg;
      if (this.e2e) {
        var r = this.e2e.incoming({ from: frame.from, me: me.screenName, e2e: frame.e2e,
          fromKeys: frame.fromKeys, ts: frame.ts, queued: !!frame.queued });
        if (!r.msg) return;              // a replay: already shown once
        if (r.dirChanged) this.pushE2eStatus(frame.from);
        msg = r.msg;
      } else {
        msg = e2eUnavailable(frame);
      }
      this._post(win, { t: 'hol:incoming-im', from: frame.from, to: frame.to, text: msg.text,
        ts: msg.ts || frame.ts, e2e: msg.e2e === true, sys: !!msg.sys, e2eFailed: !!msg.e2eFailed,
        e2eNote: msg.e2eNote || '' });
      return;
    }
    this._post(win, { t: 'hol:incoming-im', from: frame.from, to: frame.to, text: frame.text,
      ts: frame.ts, auto: !!frame.auto, away: !!frame.away });
  };

  HolRouter.prototype._routeRoom = function (frame) {
    var id = frame.room;
    if (!id) return;
    var entry = this.roomPopups.get(id);
    if (!entry) return; // no window open for this room, nothing to deliver to
    if (!entry.inited) { entry.pending.push(frame); return; }
    if (entry.win.closed) return;
    this._post(entry.win, { t: 'hol:room-frame', frame: frame });
  };

  // -------------------------------------------------------------- opening popups
  /** Double-click a buddy -> open (or focus) their IM window.
   *  ⚠ Must be called synchronously from within a real user-gesture handler (click),
   *  before any await — window.open() outside a gesture is blocked by popup blockers. */
  HolRouter.prototype.openIm = function (screenName, presend) {
    var key = String(screenName || '').toLowerCase();
    if (!key) return null;
    var existing = this.imPopups.get(key);
    if (existing && !existing.closed) {
      existing.focus();
      if (presend) this._post(existing, { t: 'hol:im-presend', text: presend });
      return existing;
    }
    var name = 'hol-im-' + key;
    var win = global.open('im.html?with=' + encodeURIComponent(screenName), name,
      'width=380,height=460,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    if (!win) return null; // popup blocked — caller should tell the user
    this.imPopups.set(key, win);
    if (presend) win.__holPresend = presend;
    return win;
  };

  /** Buddy list clicks Holden/All (or a future room entry) -> open (or focus) the room.
   *  `permanent` comes from the CALLER (buddylist.js already knows this from the room
   *  catalogue in signon-ok) — the popup itself has no way to know it before room-init. */
  HolRouter.prototype.openRoom = function (roomId, title, permanent) {
    var existing = this.roomPopups.get(roomId);
    if (existing && !existing.win.closed) {
      existing.win.focus();
      return existing.win; // ⚠ do NOT re-init — a second init would double the room-join
    }
    var win = global.open('room.html?room=' + encodeURIComponent(roomId) +
      '&title=' + encodeURIComponent(title || roomId), 'hol-room-' + roomId,
      'width=560,height=420,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    if (!win) return null;
    this.roomPopups.set(roomId, { win: win, inited: false, pending: [], permanent: !!permanent });
    return win;
  };

  // -------------------------------------------------------------- popups -> here
  HolRouter.prototype._onMessage = function (ev) {
    if (ev.origin !== location.origin) return;
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    var self = this;

    switch (m.t) {
      case 'hol:im-ready': {
        var key = String(m.withUser || '').toLowerCase();
        var win = this.imPopups.get(key);
        if (!win || win.closed || ev.source !== win) return;
        var me = this.meProvider();
        this._post(win, { t: 'hol:im-init', me: me, withUser: m.withUser });
        // 0.2.0 — "encrypted or not" before the first keystroke (and before history).
        this.imReady.set(key, win);
        this.pushE2eStatus(m.withUser);
        if (win.__holPresend) { this._post(win, { t: 'hol:im-presend', text: win.__holPresend }); win.__holPresend = null; }
        this.ws.send({ t: 'im-history-get', screenName: m.withUser });
        return;
      }
      case 'hol:send-im': {
        // ⚠ 0.2.0: only the popup FOR that conversation may send in it. holdenportal.com is
        // shared by every portal app; any same-origin page holding a reference to this tab
        // could otherwise post IMs as the signed-on user (and have them encrypted as us).
        var sendWin = this.imPopups.get(String(m.to || '').toLowerCase());
        if (!sendWin || ev.source !== sendWin || typeof m.text !== 'string') return;
        if (this.e2e) {
          // The sender's clock, server-corrected — the receiver shows it and flags a big gap.
          var sentTs = (global.HOLClock && global.HOLClock.now) ? global.HOLClock.now() : Date.now();
          var out = this.e2e.outgoing({ kind: 'im', to: m.to, text: m.text, ts: sentTs });
          if (out.error) {
            this._post(sendWin, { t: 'hol:incoming-im', from: m.to, text: out.error, ts: Date.now(), sys: true });
            return;
          }
          if (out.frame && out.frame.e2e) { this.ws.send({ t: 'im', to: m.to, e2e: out.frame.e2e }); return; }
        }
        this.ws.send({ t: 'im', to: m.to, text: m.text });
        return;
      }
      case 'hol:e2e-safety': {
        var safeWin = this.imPopups.get(String(m.withUser || '').toLowerCase());
        if (!safeWin || ev.source !== safeWin) return;
        var sn = this.e2e ? this.e2e.safety(m.withUser) : { state: 'no-local-key', number: null };
        this._post(safeWin, { t: 'hol:e2e-safety-result', withUser: m.withUser, state: sn.state, number: sn.number,
          mine: sn.mine || [], theirs: sn.theirs || [] });
        return;
      }
      case 'hol:room-ready': {
        var entry = this.roomPopups.get(m.room);
        if (!entry || entry.win.closed || ev.source !== entry.win) return;
        var me2 = this.meProvider();
        // ⚠ room-init MUST reach the popup before any room-frame — ported from main.js's
        // own solved ordering bug (main.js ~1305-1352). Init first, THEN flush the queue,
        // THEN send our own room-join — matches "the room window sends its own room-join,
        // not the buddy list" (CONTRACT-ipc.md §9).
        entry.inited = true;
        this._post(entry.win, { t: 'hol:room-init', room: m.room, title: m.title, permanent: entry.permanent, me: me2 });
        entry.pending.forEach(function (frame) { self._post(entry.win, { t: 'hol:room-frame', frame: frame }); });
        entry.pending = [];
        this.ws.send({ t: 'room-join', room: m.room });
        return;
      }
      case 'hol:room-send': {
        // A frame the room popup wants put on the socket. ⚠ 0.2.0 (security review L3):
        // ONLY from that room's own popup, and ONLY room frame types — the same whitelist
        // main.js keeps (ROOM_FRAMES_OUT). Forwarding anything verbatim let any same-origin
        // window put key-publish or a plaintext im on the socket as the signed-on user.
        var f = m.frame;
        var roomEntry = f && this.roomPopups.get(f.room);
        if (!roomEntry || ev.source !== roomEntry.win) return;
        if (ROOM_FRAMES_OUT.indexOf(String(f.t || '')) === -1) return;
        this.ws.send(f);
        return;
      }
      default:
        return;
    }
  };

  HolRouter.prototype._post = function (win, msg) {
    try { win.postMessage(msg, location.origin); } catch (e) {}
  };

  // -------------------------------------------------------------- cleanup
  /* The opener tab is the only thing that can play main.js's role here — a browser has no
   * always-alive process outside the page itself. Poll ref.closed; on the transition, tear
   * down bookkeeping and (for rooms) send room-leave so the occupant count never lies. */
  HolRouter.prototype._sweep = function () {
    var self = this;
    this.imPopups.forEach(function (win, key) {
      if (win.closed) { self.imPopups.delete(key); self.imReady.delete(key); }
    });
    this.roomPopups.forEach(function (entry, roomId) {
      if (entry.win.closed) {
        self.roomPopups.delete(roomId);
        if (!self.roomLeaving.has(roomId)) {
          self.ws.send({ t: 'room-leave', room: roomId });
        }
      }
    });
  };

  /** Called by buddylist.js during sign-off/teardown, so a deliberate sign-off doesn't
   *  race a burst of room-leave sends at a socket that's already going away. */
  HolRouter.prototype.suppressRoomLeaves = function () {
    var self = this;
    this.roomPopups.forEach(function (_, roomId) { self.roomLeaving.add(roomId); });
  };

  /** Sign-off closes every conversation window (review P-d). Left open, they would carry
   *  on sending as whoever signs on next in this tab — and, as of 0.2.0, be encrypted
   *  with THAT account's key. */
  HolRouter.prototype.closeAllPopups = function () {
    this.imPopups.forEach(function (win) { try { win.close(); } catch (e) {} });
    this.roomPopups.forEach(function (entry) { try { entry.win.close(); } catch (e) {} });
    this.imPopups.clear(); this.imReady.clear(); this.roomPopups.clear();
  };

  /** An im-error for a conversation: into that popup as a grey line, if it's open. */
  HolRouter.prototype.imError = function (frame) {
    var win = this.imPopups.get(String(frame.to || '').toLowerCase());
    if (!win || win.closed) return false;
    this._post(win, { t: 'hol:incoming-im', from: frame.to, text: frame.error || 'Your message could not be delivered.',
      ts: Date.now(), sys: true });
    return true;
  };

  global.HolRouter = HolRouter;
})(window);
