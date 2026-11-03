// Day / night look for pages whose <html> has class "themed".
// Auto follows the device's light/dark setting; the masthead button can pin Day or Night
// on this device only (localStorage, nothing leaves the browser). Loaded in <head> so the
// saved choice applies before the page paints. Also fills the masthead date.
(function () {
    var KEY = 'hp-theme';
    var root = document.documentElement;
    var mode = 'auto';
    try {
        var saved = localStorage.getItem(KEY);
        if (saved === 'light' || saved === 'dark') mode = saved;
    } catch (e) { /* storage blocked: stay on auto */ }

    function apply() {
        if (mode === 'auto') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', mode);
    }
    apply();

    document.addEventListener('DOMContentLoaded', function () {
        var date = document.getElementById('mastDate');
        if (date) {
            date.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
        }

        // Frames marked data-hp-theme (the weather pages) follow this look too. The page inside listens for
        // {type: 'hp-theme', mode} from this origin and hides its own toggle once one arrives (agreed with
        // the Weather thread 11-03). Sent on frame load and on every change; nothing is saved by the frame.
        var frames = document.querySelectorAll('iframe[data-hp-theme]');
        function tellFrames() {
            Array.prototype.forEach.call(frames, function (f) {
                try {
                    f.contentWindow.postMessage({ type: 'hp-theme', mode: mode }, new URL(f.src).origin);
                } catch (e) { /* frame gone or no src: nothing to tell */ }
            });
        }
        Array.prototype.forEach.call(frames, function (f) { f.addEventListener('load', tellFrames); });
        // A frame that already finished loading (its page is cross-origin, so reading it throws) gets told now
        var ready = Array.prototype.some.call(frames, function (f) {
            try { return f.contentWindow.location.href !== 'about:blank'; } catch (e) { return true; }
        });
        if (ready) tellFrames();

        var btn = document.getElementById('themeToggle');
        if (!btn || !root.classList.contains('themed')) return;
        var LABEL = { auto: 'Auto', light: 'Day', dark: 'Night' };
        var NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
        function render() {
            btn.textContent = LABEL[mode];
            btn.setAttribute('aria-label', 'Look: ' + LABEL[mode] + '. Tap to change.');
        }
        btn.addEventListener('click', function () {
            mode = NEXT[mode];
            try {
                if (mode === 'auto') localStorage.removeItem(KEY);
                else localStorage.setItem(KEY, mode);
            } catch (e) { /* storage blocked: the change lasts until the page is left */ }
            apply();
            render();
            tellFrames();
        });
        render();
        btn.hidden = false;
    });
})();
