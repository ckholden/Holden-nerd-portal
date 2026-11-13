/* HoldenDMR shared chat-command parser (hd2.6, 2026-11-13).
   Everything between the CHAT-PARSER markers is a BYTE-FOR-BYTE copy of the desktop app's parser
   (dmr/desktop/index.html, wave 2 rev 2.1, portal 25e644e), so the web app and the desktop read a typed line the
   same way and print the same usage/hint text. Do NOT edit the block here: change the desktop, then re-copy.
   dmrptt/test/holdencmd_parity.mjs fails if the two blocks differ, and also checks that nothing this parser sends
   as room chat is a line the gateway's chat guard would refuse.
   Loaded as a classic script; exposes window.HoldenCmd. */
(function(){
/* ==== CHAT-PARSER-BEGIN ====
   parseChatLine(raw, ctx): ONE pure function decides whether a chat line is a command (2026-10-17, dispatch
   commands). No DOM, no globals, no sends: tests/test_client.mjs runs this exact block in node.
   Returns null = ordinary chat (sent to the room as typed), or {kind, ...}. kind 'usage' / 'error' = print
   p.text and send nothing.
   WAVE 2 (2026-11-13, WAVE2-CONTRACT.md D1-D3): decision 2 - a line that starts with a STRICT word (ping, rc,
   radios, rollcall, lh, sms, !lh) and parses is always a command. Narrowed to match SERVER's gw chat guard (B6):
   one that doesn't parse prints that command's usage line or the name hint (never the room) only when it is 2 tokens
   or fewer ("rc car", "ping dad"); longer it is chat ("ping dad when you get home", "rc car is fun").
   radios / rollcall are commands only as the whole line ("Radios are all charged" is chat). !lh stays strict.
   sms stays strict at ANY length (rev 2 review): "sms dad running late, door code 4512" was meant as a private
   radio text, so a line starting with sms that doesn't parse prints the hint / usage and is never posted to the room.
   The desktop may be STRICTER than the gw guard (it prints a usage line where gw would post), never looser: a line
   the desktop sends as chat is one gw posts (gw splits the raw line on the same characters as \s here).
   A line that starts with "." and a letter is always a command (dot form: strip one dot, parse the rest the bare
   way, fully strict; else usage / "Unknown command").
   The everyday words (c lo dc st status patch bc map clear help) stay chat outside their exact forms ("c u later",
   "st louis", "patch it up", "bc of traffic", "help me") while PC_STRICT_EVERYDAY is false - Christian's open
   question (contract F); true makes them strict too. First names never reach the room from a 2-token ping/rc/lh line
   or from any sms or bc line; a longer ping/rc/lh line is chat ("ping dad when you get home").
   ctx = {canPage, listenOnly, pageTargets:[{key,label}], myCall, curNet, nets, roster, strictEveryday}
   nets: an array is the account's COMPLETE network list ([] = TGIF only); null = not known yet.
   roster: hello.roster (C4) or null = an OLD gw -> PC_ROSTER_BUILTIN. strictEveryday: tests only (default the constant). */
const PC_STRICT_EVERYDAY = false;   /* ⚠ Christian's pick (contract F) - the page doesn't ship until he chooses */
/* The family radios when hello has no roster (an old gw). Same as the gw's ROSTER_BUILTIN (contract A2, C4 shape). */
const PC_ROSTER_BUILTIN = [
  { id: 3140888, call: 'KJ7DTS', who: 'Christian', names: ['christian', 'chris'], hotspot_peer: 3140888, hotspot_agent: true, bc: true, rc: true },
  { id: 3195193, call: 'KK7ION', who: 'Dad', names: ['dad', 'chris'], hotspot_peer: 3195193, hotspot_agent: true, bc: true, rc: true },
  { id: 3206088, call: 'KK7RBQ', who: 'Grandpa', names: ['pete', 'grandpa'], hotspot_peer: 3206088, hotspot_agent: false, bc: false, rc: true }
];
const PC_EVERYDAY = ['c', 'lo', 'dc', 'st', 'status', 'patch', 'bc', 'map', 'clear', 'help'];
const PC_PRESTON = 'Preston has no DMR radio, so there is nothing to check.';
const PC_NOLH = '!lh is gone: use lh <callsign> for last heard, or !<callsign> for a name lookup.';
function pcIsCall(s) { return /^[A-Za-z0-9]{3,10}$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s); }
function pcRoster(ctx) {
  const r = ctx && Array.isArray(ctx.roster) ? ctx.roster.filter(function (e) {
    return e && typeof e.call === 'string' && /^[A-Za-z0-9]{3,8}$/.test(e.call) && Number.isInteger(e.id);
  }) : [];
  return r.length ? r : PC_ROSTER_BUILTIN;
}
function pcCanRc(e) { return e.rc !== false; }
function pcCanBc(e) { return e.bc === true; }
function pcCalls(ctx, pred) {
  return pcRoster(ctx).filter(function (e) { return !pred || pred(e); }).map(function (e) { return e.call.toLowerCase(); });
}
/* a roster radio by callsign or decimal DMR ID (case and spaces ignored), else null */
function pcFind(tok, ctx) {
  const t = String(tok == null ? '' : tok).trim().toUpperCase();
  return pcRoster(ctx).find(function (e) { return e.call.toUpperCase() === t || String(e.id) === t; }) || null;
}
function pcIsName(w, ctx) {
  return pcRoster(ctx).some(function (e) { return Array.isArray(e.names) && e.names.indexOf(w) >= 0; });
}
/* "Use the callsign: rc kk7ion" / "Use the callsign: rc kj7dts (Christian) or rc kk7ion (Dad)" (D3). null = no match. */
function pcHint(cmd, w, ctx, sfx, pred) {
  const hits = pcRoster(ctx).filter(function (e) { return Array.isArray(e.names) && e.names.indexOf(w) >= 0 && (!pred || pred(e)); });
  if (!hits.length) return null;
  if (hits.length === 1) return 'Use the callsign: ' + cmd + ' ' + hits[0].call.toLowerCase() + (sfx || '');
  return 'Use the callsign: ' + hits.map(function (e) {
    return cmd + ' ' + e.call.toLowerCase() + (sfx || '') + (e.who ? ' (' + e.who + ')' : '');
  }).join(' or ');
}
/* D3 usage lines, exact text. null = not a command word. */
function pcUsage(word, ctx) {
  const list = function (cmd, pred) { return pcCalls(ctx, pred).map(function (c) { return cmd + ' ' + c; }).join(', '); };
  switch (word) {
    case 'ping': return 'Usage: ping <callsign or DMR ID>  (' + list('ping') + '). Nothing is transmitted.';
    case 'rc': return 'Usage: rc <callsign or DMR ID>  (' + list('rc', pcCanRc) + '). This TRANSMITS one radio check over HOLDEN.';
    case 'radios': return 'Usage: radios  - all family radios: heard, last check, hotspot. Nothing is transmitted.';
    case 'rollcall': return 'Usage: rollcall  - TRANSMITS one radio check to each family radio in turn (about a minute).';
    case 'lh': return 'Usage: lh  or  lh <callsign>  (' + list('lh') + ')';
    case 'sms': return 'Usage: sms <callsign | DMR ID | holden | preston> <message>  - sends a DMR radio text (keys their hotspot about a second).';
    case 'bc': return 'Usage: bc on|off (your hotspot)  or  bc <callsign> on|off  (callsign: ' + pcCalls(ctx, pcCanBc).join(' or ') + ')';
    case 'st': case 'status': return 'Usage: st  - your talkgroup, patch and hotspots.';
    case 'lo': case 'logoff': return 'Usage: lo  - log off.';
    case 'dc': case 'disconnect': return 'Usage: dc  - go quiet (TG 4000).';
    case 'nr': case 'net': return 'Usage: nr  - the weather net report.';
    case 'c': return 'Usage: c [t|b|p|h]<talkgroup>  e.g. c 33611, c h33611';
    case 'cls': case 'clear': return 'Usage: /cls  or  /cls texts';
    case 'help': return 'Usage: help';
    case 'map': return 'Usage: map <callsign>';
    case 'patch': return 'Usage: patch (state) | patch on [minutes] | patch off';
  }
  return null;
}
/* A station in a ping / rc / lh slot (D1). -> {text} = print it (a name hint or the Preston line), {call, entry} =
   the station, null = not a station. Roster radios (call or ID) and "me" (the own callsign) only, except lh
   (anyCall) which also takes any other callsign, as before. pred limits the roster radios (rc: rc true). */
function pcSlot(cmd, tok, ctx, pred, anyCall) {
  const w = String(tok || '').toLowerCase();
  if (w === 'preston') return { text: PC_PRESTON };
  if (pcIsName(w, ctx)) return { text: pcHint(cmd, w, ctx, '', pred) || pcUsage(cmd, ctx) };
  let e;
  if (w === 'me') {
    if (!ctx.myCall) return null;
    e = pcFind(ctx.myCall, ctx);
    if (!e) return anyCall ? { call: String(ctx.myCall).toUpperCase(), entry: null } : null;
  } else e = pcFind(tok, ctx);
  if (e && (!pred || pred(e))) return { call: e.call.toUpperCase(), entry: e };
  if (!e && anyCall && pcIsCall(tok)) return { call: String(tok).toUpperCase(), entry: null };
  return null;
}
function pcIsTypedCall(c) {          /* same rule as isTypedCall (map/track): base call has a letter and a digit */
  const b = c.split('-')[0];
  return /^[A-Z0-9]{3,7}(-[A-Z0-9]{1,2})?$/.test(c) && /[A-Z]/.test(b) && /\d/.test(b);
}
function pcPageTarget(tok, ctx) {
  const t = String(tok || '').toUpperCase();
  const list = ctx.pageTargets || [];
  if (t && ctx.myCall && t === String(ctx.myCall).toUpperCase()) {
    const self = list.find(function (x) { return x.label === 'ME'; });
    if (self) return self;
  }
  return list.find(function (x) { return String(x.key).toUpperCase() === t || String(x.label).toUpperCase() === t; }) || null;
}
function parseChatLine(raw, ctx) {
  ctx = ctx || {};
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (/^\.[A-Za-z]/.test(s)) return pcDot(s, ctx);
  return pcBare(s, ctx);
}
/* Dot form (D1): strip exactly one leading "." and parse the rest the bare way. Never chat: a line that would be
   chat prints that word's usage line, or "Unknown command". pg/, track/ ... (punctuation words) have no dot form. */
function pcDot(s, ctx) {
  const rest = s.slice(1).trim();
  const word = rest.split(/\s+/)[0];
  const lowr = rest.toLowerCase().replace(/\s+/g, ' ');
  const unknown = { kind: 'usage', text: 'Unknown command: .' + word.slice(0, 24) + '. Type help for the list.' };
  if (/^[A-Za-z]+\//.test(rest)) return unknown;
  if (lowr === 'cls' || lowr === 'clear') return { kind: 'cls' };      /* .cls / .clear: no ask (as .clear always was) */
  if (lowr === 'cls texts') return { kind: 'smsclear' };
  if (lowr === 'net') return { kind: 'nr' };
  const p = pcBare(rest, ctx, true);     /* the dot form stays fully strict (no loose chat fall-through) */
  if (p) return p;
  const u = pcUsage(word.toLowerCase(), ctx);
  return u ? { kind: 'usage', text: u } : unknown;
}
/* strict = true only from the dot form. A bare line (strict false) that starts with ping / rc / lh but does not
   parse is a command mistake (usage or name hint, never the room) only when it is 2 tokens or fewer ("rc car",
   "ping dad"); a longer one is chat ("ping dad when you get home", "rc car is fun"). radios / rollcall are commands
   only as the whole line ("Radios are all charged", "rollcall at 7 tonight?" are chat). sms never falls through to
   chat (a private text must not reach the room). SERVER's narrowed gw chat guard (B6) applies the same token rule
   for old pages; the desktop may be stricter than gw (sms, "ping you", "dad lh"), never looser. */
function pcBare(s, ctx, strict) {
  const low0 = s.toLowerCase();                       /* what the old branches compared */
  const low = low0.replace(/\s+/g, ' ');              /* lo / st / lh / patch / bc */
  const w0 = low.split(' ')[0];
  const strictEv = typeof ctx.strictEveryday === 'boolean' ? ctx.strictEveryday : PC_STRICT_EVERYDAY;
  const loose = !strict && low.split(' ').length > 2; /* a non-parsing strict-word line this long is chat */
  const usage = function (w) { return { kind: 'usage', text: pcUsage(w, ctx) }; };
  const miss = function (text) { return loose ? null : { kind: 'usage', text: text }; };
  let m, r;

  if (low === 'help' || low === '/help' || low === '?') return { kind: 'help' };   /* D3: .help via the dot form; F1 types .help */
  if (low === 'lo' || low === 'logoff' || low === 'log off') return { kind: 'lo' };
  if (low === 'dc' || low === 'disconnect') return { kind: 'dc' };
  if (low === '/cls texts' || low === 'cls texts') return { kind: 'smsclear' };
  if (low === '/cls') return { kind: 'cls' };
  if (low === 'clear') return { kind: 'cls', ask: true };   /* a bare word (also a sign-off): asks first */
  if (low === 'net report' || low === 'nr') return { kind: 'nr' };
  if (low === 'st' || low === 'status') return { kind: 'st' };

  /* radios (read only) / rollcall (TRANSMITS): the exact word only. With more words it is chat ("Radios are all
     charged", "rollcall at 7 tonight?"); the dot form (".radios x") prints the usage. */
  if (w0 === 'radios') return low === 'radios' ? { kind: 'radios' } : (strict ? usage('radios') : null);
  if (w0 === 'rollcall') return low === 'rollcall' ? { kind: 'rollcall' } : (strict ? usage('rollcall') : null);

  /* rc <station>: ONE over-the-air radio check (TRANSMITS). A roster radio with rc (call or ID) or "me".
     "rc car" / "rc dad" (2 tokens) print the usage / hint; "rc car is fun" is chat. */
  if (w0 === 'rc') {
    m = s.match(/^rc\s+(\S+)$/i);
    r = m ? pcSlot('rc', m[1], ctx, pcCanRc, false) : null;
    if (r && r.text) return miss(r.text);
    if (r && r.entry) return { kind: 'rc', call: r.call, id: r.entry.id, who: r.entry.who || null };
    return miss(pcUsage('rc', ctx));
  }

  /* lh = who keyed up on my TG; lh CALL / CALL lh (F12 flow) = that station's last keyups. "lh is" (2 tokens) prints
     the usage; "lh is cool" is chat. `!lh` is gone (below). */
  if (low === 'lh') return { kind: 'lh', call: null };
  m = s.match(/^lh\s+(\S+)$/i) || s.match(/^(\S+)\s+lh$/i);
  if (m || w0 === 'lh') {
    r = m ? pcSlot('lh', m[1], ctx, null, true) : null;
    if (r && r.text) return { kind: 'usage', text: r.text };
    if (r) return { kind: 'lh', call: r.call };
    if (w0 === 'lh') return miss(pcUsage('lh', ctx));
  }

  /* patch | patch? | patch status | patch on [30 | 30m | 2h] | patch off. "patch me through" etc. stay chat. */
  m = s.match(/^patch(?:\s+(on|off|status))?(?:\s+(\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?)?\s*(\?)?$/i);
  if (m) {
    const act = (m[1] || 'status').toLowerCase();
    if (m[4] || act === 'status') {
      if (m[2]) return { kind: 'usage', text: 'Usage: patch (state) | patch on [minutes] | patch off' };
      return { kind: 'patch', action: 'state' };   /* "patch on?" is a question, never a start */
    }
    if (act === 'off') {
      if (m[2]) return { kind: 'usage', text: "Usage: patch off  (it takes no minutes)" };
      return { kind: 'patch', action: 'off' };
    }
    let mins = null;
    if (m[2]) {
      mins = parseInt(m[2], 10) * (/^h/i.test(m[3] || '') ? 60 : 1);
      if (!(mins > 0)) return { kind: 'usage', text: 'Usage: patch on [minutes]  e.g. patch on 30, patch on 2h' };
    }
    return { kind: 'patch', action: 'on', minutes: mins };
  }

  /* bc on|off [min] = your own hotspot. Another hotspot by CALLSIGN only (Christian 2026-10-17: "Bc Kk7ion on bc kj7dts
     on etc. or bc on/off call sign"): bc kk7ion on|off [min]  or  bc on|off kk7ion [min], the same for kj7dts.
     A first name gets the callsign hint (bc-capable radios only, the typed action kept; none -> the bc usage), "preston"
     the no-radio line, "me" or any other callsign the bc usage (nothing sent). The bc callsigns come from the roster.
     "bc", "bc on my way", "bc of traffic", "bc im off", "bc on time" stay chat (unless PC_STRICT_EVERYDAY). */
  let bc = null;
  if ((m = s.match(/^bc\s+(on|off)(?:\s+(\d{1,3})\s*(?:m|min|mins|minutes?)?)?$/i))) bc = { who: null, act: m[1], min: m[2] };
  else if ((m = s.match(/^bc\s+([A-Za-z0-9]{2,10})\s+(on|off)(?:\s+(\d{1,3})\s*(?:m|min|mins|minutes?)?)?$/i))) bc = { who: m[1], act: m[2], min: m[3] };
  else if ((m = s.match(/^bc\s+(on|off)\s+([A-Za-z0-9]{2,10})(?:\s+(\d{1,3})\s*(?:m|min|mins|minutes?)?)?$/i))) bc = { who: m[2], act: m[1], min: m[3] };
  if (bc && bc.who) {
    const w = bc.who.toLowerCase();
    if (w === 'preston') return { kind: 'usage', text: PC_PRESTON };
    if (pcIsName(w, ctx)) return { kind: 'usage', text: pcHint('bc', w, ctx, ' ' + bc.act.toLowerCase(), pcCanBc) || pcUsage('bc', ctx) };
    if (pcCalls(ctx, pcCanBc).indexOf(w) >= 0) bc.who = w;
    else if (w === 'me' || pcIsCall(w)) return usage('bc');
    else bc = null;                                   /* "bc im off", "bc on time": chat */
  }
  if (bc) {
    const act = bc.act.toLowerCase();
    if (act === 'off' && bc.min) return { kind: 'usage', text: 'Usage: bc off  (it takes no minutes)' };
    let mins = null;
    if (bc.min) {
      mins = parseInt(bc.min, 10);
      if (!(mins >= 1 && mins <= 60)) return { kind: 'error', text: 'BC-TRBO can be woken for 1 to 60 minutes.' };
    }
    if (ctx.listenOnly) return { kind: 'error', text: "BC-TRBO control isn't available on a listen-only account." };
    return { kind: 'bc', target: bc.who || 'me', action: act, minutes: mins };
  }

  /* sms <callsign | DMR ID | holden> <message> - a DMR radio text from your callsign (gw.py -> dmr-sms-tx).
     This one TRANSMITS: the recipient's hotspot keys up about a second.  Callsigns/IDs only, no names.
     Received texts appear in the chat on their own.  `@sms` is the separate APRS-to-phone command.
     A valid target + message is always the text. Otherwise it prints the usage / name hint at ANY length ("sms dad
     running late, door code 4512" gets the callsign hint): never chat, so a private text can't reach the room
     (rev 2 review; the gw guard would post 3+ tokens from an old page, the desktop is stricter on purpose).
     D1 fix: "sms preston <msg>" is valid (app to app, gw resolves it). */
  if (w0 === 'sms') {
    m = s.match(/^sms\s+(\S+)\s+([\s\S]+)$/i);
    if (m) {
      const t = m[1].toLowerCase();
      if (t !== 'preston' && pcIsName(t, ctx)) return { kind: 'usage', text: pcHint('sms', t, ctx, ' <message>') };
      if (/^\d{1,8}$/.test(m[1]) || /^holden1?$/i.test(m[1]) || t === 'preston' || /^[A-Za-z]{1,2}\d[A-Za-z]{1,4}$/.test(m[1])) {
        if (ctx.listenOnly) return { kind: 'error', text: "Radio texts aren't available on a listen-only account." };
        return { kind: 'dmrsms', to: m[1].toUpperCase(), text: m[2].trim().slice(0, 267) };
      }
    }
    m = s.match(/^sms\s+(\S+)$/i);                    /* "sms dad": the hint, like the gw guard */
    if (m && m[1].toLowerCase() !== 'preston' && pcIsName(m[1].toLowerCase(), ctx))
      return { kind: 'usage', text: pcHint('sms', m[1].toLowerCase(), ctx, ' <message>') };
    return usage('sms');                              /* strict at any length: never the room */
  }

  /* ping CALL / CALL ping (hsping: read-only hotspot + radio state). A roster radio (call or ID) or "me".
     "ping", "ping you", "ping w7abc" print the usage; "ping dad" gets the callsign hint; "ping me later" and
     "ping dad when you get home" (3+ tokens) are chat.
     "<x> ping" is a command only when x is a station, a name, preston or callsign-shaped ("you ping" is chat). */
  m = s.match(/^ping\s+(\S+)$/i) || s.match(/^(\S+)\s+ping$/i);
  if (m || w0 === 'ping') {
    r = m ? pcSlot('ping', m[1], ctx, null, false) : null;
    if (r && r.text) return { kind: 'usage', text: r.text };
    if (r) return { kind: 'ping', call: r.call };
    if (w0 === 'ping' || pcIsCall(m[1])) return miss(pcUsage('ping', ctx));
  }

  if (/^(track|stoptrack|tracks|map|radar|aprs)\/\s*(.*)$/i.test(s)) return { kind: 'mapslash' };
  m = s.match(/^map\s+([A-Za-z0-9\-]{3,10})$/i) || s.match(/^([A-Za-z0-9\-]{3,10})\s+map$/i);
  if (m && pcIsTypedCall(m[1].toUpperCase())) return { kind: 'map', call: m[1].toUpperCase() };
  if (low0 === 'map') return { kind: 'map', call: null };

  /* `!lh CALL` (the old lookup alias) is gone and strict: it clashed with lh. `!CALL` / `CALL!` stays the lookup. */
  if (/^!lh(\s|$)/i.test(s)) return { kind: 'usage', text: PC_NOLH };
  m = s.match(/^!\s*([A-Za-z0-9]{3,10})$/) || s.match(/^([A-Za-z0-9]{3,10})\s*!$/);
  if (m && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) return { kind: 'lookup', call: m[1].toUpperCase() };
  if (s === '!') return { kind: 'usage', text: 'Usage: !CALLSIGN  (or CALLSIGN!)  -  press F12 first to pull in the last station heard.' };

  /* c [t|b|p|h]<tg>: a command ONLY with a number. "c u later" / "c ya" / "c" are chat. */
  m = s.match(/^c\s+([tbph]?)\s*(\d{1,7})$/i);
  if (m) {
    const NETOF = { t: 'tgif', b: 'bm', p: 'pnw', h: 'holden' };
    const net = m[1] ? NETOF[m[1].toLowerCase()] : (ctx.curNet || 'tgif');
    const tg = parseInt(m[2], 10);
    if (!(tg > 0)) return { kind: 'error', text: 'That is not a talkgroup number.' };
    /* same rule as hasNet(): ctx.nets (hello.nets) when known, else the old tgif/bm/pnw set. `c p3141` used to pass
       for every account, then gw refused the switch and the tune landed on whatever network you were on. */
    const okNets = Array.isArray(ctx.nets) ? ['tgif'].concat(ctx.nets) : ['tgif', 'bm', 'pnw'];
    if (m[1] && okNets.indexOf(net) < 0)
      return { kind: 'error', text: ({ holden: 'HOLDEN', pnw: 'PNWDigital', bm: 'BrandMeister' }[net] || net) + " isn't set up for your account." };
    return { kind: 'c', net: net, tg: tg };
  }

  /* D4: @sms / @aprs transmit on APRS, so a listen-only account can't use them */
  if (/^@(sms|aprs)(\s|$)/i.test(s) && ctx.listenOnly)
    return { kind: 'error', text: "APRS messages aren't available on a listen-only account (they transmit on APRS)." };
  if (/^@sms(\s|$)/i.test(s)) {
    const rest = s.slice(4).trim(), sp = rest.indexOf(' ');
    const num = (sp < 0 ? rest : rest.slice(0, sp)).replace(/\D/g, '');
    const text = sp < 0 ? '' : rest.slice(sp + 1).trim();
    if (num.length !== 10 || !text) return { kind: 'usage', text: 'Usage: @sms <10-digit number> <message>' };
    return { kind: 'sms', num: num, text: text };
  }
  if (/^@aprs(\s|$)/i.test(s)) {
    const rest = s.slice(5).trim(), sp = rest.indexOf(' ');
    const to = (sp < 0 ? rest : rest.slice(0, sp)).toUpperCase();
    const text = (sp < 0 ? '' : rest.slice(sp + 1)).replace(/[|~{]/g, '').replace(/\s+/g, ' ').trim();
    if (!/^(?=[A-Z]*[0-9])[A-Z0-9]{3,6}(-[0-9]{1,2})?$/.test(to) || !text)
      return { kind: 'usage', text: 'Usage: @aprs <CALL-SSID> <message>   e.g. @aprs KK7ION-9 how is the drive?' };
    return { kind: 'aprs', to: to, text: text.slice(0, 67), cut: text.length > 67 };
  }

  /* pg/ never turns a typo into a page to EVERYONE: "pg/ msg" (space right after the slash) or "pg/all msg" pages
     everyone; "pg/<who> msg" pages a known target; an unknown <who> is an error and nothing is sent. */
  if (/^pg\//i.test(s)) {
    if (!ctx.canPage) return { kind: 'error', text: "Paging isn't enabled for this account." };
    const after = s.slice(3);
    if (!after.trim()) return { kind: 'usage', text: 'Usage: pg/<who> <message> (rings their radio; pg/<who>! adds the page tones)  or  pg/ <message> to page everyone' };
    const list = ctx.pageTargets || [];
    const all = list.find(function (x) { return x.key === 'all'; }) || null;
    let who = '', msg = after.trim();
    if (!/^\s/.test(after)) {
      const w = after.match(/^(\S+)\s*([\s\S]*)$/);
      who = w[1]; msg = w[2].trim();
    }
    let tone = false;                  /* hd2.8: pg/<who>! = the page tones on the net too (a page to one radio is a
                                          Call Alert that rings only that radio; ALL always has the tones) */
    if (/!$/.test(who)) { tone = true; who = who.slice(0, -1); }
    if (!who || who.toLowerCase() === 'all') {
      if (!all) return { kind: 'error', text: "Paging everyone isn't enabled for this account." };
      if (!who && !msg) return { kind: 'usage', text: 'Usage: pg/<who> <message> (rings their radio; pg/<who>! adds the page tones)  or  pg/ <message> to page everyone' };
      return { kind: 'page', key: all.key, label: all.label, msg: msg };
    }
    const t = pcPageTarget(who, ctx);
    if (!t) return { kind: 'error', text: "Unknown page target '" + who.toUpperCase() + "'. Targets: " +
      list.map(function (x) { return x.label; }).join(', ') + ". Use 'pg/ message' to page everyone." };
    return { kind: 'page', key: t.key, label: t.label, msg: msg, tone: tone };
  }
  /* an everyday word outside its exact forms: chat today; usage when PC_STRICT_EVERYDAY (contract F) */
  if (strictEv && PC_EVERYDAY.indexOf(w0) >= 0) return usage(w0);
  return null;
}
/* ==== CHAT-PARSER-END ==== */

/* ==== hd2.6 web glue (2026-11-13) ====
   The family / radio-check layer below is a BYTE COPY of the desktop (dmr/desktop/index.html, from "Pending server
   commands" through updateChatHint); dmrptt/test/holdencmd_parity.mjs fails if the two drift. It runs inside famInit(),
   which the page calls once its Chat markup exists. It uses these page globals at call time: $, ws, curNet, send(obj),
   addChat(who,text,ts,sys), askConfirm(msg,okLabel,onYes,opts). `me` is held HERE (setMe), never the page's #me element. */
var me = {};
function famInit() {
/* ==== FAMILY-BEGIN ==== */
/* Pending server commands (2026-10-17). The gateway ignores a cmd it does not know, so every new cmd arms a
   timeout that says so instead of hanging silently (an old server, or a reply lost with the socket). The matching
   handle() branch clears it. */
/* wave 2 (contract D4): every client timer is at least the gw's upstream timeout + 5 s */
const PEND_LABEL = { mystatus: 'st', lastheard: 'lh', patchctl: 'patch', bcctl: 'bc', hsping: 'ping', sms: 'sms',
                     radiocheck: 'rc', rollcall: 'rollcall', radiostate: 'radios', netreport: 'nr', page: 'page', lookup: 'lookup' };
const pendT = {};
function pend(name, ms, text, onFire) {
  clearTimeout(pendT[name]);
  pendT[name] = setTimeout(function () {
    delete pendT[name];
    if (onFire) onFire();
    addChat('', text || ("No answer from the server for '" + (PEND_LABEL[name] || name) + "'. It may not have this command yet."), 0, true);
  }, ms);
}
function pendClear(name) { if (pendT[name]) { clearTimeout(pendT[name]); delete pendT[name]; } }
function renderKV(m, fallbackTitle) {
  addChat('', '=== ' + (m.title || fallbackTitle) + ' ===', 0, true);
  if (m.summary) addChat('', m.summary, 0, true);
  (m.lines || []).forEach(function (l) { addChat('', l.k + ': ' + l.v, 0, true); });
  if (m.foot) addChat('', m.foot, 0, true);
}
function chatCtx() {
  return { canPage: !!me.can_page, listenOnly: !!me.listen_only, pageTargets: me.page_targets || [],
           myCall: me.call || '', curNet: curNet, nets: Array.isArray(me.nets) ? me.nets : null,   // null = list not known yet
           roster: famRoster };                                                                    // null = old gw: built-in roster
}

/* ==== FAMILY RADIOS (wave 2, 2026-11-13; WAVE2-CONTRACT.md B1-B4, C1-C4, D4-D8) ====
   Typed rc / rollcall and the panel's Radio check / Roll call buttons are the ONLY things that send radiocheck /
   rollcall; nothing here does it on hello, reconnect, a timer or a push. Ages always use the SERVER clock:
   frame.now - ts, plus the seconds since that frame arrived (performance.now) - never Date.now().
   Every roster or server string reaches the DOM through textContent or addChat (which escapes). */
let famRoster = null;              // hello.roster / ev 'roster' (C4); null = an OLD gw (hello had no roster)
let rs = null, rsAt = 0;           // the last radiostate frame (C1) and performance.now() when it arrived
let radiosAsked = false;           // a typed `radios` waits for its frame: printed once; pushes only redraw the panel
let rcRid = null, rcSaid = null;   // the running check's rid (accepted, or hello rc_inflight); rcSaid = rid already announced
let rollId = null, rollSeen = {};  // our roll call's id and the rows already printed
const FAM_TZ = 'America/Los_Angeles';
const FAM_WORD = { on: 'ON', off: 'HOTSPOT OFF', quiet: 'QUIET', unk: 'UNKNOWN' };
const FAM_DOTCLS = { on: 'dot ok', off: 'dot off', quiet: 'dot warn', unk: 'dot off unk' };
const FAM_CHK = { answered: 'answered', started: 'started (counts as on)', no_answer: 'no answer', hotspot_offline: 'not sent, hotspot offline' };
function famSay(t) { addChat('', t, 0, true); }
function rosterNow() { return pcRoster({ roster: famRoster }); }
function famLabel(call, who) { return String(call || '?') + (who ? ' (' + who + ')' : ''); }
function famStrip(t) { return String(t == null ? '' : t).trim().replace(/[.\s]+$/, ''); }
/* gw _hs_ago style: 45 s, 12 min, 1 h 32 min, 18 d 3 h */
function famAgo(s) {
  s = Math.max(0, Math.floor(+s || 0));
  if (s < 90) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
  return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
}
/* D5: "2:14 PM PT" on the same PT day as the server's now, else "Oct 25 2:14 PM PT" */
function famClock(ts, now) {
  try {
    const t = new Date(ts * 1000), n = new Date(now * 1000);
    const day = function (d) { return d.toLocaleDateString('en-US', { timeZone: FAM_TZ }); };
    const hm = t.toLocaleTimeString('en-US', { timeZone: FAM_TZ, hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ');
    return (day(t) === day(n) ? '' : t.toLocaleDateString('en-US', { timeZone: FAM_TZ, month: 'short', day: 'numeric' }) + ' ') + hm + ' PT';
  } catch (e) { return '?'; }
}
function rsNow() { return rs && rs.ok && typeof rs.now === 'number' ? rs.now + (performance.now() - rsAt) / 1000 : null; }
function famRec(e) { return rs && rs.ok && rs.radios && e ? (rs.radios[String(e.id)] || null) : null; }
function famAge(ts) { const n = rsNow(); return n == null || typeof ts !== 'number' ? null : Math.max(0, n - ts); }
/* D6 dot, first match wins: on / off (hotspot offline) / quiet (hotspot on) / unk */
function famDot(e) {
  const r = famRec(e);
  if (!r) return 'unk';
  const rf = r.last_rf, lc = r.last_check;
  if (rf && famAge(rf.ts) !== null && famAge(rf.ts) <= 900) return 'on';
  if (lc && (lc.result === 'answered' || lc.result === 'started') && famAge(lc.ts) !== null && famAge(lc.ts) <= 900) return 'on';
  if (r.hotspot && r.hotspot.online === false) return 'off';
  if (r.hotspot && r.hotspot.online === true) return 'quiet';
  return 'unk';
}
/* `radios` (D5): one line per roster radio */
function famRadiosLines() {
  if (!rs || !rs.ok) return ["Family radio state isn't available right now."];
  const now = rsNow(), out = ['=== FAMILY RADIOS ==='];
  rosterNow().forEach(function (e) {
    const r = famRec(e), head = famLabel(e.call, e.who) + ': ' + FAM_WORD[famDot(e)];
    if (!r) { out.push(head + ' · no status yet'); return; }
    const rf = r.last_rf, lc = r.last_check, hs = r.hotspot;
    out.push([head,
      rf && typeof rf.ts === 'number' ? 'heard ' + famClock(rf.ts, now) + ' (' + famAgo(famAge(rf.ts)) + ' ago)' : 'not heard on HOLDEN yet',
      lc && typeof lc.ts === 'number' ? 'last check ' + famClock(lc.ts, now) + ', ' + (FAM_CHK[lc.result] || String(lc.result || '?')) : 'no check yet',
      hs && hs.online === true ? 'hotspot on HOLDEN' : (hs && hs.online === false ? 'hotspot offline' : 'hotspot unknown')
    ].join(' · '));
  });
  out.push('Nothing was transmitted. ON = heard or answered in the last 15 min. A quiet radio may be on another network. rc <call> checks one radio; rollcall checks all.');
  return out;
}
/* D5 rc texts for refused / done */
function rcResultText(m) {
  const lab = famLabel(m.target, m.who);
  if (m.ok && m.answered) {
    /* D6 via words (D5's answered row defers to D6): the target's own hotspot_peer -> "via his hotspot";
       another roster hotspot -> "via <CALL>'s hotspot"; via_call null -> "via peer <via>". */
    const te = m.via_call ? (rosterNow().find(function (x) { return (m.id != null && x.id === m.id) ||
      String(x.call).toUpperCase() === String(m.target || '').toUpperCase(); }) || null) : null;
    const via = m.via_call ? (te && m.via != null && Number(te.hotspot_peer) === Number(m.via) ? ' via his hotspot' : ' via ' + m.via_call + "'s hotspot")
      : (m.via != null ? ' via peer ' + m.via : '');
    return lab + ': radio ANSWERED' + (typeof m.ms === 'number' ? ' in ' + (m.ms / 1000).toFixed(1) + ' s' : '') +
      ' (try ' + (m.try || 1) + ' of ' + (m.tries_asked || 2) + ')' + via + '.' + (m.model ? ' Radio: ' + m.model + '.' : '');
  }
  if (m.ok && m.started) return lab + ": a radio STARTED to answer but the answer didn't finish (two radios on one ID can collide). Count it as on.";
  if (m.ok) {
    const n = typeof m.tries === 'number' ? m.tries : (m.tries_asked || 2);
    return lab + ': NO ANSWER after ' + n + (n === 1 ? ' try' : ' tries') +
      '. That does not mean the radio is off: it may be asleep, out of range, or on a busy channel.' +
      (m.note ? ' Note: ' + famStrip(m.note) + '.' : '') + (m.retry_skipped ? ' (A later try was not sent: ' + famStrip(m.retry_skipped) + '.)' : '');
  }
  const why = famStrip(m.reason);
  switch (m.code) {
    case 'hotspot_offline': return 'Radio check NOT sent: ' + (m.target || 'that radio') + "'s hotspot is offline, so the radio can't be reached. Nothing was transmitted.";
    case 'busy': {
      const b = why.replace(/\s*-\s*try again in a few seconds$/i, '');
      return 'Radio check NOT sent: ' + (b || 'another radio check is running') + '.' + (/try again/i.test(b) ? '' : ' Try again in a few seconds.');
    }
    case 'pending': return 'Your last radio check is still running (started on another screen or before a reconnect). Its result shows on every screen you have open; or type radios in a minute.';
    case 'cooldown': return 'One moment between radio checks (' + (m.retry_s != null ? m.retry_s : '?') + ' s).';
    case 'net': return 'Radio check NOT sent: a scheduled DMR net is on. No radio checks during a net.';
    case 'channel_busy': return "Radio check NOT sent: the family channel is busy. Try again when it's quiet.";
    case 'budget': return 'Radio check NOT sent: the send limit is full (6 a minute, shared with texts and the driveway alarm). Try again in ' + (m.retry_s != null ? m.retry_s : '?') + ' s.';
    case 'gap': return 'Radio check NOT sent: ' + (why || 'wait a few seconds between radio checks') + '.';
    case 'holden_down': return 'Radio check NOT sent: the HOLDEN login is down.';
    case 'timeout': return "No result after 100 s. It may still have gone out: type radios in a minute. Don't resend it yet.";
    case 'server_error': return "The server hit an error. The radio check may still have gone out: type radios in a minute. Don't resend it yet.";
    case 'unavailable': return "Radio checks aren't available right now (the radio-check service isn't answering). Nothing was sent.";
    case 'not_family': return "Radio check NOT sent: the radio-check service doesn't know that radio. Nothing was transmitted.";
    case 'not_allowed': return "Radio checks aren't on for this account.";
    case 'use_callsign': return m.reason || pcUsage('rc', { roster: famRoster });
    case 'bad_target': return pcUsage('rc', { roster: famRoster });
    case 'no_radio': return PC_PRESTON;
  }
  return 'Radio check failed: ' + (why || m.code || 'error') + '.';
}
function rcLostText(t) { return 'No result for the radio check after ' + t + " s. It may still have gone out: type radios in a minute. Don't resend it yet."; }
/* D1 gate for rc / rollcall, in the contract's order. null = go. */
function rcGate(flag) {
  if (!(ws && ws.readyState === 1)) return 'Not connected.';
  if (me.listen_only) return "Radio checks aren't available on a listen-only account.";
  if (!famRoster) return "Radio checks need the updated server, which isn't live yet.";
  if (!me[flag]) return "Radio checks aren't on for this account.";
  return null;
}
function doRc(call, who) {
  const no = rcGate('can_radiocheck');
  if (no) { famSay(no); return; }
  famSay('Radio check to ' + famLabel(call, who) + '... this transmits on HOLDEN. Usually about 10 s, up to about a minute and a half.');
  send({ cmd: 'radiocheck', target: call });
  pend('radiocheck', 15000, "No answer from the server for 'rc'. It may not have this command yet.");
}
function doRollcall() {
  const no = rcGate('can_rollcall');
  if (no) { famSay(no); return; }
  famSay('Roll call: checking ' + rosterNow().filter(pcCanRc).map(function (e) { return e.call; }).join(', ') +
         ' in turn. This transmits once per radio and usually takes about a minute.');
  send({ cmd: 'rollcall' });
  pend('rollcall', 15000);
}
function doPing(call) {
  if (!(ws && ws.readyState === 1)) { famSay('Not connected.'); return; }
  famSay('Pinging ' + call + '...');
  send({ cmd: 'hsping', call: call });
  pend('hsping', 20000);           // gw: master + VPS reads take up to ~14-18 s
}
function doRadios() {
  if (!(ws && ws.readyState === 1)) { famSay('Not connected.'); return; }
  if (!famRoster) { famSay("Family radio state needs the updated server, which isn't live yet."); return; }
  radiosAsked = true;
  send({ cmd: 'radiostate' });
  pend('radiostate', 10000, null, function () { radiosAsked = false; });   // a late reply then prints nothing
}
function famHello(m) {
  famRoster = Array.isArray(m.roster) ? m.roster : null;
  rs = m.radiostate && typeof m.radiostate === 'object' ? m.radiostate : null;
  rsAt = performance.now();
  const inf = m.rc_inflight;
  if (inf && typeof inf === 'object') {          // D4 reconnect: re-arm the result timer, never resend
    pendClear('radiocheck');                     // gw accepted it; that `accepted` went to the old socket
    rcRid = inf.rid || null;
    const tot = (typeof inf.timeout_s === 'number' ? inf.timeout_s : (me.rc_timeout_s || 100)) + 15;
    pend('radiocheck_result', Math.max(5, tot - (+inf.age_s || 0)) * 1000, rcLostText(tot));
    if (rcSaid !== rcRid || !rcRid) { rcSaid = rcRid; famSay('Your radio check to ' + famLabel(inf.target, inf.who) + ' is still running.'); }
  }                                              // rc_inflight null: a running result timer is left alone (D4)
  if (famRoster && m.radiostate === null) send({ cmd: 'radiostate' });   // C1/D7: gw owes it too; one ask, no print
  renderFam();
  updateChatHint();
}
function rsEvent(m) {
  const reply = m.reply === true;
  if (m.ok || !reply || m.code === 'unavailable') { rs = m; rsAt = performance.now(); }   // a not_allowed reply keeps the cache
  if (radiosAsked && reply) {                    // D5: printed once, for the reply frame; a push only redraws
    radiosAsked = false;                         // (doRadios needs a roster, so the gw always sends `reply`)
    pendClear('radiostate');
    if (m.ok) famRadiosLines().forEach(famSay);
    else famSay(m.code === 'not_allowed' && m.reason ? m.reason : "Family radio state isn't available right now.");
  } else if (reply) pendClear('radiostate');
  rollProgress();
  renderFam();
  updateChatHint();
}
function rcEvent(m) {
  if (m.phase === 'accepted') {
    const mine = !!pendT.radiocheck;
    pendClear('radiocheck');
    rcRid = m.rid || null; rcSaid = rcRid;
    const tot = (typeof m.timeout_s === 'number' ? m.timeout_s : (me.rc_timeout_s || 100)) + 15;
    pend('radiocheck_result', tot * 1000, rcLostText(tot));
    if (!mine) famSay('Radio check to ' + famLabel(m.target, m.who) + ' is running (started on another screen). Its result shows here too.');
    return;
  }
  if (m.phase === 'refused') { pendClear('radiocheck'); famSay(rcResultText(m)); return; }   // never touches radiocheck_result
  if (m.phase === 'done') {
    pendClear('radiocheck');
    if (!rcRid || !m.rid || m.rid === rcRid) { pendClear('radiocheck_result'); rcRid = null; }
    famSay(rcResultText(m));
  }
}
const ROLL_FINAL = ['answered', 'started', 'no_answer', 'hotspot_offline', 'skipped'];
const ROLL_SUM = { answered: 'answered', started: 'started', no_answer: 'no answer', hotspot_offline: 'hotspot offline', skipped: 'skipped' };
function rollRowText(row) {
  const e = rosterNow().find(function (x) { return x.id === row.id; });
  const lab = 'Roll call · ' + (e ? famLabel(e.call, e.who) : String(row.id)) + ': ';
  switch (row.state) {
    case 'answered': return lab + 'answered' + (typeof row.ms === 'number' ? ' in ' + (row.ms / 1000).toFixed(1) + ' s' : '');
    case 'hotspot_offline': return lab + 'hotspot offline, skipped (nothing sent)';
    case 'no_answer': return lab + 'no answer';
    case 'started': return lab + 'started to answer (counts as on)';
  }
  return lab + 'skipped (' + (famStrip(row.reason) || 'out of time') + ')';
}
function rollProgress() {
  const rc = rs && rs.ok ? rs.rollcall : null;
  if (!rollId || !rc || rc.id !== rollId) return;
  const rows = Array.isArray(rc.rows) ? rc.rows : [];
  rows.forEach(function (row) {
    if (row && ROLL_FINAL.indexOf(row.state) >= 0 && !rollSeen[row.id]) { rollSeen[row.id] = row.state; famSay(rollRowText(row)); }
  });
  if (rc.done) {
    const parts = ROLL_FINAL.map(function (st) {
      const n = rows.filter(function (row) { return row && row.state === st; }).length;
      return n ? n + ' ' + ROLL_SUM[st] : null;
    }).filter(Boolean);
    famSay('=== ROLL CALL DONE: ' + (parts.join(', ') || 'no rows') + ' ===');
    pendClear('rollcall_done');
    rollId = null;
  }
}
function rollEvent(m) {
  const mine = !!pendT.rollcall;
  pendClear('rollcall');
  if (m.ok) {
    rollId = m.id || null; rollSeen = {};
    pend('rollcall_done', 240000, 'Roll call: no final result after 4 min. Type radios to see the latest.');
    if (m.late) famSay('Roll call did start (its reply was late).');
    else if (!mine) famSay('A roll call started on another screen of yours. Its rows show here too.');
    rollProgress();
    return;
  }
  if (m.code === 'cooldown') famSay('One moment between roll calls (' + (m.retry_s != null ? m.retry_s : '?') + ' s).');
  else if (m.code === 'timeout') famSay("No reply from the radio-check service. A roll call may have started: type radios. Don't resend it yet.");
  else if (m.code === 'server_error') famSay("The server hit an error. A roll call may have started: type radios. Don't resend it yet.");
  else famSay('Roll call NOT started: ' + (famStrip(m.reason) || m.code || 'error') + '.');
}
/* D7 panel: one row per roster radio (dot, CALL who, heard age, last check), Ping + Radio check; Roll call below */
function famSub(e) {
  if (!rs) return 'no status yet';
  if (!rs.ok) return 'radio state unavailable';
  const r = famRec(e);
  if (!r) return 'no status yet';
  const rf = r.last_rf, lc = r.last_check;
  return (rf && typeof rf.ts === 'number' ? 'heard ' + famAgo(famAge(rf.ts)) + ' ago' : 'not heard yet') + ' · ' +
         (lc && typeof lc.ts === 'number' ? (FAM_CHK[lc.result] || String(lc.result || '?')) : 'no check yet');
}
function renderFam() {
  const box = $('famBox'), list = $('famList'), col = $('leftStack');
  if (!box || !list) return;
  if (!famRoster) { box.style.display = 'none'; if (col) col.style.flex = '0 0 140px'; return; }
  box.style.display = ''; if (col) col.style.flex = '0 0 200px';
  list.innerHTML = '';
  const canRc = !!me.can_radiocheck && !me.listen_only, canRoll = !!me.can_rollcall && !me.listen_only;
  rosterNow().forEach(function (e) {
    const d = famDot(e);
    const row = document.createElement('div'); row.className = 'famrow';
    const dot = document.createElement('i'); dot.className = FAM_DOTCLS[d]; dot.title = FAM_WORD[d];
    if (d === 'unk') dot.textContent = '?';
    const b = document.createElement('b'); b.textContent = e.call;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = e.who || '';
    const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = famSub(e);
    row.appendChild(dot); row.appendChild(b); row.appendChild(n); row.appendChild(sub);
    const pb = document.createElement('button'); pb.textContent = 'Ping'; pb.title = 'Hotspot and radio state (nothing is transmitted)';
    pb.onclick = function () { doPing(e.call.toUpperCase()); };
    row.appendChild(pb);
    if (canRc && pcCanRc(e)) {
      const rb = document.createElement('button'); rb.textContent = 'Radio check'; rb.title = 'One radio check over the air (TRANSMITS)';
      rb.onclick = function (ev) {
        this.blur();                             // never keep focus: a later Enter/Space would click it again
        if (ev && ev.detail === 0) return;       // keyboard activation: transmit buttons need a pointer click (typed rc works)
        askConfirm('Radio check ' + famLabel(e.call, e.who) + '?\n\nThis transmits on HOLDEN.', 'Radio check',
                   function () { doRc(e.call.toUpperCase(), e.who || null); }, { tx: true });
      };
      row.appendChild(rb);
    }
    list.appendChild(row);
  });
  $('famRoll').style.display = canRoll ? '' : 'none';
}
$('famRoll').onclick = function (ev) {
  this.blur();                                   // never keep focus: a later Enter/Space would click it again
  if (ev && ev.detail === 0) return;             // keyboard activation: transmit buttons need a pointer click (typed rollcall works)
  askConfirm('Roll call all family radios?\n\nThis transmits once per radio (about a minute).', 'Roll call', doRollcall, { tx: true });
};
setInterval(function () { if (famRoster) renderFam(); updateChatHint(); }, 30000);   // ages tick on the server clock
/* D8 #chathint: sms / .sms <roster call or id> and pg/<who> reachability, from the cached radiostate. A guide only. */
function chatHintText(v) {
  let m = /^\.?sms\s+(\S+)\s/i.exec(v);
  if (m) {
    const e = pcFind(m[1], { roster: famRoster });
    if (!e) return '';
    const d = famDot(e), r = famRec(e), C = e.call.toUpperCase();
    const hold = me.sms_holds ? " If it's off, the text is held and resent once when it next keys up (up to 24 h)." : '';
    if (d === 'on') {
      const ts = [r.last_rf && r.last_rf.ts, r.last_check && (r.last_check.result === 'answered' || r.last_check.result === 'started') && r.last_check.ts]
        .filter(function (x) { return typeof x === 'number'; });
      return C + "'s radio was heard " + famAgo(famAge(Math.max.apply(null, ts))) + ' ago. The text should reach it now.';
    }
    if (d === 'quiet') return r.last_rf && typeof r.last_rf.ts === 'number'
      ? C + "'s radio hasn't been heard on HOLDEN since " + famClock(r.last_rf.ts, rsNow()) + '.' + hold
      : C + "'s radio hasn't been heard on HOLDEN yet." + hold;
    if (d === 'off') return C + "'s hotspot is offline, so the text can't reach the radio now." +
      (me.sms_holds ? " It is resent once when the radio next keys up, if the radio hasn't been heard in the last 15 min." : '');
    return '';
  }
  m = /^pg\/(\S+)\s/i.exec(v);
  if (m && rs && rs.ok) {
    const t = pcPageTarget(m[1], chatCtx());
    if (!t) return '';
    const call = t.label === 'ME' ? String(me.call || '') : String(t.label);
    const e = pcFind(call, { roster: famRoster });
    if (!e || famDot(e) === 'on') return '';
    return e.call.toUpperCase() + "'s radio hasn't been heard lately. The page goes to their phone now; the Call Alert rings the radio only if it's on.";
  }
  return '';
}
function updateChatHint() {
  const el = $('chathint'), box = $('chatin');
  if (!el || !box) return;
  let t = '';
  try { t = chatHintText(String(box.value || '')); } catch (e) { t = ''; }
  el.textContent = t;
}
/* ==== FAMILY-END ==== */
  return { pend: pend, pendClear: pendClear, pendT: pendT, renderKV: renderKV, chatCtx: chatCtx,
    famHello: famHello, rsEvent: rsEvent, rcEvent: rcEvent, rollEvent: rollEvent, renderFam: renderFam,
    updateChatHint: updateChatHint, rcGate: rcGate, doRc: doRc, doRollcall: doRollcall, doPing: doPing,
    doRadios: doRadios, famSay: famSay, famLabel: famLabel, famAgo: famAgo, rosterNow: rosterNow,
    setRoster: function (r) { if (Array.isArray(r)) famRoster = r; renderFam(); updateChatHint(); },
    hasRoster: function () { return !!famRoster; } };
}
var HC={ parseChatLine: parseChatLine, pcUsage: pcUsage, pcRoster: pcRoster, pcIsCall: pcIsCall,
  PC_ROSTER_BUILTIN: PC_ROSTER_BUILTIN, PC_PRESTON: PC_PRESTON, PC_NOLH: PC_NOLH,
  setMe: function (m) { me = m && typeof m === 'object' ? m : {}; }, getMe: function () { return me; },
  initFamily: function () { if (!HC.fam) HC.fam = famInit(); return HC.fam; }, fam: null };
if(typeof window!=='undefined')window.HoldenCmd=HC;
if(typeof module!=='undefined'&&module.exports)module.exports=HC;
})();
