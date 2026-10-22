/* hose-player.js - receive-only BrandMeister Hoseline player for the HOLDEN DMR listen page.
 *
 * WHAT IT IS
 *   An in-browser client of BrandMeister's public Hoseline feed (the same socket and the same
 *   anonymous token that hose.brandmeister.network uses). It plays four BrandMeister talkgroups
 *   on the local speaker: 3141 Oregon, 31771 PNW Regional, 91 Worldwide, 93 North America.
 *   Our servers are not involved: no gw.py, no BrandMeister login, nothing relayed anywhere.
 *
 * RECEIVE-ONLY BY CONSTRUCTION
 *   - The spotter protocol has no audio-uplink message type at all.
 *   - Every byte this module sends goes through sendControl() -> buildControlFrame(), which
 *     refuses any frame type other than JOIN(1), LEAVE(2), RESET(3) and CALL_DROP(12), and any
 *     talkgroup outside TALKGROUPS. There is exactly one ws.send() call in this file.
 *   - It never calls getUserMedia and never touches navigator.mediaDevices.
 *
 * ETIQUETTE (BrandMeister is a third party; we use their public anonymous feed)
 *   - One socket per page, and one per browser: a BroadcastChannel hands playback to the newest tab.
 *   - The socket exists only while at least one talkgroup is on. Turning the last one off closes
 *     it after lingerMs (15 s), well inside the server's own 5-minute idle close.
 *   - Reconnect: 5 s, then doubling to 60 s, with jitter; gives up after 12 straight failures.
 *     It waits for the 'online' event instead of retrying while the browser is offline.
 *   - Page hidden for hiddenGraceMs (60 s), or pagehide: the socket closes and audio suspends.
 *     It reopens by itself when the page is visible again (the toggles are remembered).
 *
 * WIRE FORMAT (msgpack arrays; verified live 2026-10-21)
 *   client -> server  JOIN [1,[tg..]]  LEAVE [2,[tg..]]  RESET [3]  CALL_DROP [12]
 *   server -> client  CALL_START [11,0,src,tg,0]  CALL_AUDIO [20,bin960]  CALL_ALIAS [21,str]
 *                     CALL_METER [22,dBFS float32]  CALL_END [13]  SYSTEM_RESCUE [80]
 *   Audio is G.711 mu-law, 8 kHz, 960 samples (120 ms) per frame.
 *
 * Usage (see INTEGRATION.md):
 *   import { getHosePlayer, mountHoseSection } from './hose-player.js';
 *   mountHoseSection(document.getElementById('hose'));
 *   window.hosePlayer = getHosePlayer();   // the page ducks it with hosePlayer.duck(true/false)
 */

export const HOSE_URL = 'wss://hose.brandmeister.network/spotter/?token=test:test';
export const HOSE_PROTOCOL = 'spotter';
export const HOSE_CREDIT = 'Audio via BrandMeister Hoseline';

/* The ONLY talkgroups this module will ever subscribe to. */
export const TALKGROUPS = Object.freeze([
  Object.freeze({ tg: 3141, label: 'Oregon' }),
  Object.freeze({ tg: 31771, label: 'PNW Regional' }),
  Object.freeze({ tg: 91, label: 'Worldwide' }),
  Object.freeze({ tg: 93, label: 'North America' })
]);
const ALLOWED_TGS = new Set(TALKGROUPS.map(t => t.tg));

export function tgLabel(tg) {
  const t = TALKGROUPS.find(x => x.tg === tg);
  return t ? t.label : '';
}

export const T = Object.freeze({
  JOIN: 1, LEAVE: 2, RESET: 3,
  CALL_START: 11, CALL_DROP: 12, CALL_END: 13,
  CALL_AUDIO: 20, CALL_ALIAS: 21, CALL_METER: 22,
  SYSTEM_RESCUE: 80
});
/* Frame types the client may send. Nothing else, ever. */
const SENDABLE = new Set([T.JOIN, T.LEAVE, T.RESET, T.CALL_DROP]);

const MAX_FRAME_BYTES = 4096;      // a CALL_AUDIO frame is 965 bytes
const MAX_AUDIO_BYTES = 2048;
const MAX_ALIAS_CHARS = 40;

/* ---------- msgpack: just the shapes above ---------------------------------- */

