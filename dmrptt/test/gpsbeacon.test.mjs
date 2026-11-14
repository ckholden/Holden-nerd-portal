// Tests for dmrptt/gpsbeacon.js (hd2.16 location share, gps-share contract) and the family-pin helpers in dmrptt/lastheard.js.
// Run from the repo root:  node dmrptt/test/gpsbeacon.test.mjs
// Offline only: a fake DOM and fake geolocation, nothing is sent anywhere. Christian uses an iPhone AND an Android tablet
// (Galaxy Tab S6 Lite, Chrome, sometimes in "desktop site" mode), so every device rule is checked for both.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const GB = require('../gpsbeacon.js'), P = GB.P;
let fail = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fail++; console.log('FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ': got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));

// ---- the app's own isAndroidPtt(), taken from index.html, run against each device's navigator
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const iap = html.match(/function isAndroidPtt\(\)\{[^\n]*?\}(?= *\/\/)/);
ok(iap, 'isAndroidPtt found in index.html');
const isAndroidPtt = (nav) => new Function('navigator', iap[0] + '; return isAndroidPtt();')(nav);

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  tab: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  tabDesk: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  aphone: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const DEV = [
  // name, ua, maxTouchPoints, short CSS side, kind, os
  ['iPhone', UA.iphone, 5, 393, 'phone', 'ios'],
  ['iPad (asks as a Mac)', UA.ipad, 5, 820, 'tablet', 'ios'],
  ['Galaxy Tab S6 Lite, Chrome', UA.tab, 5, 600, 'tablet', 'android'],
  ['Galaxy Tab S6 Lite, Chrome desktop site', UA.tabDesk, 5, 600, 'tablet', 'android'],
  ['Android phone, Chrome', UA.aphone, 5, 412, 'phone', 'android'],
  ['Android phone, desktop site', UA.tabDesk, 5, 412, 'phone', 'android'],
  ['Windows PC', UA.win, 0, 1080, 'pc', 'other'],
  ['Mac (no touch)', UA.ipad, 0, 900, 'pc', 'other'],
];
for (const [name, ua, touch, ms, kind, os] of DEV) {
  const o = { ua, touch, android: isAndroidPtt({ userAgent: ua, maxTouchPoints: touch }), minScreen: ms };
  eq(P.deviceKind(o), kind, name + ' kind');
  eq(P.osKind(o), os, name + ' os');
}
eq(P.defaultSsid('tablet'), 7, 'tablet -7');
eq(P.defaultSsid('phone'), 8, 'phone -8');

// ---- SSIDs
eq(P.ssidList(), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15], 'SSID picker never offers -9, -10, -13');
ok(!P.validSsid(9) && !P.validSsid(10) && !P.validSsid(13) && !P.validSsid(0) && !P.validSsid(16) && !P.validSsid('7') && !P.validSsid(7.5), 'blocked SSIDs');

// ---- fixFrom: iOS reports -1 for unknown speed/heading; Chrome gives NaN/null heading when still
const now = 1794640000000;
let f = P.fixFrom({ coords: { latitude: 44.2301, longitude: -120.9744, accuracy: 12, speed: 6.5, heading: 270.4, altitude: 980.2 }, timestamp: now }, now);
eq([f.spd, f.hdg, f.alt, f.tms], [23.400000000000002, 270, 980.2, now], 'm/s -> km/h, heading rounded');
f = P.fixFrom({ coords: { latitude: 44, longitude: -121, accuracy: 5, speed: -1, heading: -1, altitude: null }, timestamp: now }, now);
eq([f.spd, f.hdg, f.alt], [null, null, null], 'iOS -1 = unknown');
f = P.fixFrom({ coords: { latitude: 44, longitude: -121, accuracy: 5, speed: 0, heading: NaN }, timestamp: 0 }, now);
eq([f.spd, f.hdg, f.tms], [0, null, now], 'Chrome NaN heading; missing timestamp uses now');
eq(P.fixFrom({ coords: {} }, now), null, 'no coordinates');
eq(P.fixFrom({ coords: { latitude: 44, longitude: -121 }, timestamp: now }, now).acc, 1e9, 'no accuracy = useless');

