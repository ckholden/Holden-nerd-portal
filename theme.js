// Day / night look for pages whose <html> has class "themed".
// Auto follows the device's light/dark setting; the masthead button can pin Day or Night
// on this device only (localStorage, nothing leaves the browser). Loaded in <head> so the
// saved choice applies before the page paints. Also fills the masthead date, closes the
// Weather menu on Esc or a tap elsewhere, and tucks the compact masthead away on scroll.
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

        // The weather page also reports how far it has scrolled ({type: 'hp-scroll', y}). The compact masthead
        // tucks away while it scrolls down and comes back on any scroll up, like a phone browser's address bar.
        var mast = document.querySelector('header.mast-compact');
        if (mast && frames.length) {
            var lastY = 0, away = false;
            var tuck = function (on) {
                if (on === away || (on && mast.contains(document.activeElement))) return;
                away = on;
                mast.classList.toggle('mast-away', on);
                mast.style.marginTop = on ? -mast.offsetHeight + 'px' : '';
                if (on) {
                    mast.setAttribute('inert', '');
                    Array.prototype.forEach.call(mast.querySelectorAll('details[open]'), function (d) { d.open = false; });
                } else {
                    mast.removeAttribute('inert');
                }
            };
            window.addEventListener('message', function (e) {
                var d = e.data;
                if (!d || d.type !== 'hp-scroll' || typeof d.y !== 'number' || !isFinite(d.y)) return;
                var fromFrame = Array.prototype.some.call(frames, function (f) {
                    try { return e.source === f.contentWindow && e.origin === new URL(f.src).origin; } catch (x) { return false; }
                });
                if (!fromFrame) return;
                if (d.y < 60) tuck(false);
                else if (d.y > lastY + 8) tuck(true);
                else if (d.y < lastY - 8) tuck(false);
                else return;   // a few pixels of jitter: keep comparing against the last real move
                lastY = d.y;
            });
        }

        // Menus: Esc, a tap elsewhere, or a tap into the weather frame (the window loses focus) closes them
        var menus = document.querySelectorAll('.nav-menu details');
        function closeMenus(except) {
            Array.prototype.forEach.call(menus, function (d) { if (d.open && d !== except) d.open = false; });
        }
        if (menus.length) {
            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape') return;
                Array.prototype.forEach.call(menus, function (d) {
                    if (d.open) { d.open = false; d.querySelector('summary').focus(); }
                });
            });
            document.addEventListener('click', function (e) {
                closeMenus(e.target.closest ? e.target.closest('.nav-menu details') : null);
            });
            window.addEventListener('blur', function () { closeMenus(null); });
        }

        var btn = document.getElementById('themeToggle');
        if (!btn || !root.classList.contains('themed')) return;
        var LABEL = { auto: 'Auto', light: 'Day', dark: 'Night' };
        var NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
        function render() {
            btn.textContent = LABEL[mode];
            btn.setAttribute('aria-label', 'Day or night look: ' + LABEL[mode] + '. Press to change.');
            btn.title = 'Day or night look. Auto follows the light or dark setting on this device.';
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
