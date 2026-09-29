/*
 * Holden On Line — browser client: the host for end-to-end encryption (0.2.0).
 * CONTRACT-ipc.md §27c; reasoning and honest limits in holden-im/SPEC-e2e.md.
 *
 * This file is the browser's equivalent of main.js's initE2E(): it loads libsodium, loads
 * the saved keys from IndexedDB into memory, and builds ONE session from the SAME
 * hol-e2e-session.js the desktop app runs (byte-identical copy — do not fork it here).
 *
 * ⚠ Loaded by the SHELL PAGE ONLY (index.html). The IM popups never load this, never hold
 *   a key, and only ever receive plaintext over postMessage.
 * ⚠ Keys in the browser are stored UNSEALED (there is no OS credential store to seal them
 *   with) and holdenportal.com is shared by every portal app. SPEC-e2e.md §1 says so.
 * ⚠ Resolves to null — never rejects — when anything fails. null means "plaintext,
 *   labeled as such", and the app keeps working.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'hol-e2e', STORE = 'kv', KEYS = ['e2eDevices', 'e2eKnown'];
  var OPEN_TIMEOUT_MS = 4000;

  var cache = {};      // the synchronous view hol-e2e-session.js reads and writes
  var db = null;       // null => storage unavailable => no key is ever made

  function openDb() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      // Some private modes leave the open request pending forever; don't wait forever.
      setTimeout(function () { finish(null); }, OPEN_TIMEOUT_MS);
      try {
        var req = global.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
        req.onsuccess = function () { finish(req.result); };
        req.onerror = function () { finish(null); };
        req.onblocked = function () { finish(null); };
      } catch (e) { finish(null); }
    });
  }

  function loadAll(handle) {
    return new Promise(function (resolve) {
      if (!handle) { resolve(false); return; }
      try {
        var tx = handle.transaction(STORE, 'readonly');
        var st = tx.objectStore(STORE);
        KEYS.forEach(function (k) {
          var r = st.get(k);
          r.onsuccess = function () {
            if (r.result && typeof r.result === 'object') cache[k] = r.result;
          };
        });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
        tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  /* ⚠ MERGED PER ACCOUNT, inside the write transaction (review F9). Every record is
   * { <account key>: ... }. Two tabs of one browser each hold their own cache; a plain
   * put() of a stale cache from tab B would erase the account tab A just created a key
   * for. So: read what's stored now, overlay only the accounts THIS tab has, write that. */
  function persist(name) {
    if (!db) return;
    try {
      var tx = db.transaction(STORE, 'readwrite');
      var st = tx.objectStore(STORE);
      var mine = JSON.parse(JSON.stringify(cache[name] || {}));
      var get = st.get(name);
      get.onsuccess = function () {
        var stored = (get.result && typeof get.result === 'object') ? get.result : {};
        st.put(Object.assign({}, stored, mine), name);
      };
      tx.onerror = function () { console.warn('[hol-e2e] could not save', name); };
    } catch (e) { console.warn('[hol-e2e] could not save', name); }
  }

  // Re-read everything from IndexedDB into the cache (called at each sign-on, so a key
  // another tab made or changed since this page loaded is the one used).
  function reload() {
    if (!db) return Promise.resolve(false);
    return loadAll(db);
  }

  function sodiumReady() {
    if (!global.sodium || !global.sodium.ready) return Promise.reject(new Error('libsodium not loaded'));
    return global.sodium.ready.then(function () { return global.sodium; });
  }

  var ready = Promise.all([sodiumReady(), openDb()]).then(function (res) {
    var sodium = res[0], handle = res[1];
    return loadAll(handle).then(function (ok) {
      db = ok ? handle : null;
      if (!global.HolE2ESession || !global.HolE2E) throw new Error('hol-e2e scripts missing');
      return global.HolE2ESession.createE2EMain({
        sodium: sodium,
        store: {
          // No OS credential store in a browser: "available" means "IndexedDB works",
          // and the key is kept as-is (CONTRACT-ipc.md §27c). Without IndexedDB, no key.
          available: function () { return !!db; },
          encrypt: function (s) { return String(s); },
          decrypt: function (s) { return String(s); }
        },
        settings: {
          read: function () { return JSON.parse(JSON.stringify(cache)); },
          write: function (patch) {
            Object.keys(patch || {}).forEach(function (k) {
              if (KEYS.indexOf(k) === -1) return;
              cache[k] = JSON.parse(JSON.stringify(patch[k]));
              persist(k);
            });
          }
        },
        log: function (event, detail) { try { console.info('[hol-e2e]', event, detail || ''); } catch (e) {} }
      });
    });
  }).catch(function (err) {
    console.warn('[hol-e2e] end-to-end encryption unavailable in this browser:', err && err.message);
    return null;
  });

  global.HolE2EWeb = { ready: ready, reload: reload };
})(window);