// ---- SmartBeaconing
const at = (lat, lon, o) => Object.assign({ lat, lon, acc: 10, spd: null, hdg: null, alt: null, tms: now }, o || {});
eq(P.decide(null, at(44, -121, { acc: 101 }), now).why, 'acc', 'accuracy over 100 m dropped');
eq(P.decide(null, at(44, -121), now).why, 'first', 'first fix sends');
const last = { lat: 44, lon: -121, hdg: 0, t: now };
eq(P.decide(last, at(44.01, -121), now + 19999).why, 'gap', 'never inside 20 s');
eq(P.decide(last, at(44.0014, -121), now + 20000).why, 'moved', '>= 150 m');
eq(P.decide(last, at(44.0012, -121), now + 20000).why, 'still', '~133 m is not a move');
eq(P.decide(last, at(44, -121, { spd: 15, hdg: 30 }), now + 20000).why, 'turn', 'turned 30 deg at 15 km/h');
eq(P.decide(last, at(44, -121, { spd: 14.9, hdg: 90 }), now + 20000).why, 'still', 'turn too slow');
eq(P.decide(last, at(44, -121, { spd: 50, hdg: 29 }), now + 20000).why, 'still', '29 deg is not a turn');
eq(P.decide(Object.assign({}, last, { hdg: 350 }), at(44, -121, { spd: 50, hdg: 20 }), now + 20000).why, 'turn', 'turn across north');
eq(P.decide(last, at(44, -121), now + 600000).why, 'beat', '10 min heartbeat');
eq(P.hdgDiff(350, 10), 20, 'hdgDiff wraps');
ok(Math.abs(P.meters({ lat: 44, lon: -121 }, { lat: 45, lon: -121 }) - 111195) < 50, 'haversine 1 deg lat');
// a drive (60 km/h, one fix a second, 10 min) then parked (30 min): about every 20 s moving, every 10 min parked
{ let L = null, sent = 0, t = now; const step = 16.67 / 111195;
  for (let i = 0; i < 600; i++, t += 1000) { const fx = at(44 + i * step, -121, { spd: 60, hdg: 0, tms: t }); if (P.decide(L, fx, t).send) { sent++; L = { lat: fx.lat, lon: fx.lon, hdg: 0, t }; } }
  ok(sent >= 29 && sent <= 31, 'drive: ~30 sends in 10 min, got ' + sent);
  let parked = 0; const pl = L.lat;
  for (let i = 0; i < 1800; i++, t += 1000) { const fx = at(pl, -121, { spd: 0, tms: t }); if (P.decide(L, fx, t).send) { parked++; L = { lat: fx.lat, lon: fx.lon, hdg: null, t }; } }
  eq(parked, 3, 'parked 30 min: 3 heartbeats'); }

// ---- the pinned wire message
const msg = P.posMsg({ lat: 44.230149, lon: -120.974449, acc: 12.4, spd: 23.46, hdg: 270, alt: 980.4, tms: 1794640000400 }, true, 7);
eq(Object.keys(msg), ['cmd', 'lat', 'lon', 'acc', 'spd', 'hdg', 'alt', 'ts', 'aprs', 'ssid'], 'contract field order');
eq(msg, { cmd: 'pos', lat: 44.23015, lon: -120.97445, acc: 12, spd: 23.5, hdg: 270, alt: 980, ts: 1794640000, aprs: true, ssid: 7 }, 'contract values');
eq(P.posMsg({ lat: 1, lon: 2, acc: 3, spd: null, hdg: null, alt: null, tms: 5000 }, false, 8), { cmd: 'pos', lat: 1, lon: 2, acc: 3, spd: null, hdg: null, alt: null, ts: 5, aprs: false, ssid: 8 }, 'nulls stay null');

