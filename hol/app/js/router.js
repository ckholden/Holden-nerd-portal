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

  function HolRouter(wsClient, meProvider) {
    this.ws = wsClient;
    this.meProvider = meProvider;
    this.imPopups = new Map();   // lowerScreenName -> WindowProxy
    this.roomPopups = new Map(); // roomId -> { win, inited, pending: [] }
    this.roomLeaving = new Set(); // roomId currently tearing down — suppress double room-leave

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
    this._post(win, { t: 'hol:im-history', screenName: frame.screenName, messages: frame.messages || [] });
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
        if (win.__holPresend) { this._post(win, { t: 'hol:im-presend', text: win.__holPresend }); win.__holPresend = null; }
        this.ws.send({ t: 'im-history-get', screenName: m.withUser });
        return;
      }
      case 'hol:send-im': {
        this.ws.send({ t: 'im', to: m.to, text: m.text });
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
        // A frame the room popup wants put on the socket (room-msg, room-leave-is-handled-
        // by-close-not-this, chat frames). Forward verbatim, same as main.js's room-send relay.
        this.ws.send(m.frame);
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
      if (win.closed) self.imPopups.delete(key);
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

  global.HolRouter = HolRouter;
})(window);
