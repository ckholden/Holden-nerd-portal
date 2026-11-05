// KJ7DTS-13 callsign gate (Christian, 11-05). A speed bump, not a lock: callsigns are public and so is the weather page.
// US calls are checked with the FCC data at callook.info; other countries' calls are checked for shape only.
// The callsign is kept in this browser only (localStorage) and sent nowhere else.
(function () {
    'use strict';
    var WX = 'https://kj7dts-server.tail34c6a5.ts.net/wx/?noask=1';
    var KEY = 'kj7dts13-call';
    var US = /^(?:[KNW][A-Z]?|A[A-L])[0-9][A-Z]{1,3}$/;
    var ANY = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;
    var gate = document.getElementById('gate');
    var form = document.getElementById('callForm');
    var input = document.getElementById('call');
    var go = document.getElementById('go');
    var msg = document.getElementById('msg');
    var frame = document.getElementById('wx');

    // "KJ7DTS/M" or "VE7/KJ7DTS": the part that looks like a callsign
    function clean(raw) {
        var parts = String(raw || '').toUpperCase().replace(/\s+/g, '').split('/');
        for (var i = 0; i < parts.length; i++) if (ANY.test(parts[i])) return parts[i];
        return '';
    }

    function open(call) {
        try { localStorage.setItem(KEY, call); } catch (e) { /* private mode: ask again next time */ }
        gate.hidden = true;
        frame.src = WX;
        frame.hidden = false;
        frame.focus();
    }

    function say(text, bad) {
        msg.textContent = text;
        msg.className = bad ? 'msg bad' : 'msg';
    }

    var saved = '';
    try { saved = clean(localStorage.getItem(KEY)); } catch (e) { /* no storage */ }
    if (saved) { open(saved); return; }
    input.focus();

    form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var call = clean(input.value);
        if (!call) { say('That doesn’t look like a callsign. Try something like KJ7DTS.', true); return; }
        if (!US.test(call)) { open(call); return; }
        go.disabled = true;
        say('Checking ' + call + '…', false);
        var ctl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
        fetch('https://callook.info/' + encodeURIComponent(call) + '/json', { signal: ctl ? ctl.signal : undefined, credentials: 'omit', referrerPolicy: 'no-referrer' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)); })
            .then(function (j) {
                clearTimeout(timer);
                go.disabled = false;
                if (j && j.status === 'VALID') { open(call); return; }
                say('No current FCC license found for ' + call + '. Check the spelling and try again.', true);
            })
            .catch(function () {
                // The lookup is down or slow: let a well-formed call through rather than lock out a ham.
                clearTimeout(timer);
                go.disabled = false;
                open(call);
            });
    });
})();
