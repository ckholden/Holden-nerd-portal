# Holden Nerd Portal

Christian Holden's personal family hub at **holdenportal.com**. Static site on GitHub Pages.

## Stack

- Static HTML/CSS/JS — no build pipeline for main portal
- **Firebase** (Auth v10 Google Sign-In, Realtime Database, Storage)
- **Leaflet.js** for APRS tracker
- `kj7dts-log` + `kk7ion-log` are pre-built Vite/React bundles (source in separate repos)
- GitHub Actions Go poller (`dc911-proxy.yml`) polls Deschutes County 911 every 5 min → HOSCAD Supabase

## Auth

- ⚠ **`portal-auth.js` is client-side gating, NOT access control.** This repo is public and GitHub Pages serves every file in it to any requester, so **anything committed here is world-readable regardless of the login** — directly fetchable at its raw URL and readable in the repo itself. The gate hides pages from casual visitors and keeps the UI tidy; it does not decide what the server hands out. **If something must actually be private, it cannot live in this repo** — put it behind `878api.py`/`gw.py` on kj7dts-server, which do real server-side token checks (that is exactly why the 878 codeplug data is `.gitignore`d and served from the server instead). Never let "the portal requires a login" justify relaxing anything.
- Auth gate pattern: every protected page hides `<html>` via `visibility:hidden` until Firebase Auth resolves, then redirects unauthorized to `/portal-login?next=...`
- Approved accounts in `portal-auth.js` allowlist (9 family members + Christian)
- Firebase project: `holden-portal`; DB: `https://holden-portal-default-rtdb.firebaseio.com`
- `orfireems/` is intentionally public (no auth gate). Deployed byte-identical to `scmc.hoscad.net/cadview` too (see the file's own header comment + `sync-cadview.sh`) — that copy runs behind a stricter CSP (`hoscad-board/_headers`, unpkg-only, no `firebaseio.com`), so anything new added here that depends on a domain outside that allowlist must gate on `!IS_SCMC` or extend the CSP. **TODO idea (not yet built):** cross-reference wildfire data via Google Maps API's wildfire/crisis layer + InciWeb (inciweb.wildfire.gov) alongside the existing NIFC WFIGS layer.
- `spanish/` uses Firebase email/password auth separately from portal's Google auth
- DC911 proxy secrets in GitHub Actions repo secrets (not in code)

## Sub-apps

| Folder | What it is | Auth |
|--------|-----------|------|
| `home/` | Hub dashboard with nav cards | Portal |
| `aprs/` | KJ7DTS APRS iGate tracker (Leaflet, Firebase) | Portal |
| `spanish/` | Maestra Lupita Spanish tutor (full PWA) | Firebase email/pass |
| `weather/` | Powell Butte weather (Apps Script iFrame) | Portal |
| `weathercorb/` | Corbett weather (WeatherLink embed) + a **Net Report** button — read-aloud summary for radio nets. The embed exposes no data, so the report is fed by the holdenwx Apps Script `?corbett=1`, which reads Dad's DW9403 APRS weather beacon via aprs.fi server-side (`APRSFI_API_KEY` in Script Properties). | Portal |
| `orfireems/` | Oregon Fire/EMS CAD live tracker | **Public** |
| `home-dashboard/` | Family shared dashboard (todos, messages, photos) | Portal |
| `cadradio/` | CAD Radio PWA | Portal |
| `kj7dts-log/` | KJ7DTS ham radio log (pre-built React/Vite) | Portal |
| `kk7ion-log/` | KK7ION ham radio log (pre-built React/Vite) | Portal |
| `bsn9b/` | Nursing documentation tool | Local hardcoded creds |
| `radio/` | Radio tools | Portal |
| `dmrptt/` | **DMR PTT web walkie-talkie** (TGIF DMR, no hotspot) — has a server-side component; full details in the **local, git-ignored** `dmrptt/CLAUDE.md` + `dmrptt/HANDOFF.md` | Own `/dmrptt` Firebase gate (Google + email-link), separate from the portal allowlist |
| `878/` + `878/codeplug/` | **878 codeplug search + download** — search the shared AnyTone 878 DMR codeplug by channel/frequency/talkgroup, plus per-person download zips **per radio model** (Chris has both an 878 and a GD-168; Pete has only an 878 — `878api.py`'s `AVAILABLE_RADIOS` map controls who sees which download button). **App shell only lives here** (`878/index.html`, `878/codeplug/index.html`, `878/portal-auth-878.js` — static, public-safe, no sensitive data). The actual data (`data.json` + zips) is **deliberately NOT committed to this repo** (`.gitignore`'d) — GitHub Pages has no real access control, so anything here is de facto public regardless of the login gate. Data is served instead by `878api.py` on kj7dts-server (Flask, systemd `878api.service`, port 8099, Tailscale-served at path `/878` on the existing port-443 funnel alongside dmrptt — routes are `/data.json`, `/download/<key>/<radio>.zip`, `/whoami`, all with the `/878` prefix stripped by Tailscale before reaching Flask), gated by a verified Firebase ID token (same approach as `dmrptt`'s `gw.py`). Regenerated + deployed via `878/codeplug/export.py` (reads live from `OneDrive\radio\878\Christian KJ7DTS\` for the search index, plus each person's own 878/GD-168 folders for their zips; scp's straight to the server) — **run it after any codeplug-editing session on either radio**, see the radio project's own `CLAUDE.md` for the exact trigger rule. | Own `/878/portal-auth-878.js` Firebase gate for the page (UX only) + real server-side token check in `878api.py` for the data itself. Narrower allowlist than the portal (just Christian/KJ7DTS + Chris/KK7ION + Pete/KK7RBQ) |
| `svr/` + `svr/dmr/` | Home-server health dashboard + owner-only controls (digi/radio-mode/**PNW network** toggles, per-service restart, AI ops chat, terminal link) — all commands write to Firebase `aprs/control/*`, applied server-side by `aprs-control.py` on kj7dts-server (full detail in that project's CLAUDE.md) | Portal, controls owner-gated (`christiankholden@gmail.com`) |
| `dmr/` | **DMR hub** — landing page linking `dmrptt/`, `svr/dmr/`, `878/`, and `878/codeplug/`. Linked from a tile on the main portal homepage (both `index.html` and `home.html` — **keep those two files identical**, they're meant to be twins and have drifted once already). | Portal |
| `dmr/guide/` | **User guide** — one page, four sections (DMR PTT, Codeplug Search, DMR Monitor, AnyTone 878 radio). References 878 zones by **name only, never by number** (numbers differ per radio and shift with every codeplug edit) so routine codeplug changes don't require a guide update. **Update it when:** a tool gains/loses a real feature, the 878's shortcut-button (PF1-3/P1-2) layout changes, a home zone gets renamed, or the TG cheat-sheet/calling-procedure content changes — not for routine channel/zone additions. Bump the "Last updated" date at the top when edited. | Portal |
| `dmr/desktop/` | **"Holden DMR"** — a 2002-era-styled desktop PTT + chat client (`index.html`) and a matching CAD-styled monitor window (`monitor.html`), started 2026-08-13 (plan: `~/.claude/plans/fancy-marinating-hamster.md`). Shares `dmrptt`'s `gw.py` backend rather than forking it — no server-side duplication. `index.html`: full PTT UI + a NetLogger-style single-room chat (`.help`/`/cls`/`!lh`/`pg/`/`@mention`/`@sms` bot commands riding the gateway's `chat`/`lh`/`page` WS commands), busy-channel TX lockout tied to real incoming audio (not a timer), an "on air" indicator that tracks actual PCM arrival rather than decaying off a single event. `monitor.html`: full multi-tier map resolver (repeater→home city→state→country) ported from `svr/dmr/index.html`, day-rollover-aware row sort. Not yet packaged as a real Electron app (that's Phase 0 of the plan) — currently runs as a plain browser window. | Portal auth via `dmrptt`'s own gate (shares its backend/session model) |
| `portal-login/` | Google Sign-In entry point | — |

**Visual design:** `dmrptt/`, `svr/` (dashboard) + `svr/dmr/`, and `aprs/` — 5 files total (`dmrptt/index.html`, `dmrptt/bulletins.html`, `svr/index.html`, `svr/dmr/index.html`, `aprs/index.html`) — share a "v2" HOSCAD-dispatch-terminal CSS reskin shipped 2026-07-15 (dark terminal palette, monospace, flat controls; existing JS/DOM untouched). Standing rule: `dmrptt/` and `svr/dmr/` always get visual upgrades together, never just one.

## Deployment

Auto-deploys to GitHub Pages on push to `main`. CNAME: `holdenportal.com`. No Node/Railway/Vercel.

- **Shared local checkout gotcha:** this repo's local clone isn't exclusive to one session — a concurrent session working an unrelated branch in the same clone can silently leave the checkout switched off `main`, so a commit lands on the wrong branch and `git push origin main` no-ops without erroring (it just pushes whatever local `main` already points to). Always confirm `git branch --show-current` says `main` before pushing.

## Key conventions

- No package.json at repo root — static files only
- `robots.txt` disallows all crawlers (private portal)
- Pre-built React bundles (`kj7dts-log`, `kk7ion-log`): only compiled assets here, source is separate
- Weather Underground API key is in Google Apps Script Script Properties (not in repo)

## Firebase egress — read before adding any listener or poll

**Egress is billed per byte *delivered*, not per byte *changed*.** Before adding any subscription or poll, state the delivered-bytes-per-actual-change ratio and what multiplies it.

**⚠ The mechanism — measured 2026-08-06, correcting an earlier version of this note that got it wrong.** A `.on('value')` listener on a parent node delivers the whole node **once, at attach**. After that, RTDB sends only the **changed child** — measured at ~184 B average across 16 real `dmr_catalog` writes, *not* the 24,362 B parent. So `.on('value')` is **not** inherently expensive, and "it re-sends the whole node on every write" is false.

**It becomes expensive when the writer REPLACES the whole node** instead of updating individual children. Then the changed child *is* the entire node, and every write costs a full payload to every attached listener. That is exactly what the DMR collectors do (`put(obj)` → whole-node `set()`), and it is why the feed nodes cost 43 MB/hour/viewer while the catalog — same listener type, per-child writes — costs fractions of a cent.

**Rule:** never attach `.on('value')` to a node whose writer does a whole-node `set()`. Per-child updates are cheap. Use `.once()` for look-back data, per-child listeners for live data, or a self-hosted push feed.

**The multiplier is `viewers × writes`, and it's the number nobody counts.** A per-event cost that looks like a rounding error becomes a budget event once something multiplies it. June's multiplier was Roku devices; August's was open browser tabs.

This rule has been paid for twice:

- **June 2026** — *pull-side.* `holden-home-roku`'s `PhotoScreen.brs` re-assigned `m.photoImage.uri` on a 10 s timer, re-downloading a full-size Storage image that hadn't changed. Fixed by throttling the fetch to 300 s.
- **2026-08-02** — *push-side, and note there was no timer at all.* `/svr/dmr` held `.on('value')` on `aprs/svr/dmr|pnw|bm` (measured 3,227 + 17,130 + 19,372 = **39,729 B**). The client never re-fetched anything — RTDB re-sent the entire node on every collector write, ≈**43 MB/hour per open tab**, which burned the month's budget in ~36 hours. Fixed by moving the feeds to the self-hosted `dmrfeed` SSE service (`cf468ef`).
- **2026-08-05 — a NON-incident, kept here as the counter-example.** `aprs/svr/dmr_catalog` (**24,362 B**, 110 TGs + 246 repeaters, growing) was still on `.on('value')` and was predicted to be re-broadcasting the full node per write. **Measurement disproved that by ~130×:** 16 writes over 8 minutes delivered ~2,945 B total (~184 B each), because the catalog is written **per child**. Converted to `.once()` anyway (`a17677e`) — structurally tidier, but the real saving is fractions of a cent per month, not the 24 KB × writes that was predicted. **The lesson is the measurement, not the fix:** the same listener type on two nodes differed by two orders of magnitude purely because of how each node is *written*.

**Why the rule is phrased around bytes and not timers:** "something on a timer re-fetching unchanged data" describes June exactly and **would have missed August entirely**, which had no timer. Pull-side and push-side look nothing alike in code; they're identical on the invoice.

**Working counter-example in the same file:** `svr/dmr/index.html` fetches `aprs/svr/tg_stats` with `.once('value')` and a comment explaining that it's a look-back summary, not a live feed. Copy that shape.

**Do NOT "fix" these — they are correct as-is:** `aprs/control/state` and `aprs/svr/watch` are small, low-churn nodes that genuinely need to be live. The SSE fallback feeds in `startFirebaseFeeds()` only attach when SSE fails. As of 2026-08-05 these are the only persistent `.on('value')` listeners left in the portal, and the sweep for this class is complete.

## Memory system

Facts stored under `holden-portal` namespace in `C:\Users\Christian\Documents\Nerd\temporal-memory\`.
