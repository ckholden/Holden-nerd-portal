/*
 * Holden On Line — sound playback
 * ================================
 *   <script src="sounds.js"></script>
 *
 *   playSound('message');          // the ding
 *   playSound('door-open');        // sign on
 *   playSound('door-close');       // sign off
 *   playSound('modem');            // dial-up — no-op unless the user opted in
 *
 *   HOLSound.playConnect();        // dial-up — ONCE PER APP SESSION. Use this
 *                                 // on the sign-on path, never play('modem').
 *   HOLSound.resetConnection();   // "we hung up" — the next connect re-dials
 *   HOLSound.isConnected()
 *
 *   HOLSound.isMuted() / setMuted(b) / toggleMute()        global mute
 *   HOLSound.isModemEnabled() / setModemEnabled(b)         separate modem opt-in
 *   HOLSound.bindCheckbox(inputEl, 'modem' | 'mute')       wire a checkbox to it
 *   HOLSound.stop('modem') / HOLSound.stopAll()
 *   HOLSound.onChange(fn)                                  settings changed
 *
 * Both settings persist to localStorage and stay in sync across every HOL
 * window (buddy list, each IM window, sign-on) via the `storage` event.
 *
 * ⚠ AS OF 2026-08-10, five of these are the REAL AOL/AIM sound effects — Christian
 * pulled them from archive.org (item im_20191103) after hearing the synthesised
 * candidates and deciding he wanted the originals instead. He was told plainly that
 * shipping them is redistribution (the installer is public) and chose to proceed
 * anyway. Do not "clean up" or resample them — 11kHz mono IS the sound people
 * remember, and touching that is undoing the entire point of using the real files.
 *   buddy-in.wav / buddy-out.wav / welcome.wav / goodbye.wav / im.wav  -- REAL AIM
 *   door-open.wav / door-close.wav / message.wav                      -- unused now,
 *     left on disk rather than deleted; nothing in this file references them.
 *   modem.wav                                                          -- still ours.
 *
 * There is deliberately NO outgoing-message sound. AIM never had one, and Christian
 * confirmed he wants it to stay that way — the message landing in your own transcript
 * is the confirmation.
 *
 * No IPC. This module deliberately touches nothing in main.js.
 */