/* Encodes non-negative integers (up to uint32) and arrays of them (up to 15 long, 2 deep). */
export function mpEncode(v) {
  const out = [];
  (function enc(x, depth) {
    if (depth > 2) throw new Error('mpEncode: too deep');
    if (Array.isArray(x)) {
      if (x.length > 15) throw new Error('mpEncode: array too long');
      out.push(0x90 | x.length);
      for (const y of x) enc(y, depth + 1);
      return;
    }
    if (Number.isInteger(x) && x >= 0 && x <= 0xffffffff) {
      if (x < 0x80) out.push(x);
      else if (x <= 0xff) out.push(0xcc, x);
      else if (x <= 0xffff) out.push(0xcd, x >> 8, x & 0xff);
      else out.push(0xce, (x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
      return;
    }
    throw new Error('mpEncode: unsupported value');
  })(v, 0);
  return Uint8Array.from(out);
}

const TD = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

/* Decodes one msgpack value that must fill the whole buffer. Throws on anything malformed,
 * truncated, too deep, too long or of a type the feed does not use (maps, ext). Strings come
 * back as JS strings, bin as a Uint8Array view (no copy). */
export function mpDecode(input) {
  const b = input instanceof Uint8Array ? input
    : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const need = n => { if (p + n > b.length) throw new RangeError('mpDecode: truncated'); };
  const u8 = () => { need(1); return b[p++]; };
  const u16 = () => { need(2); const x = dv.getUint16(p); p += 2; return x; };
  const u32 = () => { need(4); const x = dv.getUint32(p); p += 4; return x; };
  const bin = n => { need(n); const x = b.subarray(p, p + n); p += n; return x; };
  const str = n => {
    need(n);
    const s = TD ? TD.decode(b.subarray(p, p + n)) : String.fromCharCode.apply(null, b.subarray(p, p + n));
    p += n; return s;
  };
  function arr(n, d) {
    if (n > 64) throw new RangeError('mpDecode: array too long');
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = read(d + 1);
    return a;
  }
  function read(d) {
    if (d > 3) throw new RangeError('mpDecode: too deep');
    const t = u8();
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    if ((t & 0xf0) === 0x90) return arr(t & 0x0f, d);
    if ((t & 0xe0) === 0xa0) return str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u8());
      case 0xc5: return bin(u16());
      case 0xc6: return bin(u32());
      case 0xca: { need(4); const x = dv.getFloat32(p); p += 4; return x; }
      case 0xcb: { need(8); const x = dv.getFloat64(p); p += 8; return x; }
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: { const hi = u32(); const lo = u32(); return hi * 4294967296 + lo; }
      case 0xd0: { need(1); const x = dv.getInt8(p); p += 1; return x; }
      case 0xd1: { need(2); const x = dv.getInt16(p); p += 2; return x; }
      case 0xd2: { need(4); const x = dv.getInt32(p); p += 4; return x; }
      case 0xd3: { need(8); const hi = dv.getInt32(p); const lo = dv.getUint32(p + 4); p += 8; return hi * 4294967296 + lo; }
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdc: return arr(u16(), d);
    }
    throw new RangeError('mpDecode: unsupported type 0x' + t.toString(16));
  }
  const v = read(0);
  if (p !== b.length) throw new RangeError('mpDecode: trailing bytes');
  return v;
}

/* ---------- the one gate every outgoing byte passes ------------------------- */

/* Builds a client->server frame, or throws. Only JOIN/LEAVE (with allowlisted talkgroups)
 * and RESET/CALL_DROP (with no argument) can be built. */
export function buildControlFrame(type, tgs) {
  if (!SENDABLE.has(type)) throw new Error('hose: refusing to send frame type ' + String(type));
  if (type === T.JOIN || type === T.LEAVE) {
    if (!Array.isArray(tgs) || tgs.length === 0 || tgs.length > TALKGROUPS.length) {
      throw new Error('hose: JOIN/LEAVE needs 1-' + TALKGROUPS.length + ' talkgroups');
    }
    const list = [];
    for (const tg of tgs) {
      if (!ALLOWED_TGS.has(tg)) throw new Error('hose: talkgroup not on the allowlist: ' + String(tg));
      if (list.indexOf(tg) < 0) list.push(tg);
    }
    return mpEncode([type, list]);
  }
  if (tgs !== undefined) throw new Error('hose: frame type ' + type + ' takes no argument');
  return mpEncode([type]);
}

/* ---------- G.711 mu-law, decoded exactly as Hoseline does ------------------ */

const MU_SEG = [0, 132, 396, 924, 1980, 4092, 8316, 16764];
export const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const e = ~i;
    const sign = e & 0x80, exp = (e >> 4) & 7, man = e & 0x0f;
    const s = MU_SEG[exp] + (man << (exp + 3));
    t[i] = sign ? -s : s;
  }
  return t;
})();

/* mu-law bytes -> Float32 in [-1, 1], with Hoseline's gain applied before the clamp. */
export function mulawToFloat(bytes, gain = 1) {
  const out = new Float32Array(bytes.length);
  const k = gain / 32768;
  for (let i = 0; i < bytes.length; i++) {
    const v = MULAW_TABLE[bytes[i]] * k;
    out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
  }
  return out;
}

/* ---------- jitter ring (shared by the AudioWorklet and the ScriptProcessor fallback) ----
 * Self-contained on purpose: its source text is copied into the worklet module, so it must
 * not reference anything outside itself. Holds 8 kHz samples; read() resamples linearly when
 * the output rate is not 8 kHz (step = 8000 / outputRate). Waits for `pre` samples before
 * starting a talk spurt, and drops the oldest audio when more than `max` is queued so the
 * delay can never grow past `max`. */
export class PcmRing {
  constructor(cap, pre, max) {
    this.cap = cap; this.pre = pre; this.max = max;
    this.buf = new Float32Array(cap);
    this.r = 0; this.w = 0; this.n = 0; this.pos = 0; this.playing = false;
    this.dropped = 0; this.underruns = 0;
  }
  push(src) {
    for (let i = 0; i < src.length; i++) {
      if (this.n === this.cap) { this.r = (this.r + 1) % this.cap; this.n--; this.dropped++; }
      this.buf[this.w] = src[i];
      this.w = (this.w + 1) % this.cap;
      this.n++;
    }
    if (this.n > this.max) {
      const k = this.n - this.pre;
      this.r = (this.r + k) % this.cap; this.n -= k; this.dropped += k;
    }
  }
  flush() { this.r = 0; this.w = 0; this.n = 0; this.pos = 0; this.playing = false; }
  read(out, step) {
    if (!this.playing) {
      if (this.n < this.pre || this.n === 0) { out.fill(0); return false; }
      this.playing = true;
    }
    for (let i = 0; i < out.length; i++) {
      if (this.n === 0) { out.fill(0, i); this.playing = false; this.pos = 0; this.underruns++; return false; }
      const a = this.buf[this.r];
      const b = this.n > 1 ? this.buf[(this.r + 1) % this.cap] : a;
      out[i] = a + (b - a) * this.pos;
      this.pos += step;
      while (this.pos >= 1 && this.n > 0) { this.r = (this.r + 1) % this.cap; this.n--; this.pos -= 1; }
    }
    return true;
  }
}

