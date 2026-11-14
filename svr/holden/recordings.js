/* Recordings tab for /svr/holden (= holdenportal.com/hdmr), 2026-10-17.
   Christian: "scroll through previous radio tx recordings for x? days". Every over Radio hears on HOLDEN1 and
   HOLDEN DMR, kept by hdmr-archive on .151 (kj7dts-server/hdmr-archive/DESIGN.md).

   2026-11-10 (Christian): keep the recordings FOREVER (was 30 days). The page never hard-codes the retention: it
   reads keep_days from /days and /status and words itself from that (see setKeep), so it is right before AND after
   the server change. The day list is grouped by month (a year+ of days), newest first.

   Every byte comes from hdmr-archive-api, which verifies the Firebase ID token SERVER-SIDE (same owner list as
   /hdmr). Nothing here is access control. Audio is fetched with the Bearer header and played from a blob URL,
   so no token ever lands in a URL.

   ⚠ HOLDEN1 is a PUBLIC talkgroup: anyone can put words into a transcript. Every server value is rendered with
   textContent (never innerHTML), and blobs get a fixed type chosen here, never the one the server sent.

   2026-11-14 (recordings-features, Christian approved): iPhone playback (an MP3 from the server when this browser
   can't play Ogg Opus; Media Session for the lock screen), pin/unpin per over and per QSO (owner only, fresh
   sign-in, POST /pin; a pin never deletes anything, unpinning only lifts the size-cap protection), Save QSO (one
   zip: the joined MP3 + a .txt transcript, built server-side), talker chips, 1x/1.5x/2x and skip-silence during
   continuous play. The pure helpers below are also loaded by node tests (module.exports).

   2026-11-14 (Christian: "Only gives option for last 9 days but not 30 or all time"): a Show row with One day /
   Last 7 days / Last 30 days / All. A range view fetches /overs for each recorded day in the range (no server
   change), newest day first, 10 days at a time with a "Load older days" button, each day under its own header with
   its QSO blocks oldest first, exactly like the one-day view. Continuous play stays inside one day. */
