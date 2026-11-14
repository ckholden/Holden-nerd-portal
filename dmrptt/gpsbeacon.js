/* HoldenDMR location beacon (gps-beacon 2026-11-14). Design + PINNED wire contract:
   holden-dmrptt/server/gps-beacon-20261114/DESIGN.md. Christian chose "Private + APRS-IS".
   Settings -> Location beacon, OFF by default, saved on this device only:
     1. Share my location with the family (the family map, and Radio's "where's X")
     2. Also send to APRS (public on aprs.fi), only while 1 is on, with an SSID (tablet -7, phone -8; never -9/-10/-13)
   A web app can only read GPS while it is open and on screen, so the watch runs only then; the header chip says
   "paused" otherwise. SmartBeaconing-style: a fix goes out when moved >= 150 m, or turned >= 30 deg at >= 15 km/h, never
   more than once per 20 s, plus a heartbeat every 10 min while still. Fixes worse than 100 m are dropped.
   iPhone and Android (Chrome, including its "desktop site" mode on the Galaxy tablet: isAndroidPtt) each get their own
   permission words and fix-it steps. The computer layout (pcMode) gets no switch.
   index.html wires it: GB.init(api) after an operator hello, GB.onFrame(m) for 'posok'/'fampos', GB.mapShown(on).
   The pure helpers (GB.P) are exported for node (dmrptt/test/gpsbeacon.test.mjs); nothing below them runs in node. */
