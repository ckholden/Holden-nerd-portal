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
   textContent (never innerHTML), and blobs get a fixed type chosen here, never the one the server sent. */
(function(){
'use strict';
const ARCH_BASE = 'https://kj7dts-server.tail34c6a5.ts.net/hdmrarchive';   // <- only line to change if the box moves
const TZ = 'America/Los_Angeles';
const NOISE = new Set(['nonspeech', 'impossible', 'leak', 'scaffold', 'stt_none', 'phantom', 'corpus']);
const QSO_GAP_S = 300;                     // a quiet gap longer than this starts a new QSO block
const BLOB_CACHE = 12;
const FOREVER_DAYS = 3650;                 // keep_days at or above this (10 years) is shown as "kept forever"
const SEARCH_CAP = 200;                    // hdmr-archive /search default limit (newest first)
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
#tab-rec .qso{margin:14px 0 6px;padding:6px 10px;background:var(--card2);border-left:3px solid var(--blue);font-size:12px;color:var(--dim)}
#tab-rec .qso b{color:var(--tx)}
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
let days = [], curDay = '', rows = [], mode = 'day';        // mode: 'day' | 'search'
let net = '', hideNoise = true, cont = false, query = '', hitId = '';
let playingId = '', dayTimer = null, statusTimer = null, searchTimer = null;
let keep = null;                                             // null until the API says: {forever: true} | {days: N}
const monthOpen = new Map();                                 // 'YYYY-MM' -> open? (wide list: the viewer's own toggles)
let pickMonth = '', revealDay = false, searchCapped = false; // pickMonth: the month shown in the narrow day strip
const blobs = new Map();                                     // id -> object URL (small LRU)
const audio = new Audio();
audio.preload = 'none';

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
  tool.appendChild(cb('recCont', 'Play continuously', cont, v => { cont = v; }));
  p.appendChild(tool);
  if(!audio.canPlayType('audio/ogg; codecs=opus')){
    p.appendChild(mk('div', 'warnbox', 'This browser cannot play Opus audio. Use Chrome, Edge or Firefox (or a recent Safari), or use the download buttons.'));
  }
  const grid = mk('div', 'rgrid');
  const dl = mk('div', 'days'); dl.id = 'recDays'; dl.setAttribute('aria-label', 'Days');
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
    days = Array.isArray(j.days) ? j.days.filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.day)) : [];
    days.sort((a, b) => a.day < b.day ? 1 : a.day > b.day ? -1 : 0);   // newest first (the API already is)
    if(!curDay || !days.some(d => d.day === curDay)){ curDay = days.length ? days[0].day : ''; revealDay = true; }
    renderDays();
    if(mode === 'day') await loadDay(curDay, true);
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
  renderDays(); loadDay(day);
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
  const box = $('recDays'); if(!box) return;
  const narrow = !!(NARROW && NARROW.matches);
  const fe = document.activeElement, fk = fe && box.contains(fe) ? fe.dataset.k || '' : '';
  const keepTop = box.scrollTop;
  const ms0 = box.querySelector('.mstrip'), ds0 = box.querySelector('.dstrip');
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
    ds.setAttribute('aria-label', 'Days in ' + mFmtLong.format(monthDate(pickMonth)));
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
  if(revealDay){
    revealDay = false;
    const e = box.querySelector('[data-k="' + CSS.escape('d:' + curDay) + '"]');
    if(e) reveal(narrow ? box.querySelector('.dstrip') : box, e, narrow);
    if(narrow){ const c = box.querySelector('[data-k="' + CSS.escape('m:' + curMon) + '"]'); if(c) reveal(box.querySelector('.mstrip'), c, true); }
  }
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