(function(){
'use strict';
/* ---------- pure helpers (no DOM): node-tested in the kit's tests/test_recordings_page.mjs */
const P = (function(){
  const FAMILY = ['KJ7DTS', 'KK7ION', 'KK7RBQ', 'KK7JVI', 'PRESTON'];
  const RATES = [1, 1.5, 2];
  const QSO_MAX_IDS = 300, QSO_MAX_S = 3600;                // the archive refuses more (hdmr-archive QSO_MAX_*)
  function endTs(r){ return (r && (r.air_ts || r.ts)) || 0; }
  function startTs(r){ return endTs(r) - ((r && r.dur) || 0); }
  /* A quiet gap longer than gapS starts a new block. list is oldest first. */
  function qsoBlocks(list, gapS){
    const out = [];
    (list || []).forEach((r, i) => {
      if(i === 0 || startTs(r) - endTs(list[i - 1]) > gapS) out.push([]);
      out[out.length - 1].push(r);
    });
    return out;
  }
  /* An over to Radio: the wake-word paths, or anything Radio answered. */
  function isToRadio(r){ return !!r && (r.path === 'wake' || r.path === 'ai' || r.path === 'bare' || !!r.answer); }
  function matchTalker(r, sel){
    if(!sel) return true;
    if(sel === '@radio') return isToRadio(r);
    return String((r && r.talker) || '').toUpperCase() === sel;
  }
  /* Chips for the current view: All, the family callsigns present, Radio, then up to maxOthers other talkers by
     count. The selected one is always kept so it can be cleared. */
  function talkerChips(list, sel, maxOthers){
    maxOthers = maxOthers === undefined ? 6 : maxOthers;
    const n = new Map(); let radio = 0;
    (list || []).forEach(r => {
      const t = String((r && r.talker) || '').toUpperCase();
      if(t) n.set(t, (n.get(t) || 0) + 1);
      if(isToRadio(r)) radio++;
    });
    const out = [{v: '', label: 'All', n: (list || []).length}];
    FAMILY.forEach(c => { if(n.has(c)) out.push({v: c, label: c, n: n.get(c)}); });
    if(radio) out.push({v: '@radio', label: 'Radio', n: radio});
    [...n.entries()].filter(([t]) => !FAMILY.includes(t))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, maxOthers)
      .forEach(([t, c]) => out.push({v: t, label: t, n: c}));
    if(sel && !out.some(c => c.v === sel)) out.push({v: sel, label: sel === '@radio' ? 'Radio' : sel, n: 0});
    return out;
  }
  function parseRate(s){ const v = Number(s); return RATES.includes(v) ? v : 1; }
  /* The next over in TIME: a day view is oldest first, search results newest first. */
  function nextIndex(i, dir, searchMode){ return searchMode ? i - dir : i + dir; }
  /* First and last 20 ms window above threshDb (dBFS RMS), padded. null when there is nothing worth skipping
     (under 0.3 s at both ends) or the over is silent all through (then it just plays). */
  function silenceBounds(samples, rate, threshDb, padS, winS){
    threshDb = threshDb === undefined ? -45 : threshDb; padS = padS === undefined ? 0.15 : padS; winS = winS || 0.02;
    const n = (samples && samples.length) || 0;
    if(!n || !(rate > 0)) return null;
    const thr = Math.pow(10, threshDb / 20), win = Math.max(1, Math.round(rate * winS));
    let first = -1, last = -1;
    for(let s = 0; s < n; s += win){
      const e = Math.min(n, s + win); let acc = 0;
      for(let k = s; k < e; k++) acc += samples[k] * samples[k];
      if(Math.sqrt(acc / (e - s)) >= thr){ if(first < 0) first = s; last = e; }
    }
    if(first < 0) return null;
    const dur = n / rate, start = Math.max(0, first / rate - padS), end = Math.min(dur, last / rate + padS);
    if(start < 0.3 && dur - end < 0.3) return null;
    return {start: start, end: end, dur: dur};
  }
  /* POST /pin results -> the rows on the page. Returns how many rows changed. Keepsakes are never touched. */
  function applyPinResults(rows, results){
    if(!results || typeof results !== 'object') return 0;
    let changed = 0;
    (rows || []).forEach(r => {
      const s = results[r.id];
      if(!s || r.pin_kind === 'keepsake') return;
      if(s === 'pinned' || s === 'already'){ if(!r.pinned || r.pin_kind !== 'page') changed++; r.pinned = true; r.pin_kind = 'page'; }
      else if(s === 'unpinned'){ if(r.pinned) changed++; r.pinned = false; r.pin_kind = null; }
    });
    return changed;
  }
  function plural(n, w){ return n + ' ' + w + (n === 1 ? '' : 's'); }
  function pinSummary(counts, pin){
    const c = counts || {}, k = +c.keepsake || 0;
    const keep = k ? ' ' + plural(k, 'keepsake') + (k === 1 ? ' stays' : ' stay') + ' pinned for good.' : '';
    if(pin){
      const did = (+c.pinned || 0), al = (+c.already || 0), nf = (+c.not_found || 0);
      return (did ? 'Pinned ' + plural(did, 'over') + '.' : 'Nothing new to pin.') +
        (al ? ' ' + plural(al, 'over') + (al === 1 ? ' was' : ' were') + ' already pinned.' : '') + keep +
        (nf ? ' ' + plural(nf, 'over') + ' not found in the archive.' : '');
    }
    const did = +c.unpinned || 0;
    return (did ? 'Unpinned ' + plural(did, 'over') + '. ' + (did === 1 ? 'It is' : 'They are') + ' still kept forever.' : 'Nothing to unpin.') + keep;
  }
  /* What the QSO header can offer. Old rows (no pin_kind) that are pinned count as locked. */
  function pinState(blk){
    let open = 0, page = 0, locked = 0, secs = 0;
    (blk || []).forEach(r => {
      secs += +r.dur || 0;
      if(!r.pinned) open++; else if(r.pin_kind === 'page') page++; else locked++;
    });
    const n = (blk || []).length;
    return {canPin: open > 0, canUnpin: page > 0, locked: locked, tooMany: n > QSO_MAX_IDS, tooLong: secs > QSO_MAX_S, secs: secs};
  }
  const dtf = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  /* Same as the archive's qso_name: 'HOLDEN1-2026-11-13-2117-QSO' (the first over's net, Pacific start). */
  function qsoFileName(blk){
    const r = blk && blk[0]; if(!r) return 'QSO';
    const net = r.chan === 'B' ? 'HOLDEN-DMR' : (r.chan === 'H' || r.chan === 'P') ? 'PRESTONS-TG' : 'HOLDEN1';
    const p = {}; dtf.formatToParts(new Date(Math.round(startTs(r)) * 1000)).forEach(x => { p[x.type] = x.value; });
    return net + '-' + p.year + '-' + p.month + '-' + p.day + '-' + p.hour + p.minute + '-QSO';
  }
  /* The recorded days a range view covers, newest first: days from today-(n-1) through today (Pacific 'YYYY-MM-DD').
     n of 0 (or anything not a positive finite number) = every day. days: [{day: 'YYYY-MM-DD'}, ...], any order. */
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  function rangeDays(days, n, today){
    const list = (days || []).map(d => d && d.day).filter(d => DAY_RE.test(d || '')).sort().reverse();
    if(!(n > 0) || !isFinite(n) || !DAY_RE.test(today || '')) return list;
    const [y, m, d] = today.split('-').map(Number);
    const cut = new Date(Date.UTC(y, m - 1, d - (Math.floor(n) - 1))).toISOString().slice(0, 10);
    return list.filter(x => x >= cut && x <= today);
  }
  return {FAMILY, RATES, QSO_MAX_IDS, QSO_MAX_S, endTs, startTs, qsoBlocks, isToRadio, matchTalker, talkerChips,
    parseRate, nextIndex, silenceBounds, applyPinResults, pinSummary, pinState, qsoFileName, rangeDays};
})();
if(typeof module === 'object' && module && module.exports) module.exports = P;
if(typeof window === 'undefined' || typeof document === 'undefined') return;   // node: helpers only

const ARCH_BASE = 'https://kj7dts-server.tail34c6a5.ts.net/hdmrarchive';   // <- only line to change if the box moves
const TZ = 'America/Los_Angeles';
const NOISE = new Set(['nonspeech', 'impossible', 'leak', 'scaffold', 'stt_none', 'phantom', 'corpus']);
const QSO_GAP_S = 300;                     // a quiet gap longer than this starts a new QSO block
const BLOB_CACHE = 12;
const FOREVER_DAYS = 3650;                 // keep_days at or above this (10 years) is shown as "kept forever"
const SEARCH_CAP = 200;                    // hdmr-archive /search default limit (newest first)
const RANGE_PAGE = 10;                     // a range view loads this many recorded days at a time
const RANGE_FETCH = 4;                     // /overs requests in flight at once while a range loads
const VIEWS = [['day', 'One day'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All']];
const NARROW = window.matchMedia ? window.matchMedia('(max-width:720px)') : null;   // same breakpoint as the CSS

const css = `
#tab-rec .rtool{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:0 0 12px}
#tab-rec .rtool input[type=search]{flex:1 1 220px;min-width:0}
#tab-rec .chips{display:flex;gap:6px;flex-wrap:wrap}
#tab-rec .chip{padding:6px 11px;font-size:12px}
#tab-rec .chip[aria-pressed="true"]{border-color:var(--blue);color:var(--blue)}
#tab-rec .rgrid{display:grid;grid-template-columns:minmax(170px,230px) 1fr;gap:12px;align-items:start}
#tab-rec .days{display:flex;flex-direction:column;gap:6px;max-height:75vh;overflow:auto}
#tab-rec .mon{display:flex;flex-direction:column;gap:6px}
#tab-rec .mhd{position:sticky;top:0;z-index:1;display:block;width:100%;text-align:left;padding:7px 10px;background:var(--card2);line-height:1.35}
#tab-rec .mhd .mt{font-size:12px;font-weight:700;letter-spacing:.8px;color:var(--tx)}
#tab-rec .mhd .car{display:inline-block;width:14px;color:var(--dim)}
#tab-rec .mhd .ms{display:block;padding-left:14px;font-size:11px;color:var(--dim);text-transform:none;letter-spacing:0}
#tab-rec .mhd.cur{border-left:3px solid var(--blue)}
#tab-rec .mdays{display:flex;flex-direction:column;gap:6px;padding-left:10px}
#tab-rec .day{display:block;width:100%;text-align:left;text-transform:none;letter-spacing:0;padding:8px 10px;line-height:1.4}
#tab-rec .day[aria-current="true"]{border-color:var(--blue);background:rgba(80,144,255,.10)}
#tab-rec .day .d1{font-weight:700;font-size:13px}
#tab-rec .day .d2{color:var(--dim);font-size:12px}
#tab-rec .rows{min-width:0}
#tab-rec .qso{margin:14px 0 6px;padding:6px 10px;background:var(--card2);border-left:3px solid var(--blue);font-size:12px;color:var(--dim);display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
#tab-rec .qso b{color:var(--tx)}
#tab-rec .qso .qb{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
#tab-rec .qso .qb button,#tab-rec .ov .side .pn{padding:5px 8px;font-size:12px;text-transform:none;letter-spacing:0}
#tab-rec .ov .side .pn[aria-pressed="true"]{border-color:var(--patch);color:var(--patch)}
#tab-rec .rtool2{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:-4px 0 12px}
#tab-rec .chip .cn{color:var(--dim);margin-left:4px}
#tab-rec .tag.keep{color:var(--blue);border-color:var(--blue)}
#tab-rec .ov{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;padding:8px 6px;border-bottom:1px solid var(--bdim);align-items:start}
#tab-rec .ov.playing{background:rgba(48,208,128,.08);border-left:3px solid var(--ok)}
#tab-rec .ov.hit{background:rgba(240,192,64,.10)}
#tab-rec .ov .pb{width:38px;height:34px;padding:0;font-size:15px;text-transform:none}
#tab-rec .ov .meta{font-size:12px;color:var(--dim);display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
#tab-rec .ov .who{color:var(--tx);font-weight:700;font-size:13px}
#tab-rec .ov .txt{font-size:14px;line-height:1.45;margin-top:3px;white-space:pre-wrap;word-break:break-word}
#tab-rec .ov .txt.none{color:var(--dim);font-style:italic;font-size:12px}
#tab-rec .ov .ans{font-size:13px;color:var(--dim);margin-top:4px;white-space:pre-wrap;word-break:break-word}
#tab-rec .ov .ans b{color:var(--blue);font-weight:600}
#tab-rec .ov .side{display:flex;gap:6px}
#tab-rec .ov .dl{padding:5px 8px;font-size:12px}
#tab-rec .tag.h1{color:var(--warn);border-color:var(--warn)}
#tab-rec .tag.hd{color:var(--ok);border-color:var(--ok)}
#tab-rec .tag.ptg{color:var(--blue);border-color:var(--blue)}
#tab-rec .tag.pin{color:var(--patch);border-color:var(--patch)}
#tab-rec .empty{color:var(--dim);font-size:13px;padding:14px 4px}
#tab-rec .rview{margin:0 0 10px}
#tab-rec .rday{margin:18px 0 2px;padding:8px 10px;border-bottom:2px solid var(--blue);display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12px;color:var(--dim)}
#tab-rec .rsum + .rday{margin-top:6px}
#tab-rec .rday b{color:var(--tx);font-size:14px}
#tab-rec .rday button{margin-left:auto;padding:5px 8px;font-size:12px;text-transform:none;letter-spacing:0}
#tab-rec .rsum{font-size:12px;color:var(--dim);padding:2px 4px 0}
#tab-rec .rmore{display:block;margin:16px auto 4px;padding:8px 14px;text-transform:none;letter-spacing:0}
#tab-rec .rhealth{margin-top:14px}
@media (max-width:720px){
  #tab-rec .rgrid{grid-template-columns:1fr}
  #tab-rec .days{display:block;max-height:none;overflow:visible;min-width:0}
  #tab-rec .mstrip,#tab-rec .dstrip{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch}
  #tab-rec .dstrip{margin-top:4px}
  #tab-rec .mchip{flex:0 0 auto;padding:6px 10px;font-size:12px;line-height:1.3;text-align:left}
  #tab-rec .mchip[aria-pressed="true"]{border-color:var(--blue);color:var(--blue);background:rgba(80,144,255,.10)}
  #tab-rec .mchip .mn{display:block;color:var(--dim);font-size:11px;text-transform:none;letter-spacing:0}
  #tab-rec .day{flex:0 0 auto;width:auto;min-width:132px}
  #tab-rec .ov{grid-template-columns:auto 1fr}
  #tab-rec .ov .side{grid-column:2}
}`;

let started = false, visible = false, authFails = 0, stoppedAuth = false;
let revealOnShow = false;                                    // the day list was redrawn while the tab was hidden (see show)
let days = [], curDay = '', rows = [], mode = 'day';        // mode: 'day' | 'range' | 'search'
let view = 'day';                                            // the Show row: 'day' | '7' | '30' | 'all' (search sits on top)
const rangeCache = new Map();                                // day -> its overs, oldest first (range views)
const rowDay = new Map();                                    // over id -> the day it was loaded under (range views)
let rangeShown = RANGE_PAGE, rangeLoaded = [], rangeSeq = 0, rangeSig = '';
let net = '', hideNoise = true, cont = false, query = '', hitId = '';
let playingId = '', dayTimer = null, statusTimer = null, searchTimer = null;
let keep = null;                                             // null until the API says: {forever: true} | {days: N}
const monthOpen = new Map();                                 // 'YYYY-MM' -> open? (wide list: the viewer's own toggles)
let pickMonth = '', revealDay = false, searchCapped = false; // pickMonth: the month shown in the narrow day strip
const blobs = new Map();                                     // id -> {u: object URL, ext} (small LRU)
const audio = new Audio();
audio.preload = 'none';
/* iPhone (and any browser without Ogg Opus): ask the archive for an MP3 of opus overs (?fmt=mp3). */
const NEED_MP3 = !audio.canPlayType('audio/ogg; codecs=opus');
let canPin = false;                                          // /days can_pin: the owner account, on a new enough archive
let who = '';                                                // talker chip: '' | CALLSIGN | '@radio'
let rate = 1, skipSil = false;
try{ rate = P.parseRate(localStorage.getItem('hdmr.rec.rate')); skipSil = localStorage.getItem('hdmr.rec.skip') === '1'; }catch(e){}
function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }
try{ const v = localStorage.getItem('hdmr.rec.view'); if(VIEWS.some(x => x[0] === v)){ view = v; if(v !== 'day') mode = 'range'; } }catch(e){}

function $(id){ return document.getElementById(id); }
function mk(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text !== undefined && text !== null) e.textContent = String(text); return e; }
function fmtDur(s){ s = Math.max(0, Math.round(+s || 0)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; }
function fmtLen(s){ s = +s || 0; return s < 10 ? s.toFixed(1) + 's' : fmtDur(s); }
const tFmt = new Intl.DateTimeFormat('en-US', {timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit'});
const tFmtShort = new Intl.DateTimeFormat('en-US', {timeZone: TZ, hour: 'numeric', minute: '2-digit'});
const dFmt = new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric'});
const dFmtY = new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'});
const mFmtLong = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'long', year: 'numeric'});
const mFmtShort = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', year: 'numeric'});
function fmtTime(ts){ return tFmt.format(new Date(ts * 1000)); }
function fmtShort(ts){ return tFmtShort.format(new Date(ts * 1000)); }
function ptDay(ms){ return new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date(ms)); }   // 'YYYY-MM-DD' Pacific
/* noYear: the day list, where the month header already says the year. Anywhere else a day from another year
   says its year (kept forever, a search hit can be from any year). */
function dayLabel(day, noYear){
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 20));      // 20:00 UTC is midday Pacific, never across a date line
  const today = ptDay(Date.now());
  const yest = ptDay(Date.now() - 86400000);
  const f = noYear || day.slice(0, 4) === today.slice(0, 4) ? dFmt : dFmtY;
  return (day === today ? 'Today · ' : day === yest ? 'Yesterday · ' : '') + f.format(noonUtc);
}
function monthOf(day){ return String(day || '').slice(0, 7); }                     // 'YYYY-MM'
function monthDate(mon){ const [y, m] = mon.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 15)); }
function fmtTalk(s){ s = Math.max(0, Math.round(+s || 0)); return s < 3600 ? fmtDur(s) : Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm'; }
function plural(n, w){ return n + ' ' + w + (n === 1 ? '' : 's'); }
function ago(s){ s = Math.round(s); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; }
function endTs(r){ return r.air_ts || r.ts; }
function startTs(r){ return endTs(r) - (r.dur || 0); }
function netTag(r){ return mk('span', 'tag ' + (r.chan === 'B' ? 'hd' : (r.chan === 'H' || r.chan === 'P') ? 'ptg' : 'h1'), r.net || (r.chan === 'B' ? 'HOLDEN DMR' : (r.chan === 'H' || r.chan === 'P') ? "PRESTON'S TALK GROUP" : 'HOLDEN1')); }

/* ---------- network */
async function token(force){
  const u = firebase.auth().currentUser;
  if(!u) throw new Error('not signed in');
  return u.getIdToken(!!force);
}
async function api(path, asBlob){
  let force = false;
  for(let i = 0; i < 2; i++){
    const tok = await token(force);
    const r = await fetch(ARCH_BASE + path, {headers: {'Authorization': 'Bearer ' + tok}, cache: 'no-store'});
    if(r.status === 401 && !force){ force = true; continue; }   // one retry with a fresh token (expired cache)
    if(r.status === 401){ const e = new Error('unauthorized'); e.code = 401; throw e; }
    if(!r.ok){ const e = new Error('HTTP ' + r.status); e.code = r.status; throw e; }
    return asBlob ? r.arrayBuffer() : r.json();
  }
}
function fail(e, where){
  if(e && e.code === 401){
    stoppedAuth = true;
    setNote('bad', 'Not authorized. Recordings use the same sign-in list as this page. Sign in with the owner Google account.');
    return;
  }
  setNote('warn', 'Could not load ' + where + ' (' + ((e && e.message) || e) + '). Retrying.');
}
function setNote(kind, text){
  const n = $('recNote');
  if(!n) return;
  n.hidden = !text;
  n.className = 'banner ' + (kind || 'info');
  n.textContent = text || '';
}

/* ---------- layout */
function build(){
  const sec = $('tab-rec');
  if(!sec || sec.dataset.built) return;
  sec.dataset.built = '1';
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const note = mk('div', 'banner info'); note.id = 'recNote'; note.hidden = true; sec.appendChild(note);
  const p = mk('div', 'panel');
  const h2 = mk('h2', '', "Recordings · HOLDEN1 + HOLDEN DMR + PRESTON'S TALK GROUP");
  const kh = mk('span'); kh.id = 'recKeepH'; h2.appendChild(kh);              // filled by renderKeep() from the API
  p.appendChild(h2);
  const tool = mk('div', 'rtool');
  const q = mk('input'); q.type = 'search'; q.id = 'recQ'; q.placeholder = 'Search transcripts, callsigns, Radio answers…';
  q.setAttribute('aria-label', 'Search recordings'); q.autocomplete = 'off';
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(q.value), 350); });
  q.addEventListener('keydown', ev => { if(ev.key === 'Escape'){ q.value = ''; runSearch(''); } });
  tool.appendChild(q);
  const chips = mk('div', 'chips');
  [['', 'All'], ['A', 'HOLDEN1'], ['B', 'HOLDEN DMR'], ['H', "PRESTON'S TG"]].forEach(([v, label]) => {
    const b = mk('button', 'chip', label); b.dataset.net = v; b.setAttribute('aria-pressed', String(v === net));
    b.addEventListener('click', () => { net = v; chips.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.net === net))); mode === 'search' ? runSearch(query, true) : renderRows(); });
    chips.appendChild(b);
  });
  tool.appendChild(chips);
  const cb = (id, label, val, on) => {
    const l = mk('label', 'chk' + (val ? ' on' : '')); const i = mk('input'); i.type = 'checkbox'; i.id = id; i.checked = val;
    i.addEventListener('change', () => { l.classList.toggle('on', i.checked); on(i.checked); });
    l.appendChild(i); l.appendChild(mk('span', '', label)); return l;
  };
  tool.appendChild(cb('recNoise', 'Hide no-speech', hideNoise, v => { hideNoise = v; renderRows(); }));
  tool.appendChild(cb('recCont', 'Play continuously', cont, v => { cont = v; if(!v) curTrim = null; }));
  tool.appendChild(cb('recSkip', 'Skip silence (continuous play)', skipSil, v => { skipSil = v; lsSet('hdmr.rec.skip', v ? '1' : '0'); if(!v) curTrim = null; }));
  p.appendChild(tool);
  const tool2 = mk('div', 'rtool2');
  const sp = mk('div', 'chips'); sp.setAttribute('role', 'group'); sp.setAttribute('aria-label', 'Playback speed');
  P.RATES.forEach(v => {
    const b = mk('button', 'chip', v + 'x'); b.dataset.rate = String(v); b.setAttribute('aria-pressed', String(v === rate));
    b.title = 'Play at ' + v + 'x speed';
    b.addEventListener('click', () => {
      rate = v; lsSet('hdmr.rec.rate', String(v)); applyRate();
      sp.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.rate) === rate)));
    });
    sp.appendChild(b);
  });
  tool2.appendChild(sp);
  const wc = mk('div', 'chips'); wc.id = 'recWho'; wc.setAttribute('role', 'group'); wc.setAttribute('aria-label', 'Who is talking');
  tool2.appendChild(wc);
  p.appendChild(tool2);
  if(NEED_MP3) p.appendChild(mk('div', 'note', 'This browser cannot play Opus audio, so the server sends each recording as an MP3. The download button saves that MP3.'));
  const vw = mk('div', 'chips rview'); vw.id = 'recView'; vw.setAttribute('role', 'group'); vw.setAttribute('aria-label', 'Show');
  VIEWS.forEach(([v, label]) => {
    const b = mk('button', 'chip', label); b.dataset.view = v;
    b.title = v === 'day' ? 'One day at a time: pick it in the day list' : v === 'all' ? 'Every recorded day, newest first' : 'Every recording from the last ' + v + ' days, newest day first';
    b.addEventListener('click', () => setView(v));
    vw.appendChild(b);
  });
  p.appendChild(vw);
  const grid = mk('div', 'rgrid');
  const dl = mk('div', 'days'); dl.id = 'recDays'; dl.setAttribute('role', 'group'); dl.setAttribute('aria-label', 'Days');   // a label needs a role to be read
  const rw = mk('div', 'rows'); rw.id = 'recRows';
  grid.appendChild(dl); grid.appendChild(rw);
  p.appendChild(grid);
  const fn = mk('div', 'note', 'Transcripts are machine-made from radio audio and can be wrong, especially on short overs. Times are Pacific.');
  const kn = mk('span'); kn.id = 'recKeepN'; fn.appendChild(kn);
  p.appendChild(fn);
  const h = mk('div', 'note rhealth'); h.id = 'recHealth'; p.appendChild(h);
  sec.appendChild(p);
  renderKeep();
}

