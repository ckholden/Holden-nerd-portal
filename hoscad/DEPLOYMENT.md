# HOSCAD/EMS Tracking System - Deployment Guide

## Overview

This deployment separates the frontend from the Google Apps Script backend:
- **Dispatch Board**: Static HTML/CSS/JS hosted at holdenportal.com/hoscad
- **Field App (HOSCADField)**: Static HTML/JS hosted at holdenportal.com/hoscadfield
- **Backend**: Google Apps Script Web App (existing)

## Step 1: Deploy the Backend API

1. Open your Google Apps Script project containing `code (1).gs`

2. The code has been updated to include `doGet()` and `doPost()` handlers that route API requests

3. Deploy as a Web App:
   - Click "Deploy" > "New deployment"
   - Select type: "Web app"
   - Execute as: "Me (your email)"
   - Who has access: "Anyone"
   - Click "Deploy"

4. **Copy the deployment URL** - it will look like:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```

## Step 2: Configure the Frontend

1. Open `api.js` in the hoscad-frontend folder

2. Update the `baseUrl` on line 11:
   ```javascript
   baseUrl: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',
   ```

3. Replace `YOUR_DEPLOYMENT_ID` with the actual ID from your deployment URL

## Step 3: Deploy to GitHub Pages

The frontend is hosted via **GitHub Pages** on the `ckholden/Holden-nerd-portal` repo in the `/hoscad` directory.

**Live URL**: https://holdenportal.com/hoscad

### Quick Deploy (copy + push)

From the project root, run these commands to deploy all frontend files:

```bash
# 1. Pull latest from the deploy repo
cd "C:\Users\chris\desktop\projects\Holden-nerd-portal"
git pull origin main

# 2. Copy dispatch board files
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\index.html"          hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\styles.css"          hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\app.js"              hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\api.js"              hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\sw.js"               hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\manifest.json"       hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\download.png"        hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\download.jpg"        hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\icon-cadradio.svg"   hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\alert-tone.mp3"      hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\tone-urgent.wav"     hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\tone-alert.wav"      hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\tone-change.wav"     hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\tone-note.wav"       hoscad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\tone-message.wav"    hoscad/

# 3. Copy HOSCADField app files
mkdir -p hoscadfield/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\field.html"          hoscadfield/index.html
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\api.js"              hoscadfield/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\sw-field.js"         hoscadfield/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\manifest-field.json" hoscadfield/manifest.json
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\tone-urgent.wav"     hoscadfield/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\download.png"        hoscadfield/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\icon-cadradio.svg"   hoscadfield/

# 4. Commit and push
git add hoscad/ hoscadfield/
git commit -m "Deploy HOSCAD + HOSCADField update"
git push origin main
```

GitHub Pages propagates within 1-2 minutes. Users should hard refresh (Ctrl+Shift+R) to clear cache.

### Deploy Repo Details

- **GitHub account**: ckholden
- **Repository**: `ckholden/Holden-nerd-portal`
- **Branch**: main
- **Directories**: `/hoscad` (dispatch board), `/hoscadfield` (field app)
- **Auth**: GitHub CLI (`gh auth login`)

### Deployed Files

```
holdenportal.com/hoscad/
├── index.html           # Main dispatch board
├── styles.css           # All styling
├── app.js               # Application logic
├── api.js               # API wrapper (contains backend URL)
├── sw.js                # Service worker (PWA)
├── manifest.json        # PWA manifest (main app)
├── download.png         # App icon (PNG)
├── download.jpg         # App icon (JPG)
├── icon-cadradio.svg    # App icon (SVG)
├── alert-tone.mp3       # Motorola MCC7500 dispatch alert (legacy)
├── tone-urgent.wav      # Triple ascending beep (messages, alerts)
├── tone-alert.wav       # Two-tone dispatch pager pattern
├── tone-change.wav      # Double chirp (unused - silent)
├── tone-note.wav        # Descending chime (unused - silent)
└── tone-message.wav     # Single chirp (unused - silent)

