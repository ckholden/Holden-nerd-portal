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
        appendLine(m.from, m.text, m.ts, m.away);
        if (!document.hasFocus() && window.HOLSound) HOLSound.play('message');
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
      return { who: msg.from || '', mine: mine, html: msg.text, ts: msg.ts, kind: 'msg' };
    });
    LOG = histEntries.concat(LOG); // history is older, so it goes first
    messages.forEach(function (msg) { frag.appendChild(buildLine(msg.from, msg.text, msg.ts)); });
    var divider = document.createElement('div');
    divider.className = 'histdivider';
    divider.textContent = '--- End of recent messages ---';
    frag.appendChild(divider);
    imLog.insertBefore(frag, imLog.firstChild);
  }

  function buildLine(from, text, ts, isAway) {
    var line = document.createElement('div');
    var mine = me && from && from.toLowerCase() === me.screenName.toLowerCase();
    var nameSpan = document.createElement('span');
    nameSpan.className = mine ? 'me' : 'them';
    nameSpan.textContent = (from || '') + ': ';
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

  function appendLine(from, text, ts, isAway) {
    imLog.appendChild(buildLine(from, text, ts, isAway));
    imLog.scrollTop = imLog.scrollHeight;
    var mine = me && from && from.toLowerCase() === me.screenName.toLowerCase();
    LOG.push({ who: from || '', mine: mine, html: text, ts: ts, kind: isAway ? 'sys' : 'msg' });
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