(function (root) {
'use strict';
var P = {};
P.SSID_BAD = [9, 10, 13];
P.MAX_ACC_M = 100; P.MIN_GAP_MS = 20000; P.MOVE_M = 150; P.TURN_DEG = 30; P.TURN_KMH = 15; P.BEAT_MS = 600000;
P.KEY = 'hd2_gps';
P.validSsid = function (n) { return typeof n === 'number' && Math.floor(n) === n && n >= 1 && n <= 15 && P.SSID_BAD.indexOf(n) < 0; };
P.ssidList = function () { var a = []; for (var i = 1; i <= 15; i++) if (P.validSsid(i)) a.push(i); return a; };
P.isIos = function (ua, touch) { return /iPhone|iPad|iPod/.test(ua || '') || (/Macintosh/.test(ua || '') && (touch || 0) > 1); };
/* 'tablet' | 'phone' | 'pc'. o = {ua, touch: maxTouchPoints, android: isAndroidPtt(), minScreen: the short CSS side} */
P.deviceKind = function (o) {
  var ua = o.ua || '', ms = o.minScreen || 0;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (o.touch || 0) > 1)) return 'tablet';   // iPadOS asks as a Mac
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (o.android) {
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'phone' : 'tablet';
    return (ms && ms < 600) ? 'phone' : 'tablet';                     // Chrome "desktop site": a Linux UA with touch
  }
  if ((o.touch || 0) > 0 && ms) return ms >= 600 ? 'tablet' : 'phone';
  return 'pc';
};
P.osKind = function (o) { return P.isIos(o.ua, o.touch) ? 'ios' : (o.android ? 'android' : 'other'); };
P.defaultSsid = function (kind) { return kind === 'tablet' ? 7 : 8; };
P.meters = function (a, b) {
  var r = 6371000, rad = Math.PI / 180, p1 = a.lat * rad, p2 = b.lat * rad, dp = p2 - p1, dl = (b.lon - a.lon) * rad;
  var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
};
P.hdgDiff = function (a, b) { return Math.abs(((a - b) % 360 + 540) % 360 - 180); };
function fin(v) { return typeof v === 'number' && isFinite(v); }
/* a GeolocationPosition -> {lat, lon, acc (m), spd (km/h|null), hdg (0-359|null), alt (m|null), tms (epoch ms)} */
P.fixFrom = function (gp, nowMs) {
  var c = (gp && gp.coords) || {};
  if (!fin(c.latitude) || !fin(c.longitude)) return null;
  var spd = fin(c.speed) && c.speed >= 0 ? c.speed * 3.6 : null;                 // m/s -> km/h; iOS -1 = unknown
  var hdg = fin(c.heading) && c.heading >= 0 ? ((Math.round(c.heading) % 360) + 360) % 360 : null;   // Chrome NaN when still
  return { lat: c.latitude, lon: c.longitude, acc: fin(c.accuracy) ? c.accuracy : 1e9, spd: spd, hdg: hdg,
           alt: fin(c.altitude) ? c.altitude : null, tms: fin(gp.timestamp) && gp.timestamp > 0 ? gp.timestamp : nowMs };
};
/* SmartBeaconing: last = the last fix SENT ({lat, lon, hdg, t}) or null -> {send, why} */
P.decide = function (last, fx, now) {
  if (!fx) return { send: false, why: 'none' };
  if (!(fx.acc <= P.MAX_ACC_M)) return { send: false, why: 'acc' };
  if (!last) return { send: true, why: 'first' };
  if (now - last.t < P.MIN_GAP_MS) return { send: false, why: 'gap' };
  if (P.meters(last, fx) >= P.MOVE_M) return { send: true, why: 'moved' };
  if (fx.spd != null && fx.spd >= P.TURN_KMH && fx.hdg != null && last.hdg != null && P.hdgDiff(fx.hdg, last.hdg) >= P.TURN_DEG)
    return { send: true, why: 'turn' };
  if (now - last.t >= P.BEAT_MS) return { send: true, why: 'beat' };
  return { send: false, why: 'still' };
};
/* the contract's message, exactly: {"cmd":"pos","lat","lon","acc","spd","hdg","alt","ts","aprs","ssid"} */
P.posMsg = function (fx, aprs, ssid) {
  return { cmd: 'pos', lat: Math.round(fx.lat * 1e5) / 1e5, lon: Math.round(fx.lon * 1e5) / 1e5, acc: Math.round(fx.acc),
           spd: fx.spd == null ? null : Math.round(fx.spd * 10) / 10, hdg: fx.hdg == null ? null : fx.hdg,
           alt: fx.alt == null ? null : Math.round(fx.alt), ts: Math.round(fx.tms / 1000), aprs: !!aprs, ssid: ssid };
};
P.ageText = function (sec) {
  if (!(sec >= 0)) return '';
  if (sec < 45) return 'just now';
  if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + ' min';
  return Math.floor(sec / 3600) + ' h';
};
/* gps-share (hd2.16, contract gps-share-contract.md): gw owns the share and its end time. 1..4 h, default 4. */
P.HOURS = [1, 2, 3, 4];
P.clampHours = function (h) { h = Math.round(Number(h)); return h >= 1 && h <= 4 ? h : 4; };
/* seconds left -> "2 h 10 min" / "25 min" / "1 min" */
P.leftText = function (sec) {
  if (!(sec > 0)) return '0 min';
  var m = Math.ceil(sec / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
};
P.SOON_S = 35 * 60;                                   // gw's reminder push goes 30 min before the end
/* chip state -> its words (null = no chip). s = {on, until (epoch s), nowS, perm, visible, wsOpen, sentAt, now} */
P.chipText = function (s) {
  if (!s.on) return null;
  var left = s.until ? s.until - s.nowS : 0, tail = s.until ? ' · ' + P.leftText(left) + ' left' : '';
  if (s.perm === 'denied') return '\u{1F4CD} Sharing · location blocked';
  if (s.perm === 'nogps') return '\u{1F4CD} Sharing · location off';
  if (left > 0 && left <= P.SOON_S) return '\u{1F4CD} Sharing · ' + P.leftText(left) + ' left · tap to stop';
  if (!s.visible) return '\u{1F4CD} Sharing · paused';
  if (!s.wsOpen) return '\u{1F4CD} Sharing · offline';
  return '\u{1F4CD} Sharing' + tail;
};
/* what the phone will ask, in its own words, before the first prompt */
P.askText = function (os) {
  if (os === 'ios') return 'Your iPhone will ask to use your location. Tap “Allow While Using App” (or “Allow Once” to try it). Keep “Precise” on.';
  if (os === 'android') return 'Your tablet or phone will ask holdenportal.com to use your location. Tap “While using the app” (or “Allow”), and choose “Precise”, not “Approximate”.';
  return 'Your browser will ask to use your location. Choose Allow.';
};
/* fix-it steps. what: 'denied' (the site is blocked) | 'nogps' (location is off on the device) | 'approx' (no fix
   better than 100 m: precise location is off) */
P.helpSteps = function (os, what) {
  if (os === 'ios') {
    if (what === 'denied') return { title: 'Location is blocked for HoldenDMR on this iPhone', steps: [
      'Open the iPhone Settings app → Privacy & Security → Location Services, and make sure it is on.',
      'In the same list, tap Safari Websites → choose “While Using the App” (or “Ask Next Time”), and turn Precise Location on.',
      'In Safari, open holdenportal.com, tap the “aA” button → Website Settings → Location → Allow (or Ask).',
      'Close HoldenDMR completely (swipe it away) and open it again, then turn sharing back on.'] };
    if (what === 'nogps') return { title: 'Your iPhone can’t find its location', steps: [
      'Settings → Privacy & Security → Location Services: turn it on.',
      'Step outside or near a window for a minute; GPS needs the sky.'] };
    return { title: 'Your iPhone is only giving an approximate location', steps: [
      'Settings → Privacy & Security → Location Services → Safari Websites → turn Precise Location on.',
      'Then give it a minute outdoors: fixes worse than 100 m are not shared.'] };
  }
  if (os === 'android') {
    if (what === 'denied') return { title: 'Location is blocked for holdenportal.com', steps: [
      'In Chrome, tap ⋮ → Settings → Site settings → Location → find holdenportal.com → Allow (or Reset).',
      'Android Settings → Apps → Chrome → Permissions → Location → “Allow only while using the app”, and turn “Use precise location” on.',
      'Android Settings → Location: make sure it is on.',
      'Come back here and turn sharing off and on again.'] };
    if (what === 'nogps') return { title: 'Location is off on this device', steps: [
      'Swipe down from the top and turn Location on (or Android Settings → Location).',
      'A tablet without its own GPS uses Wi-Fi to find itself: keep Wi-Fi on, and expect it to be less exact than a phone.'] };
    return { title: 'Only an approximate location is coming through', steps: [
      'Android Settings → Apps → Chrome → Permissions → Location → turn “Use precise location” on.',
      'Android Settings → Location → Location services → Google Location Accuracy: on.',
      'A Wi-Fi-only tablet may never get closer than 100 m indoors. Fixes worse than 100 m are not shared.'] };
  }
  if (what === 'denied') return { title: 'Location is blocked for this site', steps: ['Allow location for holdenportal.com in the browser’s site settings, then turn sharing off and on again.'] };
  if (what === 'nogps') return { title: 'This device can’t find its location', steps: ['Turn location on in the device settings.'] };
  return { title: 'Only an approximate location is coming through', steps: ['Fixes worse than 100 m are not shared. Try outdoors, or with precise location on.'] };
};
/* Saved on this device: only the APRS choice, the SSID and the last duration picked. Whether sharing is ON is never
   saved here: gw holds it (and its end time), and the app asks gw after every connect. */
P.loadPrefs = function (store, kind) {
  var d = { aprs: false, ssid: P.defaultSsid(kind), hours: 4 };
  try {
    var o = JSON.parse(store.getItem(P.KEY) || 'null');
    if (o && typeof o === 'object') {
      d.aprs = o.aprs === true;
      if (P.validSsid(o.ssid)) d.ssid = o.ssid;
      d.hours = P.clampHours(o.hours);
    }
  } catch (e) {}
  return d;
};
P.savePrefs = function (store, p) {
  try { store.setItem(P.KEY, JSON.stringify({ aprs: !!p.aprs, ssid: P.validSsid(p.ssid) ? p.ssid : 8, hours: P.clampHours(p.hours) })); return true; }
  catch (e) { return false; }
};
P.ackNote = function (aprsOn, ack) {
  if (!aprsOn || !ack) return '';
  if (ack === 'off') return 'APRS isn’t switched on for your account on the server yet, so this stays family-only.';
  if (ack === 'error') return 'APRS-IS didn’t take the last position. The family still got it.';
  return '';
};

/* ---------------- browser only ---------------- */
var G = { P: P };
if (typeof module !== 'undefined' && module.exports) { module.exports = G; return; }

var api = null, prefs = null, kind = 'phone', os = 'other', watchId = null, last = null, sentAt = 0, perm = 'unknown',
    badN = 0, approx = false, lastAck = null, ackT = null, chipT = null, famT = null, famOn = false, asked = false,
    supported = false, shareOn = false, until = 0, endWhy = '', pending = false, pendT = null, lastFx = null;   // gps-share: gw's truth (ev share); card hidden until gw answers
function $(i) { return document.getElementById(i); }
function visible() { return document.visibilityState === 'visible'; }
function opOk() { return !!(api && api.isOperator()); }
function nowS() { return Math.floor(Date.now() / 1000); }
/* phone, Android tablet and the computer layout alike (a computer's location is usually Wi-Fi based and may be too
   rough: fixes worse than 100 m are not sent, and the card says so). Shown only once gw has answered {cmd:"share"}. */
function enabledHere() { return opOk() && supported && !!navigator.geolocation; }

function stopWatch() { if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch (e) {} watchId = null; } }
function startWatch() {
  if (watchId != null || !navigator.geolocation) return;
  try {
    watchId = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  } catch (e) { watchId = null; }
}
function sync() {
  if (shareOn && until && nowS() >= until) { shareOn = false; until = 0; endWhy = 'expired'; last = null; }   // gw checks once a minute; never send past the end
  var want = enabledHere() && prefs && (shareOn || pending) && visible() && perm !== 'denied';   // pending: keep the watch the tap started
  if (want) startWatch(); else stopWatch();
  paint();
}
function onFix(gp) {
  var now = Date.now(), fx = P.fixFrom(gp, now);
  if (perm !== 'granted') { perm = 'granted'; paint(); }
  if (!fx) return;
  if (!(fx.acc <= P.MAX_ACC_M)) { badN++; if (badN >= 5 && !approx) { approx = true; paint(); } return; }
  badN = 0; if (approx) { approx = false; paint(); }
  lastFx = fx;                                     // kept so the first fix can go the moment gw says "on"
  trySend(fx, now);
}
function trySend(fx, now) {
  var d = P.decide(last, fx, now);
  if (!d.send || !shareOn || !api.wsOpen()) return;
  var m = P.posMsg(fx, prefs.aprs, prefs.ssid);
  if (!api.send(m)) return;
  last = { lat: fx.lat, lon: fx.lon, hdg: fx.hdg, t: now }; sentAt = now;
  clearTimeout(ackT); ackT = setTimeout(function () { lastAck = 'none'; paint(); }, 20000);
  paint();
}
function onErr(e) {
  var c = e && e.code;
  if (c === 1) { perm = 'denied'; stopWatch(); }
  else if (c === 2) { perm = 'nogps'; }
  paint();                                         // 3 = timeout: the watch carries on
}
function onAck(m) {
  clearTimeout(ackT); lastAck = (m && typeof m.aprs === 'string') ? m.aprs : null;
  if (perm === 'nogps') perm = 'granted';
  paint();
}

