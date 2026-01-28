# Weather Page Changelog

## 2026-01-27 — Reverted back to Google Apps Script iframe

### What changed
- Removed the self-hosted dashboard that called Weather Underground API directly from the browser
- Restored the iframe embedding the Google Apps Script web app
- Reverted `dashboard.html` in Google Apps Script back to the original version (from `weather code.txt` reference)

### Why
The self-hosted approach (calling WU API directly from the browser) failed due to CORS restrictions — Weather Underground blocks browser-side API requests. The Google Apps Script backend is required because it makes API calls server-side where CORS doesn't apply.

The new dashboard also removed features that existed in the original:
- ALERTWest webcam gallery with modal viewer
- NWS weather alerts
- NWS 5-day forecast with hourly breakdown
- Comfort and driving condition badges with emojis
- Rain totals (today/24h/7d)
- 24h temperature sparkline
- Station health indicator
- Dark/light theme toggle
- History table with CSV export

### How the revert was done
1. Replaced `weather/index.html` on GitHub (Holden-nerd-portal) with an iframe pointing to the Google Apps Script URL
2. Replaced `dashboard.html` in Google Apps Script with the original version (copied from `weather code.txt` backup)
3. `weather.gs` and `webapp.gs` in Google Apps Script were unchanged — they were already correct
4. Redeployed the Google Apps Script web app (new version)
5. Pushed the GitHub change and GitHub Pages rebuilt automatically

### CSP update
- Changed `connect-src https://api.weather.com` back to `frame-src https://script.google.com`

---

## 2026-01-27 — Replace Google Apps Script with self-hosted dashboard

### What changed
- Removed the iframe that embedded a Google Apps Script for weather data
- Built a self-hosted weather dashboard that fetches data directly from the Weather Underground API (station `KORPOWEL55` — Powell Butte North Slope, OR)

### Details
- **API**: Weather Underground Personal Weather Station API (`api.weather.com`)
- **Data displayed**: Temperature, heat index, wind chill, wind speed/gust/direction, humidity, barometric pressure, precipitation rate/total, dew point
- **Auto-refresh**: Every 5 minutes
- **Layout**: Responsive card grid (3 columns desktop, 2 tablet, 1 mobile)
- **CSP update**: Replaced `frame-src https://script.google.com` with `connect-src https://api.weather.com`

### Why
The Google Apps Script embed was broken. Fetching directly from the WU API is simpler and removes the dependency on Google's infrastructure.
