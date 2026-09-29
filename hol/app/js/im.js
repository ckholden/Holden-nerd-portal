/*
 * Holden On Line — browser client: 1:1 IM popup controller.
 * No socket of its own — relays through window.opener via postMessage (see js/router.js).
 * Every message here is sanitized through holshared.js's ONE allowlist sanitizer before
 * ever touching innerHTML — do not write a second one (CONTRACT-ipc.md §21/§9).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var imTitle = $('imTitle'), imLog = $('imLog'), imCompose = $('imCompose'),
      imSend = $('imSend'), imStatus = $('imStatus'), imMax = $('imMax'), imClose = $('imClose');

  // Mirrors what's on screen, for File > Save Conversation... — same {who,html,ts} shape
  // HOLShared.transcriptText() (holshared.js, shared verbatim with the desktop app) expects.
  var LOG = [];

  var params = new URLSearchParams(location.search);
  var withUser = params.get('with') || '';
  var me = null;
  var ready = false;
  var historyShown = false;

  imTitle.textContent = withUser ? 'IM with ' + withUser : 'IM';
  imStatus.textContent = 'Connecting…';

  if (window.opener) {
    window.opener.postMessage({ t: 'hol:im-ready', withUser: withUser }, location.origin);
  } else {
    imStatus.textContent = 'This window was not opened by Holden On Line.';
  }

  window.addEventListener('message', function (ev) {
    if (ev.origin !== location.origin || ev.source !== window.opener) return;
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hol:im-init':
        me = m.me;
        withUser = m.withUser || withUser;
        imTitle.textContent = 'IM with ' + withUser;
        imStatus.textContent = 'Ready.';
        ready = true;
        return;
      case 'hol:im-history':
        if (m.screenName && m.screenName.toLowerCase() !== withUser.toLowerCase()) return;
        renderHistory(m.messages || []);
        return;
      case 'hol:incoming-im':
        // 0.2.0 — the shell could not open it (or refused to send): grey, never attributed.
        if (m.sys || m.e2eFailed) { appendSys(m.text || ''); return; }
        appendLine(m.from, m.text, m.ts, m.away, plainTag(m) + noteOf(m));
        if (!document.hasFocus() && window.HOLSound) HOLSound.play('message');
        return;
      case 'hol:im-e2e-status':
        handleE2eStatus(m.status);
        return;
      case 'hol:e2e-safety-result':
        showSafety(m);
        return;
      case 'hol:im-presend':
        imCompose.value = m.text || '';
        doSend();
        return;
      default:
        return;
    }
  });

  function renderHistory(messages) {
    if (historyShown || !messages.length) { historyShown = true; return; }
    historyShown = true;
    var frag = document.createDocumentFragment();
    var histEntries = messages.map(function (msg) {
      var mine = me && msg.from && msg.from.toLowerCase() === me.screenName.toLowerCase();
      if (msg.e2eFailed) return { who: '', mine: false, text: String(msg.text || ''), ts: msg.ts, kind: 'sys' };
      // ⚠ The SANITIZED html goes in the log that Save Conversation reads (review F12).
      return { who: (msg.from || '') + plainTag(msg) + noteOf(msg), mine: mine,
        html: HOLShared.messageHtml({ html: msg.text }), ts: msg.ts, kind: 'msg' };
    });
    LOG = histEntries.concat(LOG); // history is older, so it goes first
    messages.forEach(function (msg) {
      frag.appendChild(msg.e2eFailed ? buildSys(msg.text || '') : buildLine(msg.from, msg.text, msg.ts, false, plainTag(msg) + noteOf(msg)));
    });
    var divider = document.createElement('div');
    divider.className = 'histdivider';
    divider.textContent = '--- End of recent messages ---';
    frag.appendChild(divider);
    imLog.insertBefore(frag, imLog.firstChild);
  }

  function buildLine(from, text, ts, isAway, tag) {
    var line = document.createElement('div');
    var mine = me && from && from.toLowerCase() === me.screenName.toLowerCase();
    var nameSpan = document.createElement('span');
    nameSpan.className = mine ? 'me' : 'them';
    nameSpan.textContent = (from || '') + (tag || '') + ': ';
    var stampSpan = document.createElement('span');
    stampSpan.className = 'stamp';
    stampSpan.textContent = ' ' + (window.HOLClock ? HOLClock.stamp(ts) : '');
    line.appendChild(nameSpan);
    var body = HOLShared.messageToElement({ html: text });
    body.style.display = 'inline';
    line.appendChild(body);
    line.appendChild(stampSpan);
    if (isAway) line.classList.add('sys');
    return line;
  }

  function appendLine(from, text, ts, isAway, tag) {
    imLog.appendChild(buildLine(from, text, ts, isAway, tag));
    imLog.scrollTop = imLog.scrollHeight;
    var mine = me && from && from.toLowerCase() === me.screenName.toLowerCase();
    // ⚠ Sanitized html, and an away line as a normal line labeled as such: a 'sys' entry
    // is saved from `text`, which this never had — away lines saved as blank "* " (F12).
    LOG.push({ who: (from || '') + (tag || '') + (isAway && !/away message/.test(tag || '') ? ' (away message)' : ''),
      mine: mine, html: HOLShared.messageHtml({ html: text }), ts: ts, kind: 'msg' });
  }

  // A grey line nobody said — status, notices, "could not be read".
  function buildSys(text) {
    var line = document.createElement('div');
    line.className = 'sys';
    line.textContent = String(text || '');
    return line;
  }
  function appendSys(text) {
    imLog.appendChild(buildSys(text));
    imLog.scrollTop = imLog.scrollHeight;
    // transcriptText() prints a sys entry's `text` (not `html`).
    LOG.push({ who: '', mine: false, text: String(text || ''), ts: Date.now(), kind: 'sys' });
  }

  /* ---- end-to-end encryption (0.2.0, holden-im CONTRACT-ipc.md §27c) ------------------
   * ⚠ THIS POPUP NEVER SEES A KEY. The shell page encrypts what doSend() posts and decrypts
   * what arrives; this only shows the label the shell computed, and its one-shot notices.
   * Same wording as the desktop's im.html — "(preview)" stays until SPEC-e2e.md §8 is done. */
  var E2E_STATE = null;
  function plainTag(msg) {
    if (E2E_STATE !== 'e2e' || !msg || msg.e2e === true) return '';
    if (me && msg.from && msg.from.toLowerCase() === me.screenName.toLowerCase()) return '';
    return msg.away ? ' (away message, not encrypted)' : ' (NOT encrypted)';
  }
  // The shell's note on a decrypted line ("from a new computer" / "arrived late"), worded
  // in hol-e2e-session.js so the browser and the desktop app say the same thing.
  function noteOf(msg) {
    return (msg && msg.e2e === true && typeof msg.e2eNote === 'string') ? msg.e2eNote : '';
  }
  function handleE2eStatus(p) {
    if (!p || (p.withUser && p.withUser.toLowerCase() !== withUser.toLowerCase())) return;
    var el = $('imE2e');
    var who = withUser || 'them';
    var text = 'Not encrypted', cls = '', tip;
    if (p.state === 'e2e' && p.unverified) {
      text = '🔒 Encrypted — ⚠ safety number changed'; cls = 'warn';
      tip = who + '’s computers changed since you last checked. Until you compare your safety number ' +
            '(People > Verify Encryption), you can’t be sure only ' + who + ' can read this.';
    } else if (p.state === 'e2e') {
      text = '🔒 End-to-end encrypted (preview)'; cls = 'on';
      tip = 'Only you and ' + who + ' can read these messages — not the Holden On Line server — unless someone ' +
            'slipped in a fake key; People > Verify Encryption checks for that. Keys in a browser are less ' +
            'protected than in the Windows app.';
    } else if (p.state === 'bot') {
      tip = who + ' runs on the Holden On Line server itself.';
    } else if (p.state === 'no-local-key') {
      tip = 'This browser could not set up an encryption key (private window, or storage blocked).';
    } else if (p.downgraded) {
      text = '⚠ Not encrypted'; cls = 'warn';
      tip = who + ' used to have end-to-end encryption and now doesn’t. The server can read these messages.';
    } else {
      tip = who + ' is on an older copy of Holden On Line. The server can read these messages.';
    }
    el.textContent = text;
    el.className = 'e2ebar' + (cls ? ' ' + cls : '');
    el.title = tip;
    if (E2E_STATE !== p.state) {
      if (p.state === 'e2e') appendSys('Messages in this conversation are end-to-end encrypted (preview).');
      else if (E2E_STATE === 'e2e' || E2E_STATE === null) appendSys('Messages in this conversation are not end-to-end encrypted.');
      E2E_STATE = p.state;
    }
    (p.notices || []).forEach(function (n) { appendSys(n); });
  }
  function doVerifyEncryption() {
    if (window.opener) window.opener.postMessage({ t: 'hol:e2e-safety', withUser: withUser }, location.origin);
  }
  function showSafety(r) {
    if (!r || !r.number) { appendSys('There is no safety number: this conversation is not end-to-end encrypted.'); return; }
    var g = String(r.number).split(' ');
    appendSys('Safety number with ' + withUser + ' — compare it with them by phone or in person:');
    for (var i = 0; i < g.length; i += 4) appendSys(g.slice(i, i + 4).join(' '));
    // ⚠ The number alone can't reveal an extra computer added to BOTH views of one account
    // (security review H2), so the counts are part of what gets compared.
    var mine = r.mine || [], theirs = r.theirs || [];
    appendSys('Computers: you ' + mine.length + ' (' + mine.join(', ') + ') · ' + withUser + ' ' + theirs.length +
              (theirs.length ? ' (' + theirs.join(', ') + ')' : '') + '.');
    appendSys('If the number matches on both screens AND each count is the number of computers or browsers you ' +
              'each really use, nobody else can read this conversation. It changes whenever either of you starts ' +
              'using a new computer or browser.');
    handleE2eStatus({ withUser: withUser, state: 'e2e' });   // Verify clears "safety number changed"
  }

  function doSend() {
    var raw = imCompose.value;
    if (!raw || !raw.trim()) return;
    var escaped = HOLShared.escapeText(raw);
    if (window.opener) {
      window.opener.postMessage({ t: 'hol:send-im', to: withUser, text: escaped }, location.origin);
    }
    appendLine(me ? me.screenName : 'You', escaped, HOLClock ? HOLClock.now() : Date.now());
    imCompose.value = '';
  }

  // File > Save Conversation... / Print... (2026-08-17) — added after a server restart
  // wiped someone's in-memory IM history (RAM-only, dies on every restart — CONTRACT-ipc.md).
  // No Electron dialog here — a browser tab downloads via a throwaway <a download> Blob link.
  function downloadTextFile(filename, text) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function doSaveConversation() {
    var title = 'IM with ' + (withUser || 'Unknown');
    var dateStr = new Date().toISOString().slice(0, 10);
    downloadTextFile('HOL - ' + title + ' - ' + dateStr + '.txt', HOLShared.transcriptText(LOG, title));
  }
  function doPrint() { window.print(); }

  if (window.HOLShared && HOLShared.attachMenu) {
    HOLShared.attachMenu($('imMenubar'), [
      { menu: 'File', items: [
          { label: 'Save Conversation...', enabled: function () { return LOG.length > 0; }, action: doSaveConversation },
          { label: 'Print...', action: doPrint },
          { sep: true },
          { label: 'Close', action: function () { window.close(); } }
        ] },
      { menu: 'People', items: [
          { label: 'Verify Encryption...', enabled: function () { return E2E_STATE === 'e2e'; },
            action: doVerifyEncryption }
        ] },
      { menu: 'Help', why: 'Not in this version.' }
    ]);
  }

  imSend.addEventListener('click', doSend);
  imCompose.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
  });

  // No minimize — JS cannot minimize a real window (platform ceiling, not a bug).
  imMax.addEventListener('click', function () {
    try { window.resizeTo(screen.availWidth, screen.availHeight); } catch (e) {}
  });
  imClose.addEventListener('click', function () { window.close(); });
})();
