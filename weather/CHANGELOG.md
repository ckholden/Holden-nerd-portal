# Weather Page Changelog

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
