/* xl.js -- the listen-only page's CALL ALERTS and RADIO TEXTS (build cwtext, 2026-10-22).
 *
 * Wiring (3 small edits in rx/index.html, see INTEGRATION-xl.md): load this file; put <div id="xlmount"></div> in #app;
 * route every JSON message through HoldenXL.onMsg(m, ws) (true = handled here; ws = the page's current socket).
 *
 * Gateway (gw.py listen_ws) frames: {ev:'xl'} call-watch state, its choices and the text grant (or null);
 * {ev:'cwalert', kind, title, body, net, pn}: an alert while this page is visibly open (a push would be swallowed);
 * {ev:'txtlog', items}, {ev:'txt', item}, {ev:'txtack'}, {ev:'smscleared', ts}, {ev:'cwerror'}.
 * Commands: {cmd:'cwset', on, talkers, nets}, {cmd:'xlget'}, {cmd:'cwack', pn} (an in-page alert was shown),
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

  function $(id) { return document.getElementById(id); }
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
    '.xlalert .xlbtn{margin-right:8px}';

  function build() {
    if (built) return true;
    var mount = $('xlmount'); if (!mount) return false;
    var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
    mount.innerHTML =
      '<details id="cwbox" class="xlbox"><summary>&#128276; Call alerts <span id="cwsum" style="color:var(--mut);text-transform:none"></span></summary>' +
      '<label class="xlrow"><input type="checkbox" id="cwon"> Notify me when they key up</label>' +
      '<div class="xlh">Who</div><div id="cwtalk"></div>' +
      '<div class="xlh">Where</div><div id="cwnets"></div>' +
      '<div id="cwmsg" class="xlmsg"></div><div id="cwplat" class="xlmsg"></div></details>' +
      '<details id="txbox" class="xlbox" style="display:none"><summary>&#128223; Radio texts <span id="txbadge" style="color:var(--amber)"></span></summary>' +
      '<div id="txlist"></div>' +
      '<div class="xlsend"><select id="txto" aria-label="Send to"></select>' +
      '<input id="txtext" maxlength="258" placeholder="message" aria-label="Message"><button class="xlbtn" id="txsend" type="button">Send</button></div>' +
      '<div id="txmsg" class="xlmsg"></div>' +
      '<div style="text-align:right;margin-top:6px"><button class="xlbtn" id="txclr" type="button">Clear texts</button></div></details>';
    $('cwon').onchange = queueSet;
    $('txsend').onclick = sendText;
    $('txtext').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); sendText(); } };
    $('txclr').onclick = clearTexts;
    $('txbox').addEventListener('toggle', function () { if ($('txbox').open) { unread = 0; $('txbadge').textContent = ''; } });
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
    checks('cwtalk', ch.talkers || [], cw.talkers || []);
    checks('cwnets', (ch.nets || []).map(function (n) { return { key: n.net, label: n.label }; }), cw.nets || []);
    var who = (cw.talkers || []).map(function (k) { return k === '*' ? 'anyone' : k; }).join(', ');
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
      var ok = send({ cmd: 'cwset', on: $('cwon').checked, talkers: picked('cwtalk'), nets: picked('cwnets') });
      if (!ok) $('cwmsg').textContent = 'Not connected - your change was not saved.';
    }, 350);
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
    if (c.sms === 'in' && !$('txbox').open) { unread++; $('txbadge').textContent = '(' + unread + ' new)'; }
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
    unread = 0; $('txbadge').textContent = '';
  }

  window.HoldenXL = {
    ready: function (w) { ws = w; build(); },
    onMsg: function (m, w) {
      if (w) ws = w;
      if (!m || typeof m.ev !== 'string') return false;
      switch (m.ev) {
        case 'xl': st = m; render(); beat(); tapped(); return true;
        case 'cwalert': alertBanner(m); return true;
        case 'cwerror': if (built) $('cwmsg').textContent = m.reason || 'Not saved'; return true;
        case 'txtlog':
          if (build()) { $('txlist').innerHTML = ''; seen = {}; unread = 0; $('txbadge').textContent = ''; }
          (m.items || []).forEach(addItem);
          unread = 0; if (built) $('txbadge').textContent = '';
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