(function (global) {
  'use strict';

  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------
  //   vol       per-sound trim so one doesn't dwarf another at the same setting
  //   optIn     'modem' => also gated behind the modem toggle
  //   solo      stop any already-playing copy before starting a new one
  var SOUNDS = {
    'buddy-in':   { file: 'buddy-in.wav',   vol: 0.85, solo: false },
    'buddy-out':  { file: 'buddy-out.wav',  vol: 0.85, solo: false },
    'welcome':    { file: 'welcome.wav',    vol: 0.90, solo: false },
    'goodbye':    { file: 'goodbye.wav',    vol: 0.85, solo: false },
    'message':    { file: 'im.wav',         vol: 1.00, solo: true },
    'modem':      { file: 'modem.wav',      vol: 0.70, solo: true, optIn: 'modem' }
  };

  // Friendly aliases so call sites can be sloppy without breaking.
  var ALIASES = {
    'buddy-signon': 'buddy-in',  buddyIn: 'buddy-in',
    'buddy-signoff': 'buddy-out', buddyOut: 'buddy-out',
    signon: 'welcome',  'sign-on': 'welcome',
    signoff: 'goodbye', 'sign-off': 'goodbye',
    // ⚠ kept pointing at 'welcome'/'goodbye', NOT removed — buddylist.html's own
    // Snd.doorOpen()/doorClose() wrappers still exist for anything that has not been
    // moved to the more specific Snd.buddyIn()/buddyOut()/welcome()/goodbye() calls.
    doorOpen: 'welcome', doorClose: 'goodbye',
    'door-open': 'welcome', 'door-close': 'goodbye',   // literal kebab-case, in case
                                                        // anything still calls playSound
                                                        // with the old key directly
    ding: 'message', im: 'message', imrcv: 'message',
    dialup: 'modem', 'dial-up': 'modem', handshake: 'modem'
  };

  var KEY_MUTE  = 'hol.sound.muted';
  var KEY_MODEM = 'hol.sound.modem';

  // -------------------------------------------------------------------------
  // Where the .wav files live. Derived from this script's own URL so it works
  // from renderer/*.html, from a packaged asar, and from any nesting depth.
  // -------------------------------------------------------------------------
  var BASE = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (!s) {
        // currentScript is null inside a module/deferred edge case — fall back
        // to the last <script> tag whose src mentions this file.
        var tags = document.getElementsByTagName('script');
        for (var i = tags.length - 1; i >= 0; i--) {
          if (tags[i].src && /sounds\.js(\?|$)/.test(tags[i].src)) { s = tags[i].src; break; }
        }
      }
      if (s) return new URL('../sounds/', s).href;
    } catch (e) { /* fall through */ }
    return '../sounds/';
  })();

  // -------------------------------------------------------------------------
  // Settings, persisted. localStorage can throw (disabled storage, opaque
  // origin), so every access is guarded — a storage failure must never stop a
  // sound from playing or take a window down.
  // -------------------------------------------------------------------------
  function readFlag(key, dflt) {
    try {
      var v = global.localStorage.getItem(key);
      if (v === null) return dflt;
      return v === '1' || v === 'true';
    } catch (e) { return dflt; }
  }

  function writeFlag(key, val) {
    try { global.localStorage.setItem(key, val ? '1' : '0'); } catch (e) { /* non-fatal */ }
  }

  var muted = readFlag(KEY_MUTE, false);        // sound ON by default
  var modemOn = readFlag(KEY_MODEM, false);     // *** MODEM OFF BY DEFAULT ***

  var listeners = [];
  function notify() {
    var state = { muted: muted, modem: modemOn };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { console.error('HOLSound listener threw', e); }
    }
  }

  // Keep every open HOL window agreeing about the settings.
  global.addEventListener('storage', function (e) {
    if (!e) return;
    if (e.key === KEY_MUTE)  { muted = readFlag(KEY_MUTE, muted); if (muted) stopAll(); notify(); }
    if (e.key === KEY_MODEM) { modemOn = readFlag(KEY_MODEM, modemOn); if (!modemOn) stop('modem'); notify(); }
  });

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------
  var primed = {};      // name -> a preloaded Audio we clone from
  var live = {};        // name -> [Audio, ...] currently playing

  function resolve(name) {
    if (SOUNDS[name]) return name;
    if (ALIASES[name]) return ALIASES[name];
    return null;
  }

  function element(name) {
    if (!primed[name]) {
      var a = new Audio(BASE + SOUNDS[name].file);
      a.preload = 'auto';
      primed[name] = a;
    }
    return primed[name];
  }

  /** Fetch the files into cache so the first ding isn't late. */
  function preload() {
    for (var name in SOUNDS) {
      if (!Object.prototype.hasOwnProperty.call(SOUNDS, name)) continue;
      try { element(name).load(); } catch (e) { /* non-fatal */ }
    }
  }

  function track(name, a) {
    (live[name] || (live[name] = [])).push(a);
    var drop = function () {
      var arr = live[name] || [];
      var i = arr.indexOf(a);
      if (i >= 0) arr.splice(i, 1);
    };
    a.addEventListener('ended', drop);
    a.addEventListener('error', drop);
  }

  function stop(name) {
    var key = resolve(name);
    if (!key) return;
    var arr = live[key] || [];
    for (var i = 0; i < arr.length; i++) {
      try { arr[i].pause(); arr[i].currentTime = 0; } catch (e) { /* ignore */ }
    }
    live[key] = [];
  }

  function stopAll() {
    for (var k in live) if (Object.prototype.hasOwnProperty.call(live, k)) stop(k);
  }

  /**
   * Play a sound.
   * Returns a Promise<boolean> — true if it actually started, false if it was
   * suppressed (muted, modem opted out, unknown name) or the browser refused.
   * It never rejects: a sound failing is never worth breaking a caller over.
   */
  function playSound(name, opts) {
    opts = opts || {};
    var key = resolve(name);
    if (!key) {
      console.warn('HOLSound: unknown sound "' + name + '"');
      return Promise.resolve(false);
    }
    var def = SOUNDS[key];

    if (muted && !opts.force) return Promise.resolve(false);
    if (def.optIn === 'modem' && !modemOn && !opts.force) return Promise.resolve(false);

    if (def.solo) stop(key);

    var a;
    try {
      a = element(key).cloneNode(true);   // clone so overlapping dings both play
    } catch (e) {
      console.warn('HOLSound: could not create audio for ' + key, e);
      return Promise.resolve(false);
    }
    a.volume = Math.max(0, Math.min(1, (opts.volume != null ? opts.volume : def.vol)));
    track(key, a);

    var p;
    try { p = a.play(); } catch (e) { return Promise.resolve(false); }
    if (!p || typeof p.then !== 'function') return Promise.resolve(true);
    return p.then(function () { return true; }, function (err) {
      // Almost always an autoplay-policy rejection before the first click.
      console.warn('HOLSound: "' + key + '" did not play —', err && err.message);
      return false;
    });
  }

  // -------------------------------------------------------------------------
  // The connect sequence — ONCE PER APP SESSION
  // -------------------------------------------------------------------------
  /*
   * ⚠ BUG THIS FIXES (2026-08-10, hit live): the handshake replayed on every
   * failed sign-on, so a mistyped password cost a full connect sequence before
   * you could retry. The complaint reads as "the sound is excessive", but the
   * sound was not too LONG, it was too FREQUENT.
   *
   * The fix is also the historically correct behaviour: you dialled BEFORE you
   * authenticated. Once the modem was connected, retyping your password did NOT
   * re-dial — the line was already up.
   *
   *   first sign-on attempt  -> dial
   *   wrong password, retry  -> silent (still "connected")
   *   sign off / server unreachable -> resetConnection(), next attempt re-dials
   *
   * ⚠ Do NOT "fix" the frequency by playing this only on SUCCESS. That is wrong
   * in both directions — you would hear the modem after you were already in.
   *
   * Deliberately a plain module variable, NOT localStorage: "connected" is
   * per-run state, and a fresh app launch must always dial.
   *
   * SIGN-OFF resets it by construction, two ways over — no call needed:
   *   1. main.js:157 — closing the buddy list calls app.quit(). New process,
   *      new flag.
   *   2. even if sign-off ever stops quitting, main.js builds a NEW sign-on
   *      BrowserWindow (createSignOn), which is a new renderer, which loads a
   *      fresh copy of this module with connected = false.
   * ⚠ Consequence: this flag is PER WINDOW. Calling resetConnection() from the
   * buddy list would not clear the sign-on window's copy. The only caller that
   * matters is signon.html.
   */
  var connected = false;

  function isConnected() { return connected; }

  function resetConnection() {
    connected = false;
    stop('modem');            // if we're hanging up mid-dial, stop dialling
    return false;
  }

  /**
   * Play the connect sequence if this app session has not connected yet.
   * Returns a Promise<boolean> — true only if it actually started a sound.
   * Suppressed silently when already connected, muted, or the modem opt-in is
   * off. Never rejects; never blocks a caller. Do not await it on the sign-on
   * path — nobody should wait for a sound.
   */
  function playConnect(opts) {
    if (connected) return Promise.resolve(false);
    connected = true;         // set BEFORE playing: a double-click on Sign On
                              // must not race two handshakes onto the line.
    return playSound('modem', opts);
  }

  // -------------------------------------------------------------------------
  // Settings API
  // -------------------------------------------------------------------------
  function setMuted(v) {
    muted = !!v;
    writeFlag(KEY_MUTE, muted);
    if (muted) stopAll();
    notify();
    return muted;
  }

  function setModemEnabled(v) {
    modemOn = !!v;
    writeFlag(KEY_MODEM, modemOn);
    if (!modemOn) stop('modem');
    notify();
    return modemOn;
  }

  /**
   * Two-way bind a checkbox.
   *   which === 'modem' -> checked means "play the handshake"
   *   which === 'mute'  -> checked means "muted"
   *   which === 'sound' -> checked means "sounds ON" (inverse of mute)
   */
  function bindCheckbox(el, which) {
    if (!el) return;
    var get, set;
    if (which === 'mute')       { get = function () { return muted; };   set = setMuted; }
    else if (which === 'sound') { get = function () { return !muted; };  set = function (v) { setMuted(!v); }; }
    else                        { get = function () { return modemOn; }; set = setModemEnabled; }
    el.checked = get();
    el.addEventListener('change', function () { set(el.checked); });
    onChange(function () { el.checked = get(); });
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  // -------------------------------------------------------------------------
  var HOLSound = {
    play: playSound,
    stop: stop,
    stopAll: stopAll,
    preload: preload,
    isMuted: function () { return muted; },
    setMuted: setMuted,
    toggleMute: function () { return setMuted(!muted); },
    playConnect: playConnect,
    resetConnection: resetConnection,
    isConnected: isConnected,
    isModemEnabled: function () { return modemOn; },
    setModemEnabled: setModemEnabled,
    toggleModem: function () { return setModemEnabled(!modemOn); },
    bindCheckbox: bindCheckbox,
    onChange: onChange,
    names: Object.keys(SOUNDS),
    baseUrl: BASE
  };

  global.HOLSound = HOLSound;
  global.playSound = playSound;   // the shorthand call sites use

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', preload);
  } else {
    preload();
  }
})(window);