// ---- words
eq([P.ageText(10), P.ageText(100), P.ageText(3599), P.ageText(7300)], ['just now', '2 min', '60 min', '2 h'], 'ageText');
eq([P.leftText(0), P.leftText(30), P.leftText(1500), P.leftText(7200), P.leftText(7800)], ['0 min', '1 min', '25 min', '2 h', '2 h 10 min'], 'leftText');
eq([P.clampHours(1), P.clampHours('3'), P.clampHours(0), P.clampHours(9), P.clampHours(undefined), P.clampHours('x')], [1, 3, 4, 4, 4, 4], 'clampHours: 1..4, else 4');
const S0 = 1794640000;
eq(P.chipText({ on: false }), null, 'no chip when off');
eq(P.chipText({ on: true, until: S0 + 3 * 3600, nowS: S0, perm: 'granted', visible: true, wsOpen: true }), '📍 Sharing · 3 h left', 'time left');
eq(P.chipText({ on: true, until: S0 + 20 * 60, nowS: S0, perm: 'granted', visible: true, wsOpen: true }), '📍 Sharing · 20 min left · tap to stop', 'near the end: tap to stop');
eq(P.chipText({ on: true, until: S0 + 3600, nowS: S0, perm: 'granted', visible: false }), '📍 Sharing · paused', 'paused in the background');
eq(P.chipText({ on: true, until: S0 + 3600, nowS: S0, perm: 'granted', visible: true, wsOpen: false }), '📍 Sharing · offline', 'offline');
eq(P.chipText({ on: true, until: S0 + 3600, nowS: S0, perm: 'denied', visible: true }), '📍 Sharing · location blocked', 'blocked');
eq(P.chipText({ on: true, until: 0, nowS: S0, perm: 'granted', visible: true, wsOpen: true }), '📍 Sharing', 'no end time: no "0 min left"');
for (const os of ['ios', 'android', 'other']) for (const w of ['denied', 'nogps', 'approx']) { const h = P.helpSteps(os, w); ok(h.title && h.steps.length, os + ' ' + w + ' help'); }
ok(/Safari Websites/.test(P.helpSteps('ios', 'denied').steps.join(' ')) && /Website Settings/.test(P.helpSteps('ios', 'denied').steps.join(' ')), 'iOS denied: Safari Websites + aA Website Settings');
ok(/Precise/.test(P.helpSteps('ios', 'approx').steps.join(' ')), 'iOS approximate: Precise Location');
ok(/Site settings/.test(P.helpSteps('android', 'denied').steps.join(' ')) && /Apps . Chrome/.test(P.helpSteps('android', 'denied').steps.join(' ')), 'Android denied: Chrome site settings + app permission');
ok(/precise/i.test(P.helpSteps('android', 'approx').steps.join(' ')), 'Android approximate: precise location');
ok(/Allow While Using App/.test(P.askText('ios')) && /Precise/.test(P.askText('android')), 'ask texts');
eq(P.ackNote(true, 'off').length > 0, true, 'off ack explained when APRS is on');
eq(P.ackNote(false, 'off'), '', 'off ack silent when APRS is off');

