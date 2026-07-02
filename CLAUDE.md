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
- `orfireems/` is intentionally public (no auth gate)
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
| `svr/` + `svr/dmr/` | Home-server health dashboard + owner-only controls (digi/radio-mode/**PNW network** toggles, per-service restart, AI ops chat, terminal link) — all commands write to Firebase `aprs/control/*`, applied server-side by `aprs-control.py` on kj7dts-server (full detail in that project's CLAUDE.md) | Portal, controls owner-gated (`christiankholden@gmail.com`) |
| `portal-login/` | Google Sign-In entry point | — |

## Deployment

Auto-deploys to GitHub Pages on push to `main`. CNAME: `holdenportal.com`. No Node/Railway/Vercel.

## Key conventions

- No package.json at repo root — static files only
- `robots.txt` disallows all crawlers (private portal)
- Pre-built React bundles (`kj7dts-log`, `kk7ion-log`): only compiled assets here, source is separate
- Weather Underground API key is in Google Apps Script Script Properties (not in repo)

## Memory system

Facts stored under `holden-portal` namespace in `C:\Users\Christian\Documents\Nerd\temporal-memory\`.