export const WORKLET_NAME = 'holden-hose-rx';

/* Source of the AudioWorklet module (output only: zero inputs, no microphone path). */
export function workletSource() {
  return PcmRing.toString() + '\n' +
    'class HoseRx extends AudioWorkletProcessor {\n' +
    '  constructor(o) {\n' +
    '    super();\n' +
    '    const p = (o && o.processorOptions) || {};\n' +
    '    this.ring = new PcmRing(p.cap || 32000, p.pre || 1920, p.max || 12000);\n' +
    '    this.step = 8000 / sampleRate;\n' +
    '    this.port.onmessage = e => {\n' +
    '      const d = e.data;\n' +
    '      if (!d) return;\n' +
    '      if (d.pcm instanceof Float32Array) this.ring.push(d.pcm);\n' +
    '      else if (d.flush) this.ring.flush();\n' +
    '    };\n' +
    '  }\n' +
    '  process(inputs, outputs) {\n' +
    '    const out = outputs[0] && outputs[0][0];\n' +
    '    if (out) this.ring.read(out, this.step);\n' +
    '    return true;\n' +
    '  }\n' +
    '}\n' +
    "registerProcessor('" + WORKLET_NAME + "', HoseRx);\n";
}

/* Talker alias from the radio: printable text only, trimmed and capped. Render with
 * textContent, never innerHTML. */
export function cleanAlias(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_ALIAS_CHARS);
}

/* ---------- the player ---------------------------------------------------- */

const DEFAULTS = {
  gain: 2,                 // Hoseline's own decode gain
  volume: 1,               // our output volume, 0..2
  reconnectMs: 5000,       // first retry, as Hoseline
  maxReconnectMs: 60000,
  maxFailures: 12,         // straight failures before giving up until the user acts
  stableMs: 30000,         // a socket that stayed up this long resets the failure count
  lingerMs: 15000,         // last talkgroup off -> close the socket after this
  hiddenGraceMs: 60000,    // page hidden this long -> close the socket, suspend audio
  hiddenCallExtraMs: 180000, // ...but let a call already playing finish (up to a DMR timeout)
  idleSuspendMs: 15000,    // no call this long -> suspend the AudioContext (battery)
  audioCheckMs: 2000,      // after a call starts: is the audio clock really moving?
  quietReconnectMs: 1200000, // visible, subscribed, not one frame in 20 min -> one fresh socket
  duckHoldMs: 1500,        // duck(false) takes effect after this, so gaps in our audio don't let the hose in
  duckSafetyMs: 30000,     // a duck with no duck(true) refresh for this long releases itself
  prebufferMs: 240,
  maxLatencyMs: 1500,
  forceScriptProcessor: false
};

