// ============================================================================
// Ham Study - "Ask the tutor" chat panel (client side).
//
// Wire contract: Ham Study tutor WIRE CONTRACT v1 (CONTRACT.md). Every path,
// field name, error code and notice code used below is pinned there. Do not
// add new ones without a v2 agreed with the server side.
//
// Rules this file keeps (DESIGN section 13, CONTRACT section 9):
//  - ES5 style (var/function), no build step, PURE ASCII source.
//  - Exactly ONE global: window.HamTutor. Every hook in index.html is guarded
//    with "if(window.HamTutor)", so the page works unchanged if this file
//    fails to load or throws.
//  - Talks only to the tutor API: POST + "Authorization: Bearer <Firebase ID
//    token>" (never a token in a URL). A token is fetched per call with
//    getIdToken(false), with exactly one getIdToken(true) retry on a 401.
//  - Chat text is never written to RTDB, localStorage or any other storage.
//    The ONLY RTDB write this file causes is the page's own recordAnswer()
//    for a graded practice answer, at most once per quiz_id.
//  - Everything that comes from the server is rendered with textContent /
//    createElement, never innerHTML.
//  - Nothing here blocks or changes the page's own study flow.
//
// Load order: index.html loads this file just BEFORE its main inline script,
// so window.HamTutor already exists when the page's load hook runs (no race
// with onAuthStateChanged). Page globals (PROGRESS, SESSION, CURRENT_VIEW,
// SETUP_CLASS, computeMastery, recordAnswer, renderPicker) are therefore read
// lazily, at call time, never at load time.
// ============================================================================
(function () {
  'use strict';
  if (window.HamTutor) return;

  // ---- constants (contract section 0 / 1 / 8) ------------------------------
  var CFG = {
    prodBase: 'https://kj7dts-server.tail34c6a5.ts.net/hamtutor',
    chatTimeoutMs: 60000,        // CONTRACT 9.5
    otherTimeoutMs: 15000,       // session / sync / reset
    syncDebounceMs: 3000,        // CONTRACT 9.3
    sessionRefreshMs: 1800000,   // re-run /session on open after 30 min
    busyRetryMs: 2000,           // 409 busy: retry once after 2 s
    maxAutoRetryMs: 5000,        // 503 busy/auth_retry: client cap
    maxInput: 1000,              // cfg max_input_chars default
    quotaShowAt: 10              // show "N messages left today" at <= 10
  };
  var V = 1;
  var RE_QID = /^[TGE][0-9][A-Z][0-9]{2}$/;
  var RE_QUIZ_ID = /^q_[a-z2-7]{10}$/;
  var RE_LETTER = /^[ABCD]$/;
  var RE_FIGURE = /^[a-z0-9-]+\.png$/;
  var LETTERS = 'ABCD';
  var CLS_KEYS = ['technician', 'general', 'extra'];
  var PREFIX_CLS = {T: 'technician', G: 'general', E: 'extra'};
  var VIEWS = ['picker', 'setup', 'quiz', 'summary', 'about'];
  var STALE_MS = 1209600000;     // 14 days (page STALE_MS)
  var HOUR_WINDOW_MS = 1296000000; // 15 days of hour buckets
  var HOUR_MS = 3600000;
  var DAY_MS = 86400000;
  // The quiz chip is the LLM-free "Quiz me" (/chat kind "quiz", CONTRACT A3): instant, free, and available
  // when chat is off. Its text is also what the server stores as the student's line (QUIZ_ME_TEXT).
  var QUIZ_ME = 'Quiz me on my weakest topic';
  var QUICK = ['What should I focus on?', QUIZ_ME, "Explain Ohm's law"];

  var COPY = {
    hint: 'Ask me anything about ham radio, or tap a suggestion below.',
    hintQuiz: 'Tap "' + QUIZ_ME + '" below for a practice question picked for you.',
    note: 'AI study helper. It can make mistakes. Never share your full name, school or address.',
    offline: "Can't reach the tutor right now. Check your internet connection, then tap Try again.",
    signedOut: 'You seem to be signed out. Reload this page and sign in again to use the tutor.',
    auth: 'Your sign-in needs a refresh. Reload this page, then try again.',
    forbidden: "The tutor isn't available for this account. You can keep studying on the page.",
    chatDisabled: "The tutor chat isn't turned on for your account yet. You can still get practice questions here: tap \"" + QUIZ_ME + "\".",
    tutorOff: 'The tutor is taking a break right now. Practice questions on the page still work!',
    quotaDay: "We've chatted a lot today! The tutor will be back tomorrow. You can keep practicing questions on the page.",
    quotaHour: "Let's take a short break - the tutor can chat again in a little while.",
    quotaGlobal: "The tutor has had a busy day. It'll be back tomorrow. You can keep practicing questions on the page.",
    busy: 'The tutor is busy - wait a moment, then tap Try again.',
    stillWorking: 'Still working on your last message. Wait a moment, then tap Try again.',
    tooLong: 'That message is too long. Please keep it under 1000 characters and send it again.',
    empty: 'Type a question first, then press Send.',
    badRequest: 'Something went wrong with that message. Try asking it a different way.',
    tooLarge: 'That was too much to send at once. Try a shorter message.',
    internal: "Something went wrong on the tutor's side. Wait a moment, then tap Try again.",
    quizExpired: 'That practice question has closed. Ask for a new one!',
    quiet: 'I got a bit tangled up. Could you ask that again?',
    // CONTRACT A13: the monthly budget (Christian: "$10/mo max") rests LLM chat; the free paths keep working.
    restingDay: 'Tutor chat is resting until tomorrow. Quizzes and explanations still work: tap Quiz me any time!',
    restingMonth: 'Tutor chat is resting until the 1st. Quizzes and explanations still work: tap Quiz me any time!',
    badCard: "A practice question couldn't be shown. Ask for another one!",
    noExpl: 'Explanation coming soon.'
  };
  var NOTICE_FALLBACK = {
    quiz_expired: COPY.quizExpired, tutor_off: COPY.tutorOff, chat_disabled: COPY.chatDisabled,
    quota_hour: COPY.quotaHour, quota_day: COPY.quotaDay, quota_global: COPY.quotaGlobal,
    tutor_quiet: COPY.quiet, resting: COPY.restingMonth
  };

  // ---- state ---------------------------------------------------------------
  var S = {
    user: null,              // firebase user from our own onAuthStateChanged
    progress: 'unknown',     // 'unknown' | 'ok' | 'failed'  (page progress load)
    open: false,
    busy: false,
    composerOn: true,
    unavailable: false,      // 403 forbidden / origin: tutor not for this account
    llm: null,               // 'on' | 'off' | 'disabled' (last seen from server)
    resting: null,           // null | 'day' | 'month': the budget rests LLM chat (CONTRACT A13)
    sessionOkAt: 0,
    sessionPromise: null,
    openQuizId: null,
    cards: {},               // quiz_id -> {id, el, buttons, choices, state}
    recorded: {},            // quiz_id -> true once recordAnswer() was called
    answeredSince: false,    // a chat answer was recorded since the panel opened
    opener: null,
    retryNote: null,
    lastSyncSig: null, syncTimer: null, syncInFlight: false, syncAgain: false
  };
  var D = {panel: null, log: null, input: null, send: null, chips: [], reset: null, close: null,
           title: null, quota: null, count: null, typing: null, hint: null, fab: null, entries: [],
           entryTexts: []};
  // Entry-card copy: [chat on, chat off (practice questions only)].
  var ENTRY_COPY = [
    ['Chat with the AI study helper: what to focus on, practice questions, and explanations in plain words.',
     'Practice questions picked for what you need most, with the official explanations.'],
    ['Not sure which session to pick? The AI study helper can suggest a topic and quiz you.',
     'Not sure which session to pick? Get a practice question picked for what you need most.']
  ];

  // ---- small helpers -------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function pg(name) { try { return window[name]; } catch (e) { return undefined; } }
  function isArr(a) { return Object.prototype.toString.call(a) === '[object Array]'; }
  function isObj(o) { return !!o && typeof o === 'object' && !isArr(o); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function show(n, on) { if (n) n.style.display = on ? '' : 'none'; }

  function apiBase() {
    // Production always uses the pinned base. A loopback-only override exists
    // for the local stub test, and is honoured ONLY when the page itself is
    // served from localhost/127.0.0.1 AND the override is also loopback, so a
    // crafted link can never redirect a real ID token anywhere.
    var h = '';
    try { h = window.location.hostname; } catch (e) { h = ''; }
    var t = window.HAMTUTOR_TEST_BASE;
    if ((h === 'localhost' || h === '127.0.0.1') && typeof t === 'string' &&
        /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(\/[A-Za-z0-9_\/-]*)?$/.test(t)) {
      return t.replace(/\/+$/, '');
    }
    return CFG.prodBase;
  }

  function newTurnId() {
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var out = '', i, buf = null;
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        buf = new Uint8Array(16);
        window.crypto.getRandomValues(buf);
      }
    } catch (e) { buf = null; }
    for (i = 0; i < 16; i++) {
      var r = buf ? buf[i] : Math.floor(Math.random() * 256);
      out += abc.charAt(r % abc.length);
    }
    return out;
  }

  function cleanText(t) {
    // Same normalisation the server applies first (CONTRACT 5.4): drop control
    // characters except newline and tab, then trim.
    return String(t || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/^\s+|\s+$/g, '');
  }

  // ---- progress summary (CONTRACT 6.1, build rules 1-5) --------------------
  // One pass over the page's already-loaded PROGRESS. No pool fetch, no RTDB
  // read, no timezone code: the server derives every number from this.
  function byLsThenId(a, b) { return (a.ls - b.ls) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)); }
  function ids(list, cap) {
    list.sort(byLsThenId);
    var out = [];
    for (var i = 0; i < list.length && i < cap; i++) out.push(list[i].id);
    return out;
  }
  function activeClass() {
    var sess = pg('SESSION');
    var c = sess ? sess.cls : pg('SETUP_CLASS');
    return CLS_KEYS.indexOf(c) >= 0 ? c : null;
  }
  function buildSummary(at) {
    var P = pg('PROGRESS') || {};
    var CL = pg('CLASSES') || {};
    var per = {}, hours = {}, lsMax = null, count = 0;
    var lo = at - HOUR_WINDOW_MS, hi = at + DAY_MS;
    for (var qid in P) {
      if (!has(P, qid)) continue;
      if (!RE_QID.test(qid)) continue;                                  // rule 1
      var e = P[qid];
      if (!e || typeof e.correct !== 'boolean') continue;               // rule 1
      var cls = PREFIX_CLS[qid.charAt(0)];                              // rule 2
      var num = typeof e.lastSeen === 'number' && isFinite(e.lastSeen);
      var ls = num ? e.lastSeen : 0;                                    // rule 3
      count++;
      var c = per[cls] || (per[cls] = {missed: [], stale: [], recent: []});
      var rec = {id: qid, ls: ls};
      if (e.correct === false) c.missed.push(rec);
      else if (at - ls >= STALE_MS) c.stale.push(rec);
      else c.recent.push(rec);
      if (num && ls > 0) {
        // rule 4 (15-day window). The extra "+1 day" ceiling only drops
        // impossible future stamps, so hour_counts can never pass the
        // server's 400-key cap (15 x 24 + 24 = 384) and reject the summary.
        if (ls >= lo && ls <= hi) {
          var hk = String(Math.floor(ls / HOUR_MS));
          hours[hk] = (hours[hk] || 0) + 1;
        }
        if (lsMax === null || ls > lsMax) lsMax = ls;
      }
    }
    var classes = {};
    for (var i = 0; i < CLS_KEYS.length; i++) {
      var k = CLS_KEYS[i];
      if (!per[k]) continue;
      var m = (typeof pg('computeMastery') === 'function') ? window.computeMastery(k) : null; // rule 5
      var cap = (CL[k] && CL[k].size) || 5000;
      classes[k] = {
        attempted: m ? m.attempted : 0,
        mastered: m ? m.mastered : 0,
        missed_ids: ids(per[k].missed, cap),
        stale_ids: ids(per[k].stale, cap),
        recent_ids: ids(per[k].recent, cap)
      };
    }
    var lsm = lsMax === null ? null : Math.floor(lsMax);
    return {
      summary: {v: V, at: Math.floor(at), active_class: activeClass(), classes: classes,
                hour_counts: hours, last_seen_max: lsm},
      sig: count + ':' + lsm
    };
  }
  // The summary only goes on the wire once the page's own progress read
  // succeeded. After a FAILED read, PROGRESS holds only this tab's new answers,
  // and sending that would overwrite the server's (Radio's) view with a subset.
  function wireSummary() {
    if (S.progress !== 'ok') return null;
    try { return buildSummary(Date.now()).summary; } catch (e) { return null; }
  }

  // ---- page context (CONTRACT 6.2) -----------------------------------------
  function buildContext() {
    var view = pg('CURRENT_VIEW');
    if (VIEWS.indexOf(view) < 0) view = null;
    var sess = pg('SESSION');
    var qid = null;
    if (view === 'quiz' && sess && sess.questions && sess.questions[sess.idx]) {
      qid = sess.questions[sess.idx].id;
      if (!RE_QID.test(String(qid))) qid = null;
    }
    return {view: view, cls: activeClass(), qid: qid, qid_answered: !!(sess && sess.answered)};
  }

  // ---- HTTP ----------------------------------------------------------------
  // Result shape (internal): {status, data, offline, signedOut}
  function token(force) {
    return new Promise(function (resolve) {
      var u = null;
      try { u = window.firebase.auth().currentUser; } catch (e) { u = null; }
      if (!u || typeof u.getIdToken !== 'function') { resolve({t: null, why: 'nouser'}); return; }
      var p;
      try { p = u.getIdToken(!!force); } catch (e) { resolve({t: null, why: 'fail'}); return; }
      Promise.resolve(p).then(function (t) {
        resolve(typeof t === 'string' && t ? {t: t} : {t: null, why: 'fail'});
      }, function () { resolve({t: null, why: 'fail'}); });
    });
  }

  function post(path, body, tok, timeoutMs, keepalive) {
    return new Promise(function (resolve) {
      var done = false, ctl = null, timer = null;
      function finish(r) { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); }
      try { if (typeof window.AbortController === 'function') ctl = new window.AbortController(); } catch (e) { ctl = null; }
      timer = setTimeout(function () {
        try { if (ctl) ctl.abort(); } catch (e) {}
        finish({status: 0, data: null, offline: true, timeout: true});
      }, timeoutMs);
      var init = {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers: {'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      };
      if (ctl) init.signal = ctl.signal;
      if (keepalive) init.keepalive = true;
      var f;
      try { f = window.fetch(apiBase() + path, init); } catch (e) { finish({status: 0, data: null, offline: true}); return; }
      Promise.resolve(f).then(function (r) {
        return r.text().then(function (txt) {
          var data = null;
          try { data = JSON.parse(txt); } catch (e) { data = null; }
          // Non-JSON, or JSON that is not ours (e.g. the path falling through
          // to another service before the Funnel mount exists): offline.
          if (!isObj(data) || data.v !== V) { finish({status: r.status, data: null, offline: true}); return; }
          finish({status: r.status, data: data, offline: false});
        });
      }).then(null, function () { finish({status: 0, data: null, offline: true}); });
    });
  }

  // One call with the house token pattern: getIdToken(false), and on a 401
  // exactly one retry of the identical request with getIdToken(true).
  function call(path, body, timeoutMs, keepalive) {
    return token(false).then(function (a) {
      if (!a.t) return a.why === 'nouser' ? {status: 0, data: null, signedOut: true} : {status: 0, data: null, offline: true};
      return post(path, body, a.t, timeoutMs, keepalive).then(function (res) {
        if (res.status !== 401) return res;
        return token(true).then(function (b) {
          if (!b.t) return res;
          return post(path, body, b.t, timeoutMs, keepalive);
        });
      });
    });
  }

  // Automatic retries the contract asks for (once each per user action):
  // 409 busy after 2 s; 503 busy / auth_retry after Retry-After (<= 5 s).
  function autoRetryDelay(res) {
    var code = res.data && res.data.error;
    if (res.status === 409 && code === 'busy') return CFG.busyRetryMs;
    if (res.status === 503 && (code === 'busy' || code === 'auth_retry')) {
      var s = res.data.retry_after_s;
      var ms = (typeof s === 'number' && s > 0) ? s * 1000 : CFG.busyRetryMs;
      return Math.max(250, Math.min(CFG.maxAutoRetryMs, ms));
    }
    return null;
  }
  function callWithRetries(path, bodyFn, timeoutMs) {
    var used = false;
    function attempt() {
      return call(path, bodyFn(), timeoutMs).then(function (res) {
        var d = used ? null : autoRetryDelay(res);
        if (d === null) return res;
        used = true;
        return wait(d).then(attempt);
      });
    }
    return attempt();
  }

  // ---- error mapping (CONTRACT 7, DESIGN 11) -------------------------------
  function errorInfo(res) {
    if (res.signedOut) return {kind: 'signed_out', text: COPY.signedOut, retry: false};
    if (res.offline || !res.data) return {kind: 'offline', text: COPY.offline, retry: true};
    var d = res.data, st = res.status, code = d.error, scope = d.scope;
    if (st === 401) return {kind: 'auth', text: COPY.auth, retry: false};
    if (st === 403 && code === 'chat_disabled') return {kind: 'chat_disabled', text: COPY.chatDisabled, retry: false};
    if (st === 403) return {kind: 'forbidden', text: COPY.forbidden, retry: false};
    if (st === 404 || st === 405) return {kind: 'offline', text: COPY.offline, retry: true};
    if (st === 409) return {kind: 'busy', text: COPY.stillWorking, retry: true};
    if (st === 413) return {kind: 'too_large', text: COPY.tooLarge, retry: false};
    if (st === 429 && code === 'resting') {
      return scope === 'day' ? {kind: 'resting', scope: 'day', text: COPY.restingDay, retry: false}
                             : {kind: 'resting', scope: 'month', text: COPY.restingMonth, retry: false};
    }
    if (st === 429) {
      if (scope === 'day') return {kind: 'quota_day', text: COPY.quotaDay, retry: false};
      if (scope === 'global') return {kind: 'quota_global', text: COPY.quotaGlobal, retry: false};
      var s = d.retry_after_s;
      if (typeof s === 'number' && s > 0) {
        var n = Math.max(1, Math.ceil(s / 60));
        return {kind: 'quota_hour', retry: false,
                text: "Let's take a short break - the tutor can chat again in about " + n + (n === 1 ? ' minute.' : ' minutes.')};
      }
      return {kind: 'quota_hour', text: COPY.quotaHour, retry: false};
    }
    if (st === 503 && code === 'tutor_off') return {kind: 'tutor_off', text: COPY.tutorOff, retry: false};
    if (st === 503) return {kind: 'busy', text: COPY.busy, retry: true};
    if (st === 400) {
      if (d.detail === 'text_too_long') return {kind: 'bad_request', text: COPY.tooLong, retry: false};
      if (d.detail === 'text_empty') return {kind: 'bad_request', text: COPY.empty, retry: false};
      return {kind: 'bad_request', text: COPY.badRequest, retry: false};
    }
    return {kind: 'internal', text: COPY.internal, retry: true};
  }
  function applyErrorEffects(info) {
    if (info.kind === 'forbidden') {
      markUnavailable();
    } else if (info.kind === 'chat_disabled') {
      S.llm = 'disabled';
      setComposer(false, "Chat isn't turned on for your account yet");
    } else if (info.kind === 'tutor_off') {
      S.llm = 'off';
    } else if (info.kind === 'quota_day') {
      setQuotaText('No messages left today');
    } else if (info.kind === 'resting') {
      setResting(info.scope, false);
    }
  }

  // ---- progress sync (CONTRACT 5.2, 9.3): fire-and-forget, budget-free ------
  function syncSoon(reason) {
    try {
      if (reason === 'load') S.progress = 'ok';
      else if (reason === 'load_failed') { S.progress = 'failed'; return; }
      if (S.progress !== 'ok') return;
      if (S.syncTimer) clearTimeout(S.syncTimer);
      S.syncTimer = setTimeout(function () { S.syncTimer = null; doSync(false); }, CFG.syncDebounceMs);
    } catch (e) { /* never let a sync break the page */ }
  }
  function doSync(keepalive) {
    if (S.progress !== 'ok' || !S.user || S.unavailable) return;
    if (S.syncInFlight) { S.syncAgain = true; return; }
    var built;
    try { built = buildSummary(Date.now()); } catch (e) { return; }
    if (built.sig === S.lastSyncSig) return;
    S.syncInFlight = true;
    call('/api/v1/sync', {v: V, summary: built.summary}, CFG.otherTimeoutMs, keepalive).then(function (res) {
      S.syncInFlight = false;
      if (res.status === 200 && res.data && res.data.ok === true) {
        S.lastSyncSig = built.sig;
        // CONTRACT A2: the sync answer says whether chat is on, so chat-only buttons can hide before the
        // panel is ever opened (a chat-off account).
        var lv = res.data.llm;
        if (lv === 'on' || lv === 'off' || lv === 'disabled') { try { setLlm(lv, false); } catch (e) { /* never break the page */ } }
        // CONTRACT A13: and whether the budget rests chat (hides "Ask the tutor about this one" meanwhile).
        if (has(res.data, 'resting')) { try { setResting(res.data.resting, false); } catch (e) { /* never break the page */ } }
      } else if (res.status === 403 && errorInfo(res).kind === 'forbidden') {
        // Not on the tutor allowlist: say nothing (sync errors are never
        // shown), just hide the tutor's buttons for this page load.
        markUnavailable();
        return;
      } else if (keepalive && res.offline && !res.timeout) {
        // Some browsers refuse a keepalive request that needs a CORS preflight.
        // The tab is usually still alive after a hide, so try once as a plain
        // request (sync is idempotent on the server: max-merge, stale guard).
        S.syncAgain = false;
        doSync(false);
        return;
      }
      if (S.syncAgain) { S.syncAgain = false; syncSoon('again'); }
    });
  }
  function flushSync() {
    // Tab hidden (app switch, lock screen, close): send a pending sync now so
    // the day's study still reaches the server for Radio and the greeting.
    if (!S.syncTimer) return;
    clearTimeout(S.syncTimer);
    S.syncTimer = null;
    doSync(true);
  }

  // ---- panel DOM -----------------------------------------------------------
  function buildPanel() {
    if (D.panel) return;
    var p = el('div');
    p.id = 'tutorPanel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-modal', 'true');
    p.setAttribute('aria-labelledby', 'tutorTitle');
    p.setAttribute('aria-describedby', 'tutorNote');

    var head = el('div'); head.id = 'tutorHead';
    var title = el('h2', null, 'Ask the tutor'); title.id = 'tutorTitle'; title.tabIndex = -1;
    var reset = el('button', 'tbtn', 'New chat'); reset.type = 'button';
    reset.setAttribute('aria-label', 'Start a new chat');
    var close = el('button', 'tbtn', 'Close'); close.type = 'button';
    close.setAttribute('aria-label', 'Close the tutor');
    head.appendChild(title); head.appendChild(reset); head.appendChild(close);

    var note = el('div', null, COPY.note); note.id = 'tutorNote';

    var log = el('div'); log.id = 'tutorLog';
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-relevant', 'additions');
    log.setAttribute('aria-label', 'Conversation with the tutor');
    log.tabIndex = 0;

    var foot = el('div'); foot.id = 'tutorFoot';
    var chips = el('div'); chips.id = 'tutorChips';
    chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Suggestions');
    D.chips = [];
    for (var i = 0; i < QUICK.length; i++) {
      var c = el('button', 'tchip', QUICK[i]); c.type = 'button';
      c.addEventListener('click', chipHandler(QUICK[i]));
      chips.appendChild(c); D.chips.push(c);
    }
    var form = el('form'); form.id = 'tutorForm';
    form.setAttribute('novalidate', '');
    var lab = el('label', 'sr-only', 'Message the tutor'); lab.htmlFor = 'tutorInput';
    var ta = el('textarea'); ta.id = 'tutorInput'; ta.rows = 1; ta.maxLength = CFG.maxInput;
    ta.placeholder = 'Ask about ham radio...';
    ta.setAttribute('enterkeyhint', 'send'); ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('aria-describedby', 'tutorCount');
    var send = el('button', 'cta', 'Send'); send.type = 'submit'; send.id = 'tutorSend';
    form.appendChild(lab); form.appendChild(ta); form.appendChild(send);
    var meta = el('div'); meta.id = 'tutorMeta';
    var quota = el('span'); quota.id = 'tutorQuota'; quota.setAttribute('aria-live', 'polite');
    var count = el('span'); count.id = 'tutorCount';
    meta.appendChild(quota); meta.appendChild(count);
    foot.appendChild(chips); foot.appendChild(form); foot.appendChild(meta);

    p.appendChild(head); p.appendChild(note); p.appendChild(log); p.appendChild(foot);
    document.body.appendChild(p);

    D.panel = p; D.log = log; D.input = ta; D.send = send; D.reset = reset; D.close = close;
    D.title = title; D.quota = quota; D.count = count;

    close.addEventListener('click', function () { closePanel(); });
    reset.addEventListener('click', function () { resetChat(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); sendFromInput(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        sendFromInput();
      }
    });
    ta.addEventListener('input', function () { autosize(); updateCount(); });
    document.addEventListener('keydown', docKeydown);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', fitViewport);
      window.visualViewport.addEventListener('scroll', fitViewport);
    }
    window.addEventListener('resize', fitViewport);
    refreshControls();
  }

  function chipHandler(text) {
    return function () {
      if (text === QUIZ_ME) { sendQuizMe(); return; }
      if (S.busy || !S.composerOn || S.unavailable) return;
      sendText(text, null);
    };
  }

  // One document-level handler while the dialog is open, so Esc and the Tab
  // trap work wherever focus happens to be (inside the panel, or on <body>
  // after a click on the page beside the desktop drawer).
  function docKeydown(e) {
    if (!S.open || e.isComposing) return;
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); closePanel(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (!a || !D.panel.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && (a === first || a === D.panel || a === D.title)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }
  function focusables() {
    var list = D.panel.querySelectorAll('button, textarea, a[href], [tabindex="0"]');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.disabled) continue;
      if (n.closest && n.closest('[hidden]')) continue;
      if (n.style && n.style.display === 'none') continue;
      out.push(n);
    }
    return out;
  }

  function autosize() {
    var ta = D.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, Math.max(44, ta.scrollHeight || 0)) + 'px';
  }
  function updateCount() {
    var left = CFG.maxInput - D.input.value.length;
    D.count.textContent = left <= 100 ? left + (left === 1 ? ' character left' : ' characters left') : '';
  }

  function fitViewport() {
    // Phones: keep the full-screen panel inside the VISUAL viewport, so the
    // input stays above the on-screen keyboard (iOS does not shrink fixed
    // elements for it). Desktop: plain CSS (right-side drawer).
    if (!D.panel) return;
    var vv = window.visualViewport;
    if (!S.open || !vv || window.innerWidth > 520) { D.panel.style.height = ''; D.panel.style.top = ''; return; }
    D.panel.style.top = Math.max(0, vv.offsetTop || 0) + 'px';
    D.panel.style.height = vv.height + 'px';
  }

  function setBusy(on) { S.busy = !!on; refreshControls(); refreshCards(); }
  function setComposer(on, placeholder) {
    S.composerOn = !!on;
    if (D.input) D.input.placeholder = on ? 'Ask about ham radio...' : (placeholder || 'Chat is not available');
    refreshControls();
  }
  function refreshControls() {
    if (!D.panel) return;
    var canSend = S.composerOn && !S.unavailable;
    D.input.disabled = !canSend;
    D.send.disabled = !canSend || S.busy;
    for (var i = 0; i < D.chips.length; i++) {
      var isQuiz = D.chips[i].textContent === QUIZ_ME;
      // The quiz chip needs no chat (no LLM), so it works when chat is off or the tutor is taking a break.
      D.chips[i].disabled = isQuiz ? (S.unavailable || S.busy) : (!canSend || S.busy);
      show(D.chips[i], isQuiz || (S.llm !== 'disabled' && !S.resting));
    }
    D.reset.disabled = S.busy || S.unavailable;
    rescueFocus();
  }
  // Browsers drop focus to <body> when the focused control becomes disabled
  // (a tapped chip or answer letter while a reply is pending, the composer
  // when chat turns out to be off) or is removed (a "Try again" button). Put
  // it back inside the open dialog so Esc, Tab and screen readers keep working.
  function rescueFocus() {
    if (!S.open || !D.panel) return;
    var a = null;
    try { a = document.activeElement; } catch (e) { a = null; }
    var lost = !a || a === document.body || a === document.documentElement || !document.body.contains(a);
    if (!lost && !(D.panel.contains(a) && a.disabled)) return;
    var t = (!coarsePointer() && D.input && !D.input.disabled) ? D.input : D.title;
    try { t.focus(); } catch (e) {}
  }

  // ---- log rendering -------------------------------------------------------
  function append(node) {
    if (D.typing && D.typing.parentNode === D.log) D.log.insertBefore(node, D.typing);
    else D.log.appendChild(node);
    return node;
  }
  function nearEnd() { return D.log.scrollHeight - D.log.scrollTop - D.log.clientHeight < 80; }
  function scrollToEnd() { if (D.log) D.log.scrollTop = D.log.scrollHeight; }
  function clearLog() {
    while (D.log.firstChild) D.log.removeChild(D.log.firstChild);
    D.typing = null; D.hint = null; S.retryNote = null; S.cards = {}; S.openQuizId = null;
  }
  function addHint() {
    if (D.hint) return;
    D.hint = append(el('div', 'thint', (S.llm === 'disabled' || S.resting) ? COPY.hintQuiz : COPY.hint));
  }
  function removeHint() { if (D.hint && D.hint.parentNode) D.hint.parentNode.removeChild(D.hint); D.hint = null; }

  function addStudent(text) {
    removeHint();
    var b = el('div', 'tmsg student');
    b.appendChild(el('span', 'sr-only', 'You: '));
    b.appendChild(document.createTextNode(String(text)));
    append(b);
    scrollToEnd();
    return b;
  }
  function addTutorText(text, extra) {
    removeHint();
    var b = el('div', 'tmsg tutor' + (extra ? ' ' + extra : ''));
    b.appendChild(el('span', 'sr-only', 'Tutor: '));
    b.appendChild(document.createTextNode(String(text)));
    return append(b);
  }
  function addNote(text, cls) {
    removeHint();
    return append(el('div', 'tnote' + (cls ? ' ' + cls : ''), text));
  }
  function addErrorNote(text, retryFn) {
    clearRetryNote();
    var n = addNote(text, 'err');
    n.setAttribute('role', 'alert');
    if (retryFn) {
      var b = el('button', 'tbtn', 'Try again'); b.type = 'button';
      b.addEventListener('click', function () {
        if (S.busy) return;
        if (n.parentNode) n.parentNode.removeChild(n);
        S.retryNote = null;
        retryFn();
      });
      n.appendChild(b);
      S.retryNote = n;
    }
    scrollToEnd();
    return n;
  }
  function clearRetryNote() {
    // A new action supersedes an older failed one: keep its text, drop its button.
    var n = S.retryNote;
    S.retryNote = null;
    if (!n) return;
    var b = n.querySelector('button');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }
  function showTyping() {
    if (!D.panel || D.typing) return;
    var b = el('div', 'tmsg tutor ttypingwrap');
    b.appendChild(el('span', 'sr-only', 'The tutor is typing'));
    var dots = el('span', 'ttyping');
    dots.setAttribute('aria-hidden', 'true');
    dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
    b.appendChild(dots);
    D.log.appendChild(b);
    D.typing = b;
    scrollToEnd();
  }
  function hideTyping() {
    if (D.typing && D.typing.parentNode) D.typing.parentNode.removeChild(D.typing);
    D.typing = null;
  }

  function addNotice(it) {
    if (!isObj(it)) return;
    var code = it.code;
    if (code === 'quota_low') return;           // shown in the footer from Quota
    var text = (typeof it.text === 'string' && it.text) ? it.text : (NOTICE_FALLBACK[code] || '');
    if (!text) return;
    if (code === 'tutor_off') S.llm = 'off';
    if (code === 'chat_disabled') { S.llm = 'disabled'; setComposer(false, "Chat isn't turned on for your account yet"); }
    if (code === 'quota_day') setQuotaText('No messages left today');
    if (code === 'resting') {
      if (S.resting) return;                    // already resting: the note was shown once
      S.resting = 'month';                      // the reply's own "resting" field corrects the scope next
    }
    addNote(text);
  }

  // ---- practice-question cards (QuizItem / GradedItem) ----------------------
  function validQuiz(q) {
    if (!isObj(q) || !RE_QUIZ_ID.test(String(q.quiz_id)) || !RE_QID.test(String(q.qid))) return false;
    if (typeof q.question !== 'string' || !isArr(q.choices) || q.choices.length !== 4) return false;
    for (var i = 0; i < 4; i++) if (typeof q.choices[i] !== 'string') return false;
    return true;
  }
  function addQuizCard(q) {
    if (!validQuiz(q)) { addNote(COPY.badCard); return null; }
    if (S.cards[q.quiz_id]) return S.cards[q.quiz_id];
    removeHint();
    var card = el('div', 'tcard');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Practice question ' + q.qid);
    var sub = typeof q.subelement === 'string' ? q.subelement : q.qid.slice(0, 2);
    var subName = typeof q.sub_name === 'string' ? q.sub_name : '';
    card.appendChild(el('div', 'qsub', sub + (subName ? ' - ' + subName : '') + ' - ' + q.qid));
    card.appendChild(el('div', 'qtext', q.question));
    if (typeof q.figure === 'string' && RE_FIGURE.test(q.figure)) {
      var img = el('img', 'qfig');
      img.alt = 'Figure ' + q.figure.replace(/\.png$/, '') + ' (referenced in this question)';
      img.addEventListener('load', function () { if (nearEnd()) scrollToEnd(); });
      img.src = 'data/figures/' + q.figure;
      card.appendChild(img);
    }
    var wrap = el('div', 'choices');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Answer choices');
    var rec = {id: q.quiz_id, qid: q.qid, el: card, buttons: [], choices: q.choices.slice(0, 4), state: 'open'};
    for (var i = 0; i < 4; i++) {
      var btn = el('button', 'choice'); btn.type = 'button';
      btn.appendChild(el('span', 'clet', LETTERS.charAt(i)));
      btn.appendChild(el('span', 'ctext', q.choices[i]));
      btn.setAttribute('aria-label', LETTERS.charAt(i) + ': ' + q.choices[i]);
      btn.addEventListener('click', answerHandler(rec, i));
      wrap.appendChild(btn);
      rec.buttons.push(btn);
    }
    card.appendChild(wrap);
    append(card);
    S.cards[q.quiz_id] = rec;
    refreshCards();
    return rec;
  }
  function answerHandler(rec, i) { return function () { onAnswer(rec, i); }; }

  function setCardState(rec, state) {
    rec.state = state;
    if (state === 'closed') rec.el.classList.add('closed'); else rec.el.classList.remove('closed');
  }
  function refreshCards() {
    for (var k in S.cards) {
      if (!has(S.cards, k)) continue;
      var rec = S.cards[k];
      var live = rec.state === 'open' && !S.busy && !S.unavailable;
      for (var i = 0; i < rec.buttons.length; i++) rec.buttons[i].disabled = !live;
    }
    rescueFocus();
  }
  // quiz_open is the server's truth: only that card may take an answer.
  function applyQuizOpen(q) {
    var id = (isObj(q) && RE_QUIZ_ID.test(String(q.quiz_id))) ? q.quiz_id : null;
    if (id && !S.cards[id]) addQuizCard(q);
    S.openQuizId = id;
    for (var k in S.cards) {
      if (!has(S.cards, k)) continue;
      var rec = S.cards[k];
      if (rec.state === 'graded') continue;
      if (k === id && rec.state !== 'pending') setCardState(rec, 'open');
      else if (k !== id) {
        for (var i = 0; i < rec.buttons.length; i++) rec.buttons[i].classList.remove('picked');
        setCardState(rec, 'closed');
      }
    }
    refreshCards();
  }

  function onAnswer(rec, i) {
    if (rec.state !== 'open' || S.busy || S.unavailable) return;
    setCardState(rec, 'pending');
    rec.buttons[i].classList.add('picked');
    runTurn({id: newTurnId(), kind: 'answer', quizId: rec.id, letter: LETTERS.charAt(i), ctx: null});
  }

  function applyGraded(g, live) {
    if (!isObj(g) || !RE_QUIZ_ID.test(String(g.quiz_id)) || !RE_QID.test(String(g.qid)) ||
        !RE_LETTER.test(String(g.chosen)) || !RE_LETTER.test(String(g.correct_letter))) return;
    var ok = g.is_correct === true;
    var rec = S.cards[g.quiz_id];
    var host;
    if (rec) {
      setCardState(rec, 'graded');
      var ci = LETTERS.indexOf(g.correct_letter), ch = LETTERS.indexOf(g.chosen);
      for (var i = 0; i < rec.buttons.length; i++) {
        var b = rec.buttons[i];
        b.disabled = true;
        b.classList.remove('picked');
        b.classList.remove('correct');
        b.classList.remove('incorrect');
        var lab = LETTERS.charAt(i) + ': ' + rec.choices[i];
        if (i === ci) { b.classList.add('correct'); lab += i === ch ? ' - your answer, correct' : ' - correct answer'; }
        else if (i === ch) { b.classList.add('incorrect'); lab += ' - your answer, incorrect'; }
        b.setAttribute('aria-label', lab);
      }
      host = rec.el;
      var old = host.querySelector('.feedback');
      if (old && old.parentNode) old.parentNode.removeChild(old);
    } else {
      // The card is not on screen (e.g. trimmed from the transcript).
      host = el('div', 'tcard');
      host.appendChild(el('div', 'qsub', 'Practice question ' + g.qid + ' - you chose ' + g.chosen));
      append(host);
    }
    var fb = el('div', 'feedback');
    fb.appendChild(el('div', 'fbline ' + (ok ? 'ok' : 'bad'), ok ? 'Correct' : 'Incorrect - correct answer is ' + g.correct_letter));
    var ex = el('div', 'fbexpl');
    if (typeof g.rationale === 'string' && g.rationale) ex.textContent = g.rationale;
    else ex.appendChild(el('i', null, COPY.noExpl));
    fb.appendChild(ex);
    if (typeof g.refs === 'string' && g.refs) fb.appendChild(el('div', 'fbrefs', 'Rule: ' + g.refs));
    host.appendChild(fb);
    refreshCards();
    if (live) maybeRecord(g);
  }

  // The page records the graded answer exactly as if it had been answered on
  // the page (its own recordAnswer -> one per-leaf RTDB write), once per quiz_id.
  function maybeRecord(g) {
    var r = g.record;
    if (!isObj(r) || !RE_QID.test(String(r.qid)) || r.qid !== g.qid || typeof r.correct !== 'boolean') return;
    if (S.recorded[g.quiz_id]) return;
    S.recorded[g.quiz_id] = true;
    if (typeof pg('recordAnswer') === 'function') {
      try { window.recordAnswer(r.qid, r.correct); S.answeredSince = true; } catch (e) {}
    }
    syncSoon('chat_answer');
  }

  function renderItems(items, live) {
    if (!isArr(items)) return;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!isObj(it)) continue;
      if (it.type === 'text' && typeof it.text === 'string' && it.text) addTutorText(it.text);
      else if (it.type === 'greeting' && typeof it.text === 'string' && it.text) addTutorText(it.text, 'greet');
      else if (it.type === 'quiz') addQuizCard(it);
      else if (it.type === 'graded') applyGraded(it, live);
      else if (it.type === 'notice') addNotice(it);
    }
  }

  // ---- quota / llm state ---------------------------------------------------
  function setQuotaText(t) { if (D.quota) D.quota.textContent = t; }
  function setQuota(q) {
    if (!isObj(q) || typeof q.day_left !== 'number') return;
    var n = Math.max(0, Math.floor(q.day_left));
    if (n > CFG.quotaShowAt) setQuotaText('');
    else if (n === 0) setQuotaText('No messages left today');
    else setQuotaText(n + (n === 1 ? ' message' : ' messages') + ' left today');
  }
  function setLlm(v, fromSession) {
    if (v !== 'on' && v !== 'off' && v !== 'disabled') return;
    S.llm = v;
    if (v === 'disabled') setComposer(false, "Chat isn't turned on for your account yet");
    else if (!S.unavailable && !S.resting) setComposer(true);
    if (fromSession && v === 'off') addNote(COPY.tutorOff);
    if (fromSession && v === 'disabled') addNote(COPY.chatDisabled);
    refreshEntries();
  }
  // CONTRACT A13: the monthly budget rests LLM chat until tomorrow ('day') or the 1st ('month'). Quiz me, grading
  // with the official explanations, the greeting and sync keep working, so only the composer and the chat-only
  // chips and buttons go away. A missing or null value (an older server, or the budget has room) means not resting.
  function setResting(v, fromSession) {
    var r = (v === 'day' || v === 'month') ? v : null;
    var was = S.resting;
    S.resting = r;
    if (r) setComposer(false, r === 'day' ? 'Tutor chat is resting until tomorrow' : 'Tutor chat is resting until the 1st');
    else if (was && S.llm === 'on' && !S.unavailable) setComposer(true);
    if (fromSession && r) addNote(r === 'day' ? COPY.restingDay : COPY.restingMonth);
    refreshControls();
    refreshEntries();
  }

  // ---- /session ------------------------------------------------------------
  function ensureSession(force) {
    if (S.unavailable) return Promise.resolve(false);
    if (S.sessionPromise) return S.sessionPromise;
    if (!force && S.sessionOkAt && (Date.now() - S.sessionOkAt) < CFG.sessionRefreshMs) return Promise.resolve(true);
    if (S.busy) return Promise.resolve(S.sessionOkAt > 0);   // a turn is in flight: never clear the log under it
    clearRetryNote();
    setBusy(true);
    showTyping();
    S.sessionPromise = callWithRetries('/api/v1/session', function () {
      var b = {v: V, context: buildContext()};
      var s = wireSummary();
      if (s) b.summary = s;
      return b;
    }, CFG.otherTimeoutMs).then(function (res) {
      S.sessionPromise = null;
      hideTyping();
      setBusy(false);
      if (res.status === 200 && res.data) {
        S.sessionOkAt = Date.now();
        try { renderSession(res.data); } catch (e) { addErrorNote(COPY.internal, null); }
        return true;
      }
      var info = errorInfo(res);
      applyErrorEffects(info);
      addErrorNote(info.text, info.retry ? function () { ensureSession(true); } : null);
      return false;
    });
    return S.sessionPromise;
  }
  function renderSession(d) {
    clearLog();
    var shown = 0, tr = isArr(d.transcript) ? d.transcript : [];
    for (var i = 0; i < tr.length; i++) {
      var e = tr[i];
      if (!isObj(e)) continue;
      if (e.role === 'student' && typeof e.text === 'string' && e.text) { addStudent(e.text); shown++; }
      else if (e.role === 'tutor' && isArr(e.items)) { renderItems(e.items, false); shown++; }
    }
    if (isObj(d.greeting) && typeof d.greeting.text === 'string' && d.greeting.text) {
      addTutorText(d.greeting.text, 'greet');
      shown++;
    }
    applyQuizOpen(d.quiz_open);
    setLlm(d.llm, true);
    setResting(d.resting, true);
    if (!shown && !S.openQuizId) addHint();
    setQuota(d.quota);
    scrollToEnd();
  }

  // ---- /chat ---------------------------------------------------------------
  function chatBody(turn) {
    var b = {v: V, client_turn_id: turn.id, kind: turn.kind};
    if (turn.kind === 'message') b.text = turn.text;
    else if (turn.kind === 'answer') b.answer = {quiz_id: turn.quizId, letter: turn.letter};
    b.context = turn.ctx || buildContext();
    var s = wireSummary();
    if (s) b.summary = s;
    return b;
  }
  function runTurn(turn) {
    clearRetryNote();
    setBusy(true);
    showTyping();
    return callWithRetries('/api/v1/chat', function () { return chatBody(turn); }, CFG.chatTimeoutMs).then(function (res) {
      hideTyping();
      setBusy(false);
      if (res.status === 200 && res.data) {
        try { onChatOk(res.data, turn); } catch (e) { addErrorNote(COPY.internal, null); }
        return true;
      }
      onChatError(res, turn);
      return false;
    });
  }
  function onChatOk(d, turn) {
    renderItems(d.items, true);
    if (turn.kind === 'answer') {
      var rec = S.cards[turn.quizId];
      if (rec && rec.state === 'pending') {
        for (var i = 0; i < rec.buttons.length; i++) rec.buttons[i].classList.remove('picked');
        setCardState(rec, 'closed');
      }
    }
    applyQuizOpen(d.quiz_open);
    setLlm(d.llm, false);
    setResting(d.resting, false);
    setQuota(d.quota);
    scrollToEnd();
  }
  function onChatError(res, turn) {
    var info = errorInfo(res);
    applyErrorEffects(info);
    var rec = turn.kind === 'answer' ? S.cards[turn.quizId] : null;
    if (info.retry) {
      // "Try again" resends the SAME client_turn_id, so a reply that was
      // produced but lost on the way back is replayed, never charged twice.
      addErrorNote(info.text, function () { runTurn(turn); });
    } else {
      addErrorNote(info.text, null);
      if (rec && rec.state === 'pending') {
        for (var i = 0; i < rec.buttons.length; i++) rec.buttons[i].classList.remove('picked');
        setCardState(rec, 'open');
        refreshCards();
      }
    }
  }
  function sendText(text, ctx) {
    var t = cleanText(text);
    if (!t) { addErrorNote(COPY.empty, null); return Promise.resolve(false); }
    if (t.length > CFG.maxInput) { addErrorNote(COPY.tooLong, null); return Promise.resolve(false); }
    addStudent(t);
    return runTurn({id: newTurnId(), kind: 'message', text: t, ctx: ctx || null});
  }
  // The LLM-free practice question (CONTRACT A3): no API call on the server, never charged.
  function sendQuizMe() {
    if (S.busy || S.unavailable) return Promise.resolve(false);
    addStudent(QUIZ_ME);
    return runTurn({id: newTurnId(), kind: 'quiz', ctx: null});
  }
  function sendFromInput() {
    if (!D.input || S.busy || !S.composerOn || S.unavailable) return;
    var t = cleanText(D.input.value);
    if (!t) return;
    if (t.length > CFG.maxInput) { addErrorNote(COPY.tooLong, null); return; }
    D.input.value = '';
    autosize();
    updateCount();
    sendText(t, null);
  }

  // ---- /reset --------------------------------------------------------------
  function resetChat() {
    if (S.busy || S.unavailable) return;
    clearRetryNote();
    setBusy(true);
    callWithRetries('/api/v1/reset', function () { return {v: V}; }, CFG.otherTimeoutMs).then(function (res) {
      setBusy(false);
      if (res.status === 200 && res.data && res.data.ok === true) {
        clearLog();
        addHint();
        refreshCards();
        if (D.input && !D.input.disabled) try { D.input.focus(); } catch (e) {}
        return;
      }
      var info = errorInfo(res);
      applyErrorEffects(info);
      addErrorNote(info.text, info.retry ? resetChat : null);
    });
  }

  // ---- open / close / explain ----------------------------------------------
  function coarsePointer() {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
  }
  function openPanel() {
    try {
      if (!S.user || S.unavailable) return Promise.resolve(false);
      buildPanel();
      if (!S.open) {
        S.opener = document.activeElement;
        S.open = true;
        D.panel.classList.add('open');
        document.body.classList.add('tutor-open');
        if (D.fab) { D.fab.setAttribute('aria-expanded', 'true'); show(D.fab, false); }
        fitViewport();
        // Phones: focus the dialog title, not the textarea (no surprise keyboard).
        var target = (!coarsePointer() && !D.input.disabled) ? D.input : D.title;
        try { target.focus(); } catch (e) {}
      }
      return ensureSession(false);
    } catch (e) {
      return Promise.resolve(false);
    }
  }
  function closePanel() {
    try {
      if (!S.open) return;
      S.open = false;
      D.panel.classList.remove('open');
      D.panel.style.height = ''; D.panel.style.top = '';
      document.body.classList.remove('tutor-open');
      if (D.fab) D.fab.setAttribute('aria-expanded', 'false');
      refreshEntries();
      if (S.answeredSince) {
        S.answeredSince = false;
        if (pg('CURRENT_VIEW') === 'picker' && typeof pg('renderPicker') === 'function') {
          try { window.renderPicker(); } catch (e) {}
        }
      }
      var o = S.opener;
      S.opener = null;
      if (o && o.focus && document.body.contains(o)) { try { o.focus(); } catch (e) {} }
      else if (D.fab && D.fab.style.display !== 'none') { try { D.fab.focus(); } catch (e) {} }
    } catch (e) { /* never break the page */ }
  }
  function explain(qid) {
    qid = String(qid || '');
    if (!RE_QID.test(qid)) return openPanel();
    var ctx = {view: 'quiz', cls: PREFIX_CLS[qid.charAt(0)], qid: qid, qid_answered: true};
    return openPanel().then(function (ok) {
      if (!ok || S.busy || S.unavailable || !S.composerOn || S.llm === 'disabled') return false;
      return sendText('Can you help me understand question ' + qid + '?', ctx);
    });
  }
  // Keep Enter/Space on tutor buttons that live OUTSIDE the panel from also
  // reaching the page's quiz shortcut handler (which would press "Next").
  function stopKeys(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.stopPropagation();
  }
  function addExplainButton(fb, qid) {
    try {
      if (!fb || !S.user || S.unavailable || S.llm === 'disabled' || S.resting || !RE_QID.test(String(qid))) return;
      var b = el('button', 'cta ghost tutor-explain', 'Ask the tutor about this one');
      b.type = 'button';
      b.addEventListener('click', function () { explain(qid); });
      b.addEventListener('keydown', stopKeys);
      fb.appendChild(b);
    } catch (e) { /* never break the page */ }
  }

  // ---- entry points: floating button + picker/setup/summary entries ---------
  function entryCard(title, which) {
    var wrap = el('div', 'tutor-entry');
    var b = el('button', 'modecard'); b.type = 'button';
    b.appendChild(el('b', null, title));
    var t = el('span', null, ENTRY_COPY[which][0]);
    D.entryTexts.push({el: t, which: which});
    b.appendChild(t);
    b.addEventListener('click', function () { openPanel(); });
    b.addEventListener('keydown', stopKeys);
    wrap.appendChild(b);
    return wrap;
  }
  function installEntries() {
    var fab = el('button', 'cta', 'Ask the tutor');
    fab.id = 'tutorFab'; fab.type = 'button';
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-controls', 'tutorPanel');
    fab.setAttribute('aria-expanded', 'false');
    fab.addEventListener('click', function () { openPanel(); });
    fab.addEventListener('keydown', stopKeys);
    show(fab, false);
    document.body.appendChild(fab);
    D.fab = fab;

    var picker = document.getElementById('view-picker');
    if (picker) {
      var e1 = entryCard('Ask the tutor', 0);
      picker.insertBefore(e1, picker.querySelector('.foot-links'));
      D.entries.push(e1);
    }
    var setup = document.getElementById('view-setup');
    if (setup) {
      var e2 = entryCard('Ask the tutor', 1);
      setup.appendChild(e2);
      D.entries.push(e2);
    }
    var nav = document.querySelector('#view-summary .qnav');
    if (nav) {
      var b3 = el('button', 'cta ghost', 'Ask the tutor'); b3.type = 'button';
      b3.addEventListener('click', function () { openPanel(); });
      b3.addEventListener('keydown', stopKeys);
      nav.appendChild(b3);
      D.entries.push(b3);
    }
    for (var i = 0; i < D.entries.length; i++) show(D.entries[i], false);
  }
  // The tutor's buttons show for a signed-in user until the server says this
  // account is not on the tutor allowlist (403 forbidden from /sync or
  // /session); then they stay hidden for the rest of the page load.
  function refreshEntries() {
    var on = !!S.user && !S.unavailable;
    var chatOff = S.llm === 'disabled' || !!S.resting;   // resting (A13): practice-question copy, no explain buttons
    show(D.fab, on && !S.open);
    for (var i = 0; i < D.entries.length; i++) show(D.entries[i], on);
    for (var k = 0; k < D.entryTexts.length; k++) {
      var et = D.entryTexts[k];
      et.el.textContent = ENTRY_COPY[et.which][chatOff ? 1 : 0];
    }
    // "Ask the tutor about this one" needs chat, so it hides for a chat-off account.
    var ex = document.querySelectorAll('.tutor-explain');
    for (var j = 0; j < ex.length; j++) show(ex[j], on && !chatOff);
    if (on) document.body.classList.add('tutor-has-fab'); else document.body.classList.remove('tutor-has-fab');
  }
  function markUnavailable() {
    S.unavailable = true;
    setComposer(false, 'The tutor is not available for this account');
    refreshEntries();
  }
  function onUser(user) {
    S.user = user || null;
    refreshEntries();
    if (!S.user && S.open) closePanel();
  }

  function init() {
    try { installEntries(); } catch (e) {}
    try { window.firebase.auth().onAuthStateChanged(onUser); } catch (e) { /* no firebase: stay hidden */ }
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushSync();
      });
      window.addEventListener('pagehide', flushSync);
    } catch (e) {}
  }

  window.HamTutor = {
    open: openPanel,
    close: closePanel,
    isOpen: function () { return !!S.open; },
    syncSoon: syncSoon,
    explain: explain,
    addExplainButton: addExplainButton,
    // Test hooks only (node/jsdom + headless harness). Not used by the page.
    _t: {cfg: CFG, state: S, dom: D, buildSummary: buildSummary, buildContext: buildContext,
         errorInfo: errorInfo, apiBase: apiBase, newTurnId: newTurnId, cleanText: cleanText}
  };

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