/* ---------- retention: worded from the API, never assumed (2026-11-10: forever, was 30 days)
   keep_days (hdmr-archive /days and /status): a number below FOREVER_DAYS = that many days; null, <= 0, at or above
   FOREVER_DAYS, or keep_forever === true = forever. A reply without keep_days changes nothing. */
function setKeep(j){
  if(!j || typeof j !== 'object') return;
  const k = j.keep_days;
  let nx;
  if(j.keep_forever === true || k === null || (typeof k === 'number' && (k <= 0 || k >= FOREVER_DAYS))) nx = {forever: true};
  else if(typeof k === 'number' && isFinite(k)) nx = {days: Math.round(k)};
  else return;
  if(keep && keep.forever === nx.forever && keep.days === nx.days) return;
  keep = nx; renderKeep();
}
function renderKeep(){
  const h = $('recKeepH'), n = $('recKeepN');
  if(h) h.textContent = !keep ? '' : keep.forever ? ' · kept forever' : ' · last ' + keep.days + ' days (pinned: kept forever)';
  if(n) n.textContent = !keep ? '' : keep.forever
    ? " Recordings are kept forever. Pinned ones are also safe from the archive's size cap."
    : ' Recordings are deleted after ' + keep.days + ' days unless pinned.';
}

/* ---------- days */
async function loadDays(){
  try{
    const j = await api('/days');
    setKeep(j);
    canPin = j.can_pin === true;                             // an older archive never says so: no pin buttons
    days = Array.isArray(j.days) ? j.days.filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.day)) : [];
    days.sort((a, b) => a.day < b.day ? 1 : a.day > b.day ? -1 : 0);   // newest first (the API already is)
    if(!curDay || !days.some(d => d.day === curDay)){ curDay = days.length ? days[0].day : ''; revealDay = true; }
    renderDays();
    if(mode === 'day') await loadDay(curDay, true);
    else if(mode === 'range') await loadRange(true);
  }catch(e){ fail(e, 'the day list'); }
}
/* Months, newest first. Wide: collapsible month groups (the newest month and the open day's month start open; a
   collapsed month builds no day buttons). Narrow (the same 720px breakpoint as the CSS): a strip of months over a
   strip of that month's days. Every re-render (today refreshes every 30 s) keeps the viewer's scroll and focus. */
