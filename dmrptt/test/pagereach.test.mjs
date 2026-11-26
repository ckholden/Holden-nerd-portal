// Page receipt test, wire contract v2 (gw ev "pagereach", 2026-11-26). Run from the repo root:
//   node dmrptt/test/pagereach.test.mjs
// 1. The PAGE-REACH block must be byte-identical in dmrptt/index.html and dmr/desktop/index.html.
// 2. pageReachLines() gives the agreed wording for every case of the v2 frame (tones, aborted, alert, checked, apps).
// 3. Both renderers (phone/PWA and desktop), run from the pages' own source against a small fake DOM with fake timers:
//    "Checking hotspots..." after an ok pageresult with an id; only a pagereach with the same id is shown; the 10 s
//    "No hotspot report came back" fallback; a late receipt still replaces it; an old gw (no id) shows nothing new;
//    plain text only; one screen-reader announcement per status.
// 4. Static wiring in both pages.
// Offline only: no network, nothing sent.
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const WEB = read('dmrptt/index.html'), DESK = read('dmr/desktop/index.html');
function between(s, a, b, name) {
  const i = s.indexOf(a), j = s.indexOf(b);
  if (i < 0 || j < 0 || s.indexOf(a, i + 1) >= 0 || s.indexOf(b, j + 1) >= 0 || j < i) throw new Error('markers missing or doubled: ' + name);
  return s.slice(i, j + b.length);
}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '\n   got  ' + JSON.stringify(a) + '\n   want ' + JSON.stringify(b));

const B = '/* ==== PAGE-REACH-BEGIN ====', E = '/* ==== PAGE-REACH-END ==== */';
const webBlk = between(WEB, B, E, 'web shared'), deskBlk = between(DESK, B, E, 'desk shared');
ok(webBlk === deskBlk, 'PAGE-REACH block differs between dmrptt/index.html and dmr/desktop/index.html: re-copy it');
ok(/^[\x00-\x7f]*$/.test(webBlk), 'PAGE-REACH block is pure ASCII');
const F = new Function(webBlk + '\nreturn {pageReachLines, pageReachName, pageReachJoin, pageReachId, pageReachIsMine, pageReachSay, pageReachCall, W: PAGE_REACH_WAIT_MS, C: PAGE_REACH_CHECKING, LOST: PAGE_REACH_LOST};')();
const L = F.pageReachLines;
eq([F.W, F.C, F.LOST], [10000, 'Checking hotspots...', 'No hotspot report came back'], 'contract v2 constants (10 s, wording)');

// ---- 2. wording ----
const PIN = { ev: 'pagereach', id: 'p1', net: 'HOLDEN 1', tones: true, aborted: false, alert: null, checked: true, on_air: ['KK7RBQ'], offline: ['KJ7DTS', 'KK7ION'], apps: 3 };
const R = (o) => Object.assign({}, PIN, o);
eq(L(PIN, 'KJ7DTS'), [{ cls: 'ok', text: "On the air via Pete's hotspot" }, { cls: 'warn', text: "Offline: your truck hotspot, Dad's hotspot" }],
  'pinned v2 example, viewer Christian (the 11-26 16:40Z case)');
eq(L(PIN, 'kj7dts '), L(PIN, 'KJ7DTS'), 'viewer call is case/space-insensitive');
eq(L(PIN, 'KK7ION'), [{ cls: 'ok', text: "On the air via Pete's hotspot" }, { cls: 'warn', text: "Offline: Christian's hotspot, Dad's hotspot" }],
  'pinned example, viewer Dad');
