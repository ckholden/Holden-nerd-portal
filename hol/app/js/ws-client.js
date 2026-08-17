/*
 * Holden On Line — browser client WebSocket owner
 *
 * Ported from holden-im/renderer/buddylist.html's connect()/scheduleRetry()/pong-watchdog
 * (~lines 1546-1671) and holden-im's CONTRACT-ipc.md §15b/§pong-watchdog. This is the ONLY
 * file that ever touches a real WebSocket — router.js relays everything else to popups via
 * postMessage. Instantiated once by buddylist.js after HTTP sign-on succeeds.
 *
 * Extra requirement beyond the desktop app (browser-specific, not present in Electron):
 * Chrome/Edge throttle backgrounded-tab timers to ~1/min after 5 min unfocused, which would
 * blow past the server's 25s pong-watchdog deadline. document.visibilitychange/'online'/
 * 'pageshow' force an immediate ping+resync on refocus — pattern ported from
 * Holden-nerd-portal/dmrptt/index.html (~lines 452-455), extended with the resync HOL needs
 * that dmrptt doesn't.
 */
(function (global) {
  'use strict';

  var PING_EVERY_MS = 25000;
  var PONG_GRACE_MS = 25000;

  function HolWsClient(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.connected = false;
    this.everConnected = false;
    this.retryMs = 1000;
    this.retryTimer = null;
    this.connDeadline = 0;
    this.pingTimer = null;
    this.pingSentAt = 0;
    this.pongSeen = false;
    this.token = null;
    this.screenName = null;
    this.listeners = {}; // eventName -> [fn]

    var self = this;
    // ⚠ 'pageshow' fires on a normal FIRST load too, not just bfcache restores — every
    // listener below must no-op until connect() has actually been called once (i.e. a
    // real sign-on has happened), or the sign-on view would open a socket on its own.
    global.addEventListener('online', function () { if (self.token) self._tryNow(); });
    global.addEventListener('pageshow', function () {
      if (!self.token) return;
      self._tryNow(); self._refocusResync();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !self.token) return;
      self._tryNow(); self._refocusResync();
    });
  }

  HolWsClient.prototype.on = function (evt, fn) {
    (this.listeners[evt] || (this.listeners[evt] = [])).push(fn);
    return this;
  };

  HolWsClient.prototype._emit = function (evt, data) {
    var fns = this.listeners[evt];
    if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](data); } catch (e) { console.error('HolWsClient listener threw for', evt, e); }
    }
  };

  /** Begin (or resume) a session. token comes from POST /api/signon. */
  HolWsClient.prototype.connect = function (token, screenName) {
    this.token = token;
    this.screenName = screenName;
    this._connect();
  };

  HolWsClient.prototype._connect = function () {
    var self = this;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    this.connDeadline = 0;
    this._emit('conn-state', this.everConnected ? 'reconnecting' : 'connecting');

    var ws;
    try { ws = new WebSocket(this.wsUrl); }
    catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;

    ws.onopen = function () {
      self.connected = true; self.everConnected = true; self.retryMs = 1000;
      self._emit('conn-state', 'signing-on');
      self._resetPong();
      self.send({
        t: 'signon',
        token: self.token,
        screenName: self.screenName,
        clientVersion: (global.HOL_CONFIG && global.HOL_CONFIG.CLIENT_VERSION) || '0.1.0-web'
      });
      self._armPingTimer();
    };

    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'pong') { self.pongSeen = true; self.pingSentAt = 0; return; }
      if (m.t === 'signon-ok') { self.token = m.token || self.token; }
      self._emit('frame', m);
      self._emit('frame:' + m.t, m);
    };

    ws.onclose = function () {
      self.connected = false;
      self._clearPingTimer();
      self._emit('conn-state', 'offline');
      self._scheduleRetry();
    };

    ws.onerror = function () { /* onclose always follows */ };
  };

  HolWsClient.prototype._scheduleRetry = function () {
    var self = this;
    if (this.retryTimer) return;
    var wait = this.retryMs + Math.floor(Math.random() * Math.min(this.retryMs, 2000));
    this.connDeadline = Date.now() + wait;
    this._emit('conn-state', 'reconnecting');
    this.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self.connDeadline = 0;
      self.retryMs = Math.min(self.retryMs * 2, 30000);
      self._connect();
    }, wait);
  };

  HolWsClient.prototype._tryNow = function () {
    if (this.connected && this.ws && this.ws.readyState === 1) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retryMs = 1000;
    this.connDeadline = 0;
    this._connect();
  };

  /** Even when nominally still open, force an immediate ping + roster resync on refocus
   *  so a tab that sat backgrounded (and was throttled) repaints correctly right away
   *  rather than waiting for the next 25s tick — HOL's own requirement, beyond dmrptt's
   *  reconnect-on-wake pattern. */
  HolWsClient.prototype._refocusResync = function () {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
    this.send({ t: 'ping' });
    this.pingSentAt = this.pingSentAt || Date.now();
    this.send({ t: 'roster-get' });
  };

  HolWsClient.prototype._resetPong = function () { this.pingSentAt = 0; this.pongSeen = false; };

  HolWsClient.prototype._armPingTimer = function () {
    var self = this;
    this._clearPingTimer();
    this.pingTimer = setInterval(function () { self._pingTick(); }, PING_EVERY_MS);
  };

  HolWsClient.prototype._clearPingTimer = function () {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  };

  HolWsClient.prototype._pingTick = function () {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
    if (this.pongSeen && this.pingSentAt && (Date.now() - this.pingSentAt) > PONG_GRACE_MS) {
      try { this.ws.close(); } catch (e) {} // onclose does the rest, including retry
      return;
    }
    if (this.send({ t: 'ping' })) this.pingSentAt = this.pingSentAt || Date.now();
  };

  HolWsClient.prototype.send = function (obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  };

  /** A real sign-off: tell the server, then close deliberately (no retry should follow). */
  HolWsClient.prototype.signOff = function () {
    this.send({ t: 'signoff' });
    this._clearPingTimer();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { if (this.ws) { this.ws.onclose = null; this.ws.close(); } } catch (e) {}
    this.connected = false;
    this.everConnected = false;
  };

  global.HolWsClient = HolWsClient;
})(window);
