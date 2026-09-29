/*
 * Holden On Line — browser client config
 * Single place to change if the server's public address ever changes.
 * ⚠ If this changes, the CSP connect-src/img-src in index.html, im.html and
 *   room.html must be updated to match — see the comment there.
 */
(function (global) {
  'use strict';
  global.HOL_CONFIG = {
    SERVER_HTTP_BASE: 'https://kj7dts-backup.tail34c6a5.ts.net',
    SERVER_WS_URL: 'wss://kj7dts-backup.tail34c6a5.ts.net',
    // 0.2.0-web: this client speaks end-to-end encryption (the server only hands E2E
    // envelopes to sessions >= 0.2.0; older ones get a "please update" placeholder).
    CLIENT_VERSION: '0.2.0-web'
  };
})(window);
