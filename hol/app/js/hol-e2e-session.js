/*
 * Holden On Line 0.2.0 — one signed-on session's end-to-end encryption state: which
 * account, this device's key, everyone's public keys, trust-on-first-use memory, notices.
 * Wire + IPC names: CONTRACT-ipc.md §27. Reasoning and honest limits: SPEC-e2e.md.
 *
 * ⚠ ONE IMPLEMENTATION, TWO HOMES — copied BYTE-IDENTICAL, like hol-e2e.js, to
 *   Holden-nerd-portal/hol/app/js/hol-e2e-session.js. The rules for when a message is
 *   encrypted, what a failure says, and what counts as a new device must not drift
 *   between the desktop app and the browser app.
 * ⚠ It runs where the keys live and NOWHERE ELSE: main.js on desktop (never a renderer —
 *   im.html and buddylist.html render other people's HTML), the shell page in the browser
 *   (never an IM popup). Windows get plaintext + a status label; nothing crypto crosses.
 * ⚠ NO ELECTRON, NO DOM, NO STORAGE API. The host passes in the credential store and a
 *   synchronous settings reader/writer (settings.json on desktop; an IndexedDB-backed
 *   cache in the browser), so test/hol-e2e-session.test.js runs all of this under Node.
 * ⚠ The crypto itself is hol-e2e.js. This file only decides WHEN to use it and
 *   remembers what it has seen.
 *
 * ⚠ THE SERVER IS THE ADVERSARY THIS FILE IS WRITTEN AGAINST. Every key list, roster row,
 *   `bot` flag and timestamp below arrived from it. Independent security review
 *   2026-09-28 (findings H1-H3, M1, M2, L1, L2) — each fix is marked with its id; do not
 *   "simplify" one away without re-reading SPEC-e2e.md §5.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hol-e2e.js'));
  else root.HolE2ESession = factory(root.HolE2E);
})(typeof self !== 'undefined' ? self : this, function (HolE2E) {
'use strict';

const MAX_TEXT = 4000;               // = im.html MAX_LEN = server CONFIG.maxMessageChars
const SEEN_PER_PEER = 300;           // message ids remembered per contact (replay drop, M2)
const LATE_MS = 10 * 60 * 1000;      // sender's clock vs. server's stamp (M2)
const NEW_DEVICE_TAG_MS = 24 * 60 * 60 * 1000;   // "(from a new computer)" window (M1)
const SELF = '*';                    // notices about THIS account, shown in every window

// Same stripping the server's cleanText() does to plaintext IMs — it can't do it to
// ciphertext, so it happens here after decrypting (L1).
function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/g, '')
    .slice(0, MAX_TEXT);
}

function createE2EMain(opts) {
  const sodium = opts.sodium;
  const E = HolE2E.create(sodium);
  const store = opts.store;          // { available(), encrypt(str) -> b64, decrypt(b64) -> str }
  const settings = opts.settings;    // { read() -> object, write(patch) }
  const log = opts.log || function () {};
  const now = opts.now || function () { return Date.now(); };
  const key = E.keyOf;

  let me = '';                       // the SERVER-CONFIRMED screen name (performSignOn)
  let device = null;                 // { d, pk, sk } — sk only in memory while signed on
  let myKeys = [];                   // the server's view of this account's devices
  const dir = new Map();             // peerKey -> { name, keys:[{d,k}], bot }
  const downgraded = new Set();      // peerKeys that HAD keys and now have none
  const botWarned = new Set();       // peerKeys whose bogus `bot` flag was already reported
  const selfShown = new Map();       // peerKey -> Set(text) of self alerts shown in that window
  let selfAlerts = [];               // this session's alerts about THIS account

  // ---------------------------------------------------------------- persistence
  function readJson(name) {
    const s = settings.read() || {};
    const v = s[name];
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }
  // e2eKnown / e2eNotices / e2eSeen are all { <my sn key>: { <peer sn key>: ... } }.
  function mineOf(name) {
    const all = readJson(name);
    const m = all[key(me)];
    return { all: all, mine: (m && typeof m === 'object' && !Array.isArray(m)) ? m : {} };
  }
  function writeMine(name, mine) {
    const r = mineOf(name);
    r.all[key(me)] = mine;
    const patch = {}; patch[name] = r.all;
    safeWrite(patch);
  }
  /* ⚠ A settings write can fail (file locked by antivirus, disk full). It must never throw
   * out of here: this runs inside the handler for an arriving message, and a throw there
   * loses the message (review F5). -> false on failure, and the caller decides. */
  function safeWrite(patch) {
    try { settings.write(patch); return true; } catch (e) {
      log('e2e.settings-write-failed', { keys: Object.keys(patch).join(','), detail: String((e && e.message) || e) });
      return false;
    }
  }

  /* Known devices per contact (and per THIS account, under my own key):
   *   { dev: { <d>: { k, t } }, changedAt }
   * t = when the device first appeared AFTER we already knew this contact (0 for the first
   * set we ever saw); changedAt = an unacknowledged change, cleared by Verify (M1). */
  function knownFor(pk) {
    const v = mineOf('e2eKnown').mine[pk];
    if (!v || typeof v !== 'object' || !v.dev || typeof v.dev !== 'object') return null;
    return v;
  }
  function saveKnown(pk, rec) {
    const m = mineOf('e2eKnown').mine;
    m[pk] = rec;
    writeMine('e2eKnown', m);
  }

  // One-shot lines for a conversation window. PERSISTED, so a change that happens while
  // no window is open — or right before signing off — is still shown next time (M1).
  function addNotice(pk, text) {
    const m = mineOf('e2eNotices').mine;
    const list = Array.isArray(m[pk]) ? m[pk] : [];
    if (list.indexOf(text) !== -1) return;
    list.push(text);
    m[pk] = list.slice(-10);
    writeMine('e2eNotices', m);
  }
  function takeNotices(pk) {
    const m = mineOf('e2eNotices').mine;
    const list = Array.isArray(m[pk]) ? m[pk] : [];
    if (!list.length) return [];
    delete m[pk];
    writeMine('e2eNotices', m);
    return list;
  }
  function addSelfAlert(text) {
    if (selfAlerts.indexOf(text) === -1) selfAlerts.push(text);
    addNotice(SELF, text);
  }

  // Message ids already shown, per contact, across restarts (M2).
  function seenHas(pk, id) {
    const list = mineOf('e2eSeen').mine[pk];
    return Array.isArray(list) && list.indexOf(id) !== -1;
  }
  function seenAdd(pk, id) {
    const m = mineOf('e2eSeen').mine;
    const list = Array.isArray(m[pk]) ? m[pk] : [];
    list.push(id);
    m[pk] = list.slice(-SEEN_PER_PEER);
    writeMine('e2eSeen', m);
  }

  // ---------------------------------------------------------------- identity
  function reset() {
    device = null;                   // the sk string goes with it; JS can't zero a string
    myKeys = [];
    dir.clear(); downgraded.clear(); botWarned.clear(); selfShown.clear();
    selfAlerts = [];
    me = '';
  }
  // Called from main.js performSignOn() on a real success, with body.screenName.
  function setIdentity(screenName) {
    const next = String(screenName || '').trim();
    if (key(next) !== key(me)) reset();
    me = next;
    // Alerts about this account that no window has shown yet (e.g. from last session).
    const pending = mineOf('e2eNotices').mine[SELF];
    if (Array.isArray(pending)) pending.forEach((t) => { if (selfAlerts.indexOf(t) === -1) selfAlerts.push(t); });
  }

  // ---------------------------------------------------------------- local device
  function pkMatchesSk(pk, sk) {
    try {
      const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
      const derived = sodium.crypto_scalarmult_base(sodium.from_base64(sk, B64));
      return sodium.to_base64(derived, B64) === pk;
    } catch (e) { return false; }
  }

  /* -> { d, k } (public parts only) or null. ONLY for the account main itself signed on
   * as — a renderer naming some other account on a shared PC gets nothing.
   * ⚠ No secure store = no key, ever. A private key in cleartext on disk is worse than no
   *   E2E; the window then honestly says "not end-to-end encrypted" (SPEC-e2e.md §2). */
  function deviceFor(screenName) {
    if (!me || key(screenName) !== key(me)) return null;
    if (device) return { d: device.d, k: device.pk };
    if (!store.available()) { log('e2e.no-secure-store', {}); return null; }

    const all = readJson('e2eDevices');
    const rec = all[key(me)];
    if (rec && typeof rec.d === 'string' && E.DEVICE_RE.test(rec.d) && typeof rec.pk === 'string' && typeof rec.skEnc === 'string') {
      let sk = null;
      try { sk = store.decrypt(rec.skEnc); } catch (e) { sk = null; }
      if (sk && pkMatchesSk(rec.pk, sk)) {
        device = { d: rec.d, pk: rec.pk, sk: sk };
        checkSelf();
        return { d: device.d, k: device.pk };
      }
      // Most likely the OS profile changed and the credential store can't unseal it.
      // "New device starts fresh" (Christian's decision) — make a new one.
      log('e2e.device-unreadable', { device: rec.d.slice(0, 6) });
    }

    const nd = E.newDevice();
    let skEnc = null;
    try { skEnc = store.encrypt(nd.sk); } catch (e) { skEnc = null; }
    if (!skEnc) { log('e2e.device-seal-failed', {}); return null; }
    all[key(me)] = { d: nd.d, pk: nd.pk, skEnc: skEnc };
    // A key that couldn't be saved would be a different "new computer" on every start —
    // go without encryption this session instead (labeled), and try again next time.
    if (!safeWrite({ e2eDevices: all })) return null;
    device = nd;
    log('e2e.device-created', { device: nd.d.slice(0, 6) });
    checkSelf();
    return { d: nd.d, k: nd.pk };
  }

  /* H1 — ⚠ NEVER TAKE THE SERVER'S WORD FOR THIS DEVICE'S OWN KEY. If its list carries
   * this device id with some other key, that entry is dropped and the real one used, so
   * our own copies can't be quietly encrypted to someone else. (checkSelf says so loudly.) */
  function myKeysPlusOwn() {
    const out = myKeys.filter((k) => !device || k.d !== device.d);
    if (device) out.push({ d: device.d, k: device.pk });
    return out;
  }

  /* H1 + H2a — this ACCOUNT's own device list, trust-on-first-use like a contact's. A
   * device nobody here has seen before means someone signed on from a new computer — or
   * someone with the password did, or the server invented one. Either way every message
   * to or from this account is readable there from now on, and the owner must hear it. */
  function checkSelf() {
    if (!me) return;
    const selfKey = key(me);
    const known = knownFor(selfKey);
    const cur = {};
    myKeysPlusOwn().forEach((k) => { cur[k.d] = k.k; });
    if (device && myKeys.some((k) => k.d === device.d && k.k !== device.pk)) {
      addSelfAlert('⚠ The server is listing a DIFFERENT encryption key for this computer than the one it ' +
        'actually has. Messages sent to you may be readable by someone else. Sign off and back on; if this ' +
        'keeps appearing, don’t send anything private and tell Christian.');
      log('e2e.own-key-mismatch', {});
    }
    const dev = {};
    const firstTime = !known;
    Object.keys(cur).forEach((d) => {
      const was = known && known.dev[d];
      if (was && was.k === cur[d]) { dev[d] = was; return; }
      dev[d] = { k: cur[d], t: firstTime ? 0 : now() };
      if (firstTime || (device && d === device.d)) return;
      addSelfAlert(was
        ? '⚠ The encryption key of one of YOUR other computers (' + d.slice(0, 6) + ') changed. If you didn’t ' +
          'reinstall Holden On Line there, change your password now.'
        : '⚠ A new computer (' + d.slice(0, 6) + ') was added to your Holden On Line account. It can read your ' +
          'encrypted messages from now on. If that wasn’t you, change your password now and tell Christian.');
      log('e2e.own-device-added', { device: d.slice(0, 6), changed: !!was });
    });
    if (JSON.stringify(known ? known.dev : null) !== JSON.stringify(dev)) saveKnown(selfKey, { dev: dev, changedAt: 0 });
  }

  // -> true when it changed (main then refreshes every open IM window's status).
  function setMyKeys(keys) {
    const next = (Array.isArray(keys) ? keys : []).filter(E.validKey).map((k) => ({ d: k.d, k: k.k }));
    const changed = JSON.stringify(next) !== JSON.stringify(myKeys);
    myKeys = next;
    checkSelf();
    return changed || selfAlerts.length > 0;
  }

  // ---------------------------------------------------------------- directory + TOFU
  /* One observation of a contact's directory entry — from a roster row, a relayed frame's
   * fromKeys, or an im-history reply's keys. All three come from the same server
   * directory, so the latest one wins. Trust on first use: a device we have never seen,
   * a changed key for one we have, all devices replaced, and keys vanishing all say so.
   * -> true when this contact's status may have changed. */
  function observe(name, keysIn, isBot) {
    const pk = key(name);
    if (!pk || !me || pk === key(me)) return false;
    const keys = (Array.isArray(keysIn) ? keysIn : []).filter(E.validKey).map((k) => ({ d: k.d, k: k.k }));
    const prev = dir.get(pk);
    const known = knownFor(pk);
    const hadKeys = !!(known && Object.keys(known.dev).length);
    let bot = (isBot === undefined) ? !!(prev && prev.bot) : !!isBot;

    /* H3 — a real bot never has keys and never HAD any. The server marking a person as a
     * bot would otherwise force plaintext under a neutral grey "not encrypted" label with
     * no warning. Refuse the flag and say why; if keys are gone too, it's a downgrade. */
    if (bot && (keys.length || hadKeys)) {
      bot = false;
      if (!botWarned.has(pk)) {
        botWarned.add(pk);
        addNotice(pk, '⚠ The server labeled ' + name + ' as a robot, but ' + name + ' uses encryption — that ' +
          'label is wrong and was ignored. Compare your safety number (People > Verify Encryption).');
        log('e2e.bot-flag-rejected', { peer: String(name) });
      }
    }

    const entry = { name: String(name), keys: keys, bot: bot };
    dir.set(pk, entry);
    let changed = !prev || JSON.stringify(prev.keys) !== JSON.stringify(keys) || prev.bot !== bot;
    if (bot) return changed;

    if (keys.length) {
      const dev = {};
      let swapped = false, added = false, anyKept = false;
      keys.forEach((k) => {
        const was = known && known.dev[k.d];
        if (was && was.k === k.k) { dev[k.d] = was; anyKept = true; return; }
        if (was) swapped = true; else added = true;
        dev[k.d] = { k: k.k, t: hadKeys ? now() : 0 };
      });
      let changedAt = (known && known.changedAt) || 0;
      if (hadKeys && (swapped || added)) {
        changedAt = changedAt || now();
        if (!anyKept) {
          addNotice(pk, '⚠ NONE of the computers ' + entry.name + ' used before are on their account any more — ' +
            'their encryption keys were all replaced. Unless they told you they started over, don’t send anything ' +
            'private until you compare your safety number (People > Verify Encryption) by phone or in person.');
          log('e2e.peer-devices-replaced', { peer: entry.name });
        } else if (swapped) {
          addNotice(pk, '⚠ ' + entry.name + '’s encryption key changed on a computer they were already using. ' +
            'That should not happen on its own. Before sending anything private, compare your safety number ' +
            '(People > Verify Encryption) by phone or in person.');
          log('e2e.peer-key-swapped', { peer: entry.name });
        } else {
          addNotice(pk, entry.name + ' signed on from a new computer, so your safety number with them changed. ' +
            'Compare it again if you want to be sure (People > Verify Encryption).');
        }
      }
      if (downgraded.delete(pk)) changed = true;
      const rec = { dev: dev, changedAt: changedAt };
      if (JSON.stringify(known) !== JSON.stringify(rec)) { saveKnown(pk, rec); changed = true; }
    } else if (hadKeys && !downgraded.has(pk)) {
      // ⚠ Keep `known` as it was: if the same keys come back, that is not a new device.
      downgraded.add(pk);
      addNotice(pk, '⚠ ' + entry.name + ' used to have end-to-end encryption and now doesn’t, so messages ' +
        'to them will NOT be end-to-end encrypted. They may be on an older copy of Holden On Line.');
      log('e2e.peer-downgraded', { peer: entry.name });
      changed = true;
    }
    return changed;
  }

  // Roster rows as buddylist.html normalized them (screenName, keys, bot).
  // ⚠ A row with NO `keys` array carries no information (buddylist adopts a mid-session
  // account from a presence frame without one) — skipped, never read as "keys vanished",
  // which would fire a false downgrade warning.
  function setRoster(rows) {
    let changed = false;
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (r && r.screenName && Array.isArray(r.keys) && observe(r.screenName, r.keys, r.bot === true)) changed = true;
    });
    return changed;
  }

  function stateOf(peer) {
    const e = dir.get(key(peer));
    if (e && e.bot) return 'bot';
    if (!device) return 'no-local-key';
    return (e && e.keys.length) ? 'e2e' : 'plain';
  }

  // -> the im-e2e-status payload. ⚠ Drains the one-shot notices: call it only when a
  //    window for `peer` exists to show them.
  function statusFor(peer) {
    const pk = key(peer);
    const out = { withUser: peer, state: stateOf(peer) };
    if (downgraded.has(pk) && out.state !== 'bot') out.downgraded = true;
    const known = knownFor(pk);
    if (out.state === 'e2e' && known && known.changedAt) out.unverified = true;
    // Alerts about THIS account go to every window once per session (and are cleared from
    // storage once any window has shown them).
    const shown = selfShown.get(pk) || new Set();
    const self = selfAlerts.filter((t) => !shown.has(t));
    self.forEach((t) => shown.add(t));
    selfShown.set(pk, shown);
    if (self.length) takeNotices(SELF);
    const n = self.concat(takeNotices(pk));
    if (n.length) out.notices = n;
    return out;
  }

  // ---------------------------------------------------------------- send
  /* msg = what im.html sent on 'send-im'. -> { frame } to hand the buddy list, or
   * { error } to show in the window instead. Typing and plaintext pass through untouched.
   * ⚠ If a conversation is 'e2e' and sealing FAILS, the message is NOT sent — silently
   *   falling back to plaintext is exactly the downgrade this feature exists to stop. */
  function outgoing(msg) {
    if (!msg || msg.kind === 'typing' || typeof msg.typing === 'boolean') return { frame: msg };
    if (typeof msg.text !== 'string' || !msg.text || !msg.to) return { frame: msg };
    if (stateOf(msg.to) !== 'e2e') return { frame: msg };
    const entry = dir.get(key(msg.to));
    let env;
    try {
      env = E.seal({
        text: msg.text.slice(0, MAX_TEXT), from: me, to: entry.name, ts: msg.ts || now(),
        device: device, recipients: entry.keys.concat(myKeysPlusOwn())
      });
    } catch (e) {
      log('e2e.seal-failed', { code: e && e.code });
      return { error: '(Not sent — this message could not be encrypted. Try signing off and back on.)' };
    }
    return { frame: { to: msg.to, e2e: env } };
  }

  // ---------------------------------------------------------------- receive
  function failText(code, from) {
    const fromMe = key(from) === key(me);
    if (code === 'no-local-key') {
      return '(An encrypted message arrived, but this computer has no encryption key, so it can’t be read here.)';
    }
    if (code === 'not-for-this-device') {
      return fromMe
        ? '(A message you sent from another computer before this one was set up can’t be read here.)'
        : '(An encrypted message from ' + from + ' wasn’t addressed to this computer — probably sent before ' +
          'you started using it. It can’t be read here.)';
    }
    if (code === 'unknown-sender-device') {
      return '(An encrypted message from ' + from + ' came from a computer of theirs that Holden On Line ' +
        'doesn’t recognize, so it was not shown.)';
    }
    if (code === 'wrong-conversation') {
      return '(An encrypted message that doesn’t belong in this conversation was not shown.)';
    }
    return '(An encrypted message from ' + from + ' could not be verified, so it was not shown.)';
  }

  function openOne(env, from, peer) {
    if (!device) return { ok: false, code: 'no-local-key' };
    const fromMe = key(from) === key(me);
    const e = dir.get(key(from));
    const senderKeys = fromMe ? myKeysPlusOwn() : (e ? e.keys : []);
    try {
      const r = E.open({ envelope: env, frameFrom: from, me: me, peer: peer, device: device, senderKeys: senderKeys });
      return { ok: true, id: r.id, text: cleanText(r.text), ts: r.ts, fd: env.fd };
    } catch (err) {
      log('e2e.open-failed', { from: from, code: (err && err.code) || 'error' });
      return { ok: false, code: (err && err.code) || 'error' };
    }
  }

  /* What the window appends to the sender's name on a decrypted line (M1, M2):
   *  - from a device that appeared after we already knew this contact, within 24 h
   *  - written long before the server says it arrived (a replay, or re-dated) */
  function noteFor(from, r, frameTs) {
    const notes = [];
    const pk = key(from);
    if (pk !== key(me)) {
      const known = knownFor(pk);
      const d = known && known.dev[r.fd];
      if (d && d.t && now() - d.t < NEW_DEVICE_TAG_MS) notes.push('from a new computer');
    }
    if (r.ts && frameTs && Math.abs(r.ts - frameTs) > LATE_MS) notes.push('written earlier, arrived late');
    return notes.length ? ' (' + notes.join('; ') + ')' : '';
  }

  /* A live (or queued) frame from the buddy list. -> { msg, dirChanged }: msg is the
   * 'im-message' payload for the window, or null to drop a replay. Plaintext frames pass
   * through untouched. dirChanged tells the host to refresh the window's label. */
  function incoming(msg) {
    if (!msg || !msg.e2e) return { msg: msg, dirChanged: false };
    const dirChanged = Array.isArray(msg.fromKeys) ? observe(msg.from, msg.fromKeys) : false;
    const out = { from: msg.from, me: msg.me, ts: msg.ts };
    if (msg.queued) out.queued = true;
    const r = openOne(msg.e2e, msg.from, msg.from);
    if (!r.ok) {
      return { msg: Object.assign(out, { sys: true, kind: 'sys', e2eFailed: true, text: failText(r.code, msg.from) }), dirChanged: dirChanged };
    }
    const pk = key(msg.from);
    if (seenHas(pk, r.id)) { log('e2e.replay-dropped', { from: msg.from }); return { msg: null, dirChanged: dirChanged }; }
    seenAdd(pk, r.id);
    // M2 — show when the SENDER wrote it; the server's stamp is only a delivery time.
    const note = noteFor(msg.from, r, msg.ts);
    Object.assign(out, { text: r.text, e2e: true, ts: r.ts || msg.ts });
    if (note) out.e2eNote = note;
    return { msg: out, dirChanged: dirChanged };
  }

  /* An im-history reply ({screenName, messages, keys?}). Every e2e entry is opened here;
   * nothing encrypted reaches the window. History is a replay by design, so no replay
   * drop — but every entry must belong to THIS conversation (L2). */
  function history(payload) {
    if (!payload || !Array.isArray(payload.messages)) return { payload: payload, dirChanged: false };
    const peer = payload.screenName;
    const dirChanged = Array.isArray(payload.keys) ? observe(peer, payload.keys) : false;
    const messages = payload.messages.map((m) => {
      if (!m || !m.e2e) return m;
      const belongs = key(m.from) === key(me) || key(m.from) === key(peer);
      const r = belongs ? openOne(m.e2e, m.from, peer) : { ok: false, code: 'wrong-conversation' };
      if (!r.ok) return { from: m.from, to: m.to, ts: m.ts, text: failText(r.code, m.from), e2eFailed: true };
      const out = { from: m.from, to: m.to, ts: r.ts || m.ts, text: r.text, e2e: true };
      const note = noteFor(m.from, r, m.ts);
      if (note) out.e2eNote = note;
      return out;
    });
    const out = { screenName: payload.screenName, messages: messages };
    if (payload.error) out.error = payload.error;
    return { payload: out, dirChanged: dirChanged };
  }

  // ---------------------------------------------------------------- verify
  /* H2b — the number alone can't reveal an extra device the server added to BOTH views of
   * one account, so the device counts and short ids are part of what people compare.
   * Viewing it counts as acknowledging a change (clears the "safety number changed" flag). */
  function safety(peer) {
    const e = dir.get(key(peer));
    const state = stateOf(peer);
    if (state !== 'e2e') return { state: state, number: null };
    const mine = myKeysPlusOwn();
    const known = knownFor(key(peer));
    if (known && known.changedAt) saveKnown(key(peer), { dev: known.dev, changedAt: 0 });
    return {
      state: state,
      number: E.safetyNumber(me, mine, e.name, e.keys),
      mine: mine.map((k) => (device && k.d === device.d) ? 'this computer' : k.d.slice(0, 6)),
      theirs: e.keys.map((k) => k.d.slice(0, 6))
    };
  }

  return {
    setIdentity, reset, deviceFor, setMyKeys, setRoster, observe,
    statusFor, outgoing, incoming, history, safety,
    // test/diagnostic only — never hands out the secret key
    _me: () => me, _hasDevice: () => !!device
  };
}

return { createE2EMain: createE2EMain, MAX_TEXT: MAX_TEXT, cleanText: cleanText };
});
