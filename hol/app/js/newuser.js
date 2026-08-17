/*
 * Holden On Line — browser client: self-registration.
 * Calls the server's existing /api/precheck and /api/register — both already built and
 * used by the desktop app's signup wizard; no server-side changes needed for this page.
 * ⚠ precheck() and registerAccount() share ONE validator (screenNameRefusal()) server-side
 * specifically so this page can never be told a name is free and then have it refused at
 * the end — see server.js's own "LAUNCH BLOCKER B3" comment. Do not second-guess a
 * precheck "available" result with any client-side re-validation beyond basic shape.
 */
(function () {
  'use strict';

  var CFG = window.HOL_CONFIG;
  var $ = function (id) { return document.getElementById(id); };

  var form = $('newuserForm'), fGate = $('fGate'), fScreenName = $('fScreenName'),
      fPassword = $('fPassword'), fPassword2 = $('fPassword2'),
      nameStatus = $('nameStatus'), nameSuggest = $('nameSuggest'),
      formErr = $('formErr'), formStatus = $('formStatus'),
      btnCreate = $('btnCreate'), successBox = $('successBox'), goSignOn = $('goSignOn');

  var nameChecked = null; // last screenName string that precheck confirmed available

  function api(path, body) {
    return fetch(CFG.SERVER_HTTP_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function checkName() {
    var gate = fGate.value.trim();
    var sn = fScreenName.value.trim();
    nameSuggest.textContent = '';
    formErr.textContent = '';
    if (!gate || !sn) { nameStatus.textContent = ''; nameStatus.className = 'hint'; return; }
    nameStatus.textContent = 'Checking…';
    nameStatus.className = 'hint';
    api('/api/precheck', { invite: gate, screenName: sn }).then(function (res) {
      if (res.ok && res.available) {
        nameChecked = sn;
        nameStatus.textContent = '✓ Available';
        nameStatus.className = 'hint ok';
        return;
      }
      nameChecked = null;
      if (res.field === 'invite') {
        nameStatus.textContent = '';
        formErr.textContent = res.error || 'That invite code or password is not valid.';
        return;
      }
      nameStatus.textContent = res.error || 'Not available.';
      nameStatus.className = 'hint err';
      (res.suggestions || []).forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn suggestchip'; b.textContent = s;
        b.addEventListener('click', function () { fScreenName.value = s; checkName(); });
        nameSuggest.appendChild(b);
      });
    }).catch(function () {
      nameStatus.textContent = 'Could not reach the server to check that name.';
      nameStatus.className = 'hint err';
    });
  }

  var nameTimer = null;
  fScreenName.addEventListener('input', function () {
    nameChecked = null;
    clearTimeout(nameTimer);
    nameTimer = setTimeout(checkName, 500);
  });
  fGate.addEventListener('blur', function () { if (fScreenName.value.trim()) checkName(); });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    formErr.textContent = '';
    var gate = fGate.value.trim();
    var sn = fScreenName.value.trim();
    var pw = fPassword.value;
    var pw2 = fPassword2.value;

    if (!gate) { formErr.textContent = 'Enter the invite code or Holden On Line password.'; return; }
    if (!sn) { formErr.textContent = 'Choose a screen name.'; return; }
    if (pw.length < 8) { formErr.textContent = 'Passwords must be at least 8 characters.'; return; }
    if (pw !== pw2) { formErr.textContent = 'Those two passwords do not match.'; return; }

    btnCreate.disabled = true;
    formStatus.textContent = 'Creating account…';

    api('/api/register', { invite: gate, screenName: sn, password: pw }).then(function (res) {
      btnCreate.disabled = false;
      if (!res.ok) {
        formStatus.textContent = 'Ready.';
        formErr.textContent = res.error || 'Could not create that account.';
        return;
      }
      formStatus.textContent = 'Account created.';
      form.querySelectorAll('input, button[type=submit]').forEach(function (el) { el.disabled = true; });
      goSignOn.href = 'index.html?sn=' + encodeURIComponent(res.screenName || sn);
      successBox.style.display = '';
    }).catch(function () {
      btnCreate.disabled = false;
      formStatus.textContent = 'Ready.';
      formErr.textContent = 'Could not reach the Holden On Line server.';
    });
  });
})();