eq(L(PIN, ''), L(PIN, 'KK7ION'), 'unknown viewer = Christian named, not "your"');
// tones=false: push only / Call Alert only; never "on the air via", whatever the hotspot lists say
eq(L(R({ tones: false }), 'KJ7DTS'), [{ cls: 'ok', text: 'Push sent' }], 'tones=false: "Push sent", no hotspot lines');
eq(L(R({ tones: false, alert: 'KK7ION', on_air: [], offline: ['KK7ION'] }), 'KJ7DTS'), [{ cls: 'ok', text: "Push sent + Call Alert to Dad's radio" }], 'tones=false + alert Dad');
eq(L(R({ tones: false, alert: 'KJ7DTS' }), 'KJ7DTS'), [{ cls: 'ok', text: 'Push sent + Call Alert to your radio' }], 'tones=false + alert to the viewer himself');
eq(L(R({ tones: false, alert: 'KJ7DTS' }), 'KK7ION'), [{ cls: 'ok', text: "Push sent + Call Alert to Christian's radio" }], 'tones=false + alert Christian, Dad viewing');
eq(L(R({ tones: false, alert: 'w7abc' }), 'KJ7DTS'), [{ cls: 'ok', text: "Push sent + Call Alert to W7ABC's radio" }], 'tones=false + alert unknown call');
eq(L(R({ tones: false, alert: { call: 'X' } }), 'KJ7DTS'), [{ cls: 'ok', text: 'Push sent' }], 'tones=false + junk alert: no "[object Object]"');
eq(L(R({ tones: false, checked: false, reason: 'x' }), 'KJ7DTS'), [{ cls: 'ok', text: 'Push sent' }], 'tones=false + checked=false: still just "Push sent"');
ok(!L(R({ tones: false, on_air: ['KK7RBQ'] }), 'KJ7DTS').some((x) => /on the air/i.test(x.text)), 'tones=false never says "on the air"');
// aborted
eq(L(R({ aborted: true }), 'KJ7DTS'), [{ cls: 'warn', text: 'Page canceled: you keyed up' }], 'aborted=true');
eq(L(R({ aborted: true, tones: false }), 'KJ7DTS'), [{ cls: 'warn', text: 'Page canceled: you keyed up' }], 'aborted wins over tones=false');
eq(L(R({ aborted: true, checked: false }), 'KJ7DTS'), [{ cls: 'warn', text: 'Page canceled: you keyed up' }], 'aborted wins over checked=false');
eq(L(R({ aborted: 'yes' }), 'KJ7DTS'), L(PIN, 'KJ7DTS'), 'aborted must be exactly true');
// no hotspot on the air: wording follows apps
eq(L(R({ on_air: [], offline: ['KJ7DTS', 'KK7ION', 'KK7RBQ'], apps: 3 }), 'KJ7DTS'),
  [{ cls: 'warn', text: 'No hotspot heard it. Only the apps got it' }, { cls: 'warn', text: "Offline: your truck hotspot, Dad's hotspot, Pete's hotspot" }],
  'nobody on the air, apps 3');
eq(L(R({ on_air: [], offline: [], apps: 0 }), 'KJ7DTS'),
  [{ cls: 'warn', text: 'No hotspot heard it, and no app was listening. Only the push went out' }], 'apps 0: does not claim the apps got it');
eq(L(R({ on_air: [], offline: [], apps: undefined }), 'KJ7DTS'), [{ cls: 'warn', text: 'No hotspot heard it' }], 'apps omitted (gw could not tell)');
eq(L(R({ on_air: [], offline: [], apps: '3' }), 'KJ7DTS'), [{ cls: 'warn', text: 'No hotspot heard it' }], 'apps not a number = unknown');
eq(L(R({ on_air: ['KK7RBQ', 'KK7ION', 'KJ7DTS'], offline: [] }), 'KJ7DTS'),
  [{ cls: 'ok', text: "On the air via Pete's hotspot, Dad's hotspot and your truck hotspot" }], 'all three on, none offline');
eq(L(R({ on_air: ['KK7RBQ', 'KK7ION'], offline: ['KJ7DTS'] }), 'KJ7DTS'),
  [{ cls: 'ok', text: "On the air via Pete's hotspot and Dad's hotspot" }, { cls: 'warn', text: 'Offline: your truck hotspot' }], 'two on, one off');
eq(L(R({ on_air: ['KJ7DTS'], offline: ['KJ7DTS', 'KK7ION'] }), 'KJ7DTS'),
  [{ cls: 'ok', text: 'On the air via your truck hotspot' }, { cls: 'warn', text: "Offline: Dad's hotspot" }], 'a call in both lists counts as on the air (no contradiction)');
// checked false
eq(L(R({ checked: false, reason: 'the HOLDEN master\'s status page didn\'t answer in time' }), 'KJ7DTS'),
  [{ cls: 'mut', text: "Couldn't check the hotspots: the HOLDEN master's status page didn't answer in time" }], 'checked false with reason');