// ---- prefs: per device, try/catch. Whether sharing is ON is never saved on the device (gw holds it).
const store = (init) => { const m = Object.assign({}, init); return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
eq(P.loadPrefs(store(), 'tablet'), { aprs: false, ssid: 7, hours: 4 }, 'defaults, tablet -7, 4 h');
eq(P.loadPrefs(store({ hd2_gps: '{bad' }), 'phone'), { aprs: false, ssid: 8, hours: 4 }, 'bad JSON = default');
eq(P.loadPrefs(store({ hd2_gps: '{"share":true,"aprs":true,"ssid":10,"hours":9}' }), 'phone'), { aprs: true, ssid: 8, hours: 4 }, 'old "share" ignored; -10 refused; 9 h clamped');
eq(P.loadPrefs(store({ hd2_gps: '{"aprs":false,"ssid":12,"hours":2}' }), 'phone'), { aprs: false, ssid: 12, hours: 2 }, 'saved choices kept');
eq(P.loadPrefs({ getItem() { throw new Error('private mode'); } }, 'phone').hours, 4, 'storage throws');
ok(P.savePrefs({ setItem() { throw new Error('quota'); } }, { aprs: true }) === false, 'save throws -> false');
{ const s = store(); P.savePrefs(s, { share: true, aprs: true, ssid: 13, hours: 0 }); eq(JSON.parse(s.m.hd2_gps), { aprs: true, ssid: 8, hours: 4 }, 'save normalises, never saves "share"'); }

// ---- the controller in a fake browser, once per device
function el(id) {
  const e = { id, hidden: false, checked: false, disabled: false, value: '', _t: '', children: [], options: [], className: '', style: {},
    classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } },
    appendChild(c) { this.children.push(c); if (c.tag === 'option') { this.options.push(c); if (!this.value) this.value = c.value; } return c; },
    scrollIntoView() {} };
  Object.defineProperty(e, 'textContent', { get() { return e._t + e.children.map((c) => c.textContent).join(' '); }, set(v) { e._t = String(v); e.children = []; } });
  return e;
}
function browser(dev, opts) {
  const [, ua, touch, ms] = dev; opts = opts || {};
  const ids = {}; ['gpscard', 'gpschip', 'gpsshare', 'gpshours', 'gpsuntil', 'gpsaprs', 'gpsaprsrow', 'gpsssid', 'gpsssidrow', 'gpsssidsub', 'gpsstat', 'gpshelp'].forEach((i) => { ids[i] = el(i); });
  ids.gpscard.hidden = ids.gpschip.hidden = ids.gpshelp.hidden = true;
  const ls = store(opts.saved ? { hd2_gps: JSON.stringify(opts.saved) } : {});
  const geo = { watches: 0, cleared: 0, ok: null, err: null, opts: null,
    watchPosition(a, b, o) { this.watches++; this.ok = a; this.err = b; this.opts = o; return this.watches; }, clearWatch() { this.cleared++; this.ok = null; } };
  const listeners = {}, timers = [];
  const doc = { visibilityState: 'visible', getElementById: (i) => ids[i] || null, createElement: (t) => { const x = el(''); x.tag = t; return x; },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } };
  const sent = [];
  const win = { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } };
  const ctx = { window: win, document: doc, navigator: { userAgent: ua, maxTouchPoints: touch, geolocation: geo }, screen: { width: ms, height: ms * 1.6 },
    localStorage: ls, setTimeout: (f, t) => { timers.push({ f, t }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Date, JSON, Math, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../gpsbeacon.js', import.meta.url), 'utf8'), ctx);
  const api = { isOperator: () => opts.operator !== false, isAndroid: () => isAndroidPtt({ userAgent: ua, maxTouchPoints: touch }),
    wsOpen: () => true, send: (o) => { sent.push(o); return true; }, myCall: () => 'KJ7DTS', openSettings() {}, onFamily: (p) => { sent.push({ fam: p }); } };
  ctx.window.GB.init(api);
  const fire = (t) => (listeners[t] || []).forEach((f) => f());
  const change = (id, v) => { if (typeof v === 'boolean') ids[id].checked = v; else ids[id].value = v; ids[id].onchange.call(ids[id]); };
  const fixAt = (lat, acc, t) => geo.ok && geo.ok({   // no watch = no fixes
    coords: { latitude: lat, longitude: -121, accuracy: acc || 8, speed: 10, heading: 90, altitude: 900 }, timestamp: t || Date.now() });
  const share = (on, why, secs) => ctx.window.GB.onFrame({ ev: 'share', on, until: on ? Math.floor(Date.now() / 1000) + secs : null, why });
  const pos = () => sent.filter((m) => m.cmd === 'pos');
  return { GB: ctx.window.GB, ids, geo, sent, doc, fire, change, fixAt, ls, timers, share, pos };
}
for (const dev of DEV) {
  const name = dev[0], b = browser(dev), defSsid = dev[4] === 'tablet' ? 7 : 8;
  eq(b.sent, [{ cmd: 'share' }], name + ': asks gw for the share state on connect');
  ok(b.ids.gpscard.hidden && b.ids.gpschip.hidden && b.geo.watches === 0, name + ': card hidden until gw answers (an old gw never does)');
  b.share(false, 'query');
  ok(!b.ids.gpscard.hidden, name + ': card shown once gw supports share (phone, tablet and PC)');
  ok(b.ids.gpschip.hidden && b.geo.watches === 0 && !b.ids.gpsshare.checked, name + ': off by default, no GPS asked');
  ok(b.ids.gpsaprs.disabled && b.ids.gpsssid.disabled, name + ': APRS switch + SSID need sharing on');
  eq(b.ids.gpshours.options.map((o) => o.value).join(','), '1,2,3,4', name + ': duration picker 1-4 h');
  eq(b.ids.gpshours.value, '4', name + ': 4 h by default');
  eq(b.ids.gpsssid.options.map((o) => o.value).join(','), '1,2,3,4,5,6,7,8,11,12,14,15', name + ': SSID options');
  eq(b.ids.gpsssid.value, String(defSsid), name + ': default SSID');
  b.change('gpshours', '2');
  eq(b.sent.length, 1, name + ': picking a time while off sends nothing');
  b.change('gpsshare', true);
  eq(b.sent[b.sent.length - 1], { cmd: 'share', on: true, hours: 2 }, name + ': the switch asks gw to start, with the chosen hours');
  ok(b.geo.watches === 1 && b.geo.opts.enableHighAccuracy === true, name + ': watch starts inside the tap, high accuracy');
  ok(b.ids.gpsshare.checked && /Turning on/.test(b.ids.gpsstat.textContent), name + ': switch stays on while gw answers');
  b.fixAt(44.0, 8);
  eq(b.pos().length, 0, name + ': no position before gw says on');
  b.share(true, 'start', 7200);
  eq(b.geo.watches, 1, name + ': same watch carries on');
  eq(b.pos().length, 1, name + ': the waiting fix goes out the moment gw says on');
  eq([b.pos()[0].aprs, b.pos()[0].ssid], [false, defSsid], name + ': family-only pos');
  ok(/Sharing · (2 h|1 h 59 min) left/.test(b.ids.gpschip.textContent) && !b.ids.gpschip.hidden, name + ': chip shows the time left');
  ok(/On until .*left/.test(b.ids.gpsuntil.textContent), name + ': card shows the end time');
  b.GB.onFrame({ ev: 'posok', aprs: 'off' });
  ok(!/APRS isn/.test(b.ids.gpsstat.textContent), name + ': off ack quiet while APRS is off');
  b.change('gpsaprs', true); b.change('gpsssid', '12');
  b.fixAt(44.0, 8);
  eq([b.pos()[1].aprs, b.pos()[1].ssid], [true, 12], name + ': APRS on, chosen SSID, sent at once after a settings change');
  b.GB.onFrame({ ev: 'posok', aprs: 'off' });
  ok(/APRS isn/.test(b.ids.gpsstat.textContent), name + ': off ack explained');
  eq(JSON.parse(b.ls.m.hd2_gps), { aprs: true, ssid: 12, hours: 2 }, name + ': choices saved on this device, "on" is not');
  b.fixAt(44.0, 500); b.fixAt(44.0, 500); b.fixAt(44.0, 500); b.fixAt(44.0, 500); b.fixAt(44.0, 500);
  ok(!b.ids.gpshelp.hidden && /approximate/i.test(b.ids.gpshelp.textContent), name + ': approximate-location help after 5 coarse fixes');
  eq(b.pos().length, 2, name + ': coarse fixes never sent');
  b.change('gpshours', '3');
  eq(b.sent[b.sent.length - 1], { cmd: 'share', on: true, hours: 3 }, name + ': a new time while on restarts the clock');
  b.doc.visibilityState = 'hidden'; b.fire('visibilitychange');
  ok(b.geo.cleared === 1 && /paused/.test(b.ids.gpschip.textContent), name + ': hidden -> watch stopped, chip paused');
  b.doc.visibilityState = 'visible'; b.fire('visibilitychange');
  eq(b.geo.watches, 2, name + ': visible again -> watch restarts');
  b.geo.err({ code: 1 });
  ok(/blocked/.test(b.ids.gpschip.textContent) && !b.ids.gpshelp.hidden, name + ': denied -> chip + help');
  const os = P.osKind({ ua: dev[1], touch: dev[2], android: isAndroidPtt({ userAgent: dev[1], maxTouchPoints: dev[2] }) });
  ok(b.ids.gpshelp.textContent.indexOf(P.helpSteps(os, 'denied').steps[0]) >= 0, name + ': the ' + os + ' steps');
  b.change('gpsshare', true);                                  // tried again from the switch
  b.share(true, 'start', 20 * 60);
  ok(/20 min left · tap to stop/.test(b.ids.gpschip.textContent) && b.ids.gpschip.classList.contains('bad'), name + ': near the end the chip warns');
  b.share(false, 'expired');
  ok(b.ids.gpschip.hidden && !b.ids.gpsshare.checked && /ran out/.test(b.ids.gpsstat.textContent), name + ': gw expiry turns it off, says why');
  const before = b.pos().length; b.fixAt(44.5, 8); eq(b.pos().length, before, name + ': nothing sent after expiry');
  b.share(true, 'query', -5);                                  // a stale "on" past its end: ended locally, never sent past the end
  ok(b.ids.gpschip.hidden && !b.ids.gpsshare.checked, name + ': a share past its end is treated as off');
  b.share(true, 'start', 3600);
  b.share(false, 'notsharing');
  ok(!b.ids.gpsshare.checked && /server says/.test(b.ids.gpsstat.textContent), name + ': notsharing turns the switch off');
  b.share(true, 'start', 3600);
  b.change('gpsshare', false);
  eq(b.sent[b.sent.length - 1], { cmd: 'share', on: false }, name + ': off asks gw to stop');
  ok(b.ids.gpschip.hidden && b.ids.gpsaprs.disabled, name + ': off: chip gone, APRS switch disabled');
  const n0 = b.pos().length; b.fixAt(45, 8); eq(b.pos().length, n0, name + ': nothing sent once off, before gw confirms');
  b.change('gpsshare', true);
  b.timers.filter((t) => t.t === 10000).pop().f();
  ok(!b.ids.gpsshare.checked && /didn.t answer/.test(b.ids.gpsstat.textContent), name + ': no answer in 10 s -> switch back off');
  // family map polling
  b.sent.length = 0; b.GB.mapShown(true); eq(b.sent, [{ cmd: 'fampos' }], name + ': map shown asks for fampos');
  b.GB.onFrame({ ev: 'fampos', people: [{ who: 'dad' }] }); eq(b.sent[1], { fam: [{ who: 'dad' }] }, name + ': fampos handed to the map');
  ok(b.GB.onFrame({ ev: 'talker' }) === false, name + ': other frames pass through');
}
{ const b = browser(DEV[2], { operator: false }); eq(b.sent, [], 'listener: no share query'); b.share(false, 'query');
  ok(b.ids.gpscard.hidden && b.geo.watches === 0, 'listener: no card'); b.GB.mapShown(true); eq(b.sent, [], 'listener: no fampos'); }
{ const b = browser(DEV[0], { saved: { share: true, aprs: false, ssid: 8 } }); ok(b.geo.watches === 0, 'an old saved "on" never starts GPS by itself');
  b.share(true, 'query', 3000); ok(b.geo.watches === 1 && b.ids.gpsshare.checked, 'gw says on (shared from another device): this one follows'); }

// ---- lastheard.js family helpers (generated file; node-only exports at the end)
{ const ctx = { window: {}, document: { addEventListener() {} }, module: { exports: {} }, console, setTimeout, clearTimeout, Date, Math, JSON };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL('../lastheard.js', import.meta.url), 'utf8'), ctx);
  const L = ctx.module.exports;
  ok(typeof ctx.window.LH.setFamily === 'function', 'LH.setFamily exported');
  eq([L.FAM_FADE_S, L.FAM_HIDE_S], [7200, 43200], '2 h fade, 12 h hide');
  eq(L.famClean({ who: 'dad', call: 'kk7ion', lat: 45.5, lon: -122.6, ts: 1, spd: 30, hdg: 365, acc: 9.6 }),
    { who: 'dad', call: 'KK7ION', lat: 45.5, lon: -122.6, ts: 1, spd: 30, hdg: 5, acc: 10 }, 'famClean');
  eq(L.famClean({ who: 'x', lat: 0, lon: 0, ts: 1 }), null, 'famClean: 0,0 refused');
  eq(L.famClean({ who: '<img>', call: '<script>', lat: 1, lon: 1, ts: 1 }).call, 'SCRIPT', 'famClean strips markup');
  eq(L.famClean({ lat: 1, lon: 1, ts: 1 }), null, 'famClean: nobody');
  eq([L.famAgeTxt(30), L.famAgeTxt(600), L.famAgeTxt(3 * 3600 + 900), L.famAgeTxt(8 * 3600 + 900)], ['just now', '10 min ago', '3 h 15 min ago', '8 h ago'], 'famAgeTxt');
  eq([L.famMoveTxt({ spd: null }), L.famMoveTxt({ spd: 1 }), L.famMoveTxt({ spd: 96.6, hdg: 268 })], ['Speed not known', 'Not moving', 'Moving 60 mph, heading west'], 'famMoveTxt'); }

console.log(fail ? fail + ' of ' + n + ' FAILED' : 'all ' + n + ' passed');
process.exit(fail ? 1 : 0);
