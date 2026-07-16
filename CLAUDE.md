# Holden Nerd Portal

Christian Holden's personal family hub at **holdenportal.com**. Static site on GitHub Pages.

## Stack

- Static HTML/CSS/JS — no build pipeline for main portal
- **Firebase** (Auth v10 Google Sign-In, Realtime Database, Storage)
- **Leaflet.js** for APRS tracker
- `kj7dts-log` + `kk7ion-log` are pre-built Vite/React bundles (source in separate repos)
- GitHub Actions Go poller (`dc911-proxy.yml`) polls Deschutes County 911 every 5 min → HOSCAD Supabase

## Auth

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
| `weathercorb/` | Corbett weather | Portal |
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

## Memory system

Facts stored under `holden-portal` namespace in `C:\Users\Christian\Documents\Nerd\temporal-memory\`.