function months(){
  const out = [], by = new Map();
  days.forEach(d => {
    const k = monthOf(d.day);
    let m = by.get(k);
    if(!m){ m = {mon: k, days: [], n: 0, talk_s: 0}; by.set(k, m); out.push(m); }
    m.days.push(d); m.n += +d.n || 0; m.talk_s += +d.talk_s || 0;
  });
  return out;
}
function isOpen(mon, newest){
  if(monthOpen.has(mon)) return monthOpen.get(mon);
  return mon === newest || (mode === 'day' && mon === monthOf(curDay));
}
function pickDay(day){
  const q = $('recQ'); if(q) q.value = '';
  query = ''; mode = 'day'; hitId = ''; curDay = day; pickMonth = monthOf(day);
  if(view !== 'day'){ view = 'day'; lsSet('hdmr.rec.view', view); }
  renderDays(); loadDay(day);
}
/* Open one day (from a search hit or a range view's day header), optionally flashing one over. */
function openDay(day, id){
  const q = $('recQ'); if(q) q.value = '';
  query = ''; mode = 'day'; curDay = day; hitId = id || ''; revealDay = true;
  if(view !== 'day'){ view = 'day'; lsSet('hdmr.rec.view', view); }
  renderDays(); loadDay(day);
}
function syncView(){
  const box = $('recView'); if(!box) return;
  box.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(mode !== 'search' && c.dataset.view === view)));
}
function viewLabel(){ const v = VIEWS.find(x => x[0] === view); return v ? v[1] : ''; }
function todayPT(){ return new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date()); }
function viewDays(){ return P.rangeDays(days, view === 'all' ? 0 : Number(view), todayPT()); }
function setView(v){
  const q = $('recQ'); if(q) q.value = '';
  query = ''; hitId = ''; view = v; lsSet('hdmr.rec.view', v);
  if(v === 'day'){ mode = 'day'; revealDay = true; renderDays(); loadDay(curDay); return; }
  mode = 'range'; rangeShown = RANGE_PAGE; rangeSig = '';
  renderDays();
  const r = $('recRows'); if(r){ r.textContent = ''; r.appendChild(mk('div', 'empty', 'Loading…')); }
  loadRange(false);
}
function dayBtn(d){
  const b = mk('button', 'day'); b.dataset.k = 'd:' + d.day;
  b.setAttribute('aria-current', String(mode === 'day' && d.day === curDay));
  b.appendChild(mk('div', 'd1', dayLabel(d.day, true)));
  b.appendChild(mk('div', 'd2', plural(+d.n || 0, 'over') + ' · ' + fmtTalk(d.talk_s)));
  if(d.talkers && d.talkers.length) b.appendChild(mk('div', 'd2', d.talkers.slice(0, 4).join(', ')));
  b.addEventListener('click', () => pickDay(d.day));
  return b;
}
function monthStats(m){ return plural(m.days.length, 'day') + ' · ' + plural(m.n, 'over') + ' · ' + fmtTalk(m.talk_s); }
function fillMonth(body, m){ body.textContent = ''; m.days.forEach(d => body.appendChild(dayBtn(d))); }
function renderDays(){
  syncView();
  const box = $('recDays'); if(!box) return;
  const narrow = !!(NARROW && NARROW.matches);
  const fe = document.activeElement, fk = fe && box.contains(fe) ? fe.dataset.k || '' : '';
  const keepTop = box.scrollTop;
  const ms0 = box.querySelector('.mstrip'), ds0 = box.querySelector('.dstrip');
  // relayout: the last drawing was the other layout (a rotation or a resize across 720px) or nothing at all. There is no
  // scroll of this layout to keep, so the pressed month and the open day are brought into view instead.
  const relayout = narrow ? !ms0 : !box.querySelector('.mon');
  const ms = months(), newest = ms.length ? ms[0].mon : '', curMon = monthOf(curDay);
  if(revealDay && curMon){ monthOpen.set(curMon, true); pickMonth = curMon; }
  if(!ms.some(m => m.mon === pickMonth)) pickMonth = ms.some(m => m.mon === curMon) ? curMon : newest;
  const keepM = ms0 ? ms0.scrollLeft : 0, keepD = ds0 && ds0.dataset.mon === pickMonth ? ds0.scrollLeft : 0;
  box.textContent = '';
  if(!days.length){ box.appendChild(mk('div', 'empty', 'No recordings yet.')); return; }
  if(narrow){
    const strip = mk('div', 'mstrip'); strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'Months');
    ms.forEach(m => {
      const b = mk('button', 'mchip'); b.dataset.k = 'm:' + m.mon;
      b.setAttribute('aria-pressed', String(m.mon === pickMonth));
      b.appendChild(mk('span', '', mFmtShort.format(monthDate(m.mon))));
      b.appendChild(mk('span', 'mn', plural(m.days.length, 'day')));
      b.title = mFmtLong.format(monthDate(m.mon)) + ': ' + monthStats(m);
      b.addEventListener('click', () => { pickMonth = m.mon; renderDays(); });
      strip.appendChild(b);
    });
    const m = ms.find(x => x.mon === pickMonth);
    const ds = mk('div', 'dstrip'); ds.dataset.mon = pickMonth;
    ds.setAttribute('role', 'group'); ds.setAttribute('aria-label', 'Days in ' + mFmtLong.format(monthDate(pickMonth)));
    fillMonth(ds, m);
    box.appendChild(strip); box.appendChild(ds);
    strip.scrollLeft = keepM; ds.scrollLeft = keepD;
  } else {
    ms.forEach(m => {
      const open = isOpen(m.mon, newest);
      const g = mk('div', 'mon');
      const hd = mk('button', 'mhd' + (mode === 'day' && m.mon === curMon ? ' cur' : '')); hd.dataset.k = 'm:' + m.mon;
      const body = mk('div', 'mdays'); body.id = 'recM-' + m.mon; body.hidden = !open;
      hd.setAttribute('aria-expanded', String(open)); hd.setAttribute('aria-controls', body.id);
      const car = mk('span', 'car', open ? '▾' : '▸');
      const t = mk('span', 'mt'); t.appendChild(car); t.appendChild(document.createTextNode(mFmtLong.format(monthDate(m.mon))));
      hd.appendChild(t);
      hd.appendChild(mk('span', 'ms', monthStats(m)));
      hd.addEventListener('click', () => {                 // in place: no re-render, so focus and scroll stay put
        const o = hd.getAttribute('aria-expanded') !== 'true';
        monthOpen.set(m.mon, o);
        hd.setAttribute('aria-expanded', String(o)); car.textContent = o ? '▾' : '▸';
        body.hidden = !o;
        if(o && !body.childElementCount) fillMonth(body, m);
      });
      if(open) fillMonth(body, m);
      g.appendChild(hd); g.appendChild(body);
      box.appendChild(g);
    });
    box.scrollTop = keepTop;
  }
  if(fk){ const e = box.querySelector('[data-k="' + CSS.escape(fk) + '"]'); if(e) e.focus({preventScroll: true}); }
  if(revealDay || relayout){ revealDay = false; revealCur(box, narrow); }
  if(!box.getClientRects().length) revealOnShow = true;   // the tab is hidden (display:none): nothing could be measured
}
/* Bring the pressed month chip (narrow) and the open day into view, scrolling only the list. */
function revealCur(box, narrow){
  const day = mode === 'day' && curDay ? box.querySelector('[data-k="' + CSS.escape('d:' + curDay) + '"]') : null;
  if(narrow){
    reveal(box.querySelector('.mstrip'), box.querySelector('.mchip[aria-pressed="true"]'), true);
    reveal(box.querySelector('.dstrip'), day, true);      // null when the strip shows another month
  } else reveal(box, day, false);                          // null when the open day's month is collapsed
}
/* Scroll only the list itself (never the page) so el is in view. */
function reveal(scroller, el, horiz){
  if(!scroller || !el) return;
  const s = scroller.getBoundingClientRect(), r = el.getBoundingClientRect();
  if(horiz){
    if(r.left < s.left) scroller.scrollLeft -= s.left - r.left + 8;
    else if(r.right > s.right) scroller.scrollLeft += r.right - s.right + 8;
  } else {
    const hd = el.closest('.mon') ? el.closest('.mon').querySelector('.mhd') : null;
    const top = s.top + (hd ? hd.offsetHeight : 0);        // the month header is sticky: don't hide the day under it
    if(r.top < top) scroller.scrollTop -= top - r.top + 6;
    else if(r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom + 6;
  }
}
if(NARROW){
  const re = () => renderDays();
  if(NARROW.addEventListener) NARROW.addEventListener('change', re); else if(NARROW.addListener) NARROW.addListener(re);
}
async function loadDay(day, quiet){
  if(!day){ rows = []; renderRows(); return; }
  if(!quiet){ const r = $('recRows'); if(r){ r.textContent = ''; r.appendChild(mk('div', 'empty', 'Loading…')); } }
  try{
    const j = await api('/overs?day=' + encodeURIComponent(day));
    if(mode !== 'day' || day !== curDay) return;             // the viewer moved on while this loaded
    rows = (Array.isArray(j.overs) ? j.overs : []).slice().sort((a, b) => endTs(a) - endTs(b));
    setNote('', '');
    renderRows();
  }catch(e){ fail(e, 'recordings for ' + day); }
}

/* A range view: fetch each recorded day in it (cached; today re-fetched on refresh), newest day first. Re-renders only
   when something changed, so the 30 s refresh never jumps the list under the reader. */
async function loadRange(refresh){
  const seq = ++rangeSeq, want = viewDays().slice(0, rangeShown), today = todayPT();
  const need = want.filter(d => !rangeCache.has(d) || (refresh && d === today));
  try{
    for(let i = 0; i < need.length; i += RANGE_FETCH){
      const part = need.slice(i, i + RANGE_FETCH);
      const js = await Promise.all(part.map(d => api('/overs?day=' + encodeURIComponent(d))));
      js.forEach((j, k) => rangeCache.set(part[k], (Array.isArray(j.overs) ? j.overs : []).slice().sort((a, b) => endTs(a) - endTs(b))));
    }
    if(seq !== rangeSeq || mode !== 'range') return;         // the viewer moved on while this loaded
    const sig = view + '|' + want.map(d => {
      const o = rangeCache.get(d) || [], z = o[o.length - 1];
      return d + ':' + o.length + ':' + (z ? z.id + ':' + (z.state || '') + ':' + (z.text || '').length : '');
    }).join(',');
    if(refresh && sig === rangeSig) return;
    rangeSig = sig; rangeLoaded = want;
    rows = []; rowDay.clear();
    want.forEach(d => (rangeCache.get(d) || []).forEach(r => { rows.push(r); rowDay.set(r.id, d); }));
    setNote('', '');
    renderRows();
  }catch(e){
    if(seq === rangeSeq && mode === 'range'){ const b = document.querySelector('#tab-rec .rmore'); if(b){ b.disabled = false; b.textContent = 'Try again'; } }
    fail(e, 'recordings for ' + viewLabel().toLowerCase());
  }
}

/* ---------- search */
async function runSearch(v, keep){
  query = String(v || '').trim();
  if(query.length < 2){
    if(mode === 'search'){
      hitId = '';
      if(view === 'day'){ mode = 'day'; renderDays(); loadDay(curDay); }
      else { mode = 'range'; rangeSig = ''; renderDays(); loadRange(false); }
    }
    return;
  }
  mode = 'search'; renderDays();
  try{
    const j = await api('/search?q=' + encodeURIComponent(query.slice(0, 64)) + (net ? '&net=' + net : ''));
    if(mode !== 'search' || query !== String(($('recQ') || {}).value || '').trim()) return;
    rows = Array.isArray(j.overs) ? j.overs : [];               // newest first across all days
    searchCapped = rows.length >= SEARCH_CAP;                   // the API stops at its limit: older matches exist
    renderRows();
  }catch(e){ fail(e, 'search results'); }
}

/* ---------- rows */
/* The net + no-speech filter. QSO blocks are built from this list, so a talker chip never splits a QSO. */
function baseRows(){
  return rows.filter(r => (!net || r.chan === net || (net === 'H' && r.chan === 'P')) &&
    (r.pinned || mode === 'search' || !hideNoise || !(NOISE.has(r.path) || (!r.text && (r.dur || 0) < 1.0))));
}
function visibleRows(){ return baseRows().filter(r => P.matchTalker(r, who)); }
function renderWho(base){
  const box = $('recWho'); if(!box) return;
  box.textContent = '';
  const chips = P.talkerChips(base, who);
  if(chips.length < 3 && !who) return;                       // one talker (or none): nothing to choose between
  chips.forEach(c => {
    const b = mk('button', 'chip', c.label); b.setAttribute('aria-pressed', String(c.v === who));
    b.appendChild(mk('span', 'cn', String(c.n)));
    b.title = c.v === '@radio' ? 'Only overs to Radio' : c.v ? 'Only ' + c.label : 'Everyone';
    b.addEventListener('click', () => { who = c.v; renderRows(); });
    box.appendChild(b);
  });
}
function renderRows(){
  const box = $('recRows'); if(!box) return;
  box.textContent = '';
  const base = baseRows();
  renderWho(base);
  const list = base.filter(r => P.matchTalker(r, who));
  if(mode === 'search') box.appendChild(mk('div', 'qso', list.length + ' match' + (list.length === 1 ? '' : 'es') + ' for "' + query + '"' +
    (searchCapped ? ' (the newest ' + rows.length + ' only: add a word or pick a network to reach older ones)' : '')));
  if(mode === 'range') box.appendChild(rangeSum(list));
  if(!list.length){
    box.appendChild(mk('div', 'empty', who && base.length ? 'Nothing from ' + (who === '@radio' ? 'Radio' : who) + ' in this view.' :
      mode === 'search' ? 'Nothing matches.' : (mode === 'range' ? 'Nothing recorded in these days' : 'Nothing recorded on this day') + (hideNoise ? ' (no-speech overs hidden)' : '') + '.'));
    if(mode === 'range') rangeMore(box);
    return;
  }
  if(mode === 'day'){
    P.qsoBlocks(base, QSO_GAP_S).forEach(blk => {
      const shown = blk.filter(r => P.matchTalker(r, who));
      if(!shown.length) return;                              // the chip hides a whole QSO it isn't in
      box.appendChild(qsoHead(blk, shown));
      shown.forEach(r => box.appendChild(rowEl(r, list)));
    });
  } else if(mode === 'range'){
    const byDay = new Map();
    base.forEach(r => { const d = rowDay.get(r.id) || ''; if(!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); });
    rangeLoaded.forEach(day => {
      const db = byDay.get(day); if(!db) return;
      const dl = db.filter(r => P.matchTalker(r, who)); if(!dl.length) return;
      box.appendChild(dayHead(day, dl));
      P.qsoBlocks(db, QSO_GAP_S).forEach(blk => {
        const shown = blk.filter(r => P.matchTalker(r, who));
        if(!shown.length) return;                            // the chip hides a whole QSO it isn't in
        box.appendChild(qsoHead(blk, shown));
        shown.forEach(r => box.appendChild(rowEl(r, dl)));   // continuous play stays inside this day
      });
    });
    rangeMore(box);
  } else list.forEach(r => box.appendChild(rowEl(r, list)));
  if(hitId){ const h = document.querySelector('#tab-rec .ov[data-id="' + CSS.escape(hitId) + '"]'); if(h){ h.classList.add('hit'); h.scrollIntoView({block: 'center'}); } hitId = ''; }
}
function rangeSum(list){
  const all = viewDays().length;
  return mk('div', 'rsum', viewLabel() + ': ' + plural(all, 'recorded day') + (rangeLoaded.length < all ? ' (newest ' + rangeLoaded.length + ' shown)' : '') +
    ' · ' + plural(list.length, 'over') + (hideNoise ? ', no-speech hidden' : ''));
}
function dayHead(day, dl){
  const h = mk('div', 'rday');
  h.appendChild(mk('b', '', dayLabel(day)));
  h.appendChild(document.createTextNode(plural(dl.length, 'over') + ' · ' + fmtTalk(dl.reduce((a, r) => a + (+r.dur || 0), 0))));
  const go = mk('button', 'sm', 'Open day'); go.title = 'Show only ' + dayLabel(day);
  go.addEventListener('click', () => openDay(day));
  h.appendChild(go);
  return h;
}
function rangeMore(box){
  const left = viewDays().length - rangeLoaded.length;
  if(left <= 0) return;
  const n = Math.min(RANGE_PAGE, left);
  const b = mk('button', 'rmore', 'Load ' + plural(n, 'older day') + (left > n ? ' (' + left + ' left)' : ''));
  b.addEventListener('click', () => { b.disabled = true; b.textContent = 'Loading…'; rangeShown += RANGE_PAGE; loadRange(false); });
  box.appendChild(b);
}
function qsoHead(blk, shown){
  const names = [...new Set(blk.map(x => x.talker).filter(Boolean))];
  const h = mk('div', 'qso');
  h.appendChild(mk('b', '', fmtShort(startTs(blk[0])) + ' – ' + fmtShort(endTs(blk[blk.length - 1]))));
  h.appendChild(document.createTextNode(' · ' + plural(blk.length, 'over') + (names.length ? ' · ' + names.join(', ') : '') +
    (shown.length !== blk.length ? ' · showing ' + shown.length : '')));
  const qb = mk('span', 'qb');
  const st = P.pinState(blk);
  const sv = mk('button', 'sm', 'Save QSO');
  sv.title = 'Download the whole QSO: one MP3 with the overs in order, plus a .txt transcript';
  if(st.tooMany || st.tooLong){ sv.disabled = true; sv.title = 'Too long to join into one file (' + (st.tooMany ? 'over ' + P.QSO_MAX_IDS + ' overs' : 'over an hour of audio') + '). Download the overs one at a time.'; }
  sv.addEventListener('click', () => saveQso(blk, sv));
  qb.appendChild(sv);
  if(canPin && st.canPin && !st.tooMany){
    const pb = mk('button', 'sm', 'Pin QSO'); pb.title = 'Pin every over in this QSO: safe from the size cap';
    pb.addEventListener('click', () => doPin(blk.filter(r => !r.pinned).map(r => r.id), true, noteUi()));
    qb.appendChild(pb);
  }
  if(canPin && st.canUnpin){
    const ub = mk('button', 'sm', 'Unpin QSO');
    const ids = blk.filter(r => r.pinned && r.pin_kind === 'page').map(r => r.id);
    ub.title = 'Unpin the ' + plural(ids.length, 'pinned over') + ' in this QSO (keepsakes stay pinned)';
    ub.addEventListener('click', () => confirmUnpin(ids, 'this QSO (' + plural(ids.length, 'pinned over') + ')'));
    qb.appendChild(ub);
  }
  h.appendChild(qb);
  return h;
}
function rowEl(r, list){
  const d = mk('div', 'ov' + (r.id === playingId ? ' playing' : '')); d.dataset.id = r.id;
  const pb = mk('button', 'pb', r.id === playingId && !audio.paused ? '■' : '▶');
  pb.title = r.id === playingId && !audio.paused ? 'Stop' : 'Play'; pb.setAttribute('aria-label', pb.title + ' ' + (r.talker || 'over') + ' at ' + fmtTime(startTs(r)));
  pb.addEventListener('click', () => { if(r.id === playingId && !audio.paused){ stopAudio(); } else { unlockAudio(); play(r, list); } });
  d.appendChild(pb);
  const mid = mk('div', '');
  const meta = mk('div', 'meta');
  const who = mk('span', 'who', r.talker || 'unknown');
  if(r.dmr_id) who.title = 'DMR ID ' + r.dmr_id;
  meta.appendChild(who);
  if(mode === 'search') meta.appendChild(mk('span', '', dayLabel(ptDay(r.ts * 1000))));   // says the year when not this year
  meta.appendChild(mk('span', '', fmtTime(startTs(r))));
  meta.appendChild(mk('span', '', fmtLen(r.dur)));
  meta.appendChild(netTag(r));
  if(r.pinned){
    // kept forever, a pin still means something: it is never removed by the archive's size cap (or a shorter keep)
    const ks = r.pin_kind === 'keepsake';
    const t = mk('span', 'tag ' + (ks ? 'keep' : 'pin'), (ks ? 'keepsake' : 'pinned') + (keep && keep.forever ? '' : ' · kept forever'));
    t.title = ks ? 'A keepsake: pinned for good on the server. It can never be unpinned from this page.' : 'Pinned: never deleted, not even by the size cap';
    meta.appendChild(t);
  }
  if(r.path === 'wake' || r.path === 'ai' || r.path === 'bare') meta.appendChild(mk('span', 'tag dim', 'to Radio'));
  mid.appendChild(meta);
  if(r.text){
    const cut = r.text.length === 200 || r.text.length === 400;
    const t = mk('div', 'txt', r.text + (cut ? ' …' : ''));
    if(cut) t.title = 'Radio keeps only the start of a long transcript. Play the recording for the rest.';
    mid.appendChild(t);
  }
  else mid.appendChild(mk('div', 'txt none', NOISE.has(r.path) ? 'no speech recognised' : r.state === 'pending' ? 'transcript pending…' : 'no transcript'));
  if(r.answer){ const a = mk('div', 'ans'); a.appendChild(mk('b', '', 'Radio: ')); a.appendChild(document.createTextNode(r.answer)); mid.appendChild(a); }
  if(mode === 'search'){
    const go = mk('button', 'sm', 'Open day'); go.style.marginTop = '6px';
    go.addEventListener('click', () => {
      openDay(ptDay(r.ts * 1000), r.id);
    });
    mid.appendChild(go);
  }
  d.appendChild(mid);
  const side = mk('div', 'side');
  if(canPin && (!r.pinned || r.pin_kind === 'page')){         // keepsakes (and pins from an older archive) are locked
    const pn = mk('button', 'pn', r.pinned ? 'Unpin' : 'Pin');
    pn.setAttribute('aria-pressed', String(!!r.pinned));
    pn.title = r.pinned ? 'Unpin (the recording is still kept forever)' : 'Pin: safe from the archive size cap';
    pn.setAttribute('aria-label', pn.textContent + ' the over from ' + (r.talker || 'unknown') + ' at ' + fmtTime(startTs(r)));
    pn.addEventListener('click', () => { if(r.pinned) confirmUnpin([r.id], 'this over'); else doPin([r.id], true, noteUi()); });
    side.appendChild(pn);
  }
  const dl = mk('button', 'dl', '⬇'); dl.title = 'Download'; dl.setAttribute('aria-label', 'Download this over');
  dl.addEventListener('click', () => download(r));
  side.appendChild(dl);
  d.appendChild(side);
  return d;
}

/* ---------- audio */
async function blobEntry(r){
  if(blobs.has(r.id)){ const b = blobs.get(r.id); blobs.delete(r.id); blobs.set(r.id, b); return b; }
  const mp3 = NEED_MP3 && r.codec === 'opus';                // wav plays everywhere; only opus needs the MP3
  const buf = await api('/audio/' + encodeURIComponent(r.id) + (mp3 ? '?fmt=mp3' : ''), true);
  const type = mp3 ? 'audio/mpeg' : r.codec === 'opus' ? 'audio/ogg' : 'audio/wav';
  const b = {u: URL.createObjectURL(new Blob([buf], {type: type})), ext: mp3 ? '.mp3' : r.codec === 'opus' ? '.opus' : '.wav'};
  blobs.set(r.id, b);
  while(blobs.size > BLOB_CACHE){ const [k, v] = blobs.entries().next().value; if(k === playingId) break; blobs.delete(k); URL.revokeObjectURL(v.u); trims.delete(k); }
  return b;
}
async function blobUrl(r){ return (await blobEntry(r)).u; }
let playList = [], playSearch = false, lastPlayed = null, curTrim = null, silentOn = false, unlocked = false;
const trims = new Map();                                     // id -> Promise<{start, end} | null>
/* iOS only lets a page start audio from a tap. The tap starts a fetch first, so the element is "unlocked" with a
   tiny silent clip inside the tap itself; the real play() a moment later is then allowed. */
let silentUrl = '';
function unlockAudio(){
  if(unlocked) return;
  unlocked = true;
  try{
    if(!silentUrl){
      const n = 400, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);   // 50 ms of 8 kHz silence
      const w = (o, s) => { for(let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true);
      v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      silentUrl = URL.createObjectURL(new Blob([ab], {type: 'audio/wav'}));
    }
    silentOn = true; audio.src = silentUrl;
    const p = audio.play(); if(p && p.catch) p.catch(() => {});
  }catch(e){ silentOn = false; }
}
function applyRate(){ try{ audio.defaultPlaybackRate = rate; audio.playbackRate = rate; }catch(e){} }
async function play(r, list){
  playList = list || visibleRows(); playSearch = mode === 'search';
  playingId = r.id; lastPlayed = r; curTrim = null; markPlaying();
  try{
    const u = await blobUrl(r);
    if(playingId !== r.id) return;
    silentOn = false;
    audio.src = u; applyRate();
    msMeta(r);
    await audio.play();
    applyRate();
    if(cont && skipSil) trimFor(r.id, u).then(b => {
      if(!b || playingId !== r.id || !cont || !skipSil) return;
      curTrim = {id: r.id, start: b.start, end: b.end};
      if(audio.currentTime < b.start) try{ audio.currentTime = b.start; }catch(e){}
    });
    if(cont) prefetchNext(r);
  }catch(e){
    if(e && e.name === 'AbortError') return;
    playingId = ''; markPlaying();
    if(e && e.name === 'NotAllowedError') setNote('warn', 'The browser blocked playback. Tap play again.');
    else if(e && e.code) fail(e, 'that recording'); else setNote('warn', 'Could not play that recording (' + ((e && e.message) || e) + ').');
  }
  markPlaying();
}
function nextOf(id, dir){
  const i = playList.findIndex(x => x.id === id);
  return i < 0 ? null : playList[P.nextIndex(i, dir, playSearch)] || null;
}
/* Fetch (and measure) the next over while this one plays, so a locked phone moves on without a gap. */
function prefetchNext(r){
  const nx = nextOf(r.id, 1);
  if(nx) blobUrl(nx).then(u => { if(cont && skipSil) trimFor(nx.id, u); }).catch(() => {});
}
let decodeCtx = null;
function decodeAudio(ab){
  if(!decodeCtx){
    const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if(!C) return Promise.reject(new Error('no audio decoder'));
    decodeCtx = new C(1, 1, 44100);
  }
  return new Promise((ok, no) => { const p = decodeCtx.decodeAudioData(ab, ok, no); if(p && p.then) p.then(ok, no); });
}
/* Where the speech starts and ends in an over (skip-silence). Read back from the cached blob, so no refetch. */
function trimFor(id, url){
  if(trims.has(id)) return trims.get(id);
  const pr = fetch(url).then(x => x.arrayBuffer()).then(decodeAudio)
    .then(b => P.silenceBounds(b.getChannelData(0), b.sampleRate)).catch(() => null);
  trims.set(id, pr);
  if(trims.size > 200) trims.delete(trims.keys().next().value);
  return pr;
}
function stopAudio(){ audio.pause(); playingId = ''; curTrim = null; markPlaying(); }
function step(dir){
  const id = playingId || (lastPlayed && lastPlayed.id);
  const nx = id ? nextOf(id, dir) : null;
  if(!nx) return;
  play(nx, playList);
  const el = document.querySelector('#tab-rec .ov[data-id="' + CSS.escape(nx.id) + '"]'); if(el) el.scrollIntoView({block: 'nearest'});
}
/* The end of an over (or of its speech, with skip-silence): the next one in time when playing continuously. */
function advance(){
  const id = playingId;
  if(cont && id){
    const nx = nextOf(id, 1);
    if(nx){ play(nx, playList); const el = document.querySelector('#tab-rec .ov[data-id="' + CSS.escape(nx.id) + '"]'); if(el) el.scrollIntoView({block: 'nearest'}); return; }
  }
  playingId = ''; curTrim = null; markPlaying();
}
/* ---------- lock screen (Media Session): title = talker + time; next/previous follow the continuous-play order */
const MS = navigator.mediaSession || null;
function msMeta(r){
  if(!MS) return;
  try{
    if(typeof MediaMetadata === 'function') MS.metadata = new MediaMetadata({
      title: (r.talker || 'unknown') + ' · ' + fmtTime(startTs(r)),
      artist: r.net || (r.chan === 'B' ? 'HOLDEN DMR' : (r.chan === 'H' || r.chan === 'P') ? "PRESTON'S TALK GROUP" : 'HOLDEN1'),
      album: 'Recordings · ' + dayLabel(ptDay(r.ts * 1000))});
  }catch(e){}
}
if(MS){
  const h = (a, f) => { try{ MS.setActionHandler(a, f); }catch(e){} };
  h('play', () => { if(playingId) audio.play().catch(() => {}); else if(lastPlayed) play(lastPlayed, playList); });
  h('pause', () => audio.pause());
  h('stop', () => stopAudio());
  h('nexttrack', () => step(1));
  h('previoustrack', () => step(-1));
}
function msState(){ if(MS) try{ MS.playbackState = audio.paused ? (playingId ? 'paused' : 'none') : 'playing'; }catch(e){} }
function markPlaying(){
  document.querySelectorAll('#tab-rec .ov').forEach(el => {
    const on = el.dataset.id === playingId;
    el.classList.toggle('playing', on);
    const b = el.querySelector('.pb'); if(b){ const p = on && !audio.paused; b.textContent = p ? '■' : '▶'; b.title = p ? 'Stop' : 'Play'; }
  });
}
audio.addEventListener('play', () => { markPlaying(); msState(); });
audio.addEventListener('pause', () => { markPlaying(); msState(); });
audio.addEventListener('ended', () => { if(silentOn) return; advance(); });   // the unlock clip is not an over
audio.addEventListener('timeupdate', () => {
  if(curTrim && cont && skipSil && !silentOn && curTrim.id === playingId && audio.currentTime >= curTrim.end){ curTrim = null; advance(); }
});

/* ---------- pin / unpin (owner only: the archive checks the token and a sign-in under 10 minutes old) */
function noteUi(){
  const say = (k, t) => { if(typeof flash === 'function') flash(k, t); else setNote(k === 'ok' ? 'info' : k, t); };
  return {busy: () => {}, error: t => say('warn', t), done: t => say('ok', t)};
}
function modalUi(){
  return {busy: t => modalBusy(t), error: t => modalError(t),
    done: t => { modalBusy(''); closeModal(); if(typeof flash === 'function') flash('ok', t); else setNote('info', t); }};
}
async function postPin(ids, pin){
  for(let i = 0; i < 2; i++){
    const tok = typeof idTok === 'function' ? await idTok(i > 0) : await token(i > 0);   // idTok also notes auth_time
    const r = await fetch(ARCH_BASE + '/pin', {method: 'POST', cache: 'no-store',
      headers: {'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'}, body: JSON.stringify({ids: ids, pin: !!pin})});
    let j = null; try{ j = await r.json(); }catch(e){}
    if(r.status === 401 && i === 0) continue;                // one retry with a fresh token
    if(!r.ok){ const e = new Error((j && j.error) || 'HTTP ' + r.status); e.code = r.status; e.api = j && j.error; throw e; }
    return j || {};
  }
}
/* MUST be called synchronously from a click: the fresh-sign-in popup needs the gesture. */
function doPin(ids, pin, ui){
  if(!ids || !ids.length) return;
  let pre;
  try{ pre = (typeof authFresh === 'function' && typeof startReauth === 'function' && !authFresh()) ? startReauth() : Promise.resolve(); }
  catch(e){ pre = Promise.reject(e); }
  ui.busy(pin ? 'Pinning…' : 'Unpinning…');
  pre.then(() => postPin(ids, pin), e => {
    const x = new Error(typeof reauthErrText === 'function' ? reauthErrText(e) : 'The Google sign-in confirmation failed.'); x.reauth = true; throw x;
  }).then(j => {
    P.applyPinResults(rows, j.results);
    renderRows();
    ui.done(P.pinSummary(j.counts, pin));
  }).catch(e => {
    if(e && e.api === 'reauth_required'){
      try{ authTimeCache = 0; }catch(_){}                    // the page's own clock was too generous: ask next time
      ui.error('The archive needs a Google sign-in from the last 10 minutes. Press the button again to confirm it.');
    }
    else if(e && e.reauth) ui.error(e.message);
    else if(e && e.code === 429) ui.error('Too many pin changes in a minute. Wait a moment and try again.');
    else if(e && (e.code === 401 || e.code === 403)) ui.error('Only the owner account can pin or unpin recordings.');
    else if(e && e.code === 405) ui.error('The archive on .151 does not support pinning yet.');
    else ui.error('Could not ' + (pin ? 'pin' : 'unpin') + ' (' + ((e && e.message) || e) + '). Nothing was changed.');
  });
}
function hEsc(s){ return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]); }
function confirmUnpin(ids, label){
  const txt = 'The recording' + (ids.length === 1 ? ' is' : 's are') + ' still kept forever. Unpinning only means the archive\'s size cap could remove ' +
    (ids.length === 1 ? 'it' : 'them') + ' one day, oldest first, if the archive ever fills up. Keepsakes stay pinned whatever you choose.';
  if(typeof openModal !== 'function' || typeof dlgButtons !== 'function'){
    if(window.confirm('Unpin ' + label + '?\n\n' + txt)) doPin(ids, false, noteUi());
    return;
  }
  openModal('<h3>Unpin ' + hEsc(label) + '?</h3><p>' + hEsc(txt) + '</p>' + dlgButtons('Unpin', 'recUnpinGo'));
  const go = document.getElementById('dlgGo');
  if(go) go.addEventListener('click', () => { modalError(''); doPin(ids, false, modalUi()); });
}

