/* hm-features.js -- dmrmaster-features 2026-11-14 for /svr/holden (loaded after the page's main script).
   1. "Mark as ours" for UNKNOWN peers (Status tab): their address class / software / login time and a dialog that
      names them through the feed's peer.alias op (fresh Google sign-in; the name goes to a file on .151 only).
   2. Hotspots card (Status tab, read-only): from the feed's /status "hotspots" block.
   3. Radio card (Manage tab): Call Alert ME / Dad / Pete (+ optional tones) and Radio check ME, each behind a confirm,
      sent as the feed's radio.page / radio.check ops. They TRANSMIT; the gateway on .151 runs every guard. The
      browser never talks to the radio-check service itself.
   The pure helpers at the top have no DOM access and are unit-tested with node (kit tests/test_page_features.mjs). */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ pure helpers (node-tested)
  const ROLES = ['hotspot', 'app', 'service', 'parrot', 'radio-bot', 'textbot', 'patch', 'other'];
  const ADDR_LABEL = {
    'vps': 'the VPS itself', 'home-server': 'home server (.151, tailnet)', 'home': 'home network',
    'tailnet': 'tailnet', 'starlink': 'Starlink (home or truck)', 'lan': 'private LAN',
    'other-isp': 'another ISP', 'unknown': 'unknown address'
  };
  const NETS = ['PNW', 'BM', 'TGIF', 'HOLDEN', 'BC'];
  const RADIO_WHO = {me: 'your radio (KJ7DTS)', dad: "Dad's radio (KK7ION)", pete: "Pete's radio (KK7RBQ)"};

  function addrLabel(c) { return ADDR_LABEL[c] || ADDR_LABEL.unknown; }

  function netState(v) {
    switch (v) {
      case 'up': return {cls: 'up', txt: 'up'};
      case 'down': return {cls: 'down', txt: 'down'};
      case 'off': return {cls: 'off', txt: 'off'};
      case 'muted': return {cls: 'off', txt: 'muted'};
      default: return {cls: 'unk', txt: '?'};
    }
  }

  function agoText(s) {
    if (typeof s !== 'number' || !isFinite(s)) return '';
    s = Math.max(0, Math.round(s));
    if (s < 90) return s + ' s ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  /* -> {led: 'up'|'wn'|'down'|'unk', verdict, seen} for one hotspots row from the feed */
  function hotspotSummary(row) {
    row = row || {};
    const seen = row.last_seen_s == null ? (row.has_agent ? 'no check-in received' : '') : 'checked in ' + agoText(row.last_seen_s);
    if (row.verdict === 'online') {
      const warn = row.stale || (row.services_down && row.services_down.length) || row.master === 'missed' ||
        row.master === 'out';
      return {led: warn ? 'wn' : 'up', verdict: 'ONLINE', seen: seen};
    }
    if (row.verdict === 'offline') return {led: 'down', verdict: 'OFFLINE', seen: seen};
    return {led: 'unk', verdict: 'UNKNOWN', seen: seen};
  }

  function masterText(m, missed) {
    if (m === 'in') return 'logged into the master';
    if (m === 'missed') return 'on the master, ' + (missed || 1) + ' missed keepalive' + (missed === 1 ? '' : 's');
    if (m === 'out') return 'NOT logged into the master';
    return 'master list unavailable';
  }

  /* Page / radio-check result from the gateway's frames -> {state: 'pending'|'ok'|'warn'|'bad', text, done}.
     Page frames: pageresult (immediate) then, for a Call Alert, pagealert. Radio check: accepted then done, or refused. */
  function radioResultText(kind, frames, done) {
    frames = Array.isArray(frames) ? frames.filter(f => f && typeof f === 'object') : [];
    const last = frames[frames.length - 1] || null;
    if (last && last.ev === 'timeout') return {state: 'warn', done: true,
      text: kind === 'page' ? 'No Call Alert result after 75 s. The page itself went out; check the app before resending.'
        : "No result after 115 s. It may still have gone out; don't resend it yet."};
    if (last && last.ev === 'error') return {state: 'bad', done: true, text: 'The gateway hit an error: ' + (last.reason || 'unknown') + '.'};
    if (kind === 'page') {
      const pr = frames.find(f => f.ev === 'pageresult');
      const pa = frames.find(f => f.ev === 'pagealert');
      if (!pr) return {state: 'pending', done: !!done, text: done ? 'No answer from the page handler.' : 'Sending the page…'};
      if (pr.ok !== true) return {state: 'bad', done: true,
        text: 'Page NOT sent: ' + (pr.reason || 'refused') + (pr.wait ? ' (' + pr.wait + ' s)' : '') + '.'};
      const sent = 'Page sent to ' + (pr.target || '?') + ': phone push' + (pr.alert ? ' + Call Alert to ' + (pr.radio || pr.target) + "'s radio" : '') +
        (pr.tones ? ' + page tones' + (pr.net ? ' on ' + pr.net : '') : '') + '.';
      if (!pr.alert) return {state: 'ok', done: true, text: sent + (pr.tones ? '' : ' (push only, nothing on the air)')};
      if (!pa) return {state: 'pending', done: false, text: sent + ' Checking that it rang…'};
      const r = pa.radio || pr.radio || '?';
      if (pa.answered) return {state: 'ok', done: true,
        text: r + "'s radio answered the Call Alert" + (typeof pa.ms === 'number' ? ' in ' + pa.ms + ' ms' : '') + '.'};
      if (pa.started) return {state: 'ok', done: true, text: r + "'s radio got the Call Alert (it started to answer)."};
      if (pa.result === 'hotspot_offline') return {state: 'bad', done: true,
        text: 'Offline: ' + r + "'s hotspot is offline, so nothing on the air can reach that radio. No tones were sent."};
      if (pa.result === 'budget') return {state: 'warn', done: true,
        text: 'Budget: the radio send limit for this minute was reached, so the Call Alert was not sent.' +
          (pa.fallback === 'tones' ? ' The page tones went out on ' + (pa.net || 'the net') + ' instead.' : '')};
      if (pa.fallback === 'tones') return {state: 'warn', done: true,
        text: 'No Call Alert answer from ' + r + ' (' + (pa.reason || pa.result || 'no answer') + '): fell back to tones on ' + (pa.net || 'the net') + '.'};
      return {state: 'warn', done: true, text: 'No Call Alert answer from ' + r + "'s radio: " + (pa.reason || pa.result || 'unknown') + '.' +
        (pa.fallback_why ? ' No tones either: ' + pa.fallback_why + '.' : '')};
    }
    // radio check
    const ref = frames.find(f => f.phase === 'refused');
    if (ref) {
      const why = ref.reason || ref.code || 'refused';
      if (ref.code === 'cooldown') return {state: 'warn', done: true, text: 'One moment between radio checks (' + (ref.retry_s != null ? ref.retry_s : '?') + ' s).'};
      if (ref.code === 'busy' || ref.code === 'pending') return {state: 'warn', done: true, text: 'Radio check NOT sent: ' + why + '.'};
      if (ref.code === 'unavailable') return {state: 'bad', done: true, text: "Radio checks aren't available right now. Nothing was sent."};
      return {state: 'bad', done: true, text: 'Radio check NOT sent: ' + why + '.'};
    }
    const dn = frames.find(f => f.phase === 'done');
    if (!dn) return {state: 'pending', done: !!done,
      text: frames.some(f => f.phase === 'accepted') ? 'Radio check going out (two tries, up to about 100 s)…' : 'Sending the radio check…'};
    if (dn.ok && dn.answered) return {state: 'ok', done: true,
      text: 'Your radio ANSWERED' + (typeof dn.ms === 'number' ? ' in ' + dn.ms + ' ms' : '') + ' (try ' + (dn.try || 1) + ' of ' + (dn.tries_asked || 2) + ').' +
        (dn.model ? ' Radio: ' + dn.model + '.' : '')};
    if (dn.ok && dn.started) return {state: 'ok', done: true, text: "A radio started to answer but the answer didn't finish. Count it as on."};
    if (dn.ok) return {state: 'warn', done: true, text: "No answer. That doesn't mean the radio is off: it may be asleep, out of range or on a busy channel."};
    if (dn.code === 'hotspot_offline') return {state: 'bad', done: true, text: "Offline: your hotspot is offline, so the radio can't be reached. Nothing was transmitted."};
    if (dn.code === 'budget') return {state: 'warn', done: true, text: 'Budget: the send limit is full (shared with texts and the driveway alarm). Try again in a minute.'};
    if (dn.code === 'net') return {state: 'warn', done: true, text: 'NOT sent: a scheduled net is on.'};
    return {state: 'bad', done: true, text: 'Radio check failed: ' + (dn.reason || dn.code || 'error') + '.'};
  }

  /* The role list for the dialog: the feed's guess first if it is a valid role. */
  function roleOptions(guess) {
    const g = ROLES.indexOf(guess) >= 0 ? guess : 'other';
    return ROLES.map(r => ({value: r, selected: r === g}));
  }

  const pure = {ROLES, NETS, addrLabel, netState, agoText, hotspotSummary, masterText, radioResultText, roleOptions};
  if (typeof module === 'object' && module.exports) { module.exports = pure; return; }
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------------ page wiring (browser only)
  const g = root;
  const E = (v, n) => g.esc(v, n);
  // REAUTH_OPS / ACT / lastSnap are top-level const/let in the page's script: shared by name, not window properties.
  /* global REAUTH_OPS, ACT, lastSnap */
  if (typeof REAUTH_OPS === 'object' && REAUTH_OPS) ['peer.alias', 'radio.page', 'radio.check'].forEach(o => REAUTH_OPS.add(o));

  /* ---------- 1. unknown peers */
  function unknownDetail(p, stale) {
    const u = p && p.unknown;
    if (!u || stale) return '';
    const since = u.connected_at ? g.clock(u.connected_at) + ' (' + g.dur(Date.now() / 1000 - u.connected_at) + ')' : '—';
    return '<div class="sub hmf-unk">' +
      'address <b>' + E(u.addr || '?', 45) + '</b> · ' + E(addrLabel(u.addr_class), 40) +
      ' · software ' + E(u.software || '?', 40) + (u.package ? ' / ' + E(u.package, 40) : '') +
      ' · logged in ' + since + ' ' +
      '<button class="sm" data-act="hmfMark" data-arg="' + E(p.id, 12) + '">Mark as ours…</button></div>';
  }

  let markId = null;
  function markDialog(id) {
    const snap = typeof lastSnap === 'object' ? lastSnap : null;
    const p = (snap && Array.isArray(snap.peers) ? snap.peers : []).find(x => String(x.id) === String(id));
    if (!p || !p.unknown) { g.flash('warn', 'That peer is no longer listed as unknown.'); return; }
    markId = p.id;
    const gu = p.unknown.guess || {};
    const opts = roleOptions(gu.role).map(o => '<option value="' + o.value + '"' + (o.selected ? ' selected' : '') + '>' + o.value + '</option>').join('');
    g.openModal('<h3>Mark peer ' + E(p.id, 12) + ' as ours</h3>' +
      '<p class="sub">' + E(p.callsign || 'no callsign', 12) + ' · ' + E(p.unknown.addr || '?', 45) + ' (' + E(addrLabel(p.unknown.addr_class), 40) + ') · ' +
      E(p.unknown.software || '?', 40) + (p.unknown.package ? ' / ' + E(p.unknown.package, 40) : '') + '</p>' +
      '<p class="sub">Only name it if you know this device. A name stops the UNKNOWN warning for it. The name is kept in a file on .151 ' +
      '(never in this page or the public repo); a device already named in the server\'s peer file can\'t be renamed here.</p>' +
      '<div class="frm"><label>Name<input id="hmf_alias" maxlength="40" autocomplete="off" value="' + E(gu.alias || '', 40) + '" autofocus></label>' +
      '<label>Role<select id="hmf_role">' + opts + '</select></label></div>' +
      g.dlgButtons('Save name', 'hmfMarkGo'));
  }
  function markGo() {
    const a = (g.el('hmf_alias') || {}).value || '';
    const role = (g.el('hmf_role') || {}).value || 'other';
    const alias = a.trim();
    if (!alias || alias.length > 40 || /[^\x20-\x7e]/.test(alias)) { g.modalError('Use 1 to 40 plain characters (letters, digits, punctuation).'); return; }
    const id = markId;
    g.runWrite('peer.alias', {peer_id: Number(id), alias: alias, role: role}, {
      onOk: () => { g.flash('ok', 'Peer ' + id + ' is now "' + alias + '".'); if (typeof g.schedule === 'function') g.schedule(50); }
    });
  }

  /* ---------- 2. hotspots card */
  function renderHotspots(d, stale) {
    const box = g.el('hsBody');
    if (!box) return;
    const hs = d && d.hotspots;
    if (!hs) { box.innerHTML = '<div class="sub">Not available from this feed yet (the server side of this card is not installed).</div>'; return; }
    if (!hs.enabled) { box.innerHTML = '<div class="sub">Not enabled on the server (the feed\'s link to the gateway is off).</div>'; return; }
    if (stale) { box.innerHTML = '<div class="sub">unknown (stale)</div>'; return; }
    const rows = Array.isArray(hs.rows) ? hs.rows : [];
    if (!rows.length) { box.innerHTML = '<div class="sub">' + (hs.ok ? 'No hotspots in the roster.' : 'Waiting for the gateway (' + E(hs.error || 'no answer', 40) + ').') + '</div>'; return; }
    box.innerHTML = (hs.ok ? '' : '<div class="sub warnt">The gateway is not answering (' + E(hs.error || '?', 40) + '); showing the master list only.</div>') +
      rows.map(r => {
        const s = hotspotSummary(r);
        const nets = NETS.map(n => { const v = netState(r.nets ? r.nets[n] : null);
          return '<span class="hmf-net ' + v.cls + (r.stale ? ' stale' : '') + '" title="' + n + ': ' + v.txt + '">' + n + ' ' + v.txt + '</span>'; }).join('');
        const extra = [masterText(r.master, r.missed)];
        if (r.addr_class) extra.push('from ' + addrLabel(r.addr_class));
        if (r.services_down && r.services_down.length) extra.push('⚠ ' + r.services_down.join(', ') + ' not active');
        if (r.note) extra.push(r.note);
        return '<div class="svc"><span class="led ' + s.led + '"></span><b>' + E(r.who || r.call, 24) + '</b> <span class="sub">' + E(r.call, 12) +
          ' · peer ' + E(r.peer, 10) + '</span> <span class="tag ' + (s.led === 'up' ? 'okt' : s.led === 'down' ? 'bad' : 'pend') + '">' + s.verdict + '</span>' +
          '<span class="r">' + E(s.seen, 40) + '</span></div>' +
          '<div class="hmf-nets">' + (r.stale && r.verdict !== 'unknown' ? '<span class="sub">last known: </span>' : '') + nets + '</div>' +
          '<div class="sub hmf-unk">' + E(extra.join(' · '), 300) + '</div>';
      }).join('');
  }

  /* ---------- 3. radio card */
  const radio = {pending: null, out: [], timer: null};
  function renderRadio() {
    const box = g.el('hmfRadio');
    if (!box) return;
    const busy = radio.out.some(o => !o.done);
    if (!box.dataset.built) {
      box.dataset.built = '1';
      box.innerHTML = '<div class="hmf-row">' +
        '<button class="go" data-act="hmfPageDlg" data-arg="me">Call Alert ME</button>' +
        '<button class="go" data-act="hmfPageDlg" data-arg="dad">Call Alert Dad</button>' +
        '<button class="go" data-act="hmfPageDlg" data-arg="pete">Call Alert Pete</button>' +
        '<label class="cb"><input type="checkbox" id="hmfTone"> with tones (everyone on the talkgroup hears them)</label></div>' +
        '<div class="hmf-row"><button class="go" data-act="hmfRcDlg">Radio check ME</button></div>' +
        '<div id="hmfRadioOut"></div>';
    }
    box.querySelectorAll('button[data-act^="hmf"]').forEach(b => { b.disabled = busy; });
    const out = g.el('hmfRadioOut');
    if (out) out.innerHTML = radio.out.slice(-5).reverse().map(o => {
      const r = radioResultText(o.kind, o.frames, o.done);
      const led = r.state === 'ok' ? 'up' : r.state === 'warn' ? 'wn' : r.state === 'bad' ? 'down' : 'unk';
      return '<div class="svc"><span class="led ' + led + '"></span><span class="sub">' + g.clock(o.t) + '</span> ' + E(o.label, 40) + ': ' + E(r.text, 400) + '</div>';
    }).join('');
  }
  function confirmHtml(kind, target, tone) {
    if (kind === 'rc') return '<h3>Radio check your radio?</h3><div class="warnbox">This TRANSMITS: a radio check goes out over HOLDEN to ' +
      RADIO_WHO.me + ' (up to two tries). The gateway refuses it during a net, while the channel is busy, or over the send limit.</div>';
    return '<h3>Call Alert ' + E(RADIO_WHO[target], 40) + '?</h3><div class="warnbox">This TRANSMITS: a DMR Call Alert rings ' + E(RADIO_WHO[target], 40) +
      ' and a page push goes to ' + (target === 'me' ? 'your' : 'their') + ' phone.' +
      (tone ? ' WITH TONES: the page tones also go out on the talkgroup, which everyone on it hears.' : ' No tones unless the Call Alert gets no answer.') +
      (target === 'pete' ? ' Pete only hears pages on HOLDEN DMR.' : '') + '</div>' +
      '<p class="sub">The gateway on .151 applies the same guards as the app (60 s between pages, busy channel, offline hotspot).</p>';
  }
  function radioDlg(kind, target) {
    const tone = kind === 'page' && !!(g.el('hmfTone') || {}).checked;
    radio.pending = {kind: kind, target: kind === 'rc' ? 'me' : target, tone: tone};
    g.openModal(confirmHtml(kind, target, tone) + g.dlgButtons(kind === 'rc' ? 'Send the radio check' : 'Send the Call Alert', 'hmfRadioGo', 'stop'));
  }
  function radioGo() {
    const p = radio.pending;
    if (!p) return g.closeModal();
    radio.pending = null;
    const op = p.kind === 'rc' ? 'radio.check' : 'radio.page';
    const args = p.kind === 'rc' ? {target: 'me'} : {target: p.target, tone: p.tone};
    const label = p.kind === 'rc' ? 'Radio check ME' : 'Call Alert ' + (p.target === 'me' ? 'ME' : p.target === 'dad' ? 'Dad' : 'Pete') + (p.tone ? ' + tones' : '');
    g.runWrite(op, args, {onOk: r => {
      const dd = (r && r.data) || {};
      const o = {kind: p.kind === 'rc' ? 'rc' : 'page', ticket: dd.ticket, frames: dd.frames || [], done: !!dd.done, t: Date.now() / 1000, label: label};
      if (radioResultText(o.kind, o.frames, false).done) o.done = true;
      radio.out.push(o);
      if (radio.out.length > 20) radio.out.shift();
      const tb = g.el('hmfTone'); if (tb) tb.checked = false;
      renderRadio();
      if (!o.done && o.ticket) pollResult(o, Date.now());
    }});
  }
  function pollResult(o, t0) {
    clearTimeout(radio.timer);
    radio.timer = setTimeout(async () => {
      const r = await g.cmd('radio.result', {ticket: o.ticket});
      if (r.ok && r.data) { o.frames = r.data.frames || o.frames; o.done = !!r.data.done || radioResultText(o.kind, o.frames, false).done; }
      else if (r.http === 404 || (Date.now() - t0) > 140000) { o.done = true; o.frames = o.frames.concat([{ev: 'timeout'}]); }
      renderRadio();
      if (!o.done) pollResult(o, t0);
    }, 2000);
  }

  Object.assign(ACT, {
    hmfMark: id => markDialog(id),
    hmfMarkGo: () => markGo(),
    hmfPageDlg: t => radioDlg('page', t),
    hmfRcDlg: () => radioDlg('rc', 'me'),
    hmfRadioGo: () => radioGo(),
  });

  const css = document.createElement('style');
  css.textContent = '.hmf-unk{margin:2px 0 8px 19px;line-height:1.5}.hmf-unk button{margin-left:6px}' +
    '.hmf-nets{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 2px 19px}' +
    '.hmf-net{font-size:11px;padding:1px 7px;border:1px solid var(--ln);white-space:nowrap}' +
    '.hmf-net.up{color:var(--ok);border-color:var(--ok)}.hmf-net.down{color:var(--bad);border-color:var(--bad)}' +
    '.hmf-net.off{color:var(--dim)}.hmf-net.unk{color:var(--dim);border-style:dashed}.hmf-net.stale{opacity:.55}' +
    '.hmf-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}' +
    '@media (max-width:560px){.hmf-row button{flex:1 1 45%}}';
  document.head.appendChild(css);

  g.HMF = Object.assign({}, pure, {unknownDetail: unknownDetail, renderHotspots: renderHotspots, renderRadio: renderRadio});
  renderRadio();
  if (typeof lastSnap === 'object' && lastSnap && typeof g.render === 'function') g.render(lastSnap);
})(typeof window !== 'undefined' ? window : globalThis);
