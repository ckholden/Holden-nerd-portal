# Weather - Holden Portal

The weather page for the Holden Portal. It displays weather information by embedding a Google Apps Script web app inside a full-height iframe.

## Architecture

There are **two separate pieces** that make this work:

### 1. GitHub Pages (this repo: `Holden-nerd-portal`)
- **File**: `weather/index.html`
- **What it does**: Renders the navbar, a full-viewport iframe pointing to the Google Apps Script URL, and the footer
- **Hosted at**: `holdenportal.com/weather`
- This file is just a thin wrapper — all the actual weather logic lives in Google Apps Script

### 2. Google Apps Script (separate project, not in this repo)
- **Files**: `weather.gs`, `webapp.gs`, `dashboard.html`
- **Web app URL**: `https://script.google.com/macros/s/AKfycbziArpKFV51Ly4XGss6tk1KsLuAE5ODGJhjKUKqQ-BLTH29wJJPMwVtrMll-Ta6MTStPQ/exec`
- **What it does**:
  - `weather.gs` — Fetches data from Weather Underground API on a timed trigger, writes to a Google Sheet
  - `webapp.gs` — Serves the dashboard HTML and provides JSON API endpoints (latest data, 24h series, stats, NWS forecast, NWS alerts, ALERTWest cameras, history)
  - `dashboard.html` — The full weather dashboard UI (vanilla HTML/CSS/JS)
- **Local backup**: `C:\Users\chris\desktop\projects\holdenwx\` has copies of all three files
- **Reference backup**: `weather code.txt` in the holdenwx folder contains the original working version of all code

### Data flow
```
Weather Underground API → weather.gs → Google Sheet → webapp.gs → dashboard.html (in iframe on holdenportal.com)
                                                        ↕
                                              NWS API (forecast/alerts)
                                              ALERTWest API (cameras)
```

## Dashboard Features

- Current conditions: temperature, real feel, humidity, wind (with direction arrow), pressure, rain rate
- Rain totals (today, 24h, 7d)
- Outdoor comfort and driving condition badges
- Station health indicator (online/stale/offline)
- 24h temperature sparkline
- NWS weather alerts banner
- 5-day forecast cards with hourly breakdown (condensable, 12h/24h toggle)
- ALERTWest webcam gallery with fullscreen modal viewer
- History table with CSV export
- Dark/light/auto theme toggle
- Auto-refresh every 60 seconds

## How to Update

### To change the dashboard UI:
1. Edit `dashboard.html` in the Google Apps Script editor (Extensions > Apps Script from the Google Sheet)
2. Deploy a new version: Deploy > Manage deployments > Edit > New version > Deploy
3. No changes needed on GitHub — the iframe URL stays the same

### To change the backend (data collection, API endpoints):
1. Edit `weather.gs` or `webapp.gs` in the Google Apps Script editor
2. Redeploy (same as above)

### To change the wrapper page (navbar, styling):
1. Edit `weather/index.html` in this repo
2. Commit and push to `main` — GitHub Pages will rebuild automatically

### If the Google Apps Script URL changes (after a new deployment):
1. Copy the new URL from Deploy > Manage deployments
2. Update the iframe `src` in `weather/index.html` in this repo
3. Commit and push

### To keep local backups in sync:
After making changes in Google Apps Script, copy the updated files to `C:\Users\chris\desktop\projects\holdenwx\`

## Important Notes

- **Never call the Weather Underground API directly from the browser** — it blocks CORS requests. Always go through Google Apps Script server-side.
- The Google Apps Script files (`weather.gs`, `webapp.gs`, `dashboard.html`) live **only** in Google Apps Script. The copies in `holdenwx/` are backups for reference.
- The iframe sandbox permissions (`allow-same-origin allow-scripts allow-forms allow-popups`) are required for the dashboard to function.

## Security Headers

The page sets the following via `<meta>` tags:

| Header | Value |
|---|---|
| Content-Security-Policy | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src https://script.google.com;` |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `SAMEORIGIN` |
| X-XSS-Protection | `1; mode=block` |
| Referrer-Policy | `strict-origin-when-cross-origin` |

## Script Properties (in Google Apps Script)

| Property | Description |
|---|---|
| `WU_API_KEY` | Weather Underground API key |
| `WU_STATION_ID` | PWS station ID (`KORPOWEL55`) |
| `PWS_LAT` | Station latitude (`44.1350`) |
| `PWS_LON` | Station longitude (`-120.5829`) |
| `ALERTWEST_CAM_IDS` | Camera IDs for webcam feeds |
| `ALERTWEST_SITE_IDS` | Site IDs (fallback for cameras) |
| `ALERT_EMAIL_TO` | Email for weather alerts |

## Dependencies

- **Global stylesheet** (`../styles.css`) — shared dark theme with indigo/pink gradient used across the portal
- **Google Apps Script** — the embedded endpoint serves the weather UI and data. No local JavaScript is needed