/* ---------- search */
async function runSearch(v, keep){
  query = String(v || '').trim();
  if(query.length < 2){
    if(mode === 'search'){ mode = 'day'; hitId = ''; renderDays(); loadDay(curDay); }
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
function visibleRows(){
  return rows.filter(r => (!net || r.chan === net || (net === 'H' && r.chan === 'P')) &&
    (r.pinned || mode === 'search' || !hideNoise || !(NOISE.has(r.path) || (!r.text && (r.dur || 0) < 1.0))));
}
function renderRows(){
  const box = $('recRows'); if(!box) return;
  box.textContent = '';
  const list = visibleRows();
  if(mode === 'search') box.appendChild(mk('div', 'qso', list.length + ' match' + (list.length === 1 ? '' : 'es') + ' for "' + query + '"' +
    (searchCapped ? ' (the newest ' + rows.length + ' only: add a word or pick a network to reach older ones)' : '')));
  if(!list.length){ box.appendChild(mk('div', 'empty', mode === 'search' ? 'Nothing matches.' : 'Nothing recorded on this day' + (hideNoise ? ' (no-speech overs hidden)' : '') + '.')); return; }
  let blockStart = -1;
  list.forEach((r, i) => {
    if(mode === 'day' && (i === 0 || startTs(r) - endTs(list[i - 1]) > QSO_GAP_S)){
      let j = i; while(j + 1 < list.length && startTs(list[j + 1]) - endTs(list[j]) <= QSO_GAP_S) j++;
      const blk = list.slice(i, j + 1);
      const who = [...new Set(blk.map(x => x.talker).filter(Boolean))];
      const h = mk('div', 'qso');
      h.appendChild(mk('b', '', fmtShort(startTs(blk[0])) + ' – ' + fmtShort(endTs(blk[blk.length - 1]))));
      h.appendChild(document.createTextNode(' · ' + blk.length + ' over' + (blk.length === 1 ? '' : 's') + (who.length ? ' · ' + who.join(', ') : '')));
      box.appendChild(h);
      blockStart = i;
    }
    box.appendChild(rowEl(r, list));
  });
  if(hitId){ const h = document.querySelector('#tab-rec .ov[data-id="' + CSS.escape(hitId) + '"]'); if(h){ h.classList.add('hit'); h.scrollIntoView({block: 'center'}); } hitId = ''; }
}
function rowEl(r, list){
  const d = mk('div', 'ov' + (r.id === playingId ? ' playing' : '')); d.dataset.id = r.id;
  const pb = mk('button', 'pb', r.id === playingId && !audio.paused ? '■' : '▶');
  pb.title = r.id === playingId && !audio.paused ? 'Stop' : 'Play'; pb.setAttribute('aria-label', pb.title + ' ' + (r.talker || 'over') + ' at ' + fmtTime(startTs(r)));
  pb.addEventListener('click', () => { if(r.id === playingId && !audio.paused){ stopAudio(); } else play(r, list); });
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
    const t = mk('span', 'tag pin', keep && keep.forever ? 'pinned' : 'pinned · kept forever');
    t.title = 'Pinned: never deleted, not even by the size cap';
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
      const day = ptDay(r.ts * 1000);
      const q = $('recQ'); if(q) q.value = ''; query = ''; mode = 'day'; curDay = day; hitId = r.id; revealDay = true; renderDays(); loadDay(day);
    });
    mid.appendChild(go);
  }
  d.appendChild(mid);
  const side = mk('div', 'side');
  const dl = mk('button', 'dl', '⬇'); dl.title = 'Download'; dl.setAttribute('aria-label', 'Download this over');
  dl.addEventListener('click', () => download(r));
  side.appendChild(dl);
  d.appendChild(side);
  return d;
}