eq(L(R({ net: 'HOLDEN 2', checked: false, reason: 'hotspot check only works on HOLDEN 1' }), 'KJ7DTS'),
  [{ cls: 'mut', text: "Couldn't check the hotspots: hotspot check only works on HOLDEN 1" }], 'HOLDEN 2');
eq(L(R({ checked: false, reason: undefined }), 'KJ7DTS'), [{ cls: 'mut', text: "Couldn't check the hotspots: no answer from the server" }], 'checked false, no reason');
eq(L(R({ checked: false, reason: { a: 1 } }), 'KJ7DTS'), [{ cls: 'mut', text: "Couldn't check the hotspots: no answer from the server" }], 'non-string reason: no "[object Object]"');
eq(L(R({ checked: false, reason: '   ' }), 'KJ7DTS'), [{ cls: 'mut', text: "Couldn't check the hotspots: no answer from the server" }], 'blank reason');
eq(L(R({ checked: 'yes' }), 'KJ7DTS'), [{ cls: 'mut', text: "Couldn't check the hotspots: no answer from the server" }], 'checked not exactly true = not checked (no false "on the air")');
ok(L(R({ checked: false, reason: 'x'.repeat(500) }), '')[0].text.length === "Couldn't check the hotspots: ".length + 200, 'long reason cut to 200');
// robustness
eq(L(R({ on_air: ['kk7rbq', ' KK7RBQ ', 'KK7RBQ'], offline: ['W7ABC'] }), 'KJ7DTS'),
  [{ cls: 'ok', text: "On the air via Pete's hotspot" }, { cls: 'warn', text: "Offline: W7ABC's hotspot" }], 'lower case + duplicates + an unknown call');
eq(L(R({ on_air: 'KK7RBQ', offline: null, apps: 2 }), 'KJ7DTS'), [{ cls: 'warn', text: 'No hotspot heard it. Only the apps got it' }], 'non-array lists are ignored, never crash');
eq(L(R({ on_air: [null, '', 7, { call: 'KK7RBQ' }, ['KK7ION'], '<b>x</b>'], offline: [undefined], apps: 1 }), 'KJ7DTS'),
  [{ cls: 'warn', text: 'No hotspot heard it. Only the apps got it' }], 'junk entries (numbers, objects, arrays, HTML) are dropped');
eq(L(null, 'KJ7DTS'), [], 'null frame');
eq(L({ ev: 'pageresult', ok: true, id: 'p1' }, 'KJ7DTS'), [], 'another event gives nothing');
eq(L({ ev: 'pagealert', answered: true, id: 3195193 }, 'KJ7DTS'), [], 'pagealert gives nothing');
// id matching
eq([F.pageReachId({ id: 'p1' }), F.pageReachId({ id: 42 }), F.pageReachId({}), F.pageReachId({ id: null }), F.pageReachId({ id: {} }), F.pageReachId(null)],
  ['p1', '42', '', '', '', ''], 'pageReachId');
ok(F.pageReachIsMine('p1', { id: 'p1' }) && !F.pageReachIsMine('p1', { id: 'p2' }) && !F.pageReachIsMine('p1', {}) && !F.pageReachIsMine('', { id: '' }) && !F.pageReachIsMine('', {}),
  'pageReachIsMine: same id only; nothing pending = nothing matches');
eq(F.pageReachSay([{ text: 'On the air via A' }, { text: 'Offline: B' }]), 'On the air via A. Offline: B.', 'screen-reader text adds one full stop');
eq(F.pageReachSay([{ text: 'Checking hotspots...' }, { text: 'Done.' }]), 'Checking hotspots... Done.', 'no doubled full stop');

