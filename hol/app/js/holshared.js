// Holden On Line — shared renderer helpers.
//
// Two things live here, and both are here for the SAME reason: they must exist
// exactly once for the whole app.
//
//   1. THE HTML SANITISER.  It was born inline in im.html. The chat-room window
//      renders the same kind of foreign markup, and a second copy of an allowlist
//      sanitiser is a second copy that can drift out of date — in a program where
//      one bad message reaches EVERY person in the room at once. So the code was
//      MOVED here (not duplicated) and im.html now calls it.
//
//   2. THE CLOCK.  The server stamps every message it relays. Your own sent
//      messages used to be stamped by your own PC. If that PC's clock is wrong,
//      YOUR transcript contradicts itself — your line at 3:15, the answer to it
//      at 2:47 — and nobody else sees anything odd, so nobody can help you.
//      One offset, computed from the server's `serverTime` at sign-on, shared by
//      every window.
//
// ⚠ NO DOM DEPENDENCIES AT LOAD TIME beyond `document` existing, and no `hol`
// bridge use at all: this file is loaded by windows that have no preload bridge
// (a plain-browser look-check) and it must not throw there.
//
// ⚠ Ships because package.json's build.files allowlist covers `renderer/*.js`.
// If that glob is ever narrowed, this file silently stops shipping and every
// window that depends on it falls back to plain text. See the guards below —
// they are written so that "missing" degrades to SAFE-but-plain, never to unsafe.

'use strict';