/* ---------- audio */
async function blobUrl(r){
  if(blobs.has(r.id)){ const u = blobs.get(r.id); blobs.delete(r.id); blobs.set(r.id, u); return u; }
  const buf = await api('/audio/' + encodeURIComponent(r.id), true);
  const u = URL.createObjectURL(new Blob([buf], {type: r.codec === 'opus' ? 'audio/ogg' : 'audio/wav'}));
  blobs.set(r.id, u);
  while(blobs.size > BLOB_CACHE){ const [k, v] = blobs.entries().next().value; if(k === playingId) break; blobs.delete(k); URL.revokeObjectURL(v); }
  return u;
}
let playList = [];
async function play(r, list){
  playList = list || visibleRows();
  playingId = r.id; markPlaying();
  try{
    audio.src = await blobUrl(r);
    if(playingId !== r.id) return;
    await audio.play();
  }catch(e){
    if(e && e.name === 'AbortError') return;
    playingId = ''; markPlaying();
    if(e && e.code) fail(e, 'that recording'); else setNote('warn', 'Could not play that recording (' + ((e && e.message) || e) + ').');
  }
  markPlaying();
}
function stopAudio(){ audio.pause(); playingId = ''; markPlaying(); }
function markPlaying(){
  document.querySelectorAll('#tab-rec .ov').forEach(el => {
    const on = el.dataset.id === playingId;
    el.classList.toggle('playing', on);
    const b = el.querySelector('.pb'); if(b){ const p = on && !audio.paused; b.textContent = p ? '■' : '▶'; b.title = p ? 'Stop' : 'Play'; }
  });
}
audio.addEventListener('play', markPlaying);
audio.addEventListener('pause', markPlaying);
audio.addEventListener('ended', () => {
  const i = playList.findIndex(x => x.id === playingId);
  if(cont && i >= 0){
    // a day view is oldest-first, search results newest-first: "next" is the next over in time either way
    const nx = mode === 'search' ? playList[i - 1] : playList[i + 1];
    if(nx){ play(nx, playList); const el = document.querySelector('#tab-rec .ov[data-id="' + CSS.escape(nx.id) + '"]'); if(el) el.scrollIntoView({block: 'nearest'}); return; }
  }
  playingId = ''; markPlaying();
});
async function download(r){
  try{
    const u = await blobUrl(r);
    const day = new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date(r.ts * 1000));
    const hm = new Intl.DateTimeFormat('en-GB', {timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit'}).format(new Date(r.ts * 1000)).replace(/:/g, '');
    const a = document.createElement('a');
    a.href = u; a.download = [(r.chan === 'B' ? 'HOLDEN-DMR' : (r.chan === 'H' || r.chan === 'P') ? 'PRESTONS-TG' : 'HOLDEN1'), day, hm, (r.talker || 'unknown').replace(/[^A-Za-z0-9]/g, '')].join('-') + (r.codec === 'opus' ? '.opus' : '.wav');
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
    // Kept forever, the clean-up should remove nothing. If it did, the size cap is deleting the oldest recordings.
    const gone = +s.last_prune_removed || 0;              // the API sends this as a string
    if(keep && keep.forever && gone > 0) warn.push(['bad', 'The archive\'s size cap deleted the oldest ' + plural(gone, 'recording') + ' in its last clean-up. Recordings are meant to be kept forever: the cap needs raising on .151.']);
    else if(keep && keep.forever && cap && (+s.mb || 0) >= cap * 0.8) warn.push(['warn', 'The archive is at ' + Math.round(100 * s.mb / cap) + '% of its ' + Math.round(cap) + ' MB size cap. At the cap the oldest unpinned recordings are deleted: the cap needs raising on .151.']);
    if(wStale) warn.push(['bad', 'The recording watchdog on .151 has ' + (typeof wAge === 'number' ? 'not checked in ' + ago(wAge).replace(' ago', '') : 'never checked in') + ': a missed recording would go unnoticed.']);
    if(s.watch_installed === true && s.watch_open) warn.push(['bad', 'The recording watchdog has an open alert: recordings are missing or the archive has stalled (see its email).']);
    warn.forEach(([k, t]) => { const w = mk('div', k === 'bad' ? 'warnbox' : 'patchbox', t); h.appendChild(w); });
  }catch(e){ if(!(e && e.code === 401)) h.textContent = 'Archive status unavailable (' + ((e && e.message) || e) + ').'; }
}

/* ---------- lifecycle */
function tick(){
  if(!visible || stoppedAuth || document.visibilityState === 'hidden') return;
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date());
  if(mode === 'day' && (curDay === today || !curDay) && audio.paused) loadDays();   // today grows; don't re-render mid-play
}
function show(){
  build();
  visible = true;
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
