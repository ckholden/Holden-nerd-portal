/* Holden On Line — service worker registration.
 * Split into its own file (not an inline <script>) because this page's CSP is
 * script-src 'self' with no 'unsafe-inline' — see index.html's own CSP comment. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {
      /* non-fatal — no install prompt, app still works as a plain tab */
    });
  });
}