/* ---- the Settings card + the header chip ---- */
function paint() {
  var card = $('gpscard'), chip = $('gpschip');
  var show = enabledHere();
  if (card) card.hidden = !show;
  if (chip) {
    var t = show ? P.chipText({ on: shareOn, until: until, nowS: nowS(), perm: perm, visible: visible(), wsOpen: api && api.wsOpen(),
                                sentAt: sentAt, now: Date.now() }) : null;
    chip.hidden = !t;
    if (t) { chip.textContent = t; chip.classList.toggle('bad', perm === 'denied' || perm === 'nogps' || (until > 0 && until - nowS() <= P.SOON_S)); }
  }
  if (!show || !card || !prefs) return;
  var sh = $('gpsshare'), ap = $('gpsaprs'), ss = $('gpsssid'), hr = $('gpshours');
  sh.checked = shareOn || pending; ap.checked = prefs.aprs; ap.disabled = !shareOn;
  if (hr) { if (hr.value !== String(prefs.hours)) hr.value = String(prefs.hours); }
  var us = $('gpsuntil');
  if (us) us.textContent = shareOn && until
    ? 'On until ' + new Date(until * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' (' + P.leftText(until - nowS()) + ' left). Pick a time to restart the clock from now.'
    : 'Turns itself off after this long. You get a reminder 30 min before.';
  $('gpsaprsrow').classList.toggle('dim', !shareOn);
  ss.disabled = !(shareOn && prefs.aprs); $('gpsssidrow').classList.toggle('dim', !(shareOn && prefs.aprs));
  if (ss.value !== String(prefs.ssid)) ss.value = String(prefs.ssid);
  var call = (api.myCall() || 'your call');
  $('gpsssidsub').textContent = 'This device sends as ' + call + '-' + prefs.ssid + ' (' + (kind === 'tablet' ? 'tablet' : 'phone') + ' default -' + P.defaultSsid(kind) + ')';
  var st = '';
  if (!shareOn && endWhy === 'expired') st = 'Sharing turned itself off when its time ran out.';
  else if (!shareOn && endWhy === 'notsharing') st = 'The server says sharing is off, so nothing is being sent.';
  else if (!shareOn && endWhy === 'noanswer') st = 'The server didn’t answer, so sharing is still off. Try again in a moment.';
  if (pending) st = 'Turning on…';
  if (shareOn) {
    if (perm === 'denied') st = '';
    else if (!visible()) st = 'Paused while HoldenDMR is in the background.';
    else if (!sentAt) st = asked && perm !== 'granted' ? P.askText(os) : 'Waiting for a GPS fix…';
    else { var ag = P.ageText((Date.now() - sentAt) / 1000); st = 'Last shared ' + ag + (ag === 'just now' ? '' : ' ago') + '.'; }
    if (lastAck === 'none' && sentAt) st += ' The server didn’t answer the last one (is this device’s clock right?).';
    var an = P.ackNote(prefs.aprs, lastAck); if (an) st += ' ' + an;
  }
  $('gpsstat').textContent = st;
  var help = $('gpshelp'), what = shareOn ? (perm === 'denied' ? 'denied' : perm === 'nogps' ? 'nogps' : approx ? 'approx' : null) : null;
  help.hidden = !what; help.textContent = '';
  if (what) {
    var h = P.helpSteps(os, what), b = document.createElement('b'), ol = document.createElement('ol');
    b.textContent = h.title; help.appendChild(b);
    h.steps.forEach(function (s) { var li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
    help.appendChild(ol);
    if (what === 'denied') { var r = document.createElement('button'); r.type = 'button'; r.className = 'b'; r.textContent = 'Try again';
      r.onclick = function () { perm = 'unknown'; asked = true; startWatch(); paint(); }; help.appendChild(r); }
  }
}
/* Only this account's owner can turn its share on: the switch lives in the owner's own app, and gw takes "share" only
   on that account's own socket. The switch waits for gw's answer (ev share) before it counts as on. */
function setShare(on) {
  if (!api || !api.wsOpen()) { paint(); return; }
  endWhy = '';
  if (on) {
    asked = true; last = null; sentAt = 0; lastAck = null; approx = false; badN = 0;
    if (perm === 'denied') perm = 'unknown';           // tried again from the switch: let the phone answer for itself
    api.send({ cmd: 'share', on: true, hours: P.clampHours(prefs.hours) });
    pending = true; clearTimeout(pendT);
    pendT = setTimeout(function () { if (pending) { pending = false; endWhy = 'noanswer'; sync(); } }, 10000);
    startWatch();                                       // inside the tap: iOS and Android prompt from a user gesture
  } else {
    api.send({ cmd: 'share', on: false });
    pending = false; clearTimeout(pendT);
    shareOn = false; until = 0; stopWatch(); last = null;   // stop sending at once; gw confirms with ev share stop
  }
  sync();
}
function setHours(v) {
  prefs.hours = P.clampHours(v); P.savePrefs(localStorage, prefs);
  if (shareOn && api && api.wsOpen()) api.send({ cmd: 'share', on: true, hours: prefs.hours });   // restart the clock
  paint();
}
function onShare(m) {
  supported = true; pending = false; clearTimeout(pendT);
  var was = shareOn;
  shareOn = m.on === true; until = shareOn && typeof m.until === 'number' ? m.until : 0;
  if (!shareOn) { endWhy = (m.why === 'expired' || m.why === 'notsharing') ? m.why : ''; stopWatch(); last = null; sentAt = 0; lastFx = null; }
  sync();
  if (shareOn && !was && lastFx && Date.now() - lastFx.tms < 60000) trySend(lastFx, Date.now());
}
function setAprs(on) {
  if (on && !shareOn) return paint();
  prefs.aprs = !!on; P.savePrefs(localStorage, prefs); lastAck = null;
  last = null;                                        // the next fix goes out now, with the new aprs flag
  paint();
}
function setSsid(v) { var n = parseInt(v, 10); if (!P.validSsid(n)) return paint(); prefs.ssid = n; P.savePrefs(localStorage, prefs); last = null; paint(); }

/* ---- family pins: fampos every 30 s while the Map is on screen ---- */
function famTick() { if (famOn && opOk() && api.wsOpen()) api.send({ cmd: 'fampos' }); }
G.mapShown = function (on) {
  on = !!on && opOk();
  if (on === famOn) return;
  famOn = on; clearInterval(famT); famT = null;
  if (on) { famTick(); famT = setInterval(famTick, 30000); }
};
G.onFrame = function (m) {
  if (!m) return false;
  if (m.ev === 'share') { onShare(m); return true; }
  if (m.ev === 'posok') { onAck(m); return true; }
  if (m.ev === 'fampos') { if (api && api.onFamily) api.onFamily(Array.isArray(m.people) ? m.people : []); return true; }
  return false;
};
G.openSettings = function () { if (api && api.openSettings) api.openSettings(); var c = $('gpscard'); if (c) try { c.scrollIntoView({ block: 'center' }); } catch (e) {} };
G.sync = function () { if (api) sync(); };
G.init = function (a) {
  var first = !api; api = a;
  var ms = 0; try { ms = Math.min(screen.width, screen.height); } catch (e) {}
  var o = { ua: navigator.userAgent || '', touch: navigator.maxTouchPoints || 0, android: !!a.isAndroid(), minScreen: ms };
  kind = P.deviceKind(o); os = P.osKind(o);
  if (first) {
    prefs = P.loadPrefs(localStorage, kind);
    var ss = $('gpsssid');
    if (ss && !ss.options.length) P.ssidList().forEach(function (n) { var op = document.createElement('option'); op.value = String(n); op.textContent = '-' + n; ss.appendChild(op); });
    if ($('gpsshare')) $('gpsshare').onchange = function () { setShare(this.checked); };
    if ($('gpsaprs')) $('gpsaprs').onchange = function () { setAprs(this.checked); };
    if (ss) ss.onchange = function () { setSsid(this.value); };
    var hr = $('gpshours');
    if (hr && !hr.options.length) P.HOURS.forEach(function (n) { var op = document.createElement('option'); op.value = String(n); op.textContent = n + (n === 1 ? ' hour' : ' hours'); hr.appendChild(op); });
    if (hr) hr.onchange = function () { setHours(this.value); };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pageshow', sync);
    chipT = setInterval(sync, 15000);   // sync, not paint: it also ends an expired share
    try {                                              // already blocked: say so before anyone taps
      if (navigator.permissions && navigator.permissions.query) navigator.permissions.query({ name: 'geolocation' }).then(function (r) {
        if (r.state === 'denied') perm = 'denied'; else if (r.state === 'granted') perm = 'granted';
        r.onchange = function () { perm = r.state === 'denied' ? 'denied' : (r.state === 'granted' ? 'granted' : 'unknown'); sync(); };
        sync(); }).catch(function () {});
    } catch (e) {}
  }
  if (opOk() && a.wsOpen()) a.send({ cmd: 'share' });   // every (re)connect: ask gw for the truth; an old gw never answers
  sync();
};
root.GB = G;
})(typeof window !== 'undefined' ? window : this);
