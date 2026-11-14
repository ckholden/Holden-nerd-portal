/* xl.js -- the listen-only page's CALL ALERTS and RADIO TEXTS (build cwtext, 2026-10-22).
 *
 * Wiring (3 small edits in rx/index.html, see INTEGRATION-xl.md): load this file; put <div id="xlmount"></div> in #app;
 * route every JSON message through HoldenXL.onMsg(m, ws) (true = handled here; ws = the page's current socket).
 *
 * Gateway (gw.py listen_ws) frames: {ev:'xl'} call-watch state, its choices and the text grant (or null);
 * {ev:'cwalert', kind, title, body, net, pn}: an alert while this page is visibly open (a push would be swallowed);
 * {ev:'txtlog', items}, {ev:'txt', item}, {ev:'txtack'}, {ev:'smscleared', ts}, {ev:'cwerror'}.
 * hd2.4 (2026-11-10, keyup2 DESIGN 2.3): when the xl frame carries cw_choices.people, Who becomes one-tap chips
 * (Anyone + the people the server lists) plus a box for any callsign or radio ID ({cmd:'cwadd', q}; the reply is an
 * xl frame with `added`, or {ev:'cwerror', code, q, reason}), and cwset also carries `who` (talkers = its legacy
 * projection, for an older gateway). Without cw_choices.people the old checkboxes and the old cwset run exactly as before.
 * Commands: {cmd:'cwset', on, talkers, nets}, {cmd:'cwack', pn} (an in-page alert was shown),
 * {cmd:'cwvis', vis} (every 10 s and on every visibility
 * change: is this page actually in front of him?), {cmd:'cwtap', pn} (he opened an alert; ?pn= on its link),
 * {cmd:'txtsend', to, text}, {cmd:'smsclear'}.
 *
 * Nothing here can key a radio with voice. A text goes to the gateway, which relays it (only with Christian's grant,
 * only to the family radios) as a DMR data message.
 */