(function (global) {

  /* =========================================================================
   * 1. HTML SANITISING  (moved verbatim from im.html, 2026-08-10)
   *
   * Messages travel as small fragments of HTML so bold/italic/colour survive the
   * wire, which means a HOL window renders markup that came off another machine.
   * contextIsolation is on, but script injected into a renderer could still call
   * window.hol.* — so nothing is ever inserted without passing this allowlist.
   * Tags not listed are unwrapped to their text; attributes not listed are dropped.
   * ====================================================================== */

  var ALLOWED  = { B:1, STRONG:1, I:1, EM:1, U:1, BR:1, FONT:1, SPAN:1 };
  var BLOCKISH = { DIV:1, P:1 };
  // Dropped WITH their contents. Everything else unlisted is unwrapped to its text,
  // which is right for <a>/<h1>/etc but wrong here — unwrapping <script> would paint
  // the attacker's source code into the conversation as visible text.
  var DROP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, IFRAME:1, OBJECT:1,
               EMBED:1, HEAD:1, TITLE:1, LINK:1, META:1 };
  var STYLE_PROPS = ['color','font-family','font-size','font-weight','font-style','text-decoration'];
  var NAMED_COLORS = /^[a-z]{3,20}$/i;

  function safeColor(v) {
    v = String(v || '').trim();
    if (/^#[0-9a-f]{3}$/i.test(v) || /^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(v)) return v;
    if (NAMED_COLORS.test(v)) return v;
    return null;
  }
  function safeFace(v) {
    v = String(v || '').replace(/["'`;{}()]/g, '').trim();
    return /^[\w \-,\.]{1,80}$/.test(v) ? v : null;
  }
  function safeStyle(el) {
    // Re-emit from the parsed CSSStyleDeclaration, never from the raw string —
    // the parser has already thrown away anything malformed, and url()/expression
    // can't survive a property-by-property copy of this whitelist.
    var out = [];
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      var p = STYLE_PROPS[i];
      var v = el.style.getPropertyValue(p);
      if (!v) continue;
      if (/url\(|expression|javascript:|@import/i.test(v)) continue;
      if (p === 'color') { v = safeColor(v); if (!v) continue; }
      if (p === 'font-family') { v = safeFace(v); if (!v) continue; }
      if (p === 'font-size' && !/^\d{1,3}(px|pt|em|%)$/.test(v)) continue;
      out.push(p + ':' + v);
    }
    return out.join(';');
  }

  function sanitizeInto(src, dest, depth) {
    depth = depth || 0;
    if (depth > 12) { dest.appendChild(document.createTextNode(src.textContent || '')); return; }
    var kids = src.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) { dest.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;                       // comments, everything else: gone
      var tag = n.tagName.toUpperCase();

      if (DROP[tag]) continue;                               // contents and all
      if (tag === 'BR') { dest.appendChild(document.createElement('br')); continue; }

      if (BLOCKISH[tag]) {                                   // paste / Shift+Enter artefacts
        if (dest.lastChild && dest.lastChild.nodeName !== 'BR') dest.appendChild(document.createElement('br'));
        sanitizeInto(n, dest, depth + 1);
        continue;
      }

      if (!ALLOWED[tag]) { sanitizeInto(n, dest, depth + 1); continue; }  // unwrap, keep text

      var el = document.createElement(tag);
      if (tag === 'FONT') {
        var c = safeColor(n.getAttribute('color')); if (c) el.setAttribute('color', c);
        var f = safeFace(n.getAttribute('face'));   if (f) el.setAttribute('face', f);
        var s = String(n.getAttribute('size') || '').trim();
        if (/^[1-7]$/.test(s)) el.setAttribute('size', s);
      } else if (tag === 'SPAN') {
        var st = safeStyle(n); if (st) el.setAttribute('style', st);
      }
      sanitizeInto(n, el, depth + 1);
      dest.appendChild(el);
    }
  }

  // ⚠ MEASURED, not theoretical: an earlier version parsed with
  // `document.createElement('div').innerHTML = html`. The allowlist correctly threw
  // the <img> away — but merely CREATING it in this document started a load, the
  // load failed, and the inline onerror ran. The payload executed even though it
  // never reached the screen. A detached node is NOT an inert node.
  //
  // DOMParser produces a document with no browsing context: images do not load and
  // scripts never run, so the payload is dead before the allowlist even sees it.
  var PARSER = new DOMParser();

  function sanitizeToElement(html) {
    var out = document.createElement('div');
    var doc;
    try {
      doc = PARSER.parseFromString(
        '<!doctype html><body>' + String(html == null ? '' : html), 'text/html');
    } catch (e) { return out; }
    if (doc && doc.body) sanitizeInto(doc.body, out, 0);
    return out;
  }
  function sanitizeHtml(html) { return sanitizeToElement(html).innerHTML; }

  // Chromium's insertLineBreak leaves a trailing placeholder <br>, so a message sent
  // after a Shift+Enter would ship "text<br><br>" and render with dead space.
  function trimEdgeBreaks(root) {
    function edge(last) {                       // deepest first/last descendant
      var n = root;
      while (n && n.nodeType === 1 && n.firstChild) n = last ? n.lastChild : n.firstChild;
      return n;
    }
    function strip(last) {
      for (var guard = 0; guard < 100; guard++) {
        var n = edge(last);
        if (!n || n === root) return;
        var junk = (n.nodeType === 3 && !n.nodeValue.trim()) ||
                   (n.nodeType === 1 && n.tagName === 'BR');
        if (!junk) return;
        var p = n.parentNode;
        p.removeChild(n);
        while (p && p !== root && !p.firstChild) {   // drop wrappers we just emptied
          var q = p.parentNode; q.removeChild(p); p = q;
        }
      }
    }
    strip(true); strip(false);
    return root;
  }

  function escapeText(t) {
    var d = document.createElement('div');
    d.textContent = String(t == null ? '' : t);
    return d.innerHTML.replace(/\n/g, '<br>');
  }

  /* A screen name, room title or any other short label that arrived over the wire.
   *
   * ⚠ This is deliberately HARSHER than sanitizeHtml(): a name is not a message and
   * has no business carrying markup, so it is flattened to text and clamped. The
   * clamp is not cosmetic — a 4000-character "screen name" in an occupant list is a
   * denial-of-service against the layout of a window everyone in the room is looking
   * at. Control characters go too: a lone U+202E (right-to-left override) rewrites
   * everything after it on the line.
   *
   * Returns a STRING for use with .textContent. It must never be handed to innerHTML;
   * callers that need markup use sanitizeHtml(). */
  function cleanLabel(s, max) {
    var out = String(s == null ? '' : s)
      .replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    max = max || 64;
    if (out.length > max) out = out.slice(0, max - 3) + '...';
    return out;
  }

  /* =========================================================================
   * 1b. AUTO-LINKIFY  (added 0.1.5)
   *
   * ⚠ THIS IS NOT A SECOND SANITISER AND IT MUST NEVER BECOME ONE. It runs on the
   * tree the allowlist above already produced, walking TEXT NODES only. Doing it
   * with a regex over an HTML string is the classic way to grow a second, worse
   * parser: `<font color="http://x">` would match inside the attribute and the
   * replacement would corrupt the tag. Text nodes cannot contain markup, so there
   * is nothing there to corrupt.
   *
   * ⚠ THE ANCHOR CARRIES NO href, AND THAT IS DELIBERATE. main.js has no
   * `will-navigate` guard and no `setWindowOpenHandler` (checked 2026-08-10), so a
   * live href in an Electron renderer is a one-click way to navigate the IM window
   * to a stranger's web page, or to pop a chromeless BrowserWindow pointed at it.
   * A room message reaches everyone at once, which makes that a broadcast weapon.
   * The address lives in `data-hol-link`; the click is intercepted below and handed
   * to whatever the page set as window.HOLLinkHandler. No handler => nothing happens
   * except the page's own status line. Inert beats navigable.
   *
   * ⚠ Only http and https survive. `javascript:`, `data:`, `file:` and friends are
   * not "unsupported", they are the attack — and they are rejected by asking the URL
   * parser what the protocol is, never by pattern-matching the string.
   * ====================================================================== */

  // Deliberately narrow. Trailing punctuation is trimmed after the match, because
  // "see https://example.com/x." ends a sentence far more often than a URL ends in
  // a full stop.
  var URL_RE = /(\b(?:https?:\/\/|www\.)[^\s<>"'` ]{2,})/gi;
  var TRAILING = /[.,;:!?'"’”]+$/;
  var MAX_URL = 2048;
  var MAX_SHOWN = 72;

  function trimUrl(raw) {
    var s = String(raw || '');
    for (var guard = 0; guard < 8; guard++) {
      var before = s;
      s = s.replace(TRAILING, '');
      // Keep a closing bracket only if the URL opened one. Wikipedia links need it;
      // "(see https://example.com)" does not.
      if (/\)$/.test(s) && s.split('(').length <= s.split(')').length) s = s.slice(0, -1);
      if (/\]$/.test(s) && s.split('[').length <= s.split(']').length) s = s.slice(0, -1);
      if (s === before) break;
    }
    return s;
  }

  /* Returns the absolute http(s) URL, or null. ⚠ The verdict comes from the parser,
   * not from the regex that found the candidate. */
  function safeUrl(raw) {
    var s = trimUrl(raw);
    if (!s || s.length > MAX_URL) return null;
    var abs = /^www\./i.test(s) ? 'https://' + s : s;
    var u;
    try { u = new URL(abs); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || u.hostname.indexOf('.') < 0) return null;   // "http://foo" is a typo
    return u.href;
  }

  function shorten(s) {
    s = String(s || '');
    if (s.length <= MAX_SHOWN) return s;
    return s.slice(0, MAX_SHOWN - 1) + '…';
  }

  function makeLink(shownText, url) {
    var a = document.createElement('a');
    a.className = 'hol-link';
    a.setAttribute('data-hol-link', url);   // ⚠ NOT href. See the block comment above.
    a.setAttribute('role', 'link');
    a.setAttribute('tabindex', '0');
    a.title = url;                           // hover shows the REAL destination, in full
    a.textContent = shorten(shownText);
    return a;
  }

  /* Walk text nodes and swap URL runs for anchors, in place. */
  function linkifyElement(root) {
    if (!root || !root.ownerDocument) return root;
    var doc = root.ownerDocument;
    var walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, null, false);
    var texts = [];
    var n;
    while ((n = walker.nextNode())) {
      // Never linkify inside an anchor we already made.
      var p = n.parentNode, inside = false;
      while (p && p !== root) {
        if (p.nodeType === 1 && p.hasAttribute && p.hasAttribute('data-hol-link')) { inside = true; break; }
        p = p.parentNode;
      }
      if (!inside && URL_RE.test(n.nodeValue || '')) texts.push(n);
      URL_RE.lastIndex = 0;
    }

    for (var i = 0; i < texts.length; i++) {
      var node = texts[i];
      var src = node.nodeValue || '';
      var frag = doc.createDocumentFragment();
      var last = 0, m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(src))) {
        var raw = m[0];
        var url = safeUrl(raw);
        if (!url) continue;                       // not a real link: leave it as text
        var shown = trimUrl(raw);
        var start = m.index;
        if (start > last) frag.appendChild(doc.createTextNode(src.slice(last, start)));
        frag.appendChild(makeLink(shown, url));
        last = start + shown.length;              // ⚠ shown, not raw: trailing '.' stays text
        URL_RE.lastIndex = last;
      }
      if (!last) continue;
      if (last < src.length) frag.appendChild(doc.createTextNode(src.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    return root;
  }

  function textToElement(t) {
    var out = document.createElement('div');
    var parts = String(t == null ? '' : t).split('\n');
    for (var i = 0; i < parts.length; i++) {
      if (i) out.appendChild(document.createElement('br'));
      out.appendChild(document.createTextNode(parts[i]));
    }
    return out;
  }

  /* THE ONE CALL A MESSAGE WINDOW SHOULD USE.
   * Takes {html?, text?} off the wire and returns display-ready HTML: sanitised (or
   * escaped, when only plain text arrived) and THEN linkified. Both branches get the
   * links — an earlier draft only linkified the html branch, which meant a message
   * from a client that sends plain text had dead URLs and nobody could see why. */
  function messageToElement(msg) {
    var el = (msg && msg.html) ? sanitizeToElement(msg.html) : textToElement(msg && msg.text);
    linkifyElement(el);
    return el;
  }
  function messageHtml(msg) { return messageToElement(msg).innerHTML; }

  /* For the local echo of something WE typed: it has already been through the
   * sanitiser on its way to the wire, so this only adds the links. ⚠ Linkify the copy
   * that is DISPLAYED, never the copy that is SENT — the anchors are a rendering
   * decision and putting them on the wire would hand the next client markup it would
   * only have to strip again. */
  function linkifyHtml(html) {
    var out = document.createElement('div');
    out.innerHTML = String(html == null ? '' : html);   // our own sanitised output
    linkifyElement(out);
    return out.innerHTML;
  }

  /* One interceptor for the whole app. Capture phase so nothing else can act on the
   * click first, and preventDefault unconditionally: even a link that no handler wants
   * must not navigate. */
  try {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('[data-hol-link]') : null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      var url = a.getAttribute('data-hol-link');
      if (typeof global.HOLLinkHandler === 'function') {
        try { global.HOLLinkHandler(url, e); } catch (err) {}
      }
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var a = document.activeElement;
      if (!a || !a.hasAttribute || !a.hasAttribute('data-hol-link')) return;
      e.preventDefault();
      if (typeof global.HOLLinkHandler === 'function') {
        try { global.HOLLinkHandler(a.getAttribute('data-hol-link'), e); } catch (err) {}
      }
    }, true);
  } catch (e) { /* no document: nothing to intercept */ }

  /* =========================================================================
   * 2. THE CLOCK — one server-time offset for every window
   *
   * The server hands the buddy list `serverTime` (ms) inside signon-ok, on every
   * sign-on AND every reconnect. The buddy list calls setFromServer(); everything
   * else calls now().
   *
   * ⚠ HOW THE OFFSET REACHES THE OTHER WINDOWS: localStorage. The IM and room
   * windows never see signon-ok — the buddy list owns the only socket — and there
   * is no main.js channel for "here is a number", nor should there be one just for
   * this. Chromium gives every file:// page in the app the same localStorage, which
   * is why buddylist.html can already persist its collapsed groups there.
   * ⚠ IF THAT IS EVER NOT TRUE the offset simply stays 0 in the other windows and
   * they behave exactly as they did before this file existed. Degrading to today's
   * behaviour is the whole design of the fallback; nothing breaks.
   *
   * ⚠ WHY THE OFFSET IS PERSISTED WITH A TIMESTAMP: a saved offset from last week
   * is worse than none if the user has since fixed their clock. `at` is read as a
   * DURATION on the local clock, so if the clock jumps, the age goes nonsensical
   * and the value is discarded — which is exactly the case we must not trust.
   * ====================================================================== */

  var CLOCK_KEY  = 'hol.clock.offset';
  var MAX_AGE_MS = 24 * 60 * 60 * 1000;
  var offsetMs   = 0;                 // add this to Date.now()
  var haveServer = false;

  function loadOffset() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(CLOCK_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (!o || typeof o.offset !== 'number' || !isFinite(o.offset)) return;
      var age = Date.now() - Number(o.at || 0);
      if (age < -60000 || age > MAX_AGE_MS) return;      // stale, or the clock moved
      offsetMs = o.offset;
    } catch (e) { /* private mode, quota, corrupt JSON: stay at 0 */ }
  }

  /* ⚠ The offset carries one network hop of latency: `serverTime` was read before
   * the frame was written and we compare it against the moment it arrived. On a LAN
   * that is single-digit milliseconds and on the Tailscale funnel it is tens; both
   * are invisible at the one-minute resolution these stamps are displayed at. Do NOT
   * add a round-trip estimator — it would be more code than the bug is worth.
   *
   * Anything under a second is snapped to zero so a correct clock produces byte-for-
   * byte the same stamps it did before, and so two windows cannot disagree by 1ms. */
  function setFromServer(serverTime) {
    var t = Number(serverTime);
    if (!isFinite(t) || t <= 0) return offsetMs;
    var d = t - Date.now();
    offsetMs = (Math.abs(d) < 1000) ? 0 : d;
    haveServer = true;
    try {
      global.localStorage.setItem(CLOCK_KEY,
        JSON.stringify({ offset: offsetMs, at: Date.now() }));
    } catch (e) {}
    return offsetMs;
  }

  function now()    { return Date.now() + offsetMs; }
  function offset() { return offsetMs; }
  function corrected() { return haveServer || offsetMs !== 0; }

  /* Take a timestamp that is ALREADY on server time (anything off the wire) and
   * render it the way AIM did: (3:15 PM). Local timezone, because the wall clock a
   * person reads is their own — only the instant is corrected, never the zone. */
  function stamp(ts) {
    var d = new Date(ts == null ? now() : ts);
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
    return '(' + h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap + ')';
  }

  loadOffset();

  // Another HOL window signed on and learned a better offset. Pick it up live rather
  // than only at window open, or a window left open across a sign-on keeps a stale one.
  try {
    global.addEventListener('storage', function (e) {
      if (!e || e.key !== CLOCK_KEY) return;
      loadOffset();
    });
  } catch (e) {}

  /* =========================================================================
   * 3. THE MENU BAR  (added 0.1.5)
   *
   * ⚠ WHY THIS IS HERE AND NOT IN EACH WINDOW: three windows draw the same
   * File/Edit/Insert/People/Help strip. Three copies of a dropdown implementation
   * is three places for "File does nothing" to come back.
   *
   * ⚠ THE POINT OF THE FEATURE IS THE GREY, NOT THE DROPDOWN. Christian's note was
   * *"file, insert, edit and people dont work"* — he knows it is a young app; his
   * aunt will not. A live-looking menu that does nothing reads as BROKEN. A greyed
   * one reads as *not available*, which is both honest and exactly what a Win9x
   * program looked like. So a menu with nothing behind it is disabled, visibly, and
   * an item with nothing behind it is drawn greyed rather than left out.
   *
   * ⚠ `enabled` may be a FUNCTION and it is evaluated when the menu OPENS, not when
   * it is attached. Cut/Copy have to be grey when nothing is selected, or they are
   * the same lie one level down.
   * ====================================================================== */

  var MENU_CSS =
    '.menubar span.dis,.menubar span.dis:hover{color:var(--shadow);text-shadow:1px 1px 0 var(--hi);background:transparent;}' +
    '.menubar span.open{background:var(--title1);color:#fff;}' +
    '.holmenu{position:fixed;z-index:9000;min-width:128px;padding:2px;background:var(--face);' +
      'border:1px solid var(--dark);border-top-color:var(--hi);border-left-color:var(--hi);' +
      'box-shadow:1px 1px 0 rgba(0,0,0,.35);user-select:none;}' +
    '.holmenu .mi{display:flex;align-items:center;gap:14px;padding:2px 16px 2px 18px;' +
      'white-space:nowrap;cursor:default;}' +
    '.holmenu .mi .k{margin-left:auto;color:#404040;}' +
    '.holmenu .mi.dis{color:var(--shadow);text-shadow:1px 1px 0 var(--hi);}' +
    '.holmenu .mi.dis .k{color:var(--shadow);}' +
    '.holmenu .mi.hot:not(.dis){background:var(--title1);color:#fff;}' +
    '.holmenu .mi.hot:not(.dis) .k{color:#fff;}' +
    '.holmenu .sep{height:0;margin:3px 2px;border-top:1px solid var(--shadow);border-bottom:1px solid var(--hi);}' +
    /* Links inside a message. Underlined and blue, like every link of the era. */
    '.hol-link{color:var(--link);text-decoration:underline;cursor:pointer;}' +
    '.hol-link:focus{outline:1px dotted #000;}';

  (function injectCss() {
    try {
      var s = document.createElement('style');
      s.setAttribute('data-hol', 'shared');
      s.textContent = MENU_CSS;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  })();

  var openMenu = null;        // { title, panel, spec }

  function closeMenu() {
    if (!openMenu) return;
    try { openMenu.title.classList.remove('open'); } catch (e) {}
    try { openMenu.panel.parentNode.removeChild(openMenu.panel); } catch (e) {}
    openMenu = null;
  }

  function truthy(v) {
    if (typeof v === 'function') { try { return !!v(); } catch (e) { return false; } }
    return v !== false;                 // undefined means "enabled"
  }

  function hotItems(panel) {
    return [].slice.call(panel.querySelectorAll('.mi:not(.dis)'));
  }
  function moveHot(panel, delta) {
    var items = hotItems(panel);
    if (!items.length) return;
    var i = items.findIndex(function (n) { return n.classList.contains('hot'); });
    i = (i < 0) ? (delta > 0 ? 0 : items.length - 1) : (i + delta + items.length) % items.length;
    items.forEach(function (n) { n.classList.remove('hot'); });
    items[i].classList.add('hot');
  }

  function buildPanel(entry) {
    var panel = document.createElement('div');
    panel.className = 'holmenu';
    (entry.items || []).forEach(function (it) {
      if (!it || it.sep) {
        var sp = document.createElement('div'); sp.className = 'sep';
        panel.appendChild(sp); return;
      }
      var row = document.createElement('div');
      var on = truthy(it.enabled) && typeof it.action === 'function';
      row.className = 'mi' + (on ? '' : ' dis');
      var lbl = document.createElement('span');
      lbl.textContent = it.label || '';
      row.appendChild(lbl);
      if (it.accel) {
        var k = document.createElement('span');
        k.className = 'k'; k.textContent = it.accel;
        row.appendChild(k);
      }
      if (it.why && !on) row.title = it.why;
      if (on) {
        row.addEventListener('mouseenter', function () {
          hotItems(panel).forEach(function (n) { n.classList.remove('hot'); });
          row.classList.add('hot');
        });
        // mousedown, not click: the document-level closer runs on mousedown capture.
        row.addEventListener('mouseup', function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          closeMenu();
          try { it.action(); } catch (e) { console.error('HOL menu action threw', e); }
        });
      }
      panel.appendChild(row);
    });
    return panel;
  }

  function showMenu(titleEl, entry, byHover) {
    closeMenu();
    var panel = buildPanel(entry);
    document.body.appendChild(panel);
    var r = titleEl.getBoundingClientRect();
    var left = Math.max(2, Math.min(r.left, window.innerWidth - panel.offsetWidth - 4));
    var top = r.bottom;
    if (top + panel.offsetHeight > window.innerHeight - 2) {
      top = Math.max(2, window.innerHeight - panel.offsetHeight - 2);
    }
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    titleEl.classList.add('open');
    /* ⚠ `byHover` EXISTS BECAUSE OF A BUG MEASURED IN THE UI, NOT IN THEORY. With one
     * menu already open, sliding onto the next title opens it (correct Win9x
     * behaviour) — and then the mousedown that ends the same gesture saw "this menu is
     * already open" and TOGGLED IT SHUT. Clicking File then People made People flash
     * and vanish. A menu opened by hover must be adopted by the click, not closed by
     * it; only a click on a menu a CLICK opened is a toggle. */
    openMenu = { title: titleEl, panel: panel, spec: entry, byHover: !!byHover };
  }

  /* A right-click context menu, anchored at a point instead of a menu-bar title.
   * Reuses buildPanel() so a context menu is drawn with the exact same .mi/.dis/.sep
   * look as the menu bar — one panel implementation, not a second one for right-click.
   * Outside-click, Escape and arrow-key navigation are already generic against
   * `openMenu` (see attachMenu's document-level listeners below) and need no
   * additional wiring here — they work for this menu the same as any bar menu, as
   * long as SOME bar in this window has already called attachMenu() once. */
  function showAt(x, y, items) {
    closeMenu();
    var panel = buildPanel({ items: items });
    document.body.appendChild(panel);
    var left = Math.max(2, Math.min(x, window.innerWidth - panel.offsetWidth - 4));
    var top = Math.max(2, Math.min(y, window.innerHeight - panel.offsetHeight - 4));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    openMenu = { title: null, panel: panel, spec: { items: items }, byHover: false };
  }

  /* bar   — the .menubar element
   * spec  — [{ menu:'File', enabled:true|false|fn, items:[…] }, …]
   *         Any <span data-menu> with no spec entry, or enabled:false, or no live
   *         items at all, is drawn GREY and cannot be opened. */
  function attachMenu(bar, spec) {
    if (!bar) return;
    var byName = {};
    (spec || []).forEach(function (e) { if (e && e.menu) byName[e.menu] = e; });

    var titles = [].slice.call(bar.querySelectorAll('[data-menu]'));
    titles.forEach(function (t) {
      var entry = byName[t.dataset.menu];
      var live = !!(entry && truthy(entry.enabled) && (entry.items || []).some(function (i) {
        return i && !i.sep && typeof i.action === 'function';
      }));
      if (!live) {
        t.classList.add('dis');
        // ⚠ A tooltip, not a status-bar line. Nobody reads a status bar — that is the
        // whole reason this release greys things instead of explaining them.
        t.title = (entry && entry.why) || 'Not available in this version';
        return;
      }
      t.classList.remove('dis');
      t.title = '';
      t.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (openMenu && openMenu.title === t) {
          // Opened by the hover that preceded this very click? Adopt it, don't toggle.
          if (openMenu.byHover) { openMenu.byHover = false; return; }
          closeMenu(); return;
        }
        showMenu(t, entry, false);
      });
      // Once one menu is open, sliding across the bar switches menus — Win9x behaviour.
      t.addEventListener('mouseenter', function () {
        if (!openMenu || openMenu.title === t) return;
        showMenu(t, entry, true);
      });
      // Alt+<underlined letter>
      var u = t.querySelector('u');
      var key = u && u.textContent ? u.textContent.trim().toLowerCase() : '';
      if (key) {
        t.dataset.holKey = key;
        t.dataset.holLive = '1';
      }
    });

    if (!bar.dataset.holWired) {
      bar.dataset.holWired = '1';
      document.addEventListener('mousedown', function (e) {
        if (!openMenu) return;
        if (openMenu.panel.contains(e.target)) return;
        if (bar.contains(e.target)) return;
        closeMenu();
      }, true);
      window.addEventListener('blur', closeMenu);
      document.addEventListener('keydown', function (e) {
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.key && e.key.length === 1) {
          var want = e.key.toLowerCase();
          var hit = titles.filter(function (t) {
            return t.dataset.holLive === '1' && t.dataset.holKey === want;
          })[0];
          if (hit) { e.preventDefault(); showMenu(hit, byName[hit.dataset.menu]); return; }
        }
        if (!openMenu) return;
        if (e.key === 'Escape')    { e.preventDefault(); closeMenu(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); moveHot(openMenu.panel, 1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); moveHot(openMenu.panel, -1); return; }
        if (e.key === 'Enter') {
          var hot = openMenu.panel.querySelector('.mi.hot:not(.dis)');
          if (hot) { e.preventDefault(); hot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); }
        }
      });
    }
  }

  /* ---- Edit menu ---------------------------------------------------------
   * The same five entries in all three windows, built once.
   *
   * ⚠ CUT AND COPY ARE GREY WHEN NOTHING IS SELECTED. That is not decoration: a
   * live "Copy" that copies nothing is the same broken-looking chrome one level
   * down from the menu title, and Win9x greyed them for exactly this reason.
   *
   * ⚠ PASTE CANNOT USE document.execCommand('paste') — Chromium refuses it in page
   * script, and it fails SILENTLY by returning false. Reading the clipboard through
   * the async API and inserting the text ourselves is the only route that works in a
   * renderer; if that is refused too we say "use Ctrl+V" rather than doing nothing.
   * ---------------------------------------------------------------------- */
  function selText() {
    try { var s = global.getSelection(); return s ? String(s) : ''; } catch (e) { return ''; }
  }
  function selInside(el) {
    if (!el) return false;
    try {
      var s = global.getSelection();
      if (!s || !s.rangeCount || s.isCollapsed) return false;
      return el.contains(s.anchorNode) && el.contains(s.focusNode);
    } catch (e) { return false; }
  }

  function editMenuItems(opts) {
    opts = opts || {};
    var editableOf = typeof opts.editable === 'function' ? opts.editable : function () { return null; };
    var note = typeof opts.note === 'function' ? opts.note : function () {};

    function run(cmd, failMsg) {
      var ok = false;
      try { ok = document.execCommand(cmd); } catch (e) {}
      if (!ok) note(failMsg);
    }
    return [
      { label: 'Cut', accel: 'Ctrl+X',
        enabled: function () { return selInside(editableOf()); },
        action: function () { run('cut', 'Use Ctrl+X to cut.'); } },
      { label: 'Copy', accel: 'Ctrl+C',
        enabled: function () { return !!selText(); },
        action: function () { run('copy', 'Use Ctrl+C to copy.'); } },
      { label: 'Paste', accel: 'Ctrl+V',
        enabled: function () { return !!editableOf(); },
        action: function () {
          var el = editableOf();
          if (!el) return;
          try { el.focus(); } catch (e) {}
          var insert = function (t) {
            if (t == null || t === '') return;
            var done = false;
            try { done = document.execCommand('insertText', false, String(t)); } catch (e) {}
            if (!done) note('Use Ctrl+V to paste.');
            else if (typeof opts.afterPaste === 'function') { try { opts.afterPaste(); } catch (e) {} }
          };
          try {
            if (navigator.clipboard && navigator.clipboard.readText) {
              navigator.clipboard.readText().then(insert, function () { note('Use Ctrl+V to paste.'); });
              return;
            }
          } catch (e) {}
          note('Use Ctrl+V to paste.');
        } },
      { sep: true },
      { label: 'Select All', accel: 'Ctrl+A',
        enabled: true,
        action: function () {
          var el = editableOf();
          try {
            if (el) { el.focus(); document.execCommand('selectAll'); }
            else document.execCommand('selectAll');
          } catch (e) {}
        } }
    ];
  }

  /* =========================================================================
   * 4. TEXT SIZE  (v6, §6) — Small / Medium / Large, system-wide
   *
   * Christian's own priority call, asked BEFORE the visual chrome pass: "do we need
   * to have text larger for our elderly folks?" -> "system wide." Not a fixed bump —
   * Matthew keeps authentic tiny text if he wants it; Grandma sets hers once in
   * Settings and it applies everywhere, including windows opened later.
   *
   * ⚠ SHARED VIA localStorage, THE SAME WAY sounds.js SHARES MUTE/MODEM, NOT via
   * main.js's prefs.json. Every HOL window is a separate BrowserWindow loading this
   * file fresh from file://, and main.js never renders anything — there is nothing
   * for it to do with a font size. Chromium gives every file:// page in this app the
   * SAME localStorage (see the CLOCK section above for the same reasoning), so one
   * write here plus the `storage` event reaches every other open window live.
   *
   * ⚠ APPLIED IMMEDIATELY AT MODULE LOAD, synchronously — setting a custom property
   * on documentElement works before <body> exists. Waiting for DOMContentLoaded
   * would paint one frame at the wrong size on every window open, which is exactly
   * the kind of flash the server-address/version footers elsewhere in this app are
   * already careful to avoid.
   * ====================================================================== */

  var TEXTSIZE_KEY = 'hol.textsize';
  var TEXTSIZE_PX = { small: '10px', medium: '11px', large: '14px' };

  function textSize() {
    try {
      var v = global.localStorage && global.localStorage.getItem(TEXTSIZE_KEY);
      if (v && TEXTSIZE_PX[v]) return v;
    } catch (e) {}
    return 'medium';                     // 11px — every hardcoded value this replaced
  }

  function applyTextSize(size) {
    var px = TEXTSIZE_PX[size] || TEXTSIZE_PX.medium;
    try { document.documentElement.style.setProperty('--ui-font-size', px); } catch (e) {}
  }

  function setTextSize(size) {
    if (!TEXTSIZE_PX[size]) return;
    applyTextSize(size);
    try { global.localStorage.setItem(TEXTSIZE_KEY, size); } catch (e) {}
  }

  applyTextSize(textSize());

  // Another window changed it. Live, not just at next open — same pattern as the
  // clock offset and the same reason: a window left open across a Settings change
  // must not keep showing the old size until it happens to reload.
  try {
    global.addEventListener('storage', function (e) {
      if (!e || e.key !== TEXTSIZE_KEY) return;
      applyTextSize(textSize());
    });
  } catch (e) {}

  /* Wires a <select> (option values 'small'|'medium'|'large') to the shared setting:
   * reflects the current value on call, applies + persists on change. */
  function bindTextSizeSelect(selectEl) {
    if (!selectEl) return;
    selectEl.value = textSize();
    selectEl.addEventListener('change', function () { setTextSize(selectEl.value); });
  }

  /* ===================================================================== */

  global.HOLShared = {
    sanitizeToElement: sanitizeToElement,
    sanitizeHtml: sanitizeHtml,
    trimEdgeBreaks: trimEdgeBreaks,
    escapeText: escapeText,
    cleanLabel: cleanLabel,
    // 0.1.5 — links
    linkifyElement: linkifyElement,
    linkifyHtml: linkifyHtml,
    messageToElement: messageToElement,
    messageHtml: messageHtml,
    safeUrl: safeUrl,
    // 0.1.5 — menus
    attachMenu: attachMenu,
    closeMenu: closeMenu,
    editMenuItems: editMenuItems,
    // v6 — right-click context menu, same panel/closing machinery as the menu bar
    showContextMenu: showAt
  };

  global.HOLClock = {
    setFromServer: setFromServer,
    now: now,
    offset: offset,
    isCorrected: corrected,
    stamp: stamp
  };

  /* =========================================================================
   * 5. BUDDY ICONS  (v6 era-backlog #6)
   *
   * ⚠ NOT REAL AVATARS, DELIBERATELY. There is no upload path, no server storage,
   * and no accounts column for one — building that is a materially bigger lift
   * (an upload IPC, a static-file route in server.js, a moderation question for a
   * family app) than this item's ranking justified, and nothing asked for it beyond
   * "buddy icons" as a visual signature. What ships instead: a small, deterministic
   * identicon-style icon derived from the screen name alone — the same name always
   * produces the same icon, nothing is stored, nothing is fetched, and it works for
   * every account that has ever existed with zero setup.
   *
   * ⚠ BUILT VIA DOM createElementNS, NOT AN HTML/SVG STRING. Same rule as the
   * sanitiser above: a screen name is server-supplied text and the initial drawn
   * here comes straight from it — .textContent, never markup, so there is no
   * string-concatenation path for a stray character in a screen name to become a
   * tag. ====================================================================== */
  var ICON_HUES = [0, 30, 55, 90, 140, 175, 200, 230, 265, 300, 330];
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function hashString(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }
  function buddyIconColor(screenName) {
    var h = hashString(String(screenName || '').toLowerCase());
    return 'hsl(' + ICON_HUES[h % ICON_HUES.length] + ', 55%, 40%)';
  }
  function buddyIconInitial(screenName) {
    var s = String(screenName || '').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }
  function buildIdenticonSvg(screenName, size) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'hol-buddyicon');

    var rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '0.5'); rect.setAttribute('y', '0.5');
    rect.setAttribute('width', '15'); rect.setAttribute('height', '15');
    rect.setAttribute('rx', '2');
    rect.setAttribute('fill', buddyIconColor(screenName));
    rect.setAttribute('stroke', '#000'); rect.setAttribute('stroke-opacity', '0.35');
    svg.appendChild(rect);

    var text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '8'); text.setAttribute('y', '11.5');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-family', 'Tahoma, Verdana, sans-serif');
    text.setAttribute('font-size', '9'); text.setAttribute('font-weight', 'bold');
    text.setAttribute('fill', '#fff');
    text.textContent = buddyIconInitial(screenName);   // textContent, never markup
    svg.appendChild(text);

    return svg;
  }

  /* Returns a real Element, sized 16x16 by default — callers append it directly
   * (el.appendChild(HOLShared.buddyIconEl(name))), no innerHTML on either side.
   * v7 §6 — pass a THIRD arg (an absolute URL, already resolved via
   * resolveAvatarUrl() below) to render an uploaded picture instead of the
   * generated identicon. Falls back to the identicon in place if the image
   * fails to load — a broken <img> reads as "this app is broken", not as
   * "no picture set", so it must never be left showing. */
  function buddyIconEl(screenName, size, avatarUrl) {
    size = size || 16;
    if (avatarUrl) {
      var img = document.createElement('img');
      img.src = avatarUrl;
      img.width = size; img.height = size;
      img.alt = '';
      img.className = 'hol-buddyicon hol-buddyicon-img';
      img.style.borderRadius = '2px';
      img.style.objectFit = 'cover';
      img.style.border = '1px solid rgba(0,0,0,.35)';
      img.style.display = 'block';
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(buildIdenticonSvg(screenName, size), img);
      }, { once: true });
      return img;
    }
    return buildIdenticonSvg(screenName, size);
  }

  /* v7 §6 — avatarPath from the server is deliberately server-RELATIVE (e.g.
   * "/avatars/7-1723400000000.png"); the server does not know its own externally
   * reachable hostname (LAN IP vs. tailnet name vs. a funnel domain all vary by
   * deployment — see kj7dts-server notes), so the CLIENT resolves it against the
   * serverUrl it already connected with. ws:// -> http://, wss:// -> https://. */
  function resolveAvatarUrl(serverUrl, avatarPath) {
    if (!avatarPath) return null;
    var origin = String(serverUrl || '').replace(/^ws/, 'http').replace(/\/+$/, '');
    if (!origin) return null;
    return origin + avatarPath;
  }

  global.HOLShared.buddyIconEl = buddyIconEl;
  global.HOLShared.resolveAvatarUrl = resolveAvatarUrl;

  global.HOLTextSize = {
    get: textSize,
    set: setTextSize,
    bindSelect: bindTextSizeSelect
  };

})(window);
