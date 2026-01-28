# Weather - Holden Portal

The weather page for the Holden Portal. It displays weather information by embedding a Google Apps Script web app inside a full-height iframe.

## How It Works

- `index.html` renders a navbar, a full-viewport iframe, and a footer.
- The iframe loads a Google Apps Script endpoint that provides the actual weather data and UI.
- The iframe is sandboxed (`allow-same-origin`, `allow-scripts`, `allow-forms`, `allow-popups`) and granted the `geolocation` permission so the embedded app can request the user's location.

## Security Headers

The page sets the following via `<meta>` tags:

| Header | Value |
|---|---|
| Content-Security-Policy | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src https://script.google.com;` |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `SAMEORIGIN` |
| X-XSS-Protection | `1; mode=block` |
| Referrer-Policy | `strict-origin-when-cross-origin` |

## Dependencies

- **Global stylesheet** (`../styles.css`) - shared dark theme with indigo/pink gradient used across the portal.
- **Google Apps Script** - the embedded endpoint serves the weather UI and data. No local JavaScript is needed.

## Running Locally

Serve the project root over HTTPS (required for geolocation). Any static file server works since there is no build step:

```
npx serve ..
```

Then open `/weather` in a browser.
