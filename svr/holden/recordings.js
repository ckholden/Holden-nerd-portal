/* Recordings tab for /svr/holden (= holdenportal.com/hdmr), 2026-10-17.
   Christian: "scroll through previous radio tx recordings for x? days". Every over Radio hears on HOLDEN1 and
   HOLDEN DMR, kept 30 days by hdmr-archive on .151 (kj7dts-server/hdmr-archive/DESIGN.md).

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

const css = `
#tab-rec .rtool{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:0 0 12px}
#tab-rec .rtool input[type=search]{flex:1 1 220px;min-width:0}
#tab-rec .chips{display:flex;gap:6px;flex-wrap:wrap}
#tab-rec .chip{padding:6px 11px;font-size:12px}
#tab-rec .chip[aria-pressed="true"]{border-color:var(--blue);color:var(--blue)}
#tab-rec .rgrid{display:grid;grid-template-columns:minmax(170px,230px) 1fr;gap:12px;align-items:start}
#tab-rec .days{display:flex;flex-direction:column;gap:6px;max-height:75vh;overflow:auto}
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
  #tab-rec .days{flex-direction:row;overflow-x:auto;max-height:none;padding-bottom:4px}
  #tab-rec .day{flex:0 0 auto;width:auto;min-width:132px}
  #tab-rec .ov{grid-template-columns:auto 1fr}
  #tab-rec .ov .side{grid-column:2}
}`;

let started = false, visible = false, authFails = 0, stoppedAuth = false;
let days = [], curDay = '', rows = [], mode = 'day';        // mode: 'day' | 'search'
let net = '', hideNoise = true, cont = false, query = '', hitId = '';
let playingId = '', dayTimer = null, statusTimer = null, searchTimer = null;
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
function fmtTime(ts){ return tFmt.format(new Date(ts * 1000)); }
function fmtShort(ts){ return tFmtShort.format(new Date(ts * 1000)); }
function dayLabel(day){
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 20));      // 20:00 UTC is midday Pacific, never across a date line
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date());
  const yest = new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date(Date.now() - 86400000));
  return (day === today ? 'Today · ' : day === yest ? 'Yesterday · ' : '') + dFmt.format(noonUtc);
}
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
  p.appendChild(mk('h2', '', "Recordings · HOLDEN1 + HOLDEN DMR + PRESTON'S TALK GROUP · last 30 days (pinned: kept forever)"));
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
  p.appendChild(mk('div', 'note', 'Transcripts are machine-made from radio audio and can be wrong, especially on short overs. Times are Pacific. Recordings are deleted after 30 days.'));
  const h = mk('div', 'note rhealth'); h.id = 'recHealth'; p.appendChild(h);
  sec.appendChild(p);
}

/* ---------- days */
async function loadDays(){
  try{
    const j = await api('/days');
    days = Array.isArray(j.days) ? j.days : [];
    if(!curDay || !days.some(d => d.day === curDay)) curDay = days.length ? days[0].day : '';
    renderDays();
    if(mode === 'day') await loadDay(curDay, true);
  }catch(e){ fail(e, 'the day list'); }
}
function renderDays(){
  const box = $('recDays'); if(!box) return;
  box.textContent = '';
  if(!days.length){ box.appendChild(mk('div', 'empty', 'No recordings yet.')); return; }
  days.forEach(d => {
    const b = mk('button', 'day'); b.setAttribute('aria-current', String(mode === 'day' && d.day === curDay));
    b.appendChild(mk('div', 'd1', dayLabel(d.day)));
    b.appendChild(mk('div', 'd2', d.n + ' over' + (d.n === 1 ? '' : 's') + ' · ' + fmtDur(d.talk_s)));
    if(d.talkers && d.talkers.length) b.appendChild(mk('div', 'd2', d.talkers.slice(0, 4).join(', ')));
    b.addEventListener('click', () => { const q = $('recQ'); if(q) q.value = ''; query = ''; mode = 'day'; hitId = ''; curDay = d.day; renderDays(); loadDay(d.day); });
    box.appendChild(b);
  });
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
  if(mode === 'search') box.appendChild(mk('div', 'qso', list.length + ' match' + (list.length === 1 ? '' : 'es') + ' for "' + query + '"' + (list.length >= 200 ? ' (newest 200)' : '')));
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
  if(mode === 'search') meta.appendChild(mk('span', '', dayLabel(new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date(r.ts * 1000)))));
  meta.appendChild(mk('span', '', fmtTime(startTs(r))));
  meta.appendChild(mk('span', '', fmtLen(r.dur)));
  meta.appendChild(netTag(r));
  if(r.pinned) meta.appendChild(mk('span', 'tag pin', 'pinned · kept forever'));
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
      const day = new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date(r.ts * 1000));
      const q = $('recQ'); if(q) q.value = ''; query = ''; mode = 'day'; curDay = day; hitId = r.id; renderDays(); loadDay(day);
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
    h.textContent = '';
    const bits = [];
    bits.push((s.rows || 0) + ' recordings · ' + (s.mb || 0) + ' MB');
    if(s.last_over_ts) bits.push('last over ' + ago(s.now - s.last_over_ts));
    const wAge = s.watch_last_run_age_s, wStale = s.watch_installed === true && (typeof wAge !== 'number' || wAge > 180);   // (watch-banner 2026-10-24)
    if(s.watch_installed === true && !wStale) bits.push('recording watchdog checked ' + ago(wAge));
    h.appendChild(document.createTextNode('Archive: ' + bits.join(' · ') + ' · served by hdmr-archive on .151'));
    const warn = [];
    if(s.heartbeat_age_s === null || s.heartbeat_age_s > 300) warn.push(['bad', 'The archiver on .151 is not running' + (s.heartbeat_age_s ? ' (last heartbeat ' + ago(s.heartbeat_age_s) + ')' : '') + '. New overs are not being saved.']);
    if(s.missed_24h > 0) warn.push(['warn', 'Radio heard ' + s.missed_24h + ' over' + (s.missed_24h === 1 ? '' : 's') + ' in the last 24 h that did not make it into the archive.']);
    if(s.skipped_disk > 0 && s.disk_free_mb < 2500) warn.push(['bad', 'The server is low on disk (' + s.disk_free_mb + ' MB free). Recording is paused.']);
    if(s.prune_stale) warn.push(['warn', 'The 30-day clean-up has not run in over a day and a half.']);
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