(function () {
  'use strict';
  var ws = null, st = null, seen = {}, unread = 0, sendT = null, setT = null, built = false, pendingPn = null;
  var pending = null;              /* the text just handed to the gateway, until it says "accepted" */
  var alertT = null, beepCtx = null;
  var wDraft = null, addPend = null, addT = null, setRetry = 0, lastSet = 0;   /* hd2.4: an unsent Who change; a cwadd waiting for its answer */

  function $(id) { return document.getElementById(id); }
  /* HoldenDMR hd2: tell the page the unread count (Texts tab badge + app-icon badge). */
  function unreadHook() { try { if (window.HoldenXLUnread) window.HoldenXLUnread(unread); } catch (e) {} }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function send(o) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
    return false;
  }

  /* A call-alert tap opens /dmrptt/rx/?net=holden: remember the net, so the page's own hello handler switches to it
     (only if this account may hear it -- the server decides), and drop the query from the address bar. */
  (function () {
    try {
      var q = new URLSearchParams(location.search), n = q.get('net'), p = q.get('pn');
      if (n && /^[a-z]{2,10}$/.test(n)) {
        localStorage.setItem('dmrptt_rxnet', n);
        var c = $('connect'); if (c) c.textContent = '\u25B6 Listen now';
      }
      if (p && /^[0-9a-f]{8}$/.test(p)) pendingPn = p;     /* reported once connected: "the alert was opened" */
      if (n !== null || p !== null) history.replaceState(null, '', location.pathname);
    } catch (e) {}
  })();

  /* Heartbeat: is this page in front of him? A connected page in a pocket is NOT listening, so a call on his talk
     group still alerts this phone unless the last beat (at most 30 s old) said "visible". */
  function beat() { send({ cmd: 'cwvis', vis: document.visibilityState === 'visible' }); }
  function tapped() { if (pendingPn && send({ cmd: 'cwtap', pn: pendingPn })) pendingPn = null; }
  setInterval(beat, 10000);
  document.addEventListener('visibilitychange', beat);

  /* A tap on an alert while this page is already open: Firebase's service worker focuses this page and posts the alert
     here instead of loading its link. Switch to that channel in place (audio still needs one tap on the page). */
  try {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (!d.isFirebaseMessaging || d.messageType !== 'notification-clicked') return;
      var u;
      try { u = new URL((d.fcmOptions && d.fcmOptions.link) || '', location.href); } catch (x) { return; }
      if (u.origin !== location.origin || u.pathname !== location.pathname) return;
      var n = u.searchParams.get('net'), p = u.searchParams.get('pn');
      if (p && /^[0-9a-f]{8}$/.test(p)) pendingPn = p;
      if (n && /^[a-z]{2,10}$/.test(n)) {
        try { localStorage.setItem('dmrptt_rxnet', n); } catch (x) {}
        if (ws && ws.readyState === 1 && typeof window.pickNet === 'function') window.pickNet(n);
        else { var c = $('connect'); if (c) c.textContent = '\u25B6 Listen now'; }
      }
      tapped();
    });
  } catch (e) {}

  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

  var CSS = '.xlbox{text-align:left;margin:8px 0;border:1px solid var(--bd);border-radius:8px;padding:6px 10px;background:var(--panel2)}' +
    '.xlbox summary{cursor:pointer;color:var(--cyan);font-size:13px;letter-spacing:1px;text-transform:uppercase;padding:4px 0}' +
    '.xlh{font-size:11px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;margin:8px 0 2px}' +
    '.xlrow{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--tx);padding:6px 0;min-height:36px}' +
    '.xlrow input{width:20px;height:20px;margin:0;flex:0 0 auto}' +
    '.xlmsg{font-size:11px;color:var(--mut);margin-top:4px;min-height:14px}' +
    '#txlist{max-height:min(240px,40vh);overflow:auto;font-size:13px;margin:6px 0}' +
    '#txlist div{padding:4px 0;border-bottom:1px solid var(--bdim);overflow-wrap:anywhere}' +
    '.xlsend{display:flex;gap:6px}.xlsend select{flex:0 0 34%;min-width:0;font-size:14px;padding:8px}' +
    '.xlsend input{flex:1;min-width:0;font-size:16px;padding:8px}' +
    '.xlbtn{font-family:var(--mono);font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:8px 12px;min-height:40px;' +
    'border-radius:8px;border:1px solid var(--bd);background:var(--panel);color:var(--tx)}' +
    '.xlalert{text-align:left;margin:8px 0;border:2px solid var(--amber);border-radius:8px;padding:10px;background:var(--panel)}' +
    '.xlat{font-size:15px;color:var(--amber);overflow-wrap:anywhere}.xlab{font-size:13px;color:var(--tx);margin:4px 0 8px}' +
    '.xlalert .xlbtn{margin-right:8px}' +
    /* hd2.4 Who chips + free entry: the phone card's sizes (48 px targets, 17/14 px text) */
    '.xlchips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 2px}' +
    '.xlchip{flex:1 1 calc(50% - 4px);min-width:min-content;max-width:100%;min-height:56px;display:flex;align-items:center;gap:10px;padding:6px 12px;' +
    'border-radius:12px;border:1px solid var(--bd);background:var(--panel2);color:var(--tx);text-align:left;font:inherit;cursor:pointer}' +
    '.xlchip[data-key="any"]{flex-basis:100%}' +
    '.xlchip .xlck{flex:none;width:26px;height:26px;border-radius:7px;border:2px solid var(--mut);display:grid;place-items:center;' +
    'font-size:17px;font-weight:900;line-height:1}' +
    '.xlct{display:flex;flex-direction:column;min-width:0}.xlchip b{font-size:17px;overflow-wrap:break-word}.xlent b{font-size:17px;overflow-wrap:anywhere}' +
    '.xlcs{font-size:14px;color:var(--mut);overflow-wrap:anywhere}' +
    '.xlchip.on{background:var(--brand,#0C447C);border-color:var(--cyan);color:#fff}' +
    '.xlchip.on .xlck{background:#fff;border-color:#fff;color:var(--brand,#0C447C)}.xlchip.on .xlcs{color:#dbe9f7}' +
    '.xlchip.inc:not(.on){opacity:.55}' +   /* Anyone is on: covered by it, not picked -- no tick, dimmed */
    '.xlql{display:block;font-size:17px;font-weight:700;color:var(--tx);margin:14px 0 0}' +
    '.xlq{display:flex;gap:8px;margin-top:6px}' +
    '.xlq input{flex:1;min-width:0;min-height:52px;font-size:17px;padding:10px 14px;border-radius:12px;border:1px solid var(--bd);' +
    'background:var(--panel2);color:var(--tx);text-transform:uppercase}.xlq input::placeholder{text-transform:none}' +
    '.xlq .xlbtn{flex:none;min-width:84px;min-height:52px}' +
    '.xlent{display:flex;align-items:center;gap:10px;min-height:60px;padding:6px 0;border-top:1px solid var(--bdim)}' +
    '.xlent .xlct{flex:1}.xlent .xlbtn{flex:none}' +
    '.xlok{color:var(--green)!important}.xlbad{color:#ffb3b5!important}';

  function build() {
    if (built) return true;
    var mount = $('xlmount'); if (!mount) return false;
    var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
    mount.innerHTML =
      '<details id="cwbox" class="xlbox"><summary>&#128276; Call alerts <span id="cwsum" style="color:var(--mut);text-transform:none"></span></summary>' +
      '<label class="xlrow"><input type="checkbox" id="cwon"> Notify me when they key up</label>' +
      '<div class="xlh" id="cwwhoh">Who</div><div id="cwtalk"></div>' +
      '<div id="cwv2" hidden><div id="cwchips" class="xlchips" role="group" aria-labelledby="cwwhoh"></div>' +
      '<label class="xlql" for="cwq">Add a callsign or radio ID</label>' +
      '<div class="xlq"><input id="cwq" maxlength="24" placeholder="W7ABC or 3141234" autocapitalize="characters" autocomplete="off"' +
      ' autocorrect="off" spellcheck="false" enterkeyhint="done"><button class="xlbtn" id="cwaddb" type="button">Add</button></div>' +
      '<div id="cwamsg" class="xlmsg" role="status" aria-live="polite"></div>' +
      '<div id="cwents" role="list" aria-label="Callsigns and radio IDs you added"></div>' +
      '<div id="cwcov" class="xlmsg">A callsign you add only alerts you when it talks in a place ticked under Where.</div></div>' +
      '<div class="xlh">Where</div><div id="cwnets"></div>' +
      '<div id="cwmsg" class="xlmsg"></div><div id="cwplat" class="xlmsg"></div></details>' +
      '<details id="txbox" class="xlbox" style="display:none"><summary>&#128223; Radio texts <span id="txbadge" style="color:var(--amber)"></span></summary>' +
      '<div id="txlist"></div>' +
      '<div class="xlsend"><select id="txto" aria-label="Send to"></select>' +
      '<input id="txtext" maxlength="258" placeholder="message" aria-label="Message"><button class="xlbtn" id="txsend" type="button">Send</button></div>' +
      '<div id="txmsg" class="xlmsg"></div>' +
      '<div style="text-align:right;margin-top:6px"><button class="xlbtn" id="txclr" type="button">Clear texts</button></div></details>';
    $('cwon').onchange = queueSet;
    $('cwaddb').onclick = addWho;
    $('cwq').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); addWho(); } };
    $('cwq').oninput = function () { if (!addPend && /xlbad/.test($('cwamsg').className)) amsg('', ''); };
    $('txsend').onclick = sendText;
    $('txtext').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); sendText(); } };
    $('txclr').onclick = clearTexts;
    $('txbox').addEventListener('toggle', function () { if ($('txbox').open) { unread = 0; $('txbadge').textContent = ''; unreadHook(); } });
    built = true;
    return true;
  }

  /* An alert while this page is visibly open: the gateway sends it here instead of as a push. Text only, never HTML. */
  /* iOS only lets audio start inside a tap: make the beep's audio context on his first tap on this page. */
  function unlockBeep() {
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (C && !beepCtx) beepCtx = new C();
      if (beepCtx && beepCtx.state === 'suspended') beepCtx.resume();
    } catch (e) {}
  }
  ['touchend', 'pointerdown', 'click'].forEach(function (ev) { document.addEventListener(ev, unlockBeep, { passive: true }); });
  function beep() {
    try {
      var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      var c = beepCtx || (beepCtx = new C()); if (c.state === 'suspended') c.resume();
      var o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.35);
    } catch (e) {}
  }
  function alertBanner(m) {
    if (!build()) return;
    var host = $('xlalert');
    if (!host) {
      host = document.createElement('div'); host.id = 'xlalert'; host.className = 'xlalert'; host.setAttribute('role', 'alert');
      $('xlmount').insertBefore(host, $('xlmount').firstChild);
    }
    host.innerHTML = '';
    var t = document.createElement('div'); t.className = 'xlat'; t.textContent = String(m.title || '');
    var b = document.createElement('div'); b.className = 'xlab'; b.textContent = String(m.body || '');
    host.appendChild(t); host.appendChild(b);
    var net = /^[a-z]{2,10}$/.test(m.net || '') ? m.net : null;
    var pn = /^[0-9a-f]{8}$/.test(m.pn || '') ? m.pn : null;
    if (net) {
      var go = document.createElement('button'); go.className = 'xlbtn'; go.type = 'button'; go.id = 'xlgo'; go.textContent = 'Listen';
      go.onclick = function () {
        if (pn) { pendingPn = pn; tapped(); }
        if (typeof window.pickNet === 'function') window.pickNet(net);
        host.style.display = 'none';
      };
      host.appendChild(go);
    }
    var x = document.createElement('button'); x.className = 'xlbtn'; x.type = 'button'; x.id = 'xlx'; x.textContent = 'Dismiss';
    x.onclick = function () { host.style.display = 'none'; };
    host.appendChild(x);
    host.style.display = '';
    try { if (navigator.vibrate) navigator.vibrate([400, 150, 400]); } catch (e) {}
    beep();
    if (pn && document.visibilityState === 'visible') send({ cmd: 'cwack', pn: pn });   /* shown: no push needed */
    clearTimeout(alertT); alertT = setTimeout(function () { host.style.display = 'none'; }, 60000);
  }

  function checks(id, items, chosen) {
    var box = $(id); box.innerHTML = '';
    items.forEach(function (it) {
      var l = document.createElement('label'); l.className = 'xlrow';
      var c = document.createElement('input'); c.type = 'checkbox'; c.value = it.key;
      c.checked = chosen.indexOf(it.key) >= 0; c.onchange = queueSet;
      l.appendChild(c); l.appendChild(document.createTextNode(' ' + it.label)); box.appendChild(l);
    });
  }
  function picked(id) {
    return Array.prototype.slice.call($(id).querySelectorAll('input:checked')).map(function (c) { return c.value; });
  }

  function render() {
    if (!st || !build()) return;
    var cw = st.cw || {}, ch = st.cw_choices || { talkers: [], nets: [] };
    $('cwon').checked = !!cw.on;
    var who;
    if (v2()) {                                    /* hd2.4: chips + free entry */
      $('cwtalk').hidden = true; $('cwtalk').innerHTML = ''; $('cwv2').hidden = false;
      renderWho();
      who = whoNow().map(whoLabel).filter(Boolean).join(', ');
    } else {                                       /* an older gateway: exactly the old checkboxes */
      $('cwv2').hidden = true; $('cwtalk').hidden = false;
      checks('cwtalk', ch.talkers || [], cw.talkers || []);
      who = (cw.talkers || []).map(function (k) { return k === '*' ? 'anyone' : k; }).join(', ');
    }
    checks('cwnets', (ch.nets || []).map(function (n) { return { key: n.net, label: n.label }; }), cw.nets || []);
    $('cwsum').textContent = cw.on ? ('\u00B7 on' + (who ? ' (' + who + ')' : '')) : '\u00B7 off';
    var talk = (ch.nets || []).filter(function (n) { return n.net === 'talk'; })[0];
    $('cwmsg').textContent = !st.devices
      ? 'Tap "Turn on notifications" on this page first - alerts arrive as phone notifications.'
      : 'After 1.5 s of talking, at most one alert every 45 s, and never while this page is open on that network.' +
        (talk ? ' A call on ' + talk.label + ' alerts this phone unless this page is in front of you on it.' : '');
    $('cwplat').textContent = isIOS()
      ? 'iPhone: one banner and one sound per alert - it never rings like a phone call. Open this app from its Home ' +
        'Screen icon, allow its notifications, and add it to any Focus mode you use.'
      : 'Android: open this page in Chrome itself (not inside Gmail). If alerts come late, set Chrome to "Unrestricted" ' +
        'battery use.';
    var t = st.text;
    $('txbox').style.display = t ? '' : 'none';
    if (t) {
      var sel = $('txto'), cur = sel.value; sel.innerHTML = '';
      (t.to || []).forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c === 'HOLDEN' ? 'to HOLDEN (everyone)' : 'to ' + c; sel.appendChild(o); });
      if ((t.to || []).indexOf(cur) >= 0) sel.value = cur;
      $('txtext').maxLength = t.max || 258;
      if (!$('txmsg').dataset.busy) {
        $('txmsg').textContent = 'Goes out over amateur radio as "' + t.label + ': ..." - plain words only: no business, no codes, ' +
          'no bad language. Christian sees every text.';
      }
    }
  }

  function queueSet() {
    clearTimeout(setT);
    setT = setTimeout(function () {
      setT = null;
      var ok;
      if (v2()) {
        var w = whoNow(); lastSet = Date.now();
        ok = send({ cmd: 'cwset', on: $('cwon').checked, nets: picked('cwnets'), who: w.slice(), talkers: project(w) });
        if (!ok) { wDraft = null; render(); }
      } else {
        ok = send({ cmd: 'cwset', on: $('cwon').checked, talkers: picked('cwtalk'), nets: picked('cwnets') });
      }
      if (!ok) $('cwmsg').textContent = 'Not connected - your change was not saved.';
    }, v2() ? Math.max(350, 1050 - (Date.now() - lastSet)) : 350);   /* hd2.4: never faster than the gateway's 1/s */
  }

  /* ---------- hd2.4 Who: chips from the server (cw_choices.people), Anyone, and typed callsigns / radio IDs ---------- */
  function v2() { return !!(st && st.cw_choices && Array.isArray(st.cw_choices.people)); }
  function items(a) {
    return (Array.isArray(a) ? a : []).filter(function (o) { return o && typeof o === 'object' && typeof o.key === 'string' && o.key; })
      .map(function (o) { return { key: o.key, label: String(o.label || o.key), sub: o.sub ? String(o.sub) : '', known: o.known }; });
  }
  function people() { return items(st.cw_choices.people); }
  function entries() { return items(st.cw && st.cw.entries); }
  function cap() { var c = Number(st.cw_choices.cap); return c > 0 ? c : 25; }
  function whoNow() {
    if (wDraft) return wDraft;
    var cw = st.cw || {};
    if (Array.isArray(cw.who)) return cw.who.filter(function (x) { return typeof x === 'string'; });
    var ps = people(), out = [];                   /* the server always sends cw.who; this only guards a partial frame */
    (cw.talkers || []).forEach(function (k) {
      if (k === '*') { if (out.indexOf('any') < 0) out.push('any'); return; }
      ps.forEach(function (p) { if (p.label === k && out.indexOf(p.key) < 0) out.push(p.key); });
    });
    return out;
  }
  function whoLabel(k) {
    if (k === 'any') return 'anyone';
    var all = people().concat(entries());
    for (var i = 0; i < all.length; i++) if (all[i].key === k) return all[i].label;
    return '';
  }
  /* talkers for an older gateway (DESIGN 2.1): acct:X -> its callsign when that is one of the old choices; any -> all of them */
  function project(who) {
    var keys = ((st.cw_choices && st.cw_choices.talkers) || []).map(function (t) { return t && t.key; }).filter(Boolean), ps = people(), out = [];
    function add(k) { if (keys.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k); }
    who.forEach(function (tok) {
      if (tok === 'any') keys.forEach(add);
      else if (/^acct:/.test(tok)) ps.forEach(function (p) { if (p.key === tok) add(p.label); });
    });
    return out;
  }
  function sync(box, list, make, upd) {           /* keyed reconcile: a tapped chip keeps its focus */
    var have = {}, want = {}, i;
    for (i = 0; i < box.children.length; i++) have[box.children[i].getAttribute('data-key')] = box.children[i];
    list.forEach(function (it, n) {
      var el = have[it.key]; if (!el) { el = make(); el.setAttribute('data-key', it.key); }
      want[it.key] = 1; upd(el, it);
      if (box.children[n] !== el) box.insertBefore(el, box.children[n] || null);
    });
    Array.prototype.slice.call(box.children).forEach(function (el) { if (!want[el.getAttribute('data-key')]) box.removeChild(el); });
  }
  function txt(wrap) {
    var t = document.createElement('span'); t.className = 'xlct';
    var b = document.createElement('b'), s = document.createElement('span'); s.className = 'xlcs';
    t.appendChild(b); t.appendChild(s); wrap.appendChild(t);
  }
  function makeChip() {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'xlchip';
    var ck = document.createElement('span'); ck.className = 'xlck'; ck.setAttribute('aria-hidden', 'true'); b.appendChild(ck); txt(b);
    b.onclick = function () { toggleWho(b.getAttribute('data-key')); };
    return b;
  }
  function updChip(b, it) {
    var w = whoNow(), on = w.indexOf(it.key) >= 0, inc = it.key !== 'any' && w.indexOf('any') >= 0;
    b.classList.toggle('on', on); b.classList.toggle('inc', inc); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.querySelector('.xlck').textContent = on ? '✓' : '';
    b.querySelector('b').textContent = it.label;
    var s = b.querySelector('.xlcs'); s.textContent = it.sub; s.hidden = !it.sub;
    b.setAttribute('aria-label', it.label + (it.sub ? ', ' + it.sub : '') + (inc && !on ? ', included in Anyone' : ''));
  }
  function makeEnt() {
    var r = document.createElement('div'); r.className = 'xlent'; r.setAttribute('role', 'listitem'); txt(r);
    var x = document.createElement('button'); x.type = 'button'; x.className = 'xlbtn'; x.textContent = 'Remove';
    x.onclick = function () { removeWho(r.getAttribute('data-key'), r.querySelector('b').textContent); };
    r.appendChild(x); return r;
  }
  function updEnt(r, it) {
    r.querySelector('b').textContent = it.label;
    var s = r.querySelector('.xlcs'); s.textContent = it.sub || (it.known === false ? 'Not in the RadioID list. Kept as typed.' : ''); s.hidden = !s.textContent;
    r.querySelector('button').setAttribute('aria-label', 'Remove ' + it.label);
  }
  function renderWho() {
    var w = whoNow();
    var anyOn = w.indexOf('any') >= 0 && people().length;   /* the hint lives in the Anyone button, next to the people it covers */
    sync($('cwchips'), [{ key: 'any', label: 'Anyone', sub: anyOn ? 'Covers everyone. Your own picks are kept for later.' : 'Anyone who talks there' }]
      .concat(people()), makeChip, updChip);
    sync($('cwents'), entries().filter(function (e) { return w.indexOf(e.key) >= 0; }), makeEnt, updEnt);
    $('cwaddb').disabled = !!addPend;
  }
  function amsg(t, cls) { var e = $('cwamsg'); e.textContent = t || ''; e.className = 'xlmsg' + (cls ? ' ' + cls : ''); }
  function editWho() { if (!wDraft) wDraft = whoNow().slice(); return wDraft; }
  function toggleWho(key) {
    var w = whoNow(), i = w.indexOf(key);
    if (i < 0 && w.length >= cap()) { amsg('You can have up to ' + cap() + ' on your list. Remove one first.', 'xlbad'); return; }
    var d = editWho(); i = d.indexOf(key); if (i >= 0) d.splice(i, 1); else d.push(key);
    render(); queueSet();
  }
  function removeWho(key, label) {
    var d = editWho(), i = d.indexOf(key); if (i >= 0) d.splice(i, 1);
    render(); queueSet(); amsg('Removed ' + label + '.', 'xlok');
    try { $('cwq').focus({ preventScroll: true }); } catch (e) {}
  }
  function addEnd() { addPend = null; clearTimeout(addT); addT = null; if (built) $('cwaddb').disabled = false; }
  function addWho() {
    if (!v2() || addPend) return;
    var q = String($('cwq').value || '').trim().slice(0, 24);
    if (!q) { amsg('Type a callsign like W7ABC, or a radio ID like 3141234.', 'xlbad'); $('cwq').focus(); return; }
    if (!send({ cmd: 'cwadd', q: q })) { amsg('Not connected yet - try again in a moment.', 'xlbad'); return; }
    addPend = { q: q }; $('cwaddb').disabled = true; amsg('Looking up ' + q.toUpperCase() + '...', '');
    addT = setTimeout(function () { if (!addPend) return; addEnd(); amsg('No answer from the server. Try again in a moment.', 'xlbad'); }, 9000);
  }
  function onXl(m) {                               /* the server's state is the truth unless a change is still unsent */
    var a = (m && m.added && typeof m.added === 'object' && typeof m.added.key === 'string') ? m.added : null;
    st = m; setRetry = 0;
    if (!setT) wDraft = null;
    else if (a && wDraft && wDraft.indexOf(a.key) < 0) wDraft.push(a.key);
    render();
    if (a && addPend && built) {
      addEnd(); $('cwq').value = '';
      amsg(a.note ? String(a.note) : ('Added ' + String(a.label || a.key) + (a.sub ? ' · ' + String(a.sub) : '')), 'xlok');
    }
  }
  function onCwError(m) {
    if (!built) return;
    var why = m.reason || 'Not saved', isSet = !m.q && (m.code === 'busy' || !m.code);   /* the cwset limiter's reply has no q (and today no code) */
    if (addPend && !isSet) { addEnd(); amsg(why, 'xlbad'); return; }
    if (v2() && isSet) {                           /* a cwset inside the gateway's 1/s: send it again, twice at most */
      if (setRetry < 2) { setRetry++; clearTimeout(setT); setT = null; setTimeout(queueSet, 1100); return; }
      setRetry = 0; wDraft = null; render();       /* still refused: show what the server has */
    }
    $('cwmsg').textContent = why;
  }

  function addItem(c) {
    if (!c || !build()) return;
    var k = (c.ts || 0) + '|' + c.text; if (seen[k]) return; seen[k] = 1;
    var l = $('txlist');
    var at = new Date(c.ts || Date.now()), hh = ('0' + at.getHours()).slice(-2) + ':' + ('0' + at.getMinutes()).slice(-2);
    var who = String(c.who || '').replace(/^\uD83D\uDCDF\s*/, '');
    var from = c.sms === 'in' ? (c.grp || who.split(/\s+/)[0] || '') : '';   /* a group text: the reply goes to the group */
    var d = document.createElement('div'); d.setAttribute('data-ts', String(c.ts || 0));
    var canReply = from && st && st.text && (st.text.to || []).indexOf(from) >= 0;
    d.innerHTML = '<span style="color:var(--mut)">' + hh + '</span> <b>' + esc(who) + ':</b> ' + esc(c.text) +
      (canReply ? ' <a href="#" style="color:var(--cyan);font-size:11px" data-to="' + esc(from) + '">reply</a>' : '');
    var a = d.querySelector('a[data-to]');
    if (a) a.onclick = function (e) { e.preventDefault(); $('txto').value = this.getAttribute('data-to'); $('txbox').open = true; $('txtext').focus(); };
    l.appendChild(d); while (l.childElementCount > 100) l.removeChild(l.firstChild); l.scrollTop = l.scrollHeight;
    if (c.sms === 'in' && !$('txbox').open) { unread++; $('txbadge').textContent = '(' + unread + ' new)'; unreadHook(); }
  }

  function busy(on, text, color) {
    var m = $('txmsg'); m.textContent = text || ''; m.style.color = color || 'var(--mut)';
    if (on) m.dataset.busy = '1'; else delete m.dataset.busy;
    $('txsend').disabled = !!on;
  }

  function sendText() {
    var to = $('txto').value, t = ($('txtext').value || '').trim();
    if (!t) return;
    if (!send({ cmd: 'txtsend', to: to, text: t })) { busy(false, 'Not connected yet - try again in a moment.', 'var(--red)'); return; }
    pending = t;
    busy(true, 'Sending to ' + to + '...');
    clearTimeout(sendT);
    sendT = setTimeout(function () { pending = null; busy(false, 'No answer from the gateway - check your texts before sending again.', 'var(--amber)'); }, 45000);
  }

  function clearTexts() {
    if (!window.confirm('Clear your radio texts on all your devices? (A copy stays in the server log.)')) return;
    if (!send({ cmd: 'smsclear' })) busy(false, 'Not connected yet - try again in a moment.', 'var(--red)');
  }

  function cleared(ts) {
    var l = $('txlist'); if (!l) return;
    Array.prototype.slice.call(l.children).forEach(function (d) {
      if (Number(d.getAttribute('data-ts') || 0) <= ts) l.removeChild(d);
    });
    unread = 0; $('txbadge').textContent = ''; unreadHook();
  }

  window.HoldenXL = {
    ready: function (w) { ws = w; build(); },
    onMsg: function (m, w) {
      if (w) ws = w;
      if (!m || typeof m.ev !== 'string') return false;
      switch (m.ev) {
        case 'xl': onXl(m); beat(); tapped(); return true;
        case 'cwalert': alertBanner(m); return true;
        case 'cwerror': onCwError(m); return true;
        case 'txtlog':
          if (build()) { $('txlist').innerHTML = ''; seen = {}; unread = 0; $('txbadge').textContent = ''; }
          (m.items || []).forEach(addItem);
          unread = 0; if (built) $('txbadge').textContent = ''; unreadHook();
          return true;
        case 'txt': addItem(m.item); return true;
        case 'txtack':
          /* The gateway queues every text (it never refuses one for pace): "accepted" frees the box at once; how each
             text ends ("sent" / "not sent", with its first words) comes later and may take minutes on a busy channel. */
          var mine = (typeof m.text === 'string' && m.text) ? ' "' + m.text + (m.text.length >= 40 ? '...' : '') + '"' : '';
          if (m.accepted) {
            clearTimeout(sendT);
            if (pending !== null && ($('txtext').value || '').trim() === pending) $('txtext').value = '';
            pending = null;
            busy(false, m.ahead ? 'Queued for ' + (m.to || '?') + ' (' + m.ahead + ' ahead of it)...'
                                : 'Going out to ' + (m.to || '?') + '...', 'var(--amber)');
          } else if (m.queued && 'text' in m) {
            busy(false, 'Waiting:' + mine + ' - ' + (m.reason || 'busy'), 'var(--amber)');
          } else if (m.queued) {   /* an older gateway: it waits up to 3 min for a quiet channel, one text at a time */
            clearTimeout(sendT);
            busy(true, 'Queued: ' + (m.reason || 'waiting for a quiet moment on the channel') + '...', 'var(--amber)');
            sendT = setTimeout(function () { busy(false, 'No answer from the gateway - check your texts before sending again.', 'var(--amber)'); }, 240000);
          } else if (m.ok) {
            clearTimeout(sendT);
            if (!('text' in m)) $('txtext').value = '';             /* an older gateway: the box was held until now */
            busy(false, 'Sent to ' + (m.to || '?') + mine + ' (radios send no read receipt).', 'var(--green)');
          } else {
            clearTimeout(sendT); pending = null;
            busy(false, 'Not sent:' + mine + ' ' + (m.reason || 'error'), 'var(--red)');
          }
          return true;
        case 'smscleared': cleared(m.ts || 0); return true;
      }
      return false;
    }
  };
})();
