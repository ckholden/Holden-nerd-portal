(function () {
  "use strict";

  // ---- 1. Config: every platform-specific value lives here, nowhere else ----
  var PLATFORMS = {
    win: {
      label: "Windows", detectedLabel: "Windows",
      available: true,
      file: "HoldenOnLine-Setup-0.1.8.exe", version: "0.1.8",
      size: "75.6 MB (79,315,777 bytes)", requires: "Windows 10 or 11, 64-bit",
      sha256: "051f9410dbe27c552fc740b385d362dfd5d9c985c9c31df0d9077522ecb0e8ef",
      href: "https://github.com/ckholden/Holden-nerd-portal/releases/download/hol-v0.1.8/HoldenOnLine-Setup-0.1.8.exe",
      hashCmd: "Get-FileHash .\\HoldenOnLine-Setup-0.1.8.exe -Algorithm SHA256",
      guideHref: "download/install.html",
      guideSub: "Six steps with pictures, including the blue “Windows protected your PC” warning and which button to click.",
      steps: [
        "<b>Download</b> the installer using the button above.",
        "Run it. Windows will say <b>“Windows protected your PC.”</b> That is SmartScreen noticing the installer isn’t code-signed, not a virus warning. Click <b>More info</b>, then <b>Run anyway</b> (<a href=\"download/install.html\">pictures in the guide</a>).",
        "<b>Work through the install screens</b> — Next, Install, Finish. Leave the settings as they are.",
        "<b>Create a screen name.</b> Holden On Line opens to the Sign On window; click <b>Get a Screen Name</b> and pick the name everyone will see you as.",
        "<b>You’ll need the Holden On Line password</b> to do that. It isn’t published anywhere — ask whoever invited you."
      ]
    },
    mac: {
      label: "Mac", detectedLabel: "a Mac",
      available: false,   // <<< FLIP TO true THE NIGHT THE .dmg SHIPS. See CHANGELOG/HANDOFF for the release step.
      // While available is false, Mac gets the real working alternative below (the
      // browser app) instead of a flat "coming soon" — unlike mobile, which has no
      // working alternative yet. Delete this whole block the night the .dmg ships;
      // the native install becomes strictly better (real app, notifications, etc.)
      // and this stops being the honest answer for a Mac visitor.
      webapp: {
        href: "app/",
        note: "The full native app isn&rsquo;t built for Mac yet &mdash; but Holden On Line already runs great as a browser app today.",
        steps: [
          "<b>Safari</b> (recommended): open the link, then <b>File &rarr; Add to Dock</b>. It installs like a real app, own icon, own window.",
          "<b>Chrome/Edge</b>: open the link, then click the install icon in the address bar (or the &#8942; menu &rarr; <b>Install Holden On Line&hellip;</b>).",
          "Either way, you land on the Sign On screen &mdash; <b>you'll need the Holden On Line password</b> from whoever invited you."
        ]
      },
      file: "HoldenOnLine-0.1.8.dmg", version: "0.1.8", size: "",
      requires: "macOS 12 Monterey or later (Apple Silicon & Intel)",
      sha256: "", href: "",
      hashCmd: "shasum -a 256 ~/Downloads/HoldenOnLine-0.1.8.dmg",
      guideHref: "download/install.html#mac",
      guideSub: "Covers the macOS “unidentified developer” warning and which button to click.",
      steps: [
        "<b>Download</b> the .dmg using the button above.",
        "Open it and <b>drag Holden On Line into Applications.</b>",
        "The first time you launch it, macOS will say it <b>can’t verify the developer.</b> Right-click the app → <b>Open</b> → <b>Open</b> again to confirm.",
        "<b>Create a screen name</b> from the Sign On window.",
        "<b>You’ll need the Holden On Line password</b> — ask whoever invited you."
      ]
    }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- 2. Detection: device class first, then desktop OS ----
  function detect() {
    try {
      var uaData = navigator.userAgentData;
      var ua = navigator.userAgent || "";
      var coarseNoHover = false;
      try {
        coarseNoHover = window.matchMedia &&
          window.matchMedia("(pointer: coarse) and (hover: none)").matches;
      } catch (e) {}

      var isMobile =
        (uaData && typeof uaData.mobile === "boolean" && uaData.mobile) ||
        /Android|iPhone|iPod|Mobile|IEMobile/i.test(ua) ||
        /iPad/i.test(ua) ||
        coarseNoHover; // catches iPadOS Safari, which reports UA as "Macintosh" with no "iPad" token since iOS 13

      if (isMobile) return "mobile";

      var platform = (uaData && uaData.platform) || navigator.platform || "";
      if (/win/i.test(platform) || /Windows/i.test(ua)) return "win";
      if (/mac/i.test(platform) || /Mac OS X|Macintosh/i.test(ua)) return "mac";
      return null; // Linux desktop, ChromeOS, hardened/spoofed UA — don't guess
    } catch (e) {
      return null;
    }
  }

  // ---- 3. Render: desktop template branches on .available; mobile is always "not built" ----
  function renderDesktop(key) {
    var p = PLATFORMS[key];
    var html;
    if (p.available) {
      html =
        '<div class="dlwrap">' +
          '<a class="btn btn-big" href="' + escapeHtml(p.href) + '">Download Holden On Line</a>' +
          '<div class="dlnote">Version ' + escapeHtml(p.version) + ' &nbsp;&middot;&nbsp; ' +
            escapeHtml(p.size) + ' &nbsp;&middot;&nbsp; <b>Requires ' + escapeHtml(p.requires) + '</b></div>' +
        '</div>' +
        '<div class="guide">' +
          '<b>First time installing something like this?</b> ' +
          '<a href="' + escapeHtml(p.guideHref) + '">Read the step&#8209;by&#8209;step install guide &raquo;</a>' +
          '<div class="guidesub">' + p.guideSub + '</div>' +
        '</div>' +
        '<div class="sunken"><table class="specs">' +
          '<tr><th>File</th><td>' + escapeHtml(p.file) + '</td></tr>' +
          '<tr><th>Version</th><td>' + escapeHtml(p.version) + '</td></tr>' +
          '<tr><th>Size</th><td>' + escapeHtml(p.size) + '</td></tr>' +
          '<tr><th>Requires</th><td>' + escapeHtml(p.requires) + '</td></tr>' +
          '<tr><th>SHA&#8209;256</th><td class="hash">' + escapeHtml(p.sha256) + '</td></tr>' +
        '</table><p class="hint">To check the file after downloading, open ' +
          (key === "mac" ? "Terminal" : "PowerShell in your Downloads folder") +
          ' and run <span class="hash">' + escapeHtml(p.hashCmd) +
          '</span> &mdash; the answer should match the line above, character for character.</p></div>' +
        '<ol class="steps">' + p.steps.map(function (s) { return "<li>" + s + "</li>"; }).join("") + '</ol>';
    } else if (p.webapp) {
      html =
        '<div class="dlwrap">' +
          '<a class="btn btn-big" href="' + escapeHtml(p.webapp.href) + '">Open Holden On Line</a>' +
          '<div class="dlnote">Runs in your browser &mdash; no install required to start</div>' +
        '</div>' +
        '<div class="guide">' +
          '<b>' + p.webapp.note + '</b>' +
        '</div>' +
        '<div class="sunken"><ol class="steps">' +
          p.webapp.steps.map(function (s) { return "<li>" + s + "</li>"; }).join("") +
        '</ol></div>';
    } else {
      html =
        '<div class="sunken" style="text-align:center;padding:14px 10px">' +
          '<button type="button" class="btn btn-big" disabled aria-disabled="true">Coming soon</button>' +
          '<p class="hint" style="margin-top:8px">Holden On Line for ' + escapeHtml(p.label) +
          ' is on the way &mdash; check back soon, or pick Windows above to see what&rsquo;s available today.</p>' +
        '</div>';
    }
    document.getElementById("platcontent").innerHTML = html;
    document.getElementById("statusVer").textContent = "v" + p.version;
  }

  function renderMobile() {
    document.getElementById("platcontent").innerHTML =
      '<div class="sunken" style="text-align:center;padding:14px 10px">' +
        '<button type="button" class="btn btn-big" disabled aria-disabled="true">Not available yet</button>' +
        '<p class="hint" style="margin-top:8px">There&rsquo;s no phone or tablet app yet. For now, set up Holden On Line on a Windows or Mac computer &mdash; the buttons above still work if you want to check.</p>' +
      '</div>';
  }

  function render(key) {
    if (key === "mobile") renderMobile();
    else renderDesktop(key);
  }

  // ---- 4. Pill wiring: always-live manual override, every state ----
  var pills = Array.prototype.slice.call(document.querySelectorAll(".pill"));
  function selectPlatform(key, opts) {
    opts = opts || {};
    pills.forEach(function (btn) {
      btn.setAttribute("aria-checked", String(btn.getAttribute("data-plat") === key));
    });
    render(key);
    var note = document.getElementById("detectnote");
    if (opts.fromDetection) {
      note.textContent = "Looks like you're on " +
        (key === "mobile" ? "a phone or tablet" : PLATFORMS[key].detectedLabel) +
        ". Not right? Pick a platform above.";
    } else if (opts.manual) {
      note.textContent = "Showing " + (key === "mobile" ? "Mobile" : PLATFORMS[key].label) + " options.";
    }
  }

  pills.forEach(function (btn) {
    btn.addEventListener("click", function () {
      selectPlatform(btn.getAttribute("data-plat"), { manual: true });
    });
  });

  // ---- 5. Initial detection ----
  var guess = detect();
  if (guess === "win") {
    // Default markup + default detectnote text already say "Windows detected" and the
    // Windows pill is already aria-checked="true" in the raw HTML — nothing to do.
  } else if (guess) {
    selectPlatform(guess, { fromDetection: true });
  } else {
    document.getElementById("detectnote").textContent = "Pick your platform above to see the right download.";
    // guess is null: leave the server-rendered Windows content exactly as-is rather than
    // asserting a platform detection isn't sure about.
  }
})();