// ---- 3. renderers: fake DOM + fake timers ----
function fakeEl(id) {
  return { id, children: [], className: '', style: {}, attrs: {}, scrollTop: 0, scrollHeight: 100, _text: '', parentNode: null,
    get childElementCount() { return this.children.length; }, get firstChild() { return this.children[0]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    set textContent(v) { this._text = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; },
    get textContent() { return this._text || this.children.map((c) => c.textContent).join('|'); },
    set innerHTML(v) { throw new Error('innerHTML must not be used for the receipt'); } };
}
const fakeDoc = { createElement: () => fakeEl('') };
function fakeClock() {
  let now = 1000000, seq = 0; const T = new Map();
  return {
    Date: { now: () => now },
    setTimeout: (f, ms) => { seq++; T.set(seq, { f, ms, at: now + ms }); return seq; },
    clearTimeout: (h) => { T.delete(h); },
    pending: (ms) => [...T.values()].filter((t) => ms == null || t.ms === ms).length,
    advance(ms) { const end = now + ms; for (;;) { const due = [...T.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break; T.delete(due[0]); now = due[1].at; due[1].f(); } now = end; },
  };
}
const texts = (el) => el.children.map((c) => c.textContent);
const rows = (el) => el.children.map((c) => [c.className, c.textContent]);

// PWA: run its own renderer block + its real pageAlertText
const webR = between(WEB, '/* ==== PAGE-REACH-PWA-BEGIN ====', '/* ==== PAGE-REACH-PWA-END ==== */', 'pwa renderer');
const pa0 = WEB.indexOf('function pageAlertText(m) {'), pa1 = WEB.indexOf('\n}\n', pa0);
const webPA = WEB.slice(pa0, pa1 + 3);
ok(pa0 > 0 && /No Call Alert answer/.test(webPA), 'PWA pageAlertText found');
ok(!/innerHTML/.test(webR), 'PWA renderer never uses innerHTML');
function webEnv(opts = {}) {
  const clk = fakeClock();
  const box = opts.nobox ? null : fakeEl('pagereach'), chatlog = fakeEl('chatlog'), toasts = [], fits = [];
  const st = { visible: opts.visible !== false };
  const addChat = (who, text, ts, sys, cls) => { const d = fakeEl(''); d.className = 'it' + (sys ? ' sys' : ' room') + (sys && cls ? ' ' + cls : ''); d.textContent = text; chatlog.appendChild(d); return d; };
  const env = new Function('document', '$', 'addChat', 'toast', 'myCall', 'setTimeout', 'clearTimeout', 'chatVisible', 'sizeChatLog', 'Date',
    webBlk + '\n' + webPA + '\n' + webR + '\nreturn {showPageReach, clearPageReach, pageReachOnResult, pageReachOnAlert};')(
    fakeDoc, (id) => (id === 'pagereach' ? box : id === 'chatlog' ? chatlog : null), addChat, (...a) => toasts.push(a), opts.viewer || 'KJ7DTS',
    clk.setTimeout, clk.clearTimeout, () => st.visible, () => fits.push(1), clk.Date);
  // mimic the PWA onmessage branches (pageresult -> pageReachOnResult, pagealert -> pageReachOnAlert, pagereach -> showPageReach)
  const feed = (m) => { if (m.ev === 'pageresult') env.pageReachOnResult(m); else if (m.ev === 'pagealert') env.pageReachOnAlert(m); else if (m.ev === 'pagereach') env.showPageReach(m); };
  return { clk, box, chatlog, toasts, fits, st, env, feed };
}
const RES = { ev: 'pageresult', ok: true, id: 'p1', target: 'ALL', net: 'HOLDEN 1', tones: true, cooldown: 60 };
// old gw: pageresult without id, and its other frames: nothing new at all
let w = webEnv();
[{ ev: 'pageresult', ok: true, target: 'ALL', net: 'HOLDEN 1', tones: true, cooldown: 60 }, { ev: 'pagealert', answered: true, radio: 'KJ7DTS', ms: 1500 },
  { ev: 'pagepush', who: 'Preston', accepted: 1 }].forEach(w.feed);
w.clk.advance(60000);
ok(w.box.children.length === 0 && w.chatlog.children.length === 0 && w.toasts.length === 0 && w.clk.pending() === 0, 'PWA old gw (pageresult without id): nothing new, no timers');
w.feed(R({ id: undefined })); w.feed(PIN);
ok(w.box.children.length === 0 && w.chatlog.children.length === 0, 'PWA: a pagereach with nothing pending is ignored (with or without id)');
// v2 happy path
w = webEnv();
w.feed(RES);
eq(rows(w.box), [['pr mut', 'Checking hotspots...']], 'PWA: "Checking hotspots..." in the box right after pageresult ok');
eq(rows(w.chatlog), [['it sys mut', 'Checking hotspots...']], 'PWA: and in Command Line');
ok(w.clk.pending(10000) === 1, 'PWA: one 10 s receipt timer');
w.feed(R({ id: 'p0' })); w.feed(R({ id: undefined })); w.feed(R({ id: 'P1' }));
eq(texts(w.box), ['Checking hotspots...'], 'PWA: pagereach with another id / no id / other case is ignored');
w.clk.advance(4000); w.feed(PIN);
eq(rows(w.box), [['pr ok', "On the air via Pete's hotspot"], ['pr warn', "Offline: your truck hotspot, Dad's hotspot"]], 'PWA: matching receipt replaces "Checking" in the box');
eq(rows(w.chatlog), [['it sys ok', "On the air via Pete's hotspot"], ['it sys warn', "Offline: your truck hotspot, Dad's hotspot"]], 'PWA: "Checking" chat row removed, receipt rows added');
ok(w.clk.pending(10000) === 0, 'PWA: the 10 s timer is cancelled by the receipt');
eq(w.toasts, [["Offline: your truck hotspot, Dad's hotspot.", 8000, true]], 'PWA: warning toasts quietly (visual only) while Command Line is on screen');
w.clk.advance(20000); w.feed(PIN);
eq(texts(w.box), ["On the air via Pete's hotspot", "Offline: your truck hotspot, Dad's hotspot"], 'PWA: no fallback after a receipt; a duplicate receipt is ignored');
ok(w.chatlog.children.length === 2 && w.toasts.length === 1, 'PWA: duplicate adds no rows and no toast');
ok(w.fits.length > 0, 'PWA: the chat log is re-fitted (PC layout) when the box changes');
w.clk.advance(600000); ok(w.box.children.length === 0, 'PWA: box auto-clears after 10 min');
// toast is announced when Command Line is not on screen
w = webEnv({ visible: false }); w.feed(RES); w.feed(PIN);
eq(w.toasts, [["Offline: your truck hotspot, Dad's hotspot.", 8000, false]], 'PWA: off the Command Line, the warning toast is the announcement');
w = webEnv(); w.feed(RES); w.feed(R({ offline: [] }));
eq(w.toasts, [], 'PWA: all good = no toast');
// fallback: no receipt within 10 s
w = webEnv(); w.feed(RES); w.clk.advance(9999);
eq(texts(w.box), ['Checking hotspots...'], 'PWA: still checking at 9.999 s');
w.clk.advance(1);
eq(rows(w.box), [['pr mutwarn', 'No hotspot report came back']], 'PWA: 10 s with no receipt: "No hotspot report came back" (muted warning)');
eq(rows(w.chatlog), [['it sys mutwarn', 'No hotspot report came back']], 'PWA: fallback replaces the "Checking" chat row');
eq(w.toasts, [], 'PWA: fallback does not toast while Command Line is on screen (the log announces it)');
w.feed(R({ id: 'p0' })); eq(texts(w.box), ['No hotspot report came back'], 'PWA: after the fallback another id is still ignored');
w.feed(PIN);
eq(texts(w.box), ["On the air via Pete's hotspot", "Offline: your truck hotspot, Dad's hotspot"], 'PWA: a late receipt with the same id still replaces the fallback');
eq(texts(w.chatlog), ['No hotspot report came back', "On the air via Pete's hotspot", "Offline: your truck hotspot, Dad's hotspot"], 'PWA: chat keeps the history (late)');
w = webEnv({ visible: false }); w.feed(RES); w.clk.advance(10000);
eq(w.toasts, [['No hotspot report came back', 8000]], 'PWA: off the Command Line, the fallback toasts (announced) so it is never silent');
// a refused page does not touch an earlier receipt; a new page replaces everything
w = webEnv(); w.feed(RES); w.feed(PIN); w.feed({ ev: 'pageresult', ok: false, reason: 'cooldown', wait: 40 });
eq(texts(w.box), ["On the air via Pete's hotspot", "Offline: your truck hotspot, Dad's hotspot"], 'PWA: pageresult ok:false leaves the box alone');
w.feed(Object.assign({}, RES, { id: 'p2' }));
eq(texts(w.box), ['Checking hotspots...'], 'PWA: the next page starts a fresh check');
w.feed(PIN); eq(texts(w.box), ['Checking hotspots...'], 'PWA: the old page\'s receipt (p1) cannot fill the new page (p2)');
w.feed(R({ id: 'p2', on_air: ['KK7RBQ', 'KJ7DTS', 'KK7ION'], offline: [] }));
eq(texts(w.box), ["On the air via Pete's hotspot, your truck hotspot and Dad's hotspot"], 'PWA: p2 receipt shown');
// pressing a page button (clearPageReach) drops the pending check
w = webEnv(); w.feed(RES); w.env.clearPageReach();
ok(w.box.children.length === 0 && w.chatlog.children.length === 0 && w.clk.pending(10000) === 0, 'PWA: page press clears box, "Checking" row and timer');
w.feed(PIN); ok(w.box.children.length === 0, 'PWA: a receipt for the cleared page is ignored');
// tones=false + Call Alert, both orders of pagealert
const AL = { ev: 'pagealert', target: 'KK7ION', radio: 'KK7ION', id: 3195193, answered: true, started: false, ms: 1500 };
w = webEnv(); w.feed(Object.assign({}, RES, { target: 'KK7ION', alert: true, tones: false })); w.feed(R({ tones: false, alert: 'KK7ION' }));
eq(rows(w.box), [['pr ok', "Push sent + Call Alert to Dad's radio"]], 'PWA: tones=false + alert');
w.feed(AL);
eq(rows(w.box), [['pr ok', "Push sent + Call Alert to Dad's radio"], ['pr ok', "KK7ION's radio got the Call Alert (1.5 s)."]], 'PWA: Call Alert answer added to the box when it comes after');
eq(texts(w.chatlog), ["Push sent + Call Alert to Dad's radio"], 'PWA: pageReachOnAlert adds no chat row (the pagealert branch already does)');
eq(w.toasts, [], 'PWA: "Push sent" does not toast');
w = webEnv(); w.feed(Object.assign({}, RES, { target: 'KK7ION', alert: true, tones: false }));
w.feed(Object.assign({}, AL, { answered: false, reason: "the radio didn't answer", fallback: 'tones', net: 'HOLDEN 1' }));
w.feed(R({ tones: false, alert: 'KK7ION' }));
eq(rows(w.box), [['pr ok', "Push sent + Call Alert to Dad's radio"], ['pr warn', "No Call Alert answer from KK7ION's radio: the radio didn't answer. The page tones went out on HOLDEN 1 instead."]],
  'PWA: Call Alert answer that came first is shown with the receipt');
w = webEnv(); w.feed(AL); w.clk.advance(5000); w.feed(Object.assign({}, RES, { alert: true, tones: false })); w.feed(R({ tones: false, alert: 'KK7ION' }));
eq(texts(w.box), ["Push sent + Call Alert to Dad's radio"], 'PWA: a Call Alert answer from before this page is not shown');
w.feed(Object.assign({}, AL, { radio: 'KK7RBQ' }));
eq(texts(w.box), ["Push sent + Call Alert to Dad's radio"], 'PWA: another radio\'s Call Alert answer is not added');
// aborted
w = webEnv(); w.feed(RES); w.feed(R({ aborted: true }));
eq(rows(w.box), [['pr warn', 'Page canceled: you keyed up']], 'PWA: aborted');
eq(w.toasts, [['Page canceled: you keyed up.', 8000, true]], 'PWA: aborted toasts (quiet on Command Line)');
// plain text only
w = webEnv(); w.feed(RES); w.feed(R({ checked: false, reason: '<img src=x onerror=alert(1)>' }));
eq(texts(w.box), ["Couldn't check the hotspots: <img src=x onerror=alert(1)>"], 'PWA: reason shown as text only');
eq(w.toasts, [], 'PWA: a muted "could not check" line does not toast');
// old cached HTML without the box
w = webEnv({ nobox: true }); w.feed(RES); w.feed(PIN);
eq(texts(w.chatlog), ["On the air via Pete's hotspot", "Offline: your truck hotspot, Dad's hotspot"], 'PWA: no #pagereach box still gives the chat lines, no crash');
// Dad viewing
w = webEnv({ viewer: 'KK7ION' }); w.feed(RES); w.feed(PIN);
eq(texts(w.box), ["On the air via Pete's hotspot", "Offline: Christian's hotspot, Dad's hotspot"], 'PWA: Dad viewing names Christian');

// Desktop renderer
const deskR = between(DESK, '/* ==== PAGE-REACH-DESK-BEGIN ====', '/* ==== PAGE-REACH-DESK-END ==== */', 'desk renderer');
ok(!/innerHTML/.test(deskR), 'desktop renderer never uses innerHTML');
function deskEnv(viewer = 'KJ7DTS', opts = {}) {
  const clk = fakeClock();
  const els = { chatlog: fakeEl('chatlog'), pagereachsr: opts.nosr ? null : fakeEl('pagereachsr') };
  const env = new Function('document', '$', 'me', 'setTimeout', 'clearTimeout', 'Date',
    webBlk + '\n' + deskR + '\nreturn {showPageReach, pageReachOnResult};')(fakeDoc, (id) => els[id] || null, { call: viewer }, clk.setTimeout, clk.clearTimeout, clk.Date);
  const said = [];
  const feed = (m) => { if (m.ev === 'pageresult') env.pageReachOnResult(m); else if (m.ev === 'pagereach') env.showPageReach(m); };
  const settle = () => { clk.advance(100); if (els.pagereachsr) said.push(els.pagereachsr.textContent); };
  return { clk, els, feed, settle, said };
}
let d = deskEnv();
[{ ev: 'pageresult', ok: true, target: 'ALL', net: 'HOLDEN 1', tones: true }, { ev: 'pagealert', answered: true, radio: 'KJ7DTS' }, PIN].forEach(d.feed);
d.clk.advance(60000);
ok(d.els.chatlog.children.length === 0 && d.els.pagereachsr.textContent === '' && d.clk.pending() === 0, 'desktop old gw: nothing new, no timers');
d = deskEnv(); d.feed(RES);
eq(rows(d.els.chatlog), [['it pr-mut', 'Checking hotspots...']], 'desktop: "Checking hotspots..." row');
ok(d.els.pagereachsr.textContent === '', 'desktop: status region emptied first');
d.settle(); eq(d.said, ['Checking hotspots...'], 'desktop: status region then says "Checking hotspots..."');
d.feed(R({ id: 'p0' })); eq(texts(d.els.chatlog), ['Checking hotspots...'], 'desktop: other id ignored');
d.feed(PIN); d.settle();
eq(rows(d.els.chatlog), [['it pr-ok', "On the air via Pete's hotspot"], ['it pr-warn', "Offline: your truck hotspot, Dad's hotspot"]], 'desktop: receipt rows replace the "Checking" row');
eq(d.said[1], "On the air via Pete's hotspot. Offline: your truck hotspot, Dad's hotspot.", 'desktop: one screen-reader sentence, no ".."');
ok(d.clk.pending(10000) === 0, 'desktop: 10 s timer cancelled');
d.feed(PIN); ok(d.els.chatlog.children.length === 2, 'desktop: duplicate receipt ignored');
// same words twice in a row are re-announced (region emptied, then set)
d.feed(Object.assign({}, RES, { id: 'p2' })); d.settle(); d.feed(R({ id: 'p2' }));
ok(d.els.pagereachsr.textContent === '', 'desktop: identical receipt text: region emptied before it is set again');
d.settle(); eq(d.said.slice(-1), ["On the air via Pete's hotspot. Offline: your truck hotspot, Dad's hotspot."], 'desktop: identical text set again after the pause');
// fallback + late
d = deskEnv(); d.feed(RES); d.clk.advance(10000); d.settle();
eq(rows(d.els.chatlog), [['it pr-mutwarn', 'No hotspot report came back']], 'desktop: 10 s fallback row (muted warning) replaces "Checking"');
eq(d.els.pagereachsr.textContent, 'No hotspot report came back.', 'desktop: fallback announced');
d.feed(PIN);
eq(texts(d.els.chatlog), ['No hotspot report came back', "On the air via Pete's hotspot", "Offline: your truck hotspot, Dad's hotspot"], 'desktop: late receipt with the same id still shows');
d = deskEnv(); d.feed(RES); d.feed({ ev: 'pageresult', ok: false, reason: 'busy' }); d.feed(PIN);
ok(d.els.chatlog.children.length === 2, 'desktop: a refused page does not cancel the pending check');
d = deskEnv('KK7ION'); d.feed(RES); d.feed(R({ tones: false, alert: 'KJ7DTS' }));
eq(texts(d.els.chatlog), ["Push sent + Call Alert to Christian's radio"], 'desktop: tones=false + alert, Dad viewing');
d = deskEnv(); d.feed(RES); d.feed(R({ aborted: true }));
eq(rows(d.els.chatlog), [['it pr-warn', 'Page canceled: you keyed up']], 'desktop: aborted');
d = deskEnv(); d.feed(RES); d.feed(R({ checked: false, reason: '<b>x</b>' }));
eq(rows(d.els.chatlog), [['it pr-mut', "Couldn't check the hotspots: <b>x</b>"]], 'desktop: muted line, text only');
d = deskEnv('KJ7DTS', { nosr: true }); d.feed(RES); d.feed(PIN);
ok(d.els.chatlog.children.length === 2, 'desktop: no status region (old cached page shape) still works');

// ---- 4. static wiring ----
const count = (s, x) => s.split(x).length - 1;
ok(count(WEB, "else if(m.ev==='pagereach'){ showPageReach(m); }") === 1, 'PWA onmessage routes pagereach exactly once');
ok(count(WEB, 'pageReachOnResult(m);') === 1 && /else if\(m\.ev==='pageresult'\)\{[^\n]*pageReachOnResult\(m\);/.test(WEB), 'PWA pageresult branch calls pageReachOnResult once');
ok(count(WEB, 'pageReachOnAlert(m); }') === 1 && /else if\(m\.ev==='pagealert'\)\{[^\n]*pageReachOnAlert\(m\); \}/.test(WEB), 'PWA pagealert branch calls pageReachOnAlert');
ok(/<div id="pagereach" aria-hidden="true"><\/div><\/div>/.test(WEB) && !/id="pagereach" role=/.test(WEB), 'PWA box: empty, aria-hidden, no live role (Command Line announces)');
ok(/<div id="chatlog" role="log" aria-live="polite"><\/div>/.test(WEB), 'PWA Command Line is the live log');
ok(/function toast\(s,ms,quiet\)/.test(WEB) && /if\(quiet\)t\.setAttribute\('aria-hidden','true'\); else t\.removeAttribute\('aria-hidden'\);/.test(WEB), 'PWA toast: quiet toasts are aria-hidden, every other toast is announced as before');
ok(/paintChatSeg\(\); \} return d; \}/.test(WEB), 'PWA addChat returns its row');
ok(/clearPageReach\(\);\} \}/.test(WEB), 'PWA: pressing a page button clears the old receipt');
ok(count(DESK, "} else if (m.ev === 'pagereach') {") === 1, 'desktop handle() routes pagereach exactly once');
ok(count(DESK, 'pageReachOnResult(m);') === 1 && /if \(np\) addChat\('', np, 0, true\);\n    pageReachOnResult\(m\);/.test(DESK), 'desktop pageresult branch calls pageReachOnResult');
ok(/<div id="pagereachsr" class="sronly" role="status" aria-live="polite"><\/div>/.test(DESK), 'desktop status region present and empty');
ok(!/id="chatlog"[^>]*aria-live/.test(DESK), 'desktop Command Line is not a live region (no double announcement)');
ok(count(DESK, '.warn{color:var(--rxon-fg)') === 1 && /'it pr-' \+ x\.cls/.test(DESK), 'desktop avoids the global red .warn class');
ok(/#chatlog \.it\.pr-mutwarn\{/.test(DESK) && /#pagereach \.pr\.mutwarn\{/.test(WEB) && /#chatlog \.it\.sys\.mutwarn\{/.test(WEB), 'muted-warning styles exist');
ok(count(WEB, 'build hd2.20 &middot; 2026-11-26') === 2 && count(WEB, "ver:'hd2.20'") === 1 && !/hd2\.19 &middot;/.test(WEB), 'PWA build tag hd2.20');

console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
