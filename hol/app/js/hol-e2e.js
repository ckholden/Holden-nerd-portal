/*
 * Holden On Line — end-to-end encryption for 1:1 IMs (0.2.0).
 *
 * ⚠ ONE IMPLEMENTATION. This file is copied BYTE-IDENTICAL to
 *   Holden-nerd-portal/hol/app/js/hol-e2e.js (browser app, <script> tag).
 * Same rule as holshared.js's sanitizer: do not write a second one, and do not let the
 * two copies drift. The wire format is pinned in CONTRACT-ipc.md §27; the reasoning and
 * the honest limits are in SPEC-e2e.md. Read both before changing anything here.
 *
 * No I/O, no globals, no storage: the caller passes the libsodium object and owns where
 * keys live (safeStorage on desktop, IndexedDB in the browser). Everything crossing this
 * boundary is a base64url string (no padding) or plain JS data.
 *
 * Primitives — all libsodium, nothing hand-rolled:
 *   body  = crypto_secretbox_easy (XSalsa20-Poly1305) under a random per-message key
 *   wrap  = crypto_box_easy (X25519 + XSalsa20-Poly1305), one per recipient DEVICE,
 *           carrying msgKey ‖ blake2b(nonce ‖ body) — so the body is bound to the
 *           sender's device key and nobody but that device can substitute it.
 *   hash  = crypto_generichash (BLAKE2b)
 * Deliberately NO forward secrecy (Christian's call, SPEC-e2e.md §1).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HolE2E = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEVICE_RE = /^[A-Za-z0-9_-]{16,32}$/;
  var WRAP_BYTES = 104;           // 24 nonce + (32 msgKey + 32 bodyHash) + 16 MAC
  var MAX_BODY_CHARS = 24000;     // base64url chars of the secretbox ciphertext
  var MAX_RECIPIENTS = 20;

  // Mirrors server.js snKey() exactly: fold case, strip whitespace.
  function keyOf(name) { return String(name || '').toLowerCase().replace(/\s+/g, ''); }

  function E2EError(code, detail) {
    var e = new Error(code + (detail ? ': ' + detail : ''));
    e.code = code;
    return e;
  }

  function create(sodium) {
    if (!sodium || typeof sodium.crypto_box_easy !== 'function') {
      throw new Error('HolE2E.create() needs an initialised libsodium object');
    }
    var B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
    function b64(bytes) { return sodium.to_base64(bytes, B64); }
    function unb64(str, expectLen) {
      if (typeof str !== 'string' || !str) return null;
      var out;
      try { out = sodium.from_base64(str, B64); } catch (e) { return null; }
      if (expectLen != null && out.length !== expectLen) return null;
      return out;
    }
    function concat(a, b) {
      var out = new Uint8Array(a.length + b.length);
      out.set(a, 0); out.set(b, a.length);
      return out;
    }
    function wipe(buf) { try { if (buf) sodium.memzero(buf); } catch (e) { /* best effort */ } }

    function validKey(k) {
      return !!(k && typeof k.d === 'string' && DEVICE_RE.test(k.d) && unb64(k.k, sodium.crypto_box_PUBLICKEYBYTES));
    }

    // -------------------------------------------------------------- devices
    function newDevice() {
      var kp = sodium.crypto_box_keypair();
      var out = {
        d: b64(sodium.randombytes_buf(16)),
        pk: b64(kp.publicKey),
        sk: b64(kp.privateKey)
      };
      wipe(kp.privateKey);
      return out;
    }

    // -------------------------------------------------------------- envelope shape
    // SHAPE ONLY — the same checks server.js makes. Never a substitute for open().
    function validEnvelope(env) {
      if (!env || typeof env !== 'object' || env.v !== 1) return false;
      if (typeof env.fd !== 'string' || !DEVICE_RE.test(env.fd)) return false;
      if (!unb64(env.n, sodium.crypto_secretbox_NONCEBYTES)) return false;
      if (typeof env.c !== 'string' || !env.c.length || env.c.length > MAX_BODY_CHARS) return false;
      if (!unb64(env.c)) return false;
      if (!env.w || typeof env.w !== 'object' || Array.isArray(env.w)) return false;
      var ids = Object.keys(env.w);
      if (ids.length < 1 || ids.length > MAX_RECIPIENTS) return false;
      for (var i = 0; i < ids.length; i++) {
        if (!DEVICE_RE.test(ids[i])) return false;
        if (!unb64(env.w[ids[i]], WRAP_BYTES)) return false;
      }
      return true;
    }

    // -------------------------------------------------------------- seal
    /* opts: { text, from, to, ts, device:{d, sk}, recipients:[{d,k}] }
     * `recipients` MUST include every device of the peer AND every device of the sender,
     * including `device` itself (SPEC-e2e.md §3) — this function does not guess them. */
    function seal(opts) {
      if (!opts || typeof opts.text !== 'string') throw E2EError('bad-args', 'text');
      if (!opts.device || !DEVICE_RE.test(String(opts.device.d || ''))) throw E2EError('bad-args', 'device');
      var sk = unb64(opts.device.sk, sodium.crypto_box_SECRETKEYBYTES);
      if (!sk) throw E2EError('bad-args', 'secret key');

      var seen = {}, recips = [];
      (opts.recipients || []).forEach(function (k) {
        if (validKey(k) && !seen[k.d]) { seen[k.d] = true; recips.push(k); }
      });
      if (!recips.length) { wipe(sk); throw E2EError('no-recipients'); }
      if (recips.length > MAX_RECIPIENTS) { wipe(sk); throw E2EError('too-many-devices'); }

      var inner = {
        v: 1,
        id: b64(sodium.randombytes_buf(16)),
        from: String(opts.from || ''),
        to: String(opts.to || ''),
        text: opts.text,
        ts: Number(opts.ts) || Date.now()
      };
      var msgKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
      var n = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
      var c = sodium.crypto_secretbox_easy(sodium.from_string(JSON.stringify(inner)), n, msgKey);
      var cB64 = b64(c);
      if (cB64.length > MAX_BODY_CHARS) { wipe(sk); wipe(msgKey); throw E2EError('too-long'); }

      var bh = sodium.crypto_generichash(32, concat(n, c));
      var payload = concat(msgKey, bh);
      var w = {};
      for (var i = 0; i < recips.length; i++) {
        var nd = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
        var boxed = sodium.crypto_box_easy(payload, nd, unb64(recips[i].k), sk);
        w[recips[i].d] = b64(concat(nd, boxed));
      }
      wipe(sk); wipe(msgKey); wipe(payload);
      return { v: 1, fd: opts.device.d, n: b64(n), c: cB64, w: w };
    }

    // -------------------------------------------------------------- open
    /* opts: {
     *   envelope,
     *   frameFrom  — the SERVER-ATTESTED `from` of the relayed frame (never inner.from)
     *   me         — this account's screen name
     *   peer       — the screen name this conversation is with (needed for own-copy checks)
     *   device     — {d, sk} of THIS device
     *   senderKeys — the directory's [{d,k}] for frameFrom (roster keys, or myKeys when
     *                frameFrom is me)
     * }
     * Returns { id, text, ts }. Throws E2EError with a stable .code on ANY failure —
     * callers must show a visible "could not be read" line, never drop it silently and
     * never render it as trusted. ⚠ The returned text is attacker-controlled HTML exactly
     * like a plaintext IM: it still goes through holshared.js sanitizeHtml(). */
    function open(opts) {
      var env = opts && opts.envelope;
      if (!validEnvelope(env)) throw E2EError('bad-envelope');
      if (!opts.device || typeof opts.device.d !== 'string') throw E2EError('bad-args', 'device');

      var wrap = env.w[opts.device.d];
      if (!wrap) throw E2EError('not-for-this-device');

      var senderPkB64 = null;
      (opts.senderKeys || []).forEach(function (k) { if (validKey(k) && k.d === env.fd) senderPkB64 = k.k; });
      if (!senderPkB64) throw E2EError('unknown-sender-device');

      var sk = unb64(opts.device.sk, sodium.crypto_box_SECRETKEYBYTES);
      if (!sk) throw E2EError('bad-args', 'secret key');
      var wb = unb64(wrap, WRAP_BYTES);
      var payload = null;
      try {
        // libsodium order: (ciphertext, nonce, senderPk, mySk). A wrong order fails
        // CLOSED (MAC check), never open — but it is spelled out once, here, on purpose.
        payload = sodium.crypto_box_open_easy(
          wb.slice(sodium.crypto_box_NONCEBYTES),       // ciphertext (80 bytes)
          wb.slice(0, sodium.crypto_box_NONCEBYTES),    // nonce (24 bytes)
          unb64(senderPkB64),
          sk);
      } catch (e) { payload = null; }
      wipe(sk);
      if (!payload || payload.length !== 64) throw E2EError('bad-wrap');

      var msgKey = payload.subarray(0, 32);
      var bh = payload.subarray(32, 64);
      var n = unb64(env.n, sodium.crypto_secretbox_NONCEBYTES);
      var c = unb64(env.c);
      var want = sodium.crypto_generichash(32, concat(n, c));
      if (!sodium.memcmp(want, bh)) { wipe(payload); throw E2EError('body-mismatch'); }

      var plain;
      try { plain = sodium.crypto_secretbox_open_easy(c, n, msgKey); } catch (e) { plain = null; }
      wipe(payload);
      if (!plain) throw E2EError('bad-body');

      var inner;
      try { inner = JSON.parse(sodium.to_string(plain)); } catch (e) { inner = null; }
      wipe(plain);
      if (!inner || inner.v !== 1 || typeof inner.text !== 'string' || typeof inner.id !== 'string') {
        throw E2EError('bad-inner');
      }
      // The inner claims must agree with what the SERVER attested and with this window.
      if (keyOf(inner.from) !== keyOf(opts.frameFrom)) throw E2EError('from-mismatch');
      var own = keyOf(opts.frameFrom) === keyOf(opts.me);
      var wantTo = own ? opts.peer : opts.me;
      if (keyOf(inner.to) !== keyOf(wantTo)) throw E2EError('to-mismatch');

      return { id: inner.id, text: inner.text, ts: Number(inner.ts) || 0 };
    }

    // -------------------------------------------------------------- safety number
    /* 12 groups of 5 digits over BOTH people's full current device sets. Symmetric: A and
     * B compute the same number. null when either side has no keys (nothing to verify). */
    function safetyNumber(nameA, keysA, nameB, keysB) {
      function party(name, keys) {
        var ks = (keys || []).filter(validKey).map(function (k) { return k.d + ':' + k.k; }).sort();
        return ks.length ? keyOf(name) + '|' + ks.join(';') : null;
      }
      var a = party(nameA, keysA), b = party(nameB, keysB);
      if (!a || !b) return null;
      var h = sodium.crypto_generichash(64, sodium.from_string('HOL-safety-v1|' + [a, b].sort().join('||')));
      var groups = [];
      for (var i = 0; i < 12; i++) {
        var v = 0;
        for (var j = 0; j < 5; j++) v = v * 256 + h[i * 5 + j];   // 40 bits: exact in a double
        groups.push(String(v % 100000).padStart(5, '0'));
      }
      return groups.join(' ');
    }

    return {
      newDevice: newDevice,
      seal: seal,
      open: open,
      safetyNumber: safetyNumber,
      validEnvelope: validEnvelope,
      validKey: validKey,
      keyOf: keyOf,
      DEVICE_RE: DEVICE_RE,
      WRAP_BYTES: WRAP_BYTES,
      MAX_BODY_CHARS: MAX_BODY_CHARS,
      MAX_RECIPIENTS: MAX_RECIPIENTS
    };
  }

  return { create: create, keyOf: keyOf, DEVICE_RE: DEVICE_RE };
});