/* ---------- Save QSO: the archive joins the overs (one MP3, short silence between) and adds a .txt transcript */
async function saveQso(blk, btn){
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try{
    const buf = await api('/qso?ids=' + blk.map(r => encodeURIComponent(r.id)).join(','), true);
    const u = URL.createObjectURL(new Blob([buf], {type: 'application/zip'}));
    const a = document.createElement('a'); a.href = u; a.download = P.qsoFileName(blk) + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }catch(e){
    const c = e && e.code;
    if(c === 413) setNote('warn', 'That QSO is too long to join into one file (over an hour of audio). Download the overs one at a time.');
    else if(c === 503) setNote('warn', 'The archive is busy joining another QSO, or cannot convert audio right now. Try again in a minute.');
    else if(c === 404) setNote('warn', 'The archive on .151 cannot save a whole QSO yet (or those overs are gone from it).');
    else fail(e, 'that QSO');
  }finally{ btn.disabled = false; btn.textContent = old; }
}

async function download(r){
  try{
    const b = await blobEntry(r), u = b.u;
    const day = new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date(r.ts * 1000));
    const hm = new Intl.DateTimeFormat('en-GB', {timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit'}).format(new Date(r.ts * 1000)).replace(/:/g, '');
    const a = document.createElement('a');
    a.href = u; a.download = [(r.chan === 'B' ? 'HOLDEN-DMR' : (r.chan === 'H' || r.chan === 'P') ? 'PRESTONS-TG' : 'HOLDEN1'), day, hm, (r.talker || 'unknown').replace(/[^A-Za-z0-9]/g, '')].join('-') + b.ext;
    document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ fail(e, 'that recording'); }
}

/* ---------- archive health */
async function loadStatus(){
  const h = $('recHealth'); if(!h) return;
  try{
    const s = await api('/status');
    setKeep(s);
    h.textContent = '';
    const bits = [];
    const cap = typeof s.max_mb === 'number' && s.max_mb > 0 ? s.max_mb : 0;   // HDMR_MAX_MB, when the API says it
    bits.push((s.rows || 0) + ' recordings · ' + (s.mb || 0) + ' MB' + (cap ? ' of the ' + Math.round(cap) + ' MB size cap' : ''));
    if(s.last_over_ts) bits.push('last over ' + ago(s.now - s.last_over_ts));
    const wAge = s.watch_last_run_age_s, wStale = s.watch_installed === true && (typeof wAge !== 'number' || wAge > 180);   // (watch-banner 2026-10-24)
    if(s.watch_installed === true && !wStale) bits.push('recording watchdog checked ' + ago(wAge));
    h.appendChild(document.createTextNode('Archive: ' + bits.join(' · ') + ' · served by hdmr-archive on .151'));
    const warn = [];
    if(s.heartbeat_age_s === null || s.heartbeat_age_s > 300) warn.push(['bad', 'The archiver on .151 is not running' + (s.heartbeat_age_s ? ' (last heartbeat ' + ago(s.heartbeat_age_s) + ')' : '') + '. New overs are not being saved.']);
    if(s.missed_24h > 0) warn.push(['warn', 'Radio heard ' + s.missed_24h + ' over' + (s.missed_24h === 1 ? '' : 's') + ' in the last 24 h that did not make it into the archive.']);
    if(s.skipped_disk > 0 && s.disk_free_mb < 2500) warn.push(['bad', 'The server is low on disk (' + s.disk_free_mb + ' MB free). Recording is paused.']);
    if(s.prune_stale) warn.push(['warn', 'The archive\'s daily clean-up' + (keep && !keep.forever ? ' (' + keep.days + '-day limit and size cap)' : ' (size cap)') + ' has not run in over a day and a half.']);
    // Kept forever, the clean-up should remove nothing. If it did, the size cap is deleting the oldest recordings. The cap
    // only deletes AT the cap (afterwards the archive is within one clip of max_mb), so a count with the archive far below
    // max_mb is not the cap: it is the last age prune (30 days) from before the server switched to forever, which the
    // API keeps reporting until the next clean-up (up to 6 h later). It is not shown as a cap deletion.
    const gone = +s.last_prune_removed || 0;              // the API sends this as a string
    const atCap = cap > 0 && (+s.mb || 0) >= cap * 0.8;
    if(keep && keep.forever && gone > 0 && (atCap || !cap)) warn.push(['bad', 'The archive\'s size cap deleted the oldest ' + plural(gone, 'recording') + ' in its last clean-up. Recordings are meant to be kept forever: the cap needs raising on .151.']);
    else if(keep && keep.forever && atCap) warn.push(['warn', 'The archive is at ' + Math.round(100 * s.mb / cap) + '% of its ' + Math.round(cap) + ' MB size cap. At the cap the oldest unpinned recordings are deleted: the cap needs raising on .151.']);
    if(wStale) warn.push(['bad', 'The recording watchdog on .151 has ' + (typeof wAge === 'number' ? 'not checked in ' + ago(wAge).replace(' ago', '') : 'never checked in') + ': a missed recording would go unnoticed.']);
    if(s.watch_installed === true && s.watch_open) warn.push(['bad', 'The recording watchdog has an open alert: recordings are missing or the archive has stalled (see its email).']);
    warn.forEach(([k, t]) => { const w = mk('div', k === 'bad' ? 'warnbox' : 'patchbox', t); h.appendChild(w); });
  }catch(e){ if(!(e && e.code === 401)) h.textContent = 'Archive status unavailable (' + ((e && e.message) || e) + ').'; }
}

/* ---------- lifecycle */
function tick(){
  if(!visible || stoppedAuth || document.visibilityState === 'hidden') return;
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date());
  if(audio.paused && ((mode === 'day' && (curDay === today || !curDay)) || mode === 'range')) loadDays();   // today grows; don't re-render mid-play
}
function show(){
  build();
  visible = true;
  const box = $('recDays');                                // redrawn while hidden (e.g. the phone rotated on another tab)
  if(revealOnShow && box && box.getClientRects().length){ revealOnShow = false; revealCur(box, !!(NARROW && NARROW.matches)); }
  if(!started){
    started = true;
    loadDays(); loadStatus();
    dayTimer = setInterval(tick, 30000);
    statusTimer = setInterval(() => { if(visible && !stoppedAuth && document.visibilityState !== 'hidden') loadStatus(); }, 60000);
  }
}
function hide(){ visible = false; }
window.HdmrRec = {show: show, hide: hide};

firebase.auth().onAuthStateChanged(function(u){
  if(u && location.hash === '#recordings') show();
});
})();