holdenportal.com/hoscadfield/
├── index.html           # HOSCAD Field app (built from field.html)
├── api.js               # API wrapper (same as dispatch board)
├── sw-field.js          # Field service worker (PWA)
├── manifest.json        # Field PWA manifest
├── tone-urgent.wav      # Alert tone
├── download.png         # App icon (PNG)
└── icon-cadradio.svg    # App icon (SVG)
```

## Alternative: Testing Deployment (Unblocked URL)

If `holdenportal.com` is blocked by a corporate network filter, a separate deployment
at `ckholden.github.io/hoscad` can be used for testing. This uses a separate GitHub
repo (`ckholden/hoscad`) with no CNAME file, so traffic stays on `github.io`.

- **Test URL**: https://ckholden.github.io/hoscad
- **Same backend**: Uses the same Google Apps Script API and Firebase project.
- **Same data**: All units, incidents, and messages are shared with production.
- **Setup guide**: See `TESTING-DEPLOYMENT.md` in the project root for full instructions.

---

## Step 4: Test the Deployment

1. Visit holdenportal.com/hoscad

2. Test login with existing credentials (hard refresh with Ctrl+Shift+R if cached)

3. Verify all functions work:
   - Status changes (D, DE, OS, T, AV, OOS) — no tones on board updates
   - Quick-action buttons on each row — no tones
   - Command line commands — no tones on status updates
   - New incident creation (F2 or button) — no tones
   - Messages (F4 or button) — tone on incoming messages only
   - HTMSG/HTALL — tone on incoming urgent messages only
   - ALERT banner — tone plays on alert
   - OOS Report button
   - Unit history
   - Metrics display

## Key Features

### Quick-Action Buttons
Each unit row now has clickable buttons for common status changes:
- D (Dispatch)
- DE (Enroute)
- OS (On Scene)
- T (Transporting)
- AV (Available)
- OOS (Out of Service)
- OK (Reset stale timer - only shown for OS units)
- EDIT (Open unit modal)
- UH (Unit History)

### Global Quick Actions Bar
Located below the header:
- NEW INCIDENT (F2)
- LOGON UNIT
- MESSAGES (F4)
- OOS REPORT
- OK ALL OS

### Status Summary Bar
Quick glance at fleet status showing count of units by status.

### Keyboard Shortcuts
- CTRL+K / F1 / F3: Focus command bar
- CTRL+L: Open logon modal
- F2: New incident
- F4: Open messages
- UP/DOWN: Command history
- ESC: Close dialogs

### Audio/Tone Policy
- **Status board updates**: Silent (no tones)
- **Incoming messages**: tone-urgent.wav plays
- **Incoming HT/urgent messages**: tone-urgent.wav plays
- **Alert banners**: tone-urgent.wav plays

## Step 5: Test HOSCADField

1. Visit holdenportal.com/hoscadfield
2. Enter callsign (e.g. EMS12), optionally unit info, tap CONNECT
3. Unit should appear on dispatch board as AV
4. Tap status buttons (DE, OS, T, AV) — instant update on board
5. Tap OOS — confirmation dialog should appear
6. Type `WHO` — all active units displayed
7. Type `STATUS` — own status + incident + time
8. Type `MSG STA1; TEST` — message appears on dispatch board
9. Type `NOTE; PT INFO` — note added to active incident
10. Type `ADDR MERCY` — facility info displayed
11. Type `LO` — confirmation dialog → logout
12. Dispatch assigns field unit to incident → call card appears with address prominent
13. Alert banner set from dispatch → shows prominently on field app
14. After 1800 local → auto dark mode activates
15. PWA install on mobile → works as standalone app

## Troubleshooting

### "NETWORK ERROR" on API calls
- Check that the Apps Script is deployed correctly
- Verify the deployment URL in api.js is correct
- Ensure the Apps Script has "Anyone" access

### CORS Issues
- Apps Script handles CORS automatically via JSONP/redirect
- The fetch calls use GET with redirect: 'follow' to work around CORS

### Login Not Working
- Verify Users sheet has the expected accounts
- Check browser console for error messages
- Try clearing localStorage (DevTools → Application → Local Storage → Clear)

## Notes for Microsoft Migration

When ready to migrate to Microsoft:
1. Port `code (1).gs` to Office Scripts or Azure Functions
2. Create Excel Online workbook with same 8 sheets
3. Update `api.js` baseUrl to point to new endpoint
4. Integrate with Microsoft Entra ID for auth