export function createHosePlayer(opts) {
  opts = opts || {};
  const g = opts.global || globalThis;
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const WS = opts.WebSocket || g.WebSocket;
  const AC = opts.AudioContext || g.AudioContext || g.webkitAudioContext;
  const doc = g.document || null;
  const setT = (f, ms) => g.setTimeout(f, ms);
  const clrT = t => { if (t != null) g.clearTimeout(t); };
  const now = () => (g.performance && typeof g.performance.now === 'function') ? g.performance.now() : Date.now();
  const wall = () => (g.Date && typeof g.Date.now === 'function') ? g.Date.now() : Date.now();   // comparable across tabs
  const id = Math.random().toString(36).slice(2);

  const L = { call: new Set(), level: new Set(), state: new Set() };
  let want = [];                 // talkgroups the user has on, in TALKGROUPS order
  let joined = new Set();        // what this socket has asked the server for
  /* failures only resets on a user tap (start/resume) or after a socket stayed up stableMs;
   * 'failed' is sticky until a tap. lastAttemptAt rate-limits every reopen that is not a tap. */
  let ws = null, openedAt = 0, failures = 0, lastAttemptAt = -Infinity, claimAt = 0;
  let reconnectT = null, lingerT = null, hiddenT = null, idleT = null, duckRelT = null, duckSafeT = null;
  let phase = 'off';             // off | connecting | live | reconnecting | paused | offline | failed
  let detail = '';
  let call = null;               // { src, tg, label, alias, startedAt }
  let skipping = false;
  let lastDuckAt = 0, ducked = false, muted = false, txHold = false, volume = cfg.volume;
  let ctx = null, gainNode = null, node = null, ring = null, mode = 'none', pending = [];
  let needsTap = false, sinkId = null, destroyed = false;
  let audioCheckT = null, suspendPending = false, audioStuck = false;
  let hiddenDueAt = 0, hiddenExtra = 0, lastFrameAt = 0, quietT = null;
  const stats = { frames: 0, audio: 0, bad: 0, dropped: 0, rescue: 0, sent: { 1: 0, 2: 0, 3: 0, 12: 0 }, opens: 0 };

  /* ---- events ---- */
  function on(set, cb) { if (typeof cb !== 'function') return () => {}; set.add(cb); return () => set.delete(cb); }
  function emit(set, v) { for (const cb of Array.from(set)) { try { cb(v); } catch (e) { /* page bug must not kill playback */ } } }
  function callInfo(active, extra) {
    if (!call) return null;
    const alias = call.alias;
    return Object.assign({
      active, src: call.src, tg: call.tg, label: call.label, alias,
      display: alias || ('ID ' + call.src), startedAt: call.startedAt
    }, extra || {});
  }
  function status() {
    return {
      state: phase, detail, tgs: want.slice(), joined: Array.from(joined), needsTap, muted, ducked, transmitting: txHold,
      audio: mode, ctxState: ctx ? ctx.state : 'none',
      call: call ? callInfo(!skipping) : null
    };
  }
  function setPhase(p, d) { phase = p; detail = d || ''; emit(L.state, status()); }

  /* ---- the one sender ---- */
  function sendControl(type, tgs) {
    const bytes = buildControlFrame(type, tgs);   // throws on anything not allowed
    if (!ws || ws.readyState !== 1) return false;
    ws.send(bytes);
    stats.sent[type]++;
    return true;
  }

  /* ---- subscriptions ---- */
  function sanitize(tgs) {
    const s = new Set(Array.isArray(tgs) ? tgs.map(Number) : []);
    return TALKGROUPS.map(t => t.tg).filter(tg => s.has(tg));
  }
  function syncSubs() {
    if (!ws || ws.readyState !== 1) return;
    const leave = Array.from(joined).filter(tg => want.indexOf(tg) < 0);
    const join = want.filter(tg => !joined.has(tg));
    if (leave.length) { sendControl(T.LEAVE, leave); leave.forEach(tg => joined.delete(tg)); }
    if (join.length) { sendControl(T.JOIN, join); join.forEach(tg => joined.add(tg)); }
    if (call && want.indexOf(call.tg) < 0) endCall(true);
  }

  /* ---- socket ---- */
  function visible() { return !doc || doc.visibilityState !== 'hidden'; }
  function online() { return !(g.navigator && g.navigator.onLine === false); }

  function connect() {
    if (destroyed || ws || !want.length) return;
    if (!visible()) { setPhase('paused', 'page hidden'); return; }
    if (!online()) { setPhase('offline', 'waiting for network'); return; }
    if (typeof WS !== 'function') { setPhase('failed', 'no WebSocket in this browser'); return; }
    let sock;
    try { sock = new WS(HOSE_URL, HOSE_PROTOCOL); } catch (e) { failures++; scheduleReconnect(); return; }
    sock.binaryType = 'arraybuffer';
    ws = sock; joined = new Set(); openedAt = 0; lastAttemptAt = now();
    stats.opens++;
    setPhase(failures ? 'reconnecting' : 'connecting');
    sock.onopen = () => {
      if (ws !== sock) return;
      openedAt = now();
      armQuiet();
      syncSubs();
      setPhase(want.length ? 'live' : 'off');
    };
    sock.onmessage = ev => { if (ws === sock) onFrame(ev.data); };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null; joined = new Set();
      endCall(true);
      if (openedAt && now() - openedAt >= cfg.stableMs) failures = 0;
      failures++;
      scheduleReconnect();
    };
  }

  function closeSocket() {
    const sock = ws;
    ws = null; joined = new Set();
    clrT(reconnectT); reconnectT = null;
    clrT(quietT); quietT = null;
    if (!sock) return;
    sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
    try { sock.close(1000); } catch (e) { /* already closing */ }
  }

  function retryDelay() {
    return Math.min(cfg.maxReconnectMs, cfg.reconnectMs * Math.pow(2, Math.max(0, failures - 1)));
  }
  function scheduleReconnect() {
    clrT(reconnectT); reconnectT = null;
    if (destroyed || !want.length) { setPhase('off'); return; }
    if (!visible()) { setPhase('paused', 'page hidden'); return; }
    if (!online()) { setPhase('offline', 'waiting for network'); return; }
    if (failures > cfg.maxFailures) { setPhase('failed', 'BrandMeister Hoseline unreachable'); return; }
    const delay = retryDelay();
    reconnectT = setT(() => { reconnectT = null; connect(); }, delay + Math.floor(Math.random() * 1000));
    setPhase('reconnecting', 'retry in ' + Math.round(delay / 1000) + ' s');
  }
  /* Reopen after the page came back (visible / online / pageshow). Not a tap, so it keeps the
   * backoff: never sooner than retryDelay() after the previous attempt, never out of 'failed',
   * never on top of a pending retry. */
  function revive() {
    if (destroyed || !want.length || ws || reconnectT || phase === 'failed') return;
    const wait = lastAttemptAt + retryDelay() - now();
    if (wait > 0) {
      reconnectT = setT(() => { reconnectT = null; connect(); }, wait + Math.floor(Math.random() * 1000));
      setPhase('reconnecting', 'retry in ' + Math.ceil(wait / 1000) + ' s');
    } else connect();
    if (ctx && ctx.state !== 'running') wakeAudio();
  }
  /* Liveness without sending anything: the client may only send JOIN/LEAVE/RESET/CALL_DROP,
   * so it cannot ping. If a visible, subscribed socket has carried no frame at all for
   * quietReconnectMs (a dead NAT mapping looks exactly like a quiet talkgroup), replace it once.
   * At most 3 sockets an hour on a silent talkgroup; never while hidden. */
  function armQuiet() {
    clrT(quietT); quietT = null;
    if (cfg.quietReconnectMs > 0 && cfg.quietReconnectMs !== Infinity) quietT = setT(onQuiet, cfg.quietReconnectMs);
  }
  function onQuiet() {
    quietT = null;
    if (!ws || ws.readyState !== 1 || !want.length) return;
    const idle = now() - Math.max(lastFrameAt, openedAt);
    if (idle < cfg.quietReconnectMs) { quietT = setT(onQuiet, cfg.quietReconnectMs - idle); return; }
    if (!visible()) { armQuiet(); return; }
    closeSocket();
    endCall(true);
    connect();
  }
  /* The linger after the last toggle-off: close now. */
  function finishLinger() {
    clrT(lingerT); lingerT = null;
    if (!want.length) { closeSocket(); suspendAudio(); setPhase('off'); }
  }

  /* ---- incoming frames ---- */
  function onFrame(data) {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;   // text or Blob: not ours
    if (data.byteLength < 1 || data.byteLength > MAX_FRAME_BYTES) { stats.bad++; return; }
    let m;
    try { m = mpDecode(data); } catch (e) { stats.bad++; return; }
    if (!Array.isArray(m) || !Number.isInteger(m[0])) { stats.bad++; return; }
    stats.frames++;
    lastFrameAt = now();
    switch (m[0]) {
      case T.CALL_START: {
        const src = m[2], tg = m[3];
        if (!Number.isInteger(src) || src < 0 || !Number.isInteger(tg)) { stats.bad++; return; }
        if (call) endCall(true);
        if (want.indexOf(tg) < 0 || !ALLOWED_TGS.has(tg)) return;   // not something we asked for
        call = { src, tg, label: tgLabel(tg), alias: '', startedAt: Date.now() };
        skipping = false;
        clrT(idleT); idleT = null;
        wakeAudio();
        emit(L.call, callInfo(true));
        break;
      }
      case T.CALL_AUDIO: {
        const bytes = m[1];
        if (!call || skipping) return;
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_AUDIO_BYTES) { stats.bad++; return; }
        stats.audio++;
        playPcm(mulawToFloat(bytes, cfg.gain));
        break;
      }
      case T.CALL_ALIAS:
        if (call && typeof m[1] === 'string') {
          const a = cleanAlias(m[1]);
          // The alias arrives in pieces and is sometimes re-sent shorter ("ZL3TOM Thomas", then
          // "ZL3TOM"): keep the longer one rather than flicker back.
          if (a && a !== call.alias && call.alias.indexOf(a) !== 0) { call.alias = a; if (!skipping) emit(L.call, callInfo(true)); }
        }
        break;
      case T.CALL_METER:
        if (call && !skipping && typeof m[1] === 'number' && isFinite(m[1])) emitLevel(m[1]);
        break;
      case T.CALL_END:
        endCall(false);
        break;
      case T.SYSTEM_RESCUE:
        stats.rescue++;              // Hoseline's own client ignores it too
        break;
    }
  }

  function emitLevel(db) {
    const level = db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
    emit(L.level, { dbfs: db, level });
  }

  function endCall(cut) {
    if (!call) return;
    const info = callInfo(false, { skipped: skipping });
    call = null; skipping = false;
    if (cut) flushAudio();
    emitLevel(-Infinity);
    emit(L.call, info);
    armIdleSuspend();
  }

  /* ---- audio ---- */
  function targetGain() { return (muted || ducked || txHold) ? 0 : volume; }
  /* hard = jump at once (transmit hold), otherwise a ~50 ms ramp so ducking doesn't click. */
  function applyGain(hard) {
    if (!gainNode) return;
    const v = targetGain();
    try {
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      if (hard) gainNode.gain.setValueAtTime(v, ctx.currentTime);
      else gainNode.gain.setTargetAtTime(v, ctx.currentTime, 0.015);
    } catch (e) { gainNode.gain.value = v; }
  }

  /* Must run inside the user's tap (start/resume) so mobile browsers let audio start. */
  function ensureAudio() {
    if (!AC) return;
    if (!ctx) {
      try { ctx = new AC({ sampleRate: 8000, latencyHint: 'playback' }); }
      catch (e) { try { ctx = new AC(); } catch (e2) { ctx = null; return; } }
      gainNode = ctx.createGain();
      gainNode.gain.value = targetGain();
      gainNode.connect(ctx.destination);
      try {
        const mine = ctx;
        ctx.onstatechange = () => {
          if (ctx !== mine) return;
          // Every way back to 'running' (tap, revive, WebKit's own resume after an interruption)
          // re-arms the idle suspend, so a quiet talkgroup never leaves the worklet rendering zeros.
          if (ctx.state === 'running' && !call) armIdleSuspend();
          emit(L.state, status());
        };
      } catch (e) {}
      if (sinkId != null) applySink();
      buildSource();
    }
    unlock();
  }
  function unlock() {
    if (!ctx) return;
    try {   // old iOS only starts output once a buffer plays inside the gesture
      const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
    } catch (e) {}
    if (ctx.state !== 'running' || suspendPending) {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }
  }
  /* Drop the AudioContext and build a fresh one inside the user's tap: the only cure for
   * WebKit's "running but the clock is frozen" state (bugs 263627 / 283419). */
  function rebuildAudio() {
    const old = ctx;
    if (!old) return;
    try { old.onstatechange = null; } catch (e) {}
    try { if (node) node.disconnect(); } catch (e) {}
    ctx = null; gainNode = null; node = null; ring = null; mode = 'none'; pending = [];
    clrT(idleT); idleT = null; suspendPending = false;
    try { const p = old.close(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
  function buildSource() {
    const step = 8000 / ctx.sampleRate;
    const popts = { cap: 32000, pre: Math.round(cfg.prebufferMs * 8), max: Math.round(cfg.maxLatencyMs * 8) };
    const AWN = g.AudioWorkletNode;
    const useScript = () => {
      if (node || !ctx) return;   // destroyed while the worklet was loading
      ring = new PcmRing(popts.cap, popts.pre, popts.max);
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = e => { ring.read(e.outputBuffer.getChannelData(0), step); };
      node.connect(gainNode);
      mode = 'script';
      drainPending();
    };
    if (cfg.forceScriptProcessor || !ctx.audioWorklet || typeof AWN !== 'function') { useScript(); return; }
    const src = workletSource();
    let blobUrl = null;
    try { blobUrl = g.URL.createObjectURL(new g.Blob([src], { type: 'application/javascript' })); } catch (e) {}
    const viaData = () => ctx.audioWorklet.addModule('data:application/javascript;charset=utf-8,' + encodeURIComponent(src));
    const load = blobUrl ? ctx.audioWorklet.addModule(blobUrl).catch(viaData) : viaData();
    load.then(() => {
      if (node || !ctx) return;
      node = new AWN(ctx, WORKLET_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: popts });
      node.connect(gainNode);
      mode = 'worklet';
      drainPending();
    }).catch(useScript).then(() => { if (blobUrl) { try { g.URL.revokeObjectURL(blobUrl); } catch (e) {} } });
  }
  function drainPending() { const p = pending; pending = []; p.forEach(playPcm); emit(L.state, status()); }
  function playPcm(f32) {
    if (mode === 'worklet') node.port.postMessage({ pcm: f32 }, [f32.buffer]);
    else if (mode === 'script') ring.push(f32);
    else if (ctx) { pending.push(f32); if (pending.length > 12) { pending.shift(); stats.dropped++; } }
  }
  function flushAudio() {
    pending = [];
    if (mode === 'worklet') node.port.postMessage({ flush: 1 });
    else if (mode === 'script') ring.flush();
  }
  function armIdleSuspend() {
    clrT(idleT); idleT = null;
    if (!ctx || cfg.idleSuspendMs <= 0) return;
    idleT = setT(() => { idleT = null; if (!call) suspendCtx(); }, cfg.idleSuspendMs);
  }
  /* suspend() changes state asynchronously; a call that starts in that gap must still wake it. */
  function suspendCtx() {
    if (!ctx || ctx.state !== 'running') return;
    const mine = ctx;
    suspendPending = true;
    let p;
    try { p = ctx.suspend(); } catch (e) {}
    const done = () => { if (ctx !== mine) return; suspendPending = false; if (call) wakeAudio(); };
    if (p && p.then) p.then(done, done); else done();
  }
  /* A call started: bring audio back from an idle suspend, then CHECK that sound can really
   * play. The check is a timer, not a reaction to resume()'s promise: WebKit never settles a
   * refused resume (interruption, background). "Healthy" = state 'running' AND currentTime
   * moving, because iOS can report 'running' with a frozen clock. Unhealthy during a call =
   * needsTap; the page shows a button that calls resume(). */
  function wakeAudio() {
    if (!ctx) return;
    if (ctx.state !== 'running' || suspendPending) {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }
    scheduleAudioCheck();
  }
  function scheduleAudioCheck() {
    if (!ctx || audioCheckT || cfg.audioCheckMs <= 0) return;
    const ct0 = ctx.currentTime, mine = ctx;
    audioCheckT = setT(() => {
      audioCheckT = null;
      if (ctx !== mine || !call) return;
      const running = ctx.state === 'running';
      const moving = ctx.currentTime - ct0 > (cfg.audioCheckMs / 1000) * 0.25;
      if (running && moving) {
        if (needsTap || audioStuck) { needsTap = false; audioStuck = false; emit(L.state, status()); }
        return;
      }
      audioStuck = running && !moving;
      if (!needsTap) { needsTap = true; emit(L.state, status()); }
      scheduleAudioCheck();   // keep looking while the call lasts: it may recover by itself
    }, cfg.audioCheckMs);
  }
  function suspendAudio() {
    clrT(idleT); idleT = null;
    suspendCtx();
  }
  function applySink() {
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    try { const p = ctx.setSinkId(sinkId && sinkId !== 'default' ? sinkId : ''); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }

  /* ---- page lifecycle ---- */
  /* Page hidden too long, or pagehide: close the socket and suspend audio. A lingering
   * zero-subscription socket just closes; 'failed' stays 'failed'. */
  function pauseForBackground(why) {
    clrT(hiddenT); hiddenT = null;
    if (lingerT) { finishLinger(); return; }
    if (!want.length) return;
    closeSocket();
    endCall(true);
    suspendAudio();
    if (phase !== 'failed') setPhase('paused', why);
  }
  function armHidden(ms) { hiddenDueAt = wall() + ms; hiddenT = setT(onHiddenTimer, ms); }
  function onHiddenTimer() {
    hiddenT = null;
    // A call that was already playing when the grace ran out gets to finish (Android keeps
    // audio running in a hidden tab), up to hiddenCallExtraMs.
    if (call && hiddenExtra < cfg.hiddenCallExtraMs) { hiddenExtra += 10000; armHidden(10000); return; }
    pauseForBackground('page hidden');
  }
  function onVisibility() {
    // Timers are frozen while iOS has the page asleep: if the hidden timer is long overdue,
    // the socket is suspect (a NAT may have dropped it) -> do now what the timer would have done.
    const overdue = !!hiddenT && wall() > hiddenDueAt + 5000;
    clrT(hiddenT); hiddenT = null;
    if (!visible()) {
      hiddenExtra = 0;
      if (lingerT) finishLinger();
      else if (want.length && cfg.hiddenGraceMs !== Infinity) armHidden(cfg.hiddenGraceMs);
    } else if (want.length) {
      if (overdue) pauseForBackground('page was asleep');
      if (ws && ws.readyState > 1) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws = null; joined = new Set(); }
      revive();
    }
  }
  function onPageHide() { pauseForBackground('page closed'); }
  function onPageShow(e) { if (e && e.persisted && visible()) revive(); }
  function onOffline() {
    if (lingerT) { finishLinger(); return; }
    if (!want.length) return;
    if (ws && !(openedAt && now() - openedAt >= cfg.stableMs)) failures++;   // a flapping link backs off too
    closeSocket();
    endCall(true);
    if (phase !== 'failed') setPhase('offline', 'waiting for network');
  }
  function onOnline() { if (visible()) revive(); }

  /* One Hoseline socket per browser: the newest claim wins, ordered by (time, id) so two tabs
   * that start together agree on a single winner. A tab that receives an OLDER claim while
   * playing answers with its own, so the older tab stops. */
  let bc = null;
  try { if (typeof g.BroadcastChannel === 'function') bc = new g.BroadcastChannel('holden-hose-player'); } catch (e) { bc = null; }
  function postClaim() { if (bc) { try { bc.postMessage({ claim: id, at: claimAt }); } catch (e) {} } }
  if (bc) bc.onmessage = e => {
    const d = e && e.data;
    if (!d || typeof d.claim !== 'string' || d.claim === id) return;
    if (!want.length && !lingerT) return;
    const at = Number(d.at);
    const theirsNewer = !isFinite(at) || at > claimAt || (at === claimAt && d.claim > id);
    if (theirsNewer) stop('playing in another tab'); else postClaim();
  };

  const listeners = [];
  function listen(target, type, fn) {
    if (target && typeof target.addEventListener === 'function') { target.addEventListener(type, fn); listeners.push([target, type, fn]); }
  }
  listen(doc, 'visibilitychange', onVisibility);
  listen(g, 'pagehide', onPageHide);
  listen(g, 'pageshow', onPageShow);
  listen(g, 'offline', onOffline);
  listen(g, 'online', onOnline);

  /* ---- public API ---- */

  /* Listen to these talkgroups (replaces the current set). Call it from the user's tap.
   * Anything not in TALKGROUPS is ignored. An empty list is stop(). Returns the set in use. */
  function start(tgs) {
    if (destroyed) return [];
    const next = sanitize(tgs);
    if (!next.length) { stop(); return []; }
    want = next;
    clrT(lingerT); lingerT = null;
    ensureAudio();
    if (!call) armIdleSuspend();
    claimAt = wall();
    postClaim();
    if (ws && ws.readyState === 1) { syncSubs(); setPhase('live'); }
    else if (!ws) {
      // A tap: the one place (with resume) that may clear a give-up or skip a pending retry.
      if (phase === 'failed' || phase === 'off') failures = 0;
      clrT(reconnectT); reconnectT = null;
      connect();
    }
    else emit(L.state, status());
    return want.slice();
  }

  /* Turn one talkgroup on or off; closes the socket (after lingerMs) when none are left. */
  function toggle(tg, onOff) {
    const has = want.indexOf(tg) >= 0;
    const turnOn = onOff === undefined ? !has : !!onOff;
    if (turnOn) return has ? want.slice() : start(want.concat([tg]));
    if (!has) return want.slice();                 // already off: no-op (must not re-arm the linger)
    const next = want.filter(x => x !== tg);
    if (next.length) return start(next);
    want = [];
    endCall(true);
    if (ws && ws.readyState === 1 && joined.size) syncSubs();
    clrT(reconnectT); reconnectT = null;
    clrT(lingerT);
    lingerT = ws ? setT(finishLinger, cfg.lingerMs) : null;
    if (!ws) suspendAudio();
    setPhase('off');
    return [];
  }

  /* Stop everything now: socket closed, audio suspended, no reconnect. */
  function stop(why) {
    want = [];
    clrT(lingerT); lingerT = null; clrT(hiddenT); hiddenT = null;
    closeSocket();
    endCall(true);
    suspendAudio();
    needsTap = false;
    failures = 0;
    setPhase('off', typeof why === 'string' ? why : '');
  }

  /* Skip the current call (CALL_DROP). The next call on any of our talkgroups plays. */
  function skip() {
    if (!call || skipping) return false;
    if (!sendControl(T.CALL_DROP)) return false;
    skipping = true;
    flushAudio();
    emitLevel(-Infinity);
    emit(L.call, callInfo(false, { skipped: true }));
    return true;
  }

  function setMuted(b) { muted = !!b; applyGain(); emit(L.state, status()); }
  function setVolume(v) { v = Number(v); if (!isFinite(v)) return; volume = Math.max(0, Math.min(2, v)); applyGain(); }

  /* Our own HOLDEN/TGIF audio always wins. Call duck(true) on every frame of our audio (it is
   * cheap) and duck(false) when it ends; the hose comes back duckHoldMs after duck(false), or
   * by itself duckSafetyMs after the last duck(true). */
  function duck(b) {
    if (b) {
      lastDuckAt = now();
      clrT(duckRelT); duckRelT = null;
      if (!ducked) { ducked = true; applyGain(); }
      if (!duckSafeT) armDuckSafety(cfg.duckSafetyMs);
    } else if (ducked && !duckRelT) {
      duckRelT = setT(releaseDuck, cfg.duckHoldMs);
    }
  }
  function armDuckSafety(ms) {
    duckSafeT = setT(() => {
      duckSafeT = null;
      if (!ducked) return;
      const left = cfg.duckSafetyMs - (now() - lastDuckAt);
      if (left > 0) armDuckSafety(left); else releaseDuck();
    }, ms);
  }
  function releaseDuck() {
    clrT(duckRelT); duckRelT = null; clrT(duckSafeT); duckSafeT = null;
    if (ducked) { ducked = false; applyGain(); }
  }

  /* Hard mute for as long as the page's own microphone is open, so an open mic can never pick
   * the hose up off the speaker and put it on the air (or into an app-only talkgroup). Call
   * setTransmitting(true) at key-up BEFORE the mic opens, false after it is released. Unlike
   * duck() it never releases itself: a missed false fails silent, not loud. */
  function setTransmitting(b) {
    const was = txHold;
    txHold = !!b;
    if (txHold && !was) flushAudio();
    if (txHold !== was) { applyGain(txHold); emit(L.state, status()); }
  }

  /* From a user tap: restart audio a browser suspended (iOS interruptions, background), and
   * retry now if the feed had given up. */
  function resume() {
    if (destroyed) return;
    if (audioStuck) rebuildAudio();      // frozen-clock WebKit context: start over, inside this tap
    needsTap = false; audioStuck = false;
    ensureAudio();
    if (call) scheduleAudioCheck();
    emit(L.state, status());
    if (want.length && !ws) {
      if (phase === 'failed') failures = 0;
      clrT(reconnectT); reconnectT = null;
      connect();
    }
  }

  function setSinkId(idv) { sinkId = idv == null ? null : String(idv); applySink(); }

  function destroy() {
    stop();
    clrT(duckRelT); clrT(duckSafeT); clrT(audioCheckT); clrT(idleT);
    duckRelT = duckSafeT = audioCheckT = idleT = null;
    destroyed = true;
    listeners.forEach(([t, ty, fn]) => { try { t.removeEventListener(ty, fn); } catch (e) {} });
    if (bc) { try { bc.close(); } catch (e) {} bc = null; }
    if (ctx) {
      try { ctx.onstatechange = null; } catch (e) {}
      try { const p = ctx.close(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
      ctx = null;
    }
    L.call.clear(); L.level.clear(); L.state.clear();
  }

  return Object.freeze({
    start, stop, toggle, skip, setMuted, setVolume, duck, setTransmitting, resume, setSinkId, destroy,
    onCall: cb => on(L.call, cb),
    onLevel: cb => on(L.level, cb),
    onState: cb => on(L.state, cb),
    getStatus: status,
    getStats: () => JSON.parse(JSON.stringify(Object.assign({}, stats, { failures, ringDropped: ring ? ring.dropped : null }))),
    talkgroups: TALKGROUPS
  });
}

let shared = null;
/* The page-wide player. Creating it opens nothing: no socket, no AudioContext until start(). */
export function getHosePlayer() { return shared || (shared = createHosePlayer()); }

/* ---------- the "Listen to a talk group" section --------------------------------
 * Renders into `root` (an empty element). Text is set with textContent only. Returns an
 * object with destroy(). */
export function mountHoseSection(root, player) {
  if (!root) throw new Error('mountHoseSection: no root element');
  player = player || getHosePlayer();
  const d = root.ownerDocument || document;
  const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  root.textContent = '';
  root.classList.add('hose');
  const head = el('div', 'hose-h', 'Listen to a talk group');
  const sub = el('div', 'hose-sub', 'BrandMeister talkgroups, listen only. Tap one or more.');
  const grid = el('div', 'hose-tgs');
  const btns = new Map();
  TALKGROUPS.forEach(t => {
    const b = el('button', 'b hose-tg');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.dataset.tg = String(t.tg);
    b.appendChild(el('span', 'hose-tgnum', String(t.tg)));
    b.appendChild(el('span', 'hose-tglbl', t.label));
    b.addEventListener('click', () => { player.toggle(t.tg); });
    btns.set(t.tg, b);
    grid.appendChild(b);
  });
  const now = el('div', 'hose-now', '\u2014');
  now.setAttribute('aria-live', 'polite');
  const last = el('div', 'hose-last', '');
  const meter = el('div', 'hose-meter');
  const bar = el('div', 'hose-bar');
  meter.appendChild(bar);
  meter.setAttribute('aria-hidden', 'true');
  const row = el('div', 'hose-row');
  const skipB = el('button', 'b hose-skip', 'Skip');
  const stopB = el('button', 'b hose-stop', 'Stop');
  skipB.type = stopB.type = 'button';
  skipB.disabled = stopB.disabled = true;
  skipB.addEventListener('click', () => player.skip());
  stopB.addEventListener('click', () => player.stop());
  row.appendChild(skipB); row.appendChild(stopB);
  const stateL = el('div', 'hose-state', 'Off');
  const tapB = el('button', 'b hose-tap', 'Tap to turn sound back on');
  tapB.type = 'button';
  tapB.hidden = true;
  tapB.addEventListener('click', () => player.resume());
  const credit = el('div', 'hose-credit', HOSE_CREDIT);
  [head, sub, grid, now, last, meter, row, stateL, tapB, credit].forEach(x => root.appendChild(x));

  const WORDS = {
    off: 'Off', connecting: 'Connecting\u2026', live: 'Listening', reconnecting: 'Reconnecting\u2026',
    paused: 'Paused', offline: 'No network', failed: 'Not reachable'
  };
  const offs = [];
  offs.push(player.onState(s => {
    btns.forEach((b, tg) => {
      const onNow = s.tgs.indexOf(tg) >= 0;
      b.setAttribute('aria-pressed', onNow ? 'true' : 'false');
      b.classList.toggle('on', onNow);
    });
    stopB.disabled = !s.tgs.length;
    skipB.disabled = !(s.call && s.call.active);
    let w = WORDS[s.state] || s.state;
    if (s.state === 'live' && s.tgs.length) w += ' \u00b7 ' + s.tgs.join(', ');
    if (s.detail) w += ' \u00b7 ' + s.detail;
    if (s.muted) w += ' \u00b7 muted';
    stateL.textContent = w;
    stateL.dataset.state = s.state;
    tapB.hidden = !s.needsTap;
    root.classList.toggle('hose-active', s.tgs.length > 0);
  }));
  offs.push(player.onCall(c => {
    if (c && c.active) {
      now.textContent = '\u25cf ' + c.tg + ' ' + c.label + '  \u00b7  ' + c.display;
      now.classList.add('on');
      skipB.disabled = false;
    } else {
      now.classList.remove('on');
      now.textContent = '\u2014';
      if (c) last.textContent = '\u258c LAST  ' + c.tg + ' ' + c.label + ' \u00b7 ' + c.display + (c.skipped ? ' (skipped)' : '');
      skipB.disabled = true;
    }
  }));
  offs.push(player.onLevel(v => { bar.style.width = Math.round(v.level * 100) + '%'; }));
  const s0 = player.getStatus();
  btns.forEach((b, tg) => { const o = s0.tgs.indexOf(tg) >= 0; b.setAttribute('aria-pressed', o ? 'true' : 'false'); b.classList.toggle('on', o); });

  return { destroy() { offs.forEach(f => f()); root.textContent = ''; } };
}
