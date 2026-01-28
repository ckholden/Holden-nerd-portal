# HOSCAD/EMS Tracking System - Deployment Guide

## Overview

This deployment separates the frontend from the Google Apps Script backend:
- **Frontend**: Static HTML/CSS/JS hosted at holdenportal.com/hoscad
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

The frontend is hosted via **GitHub Pages** on the `ckholden/Holden-nerd-portal` repo in the `/tccad` directory.

**Live URL**: https://holdenportal.com/tccad

### Quick Deploy (copy + push)

From the project root, run these commands to deploy all frontend files:

```bash
# 1. Pull latest from the deploy repo
cd "C:\Users\chris\desktop\projects\Holden-nerd-portal"
git pull origin main

# 2. Copy all frontend files to the deploy directory
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\index.html"         tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\styles.css"         tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\app.js"             tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\api.js"             tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\radio.html"         tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\radio.js"           tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\sw.js"              tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\manifest.json"      tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\manifest-radio.json" tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\download.png"       tccad/
cp "C:\Users\chris\desktop\projects\hoscad\hoscad-frontend\download.jpg"       tccad/

# 3. Commit and push
git add tccad/
git commit -m "Deploy HOSCAD frontend update"
git push origin main
```

GitHub Pages propagates within 1-2 minutes. Users should hard refresh (Ctrl+Shift+R) to clear cache.

### Deploy Repo Details

- **GitHub account**: ckholden
- **Repository**: `ckholden/Holden-nerd-portal`
- **Branch**: main
- **Directory**: `/tccad`
- **Auth**: GitHub CLI (`gh auth login`)

### Deployed Files

```
holdenportal.com/tccad/
├── index.html           # Main dispatch board
├── styles.css           # All styling
├── app.js               # Application logic
├── api.js               # API wrapper (contains backend URL)
├── radio.html           # Standalone CADRadio page
├── radio.js             # Radio module (Firebase PTT)
├── sw.js                # Service worker (PWA)
├── manifest.json        # PWA manifest (main app)
├── manifest-radio.json  # PWA manifest (radio)
├── download.png         # App icon (PNG)
└── download.jpg         # App icon (JPG)
```

## Step 4: Test the Deployment

1. Visit holdenportal.com/tccad

2. Test login with existing credentials (hard refresh with Ctrl+Shift+R if cached)

3. Verify all functions work:
   - Status changes (D, DE, OS, T, AV, OOS)
   - Quick-action buttons on each row
   - Command line commands
   - New incident creation (F2 or button)
   - Messages (F4 or button)
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
- Try clearing the token (CLEAR TOKEN button)

## Notes for Microsoft Migration

When ready to migrate to Microsoft:
1. Port `code (1).gs` to Office Scripts or Azure Functions
2. Create Excel Online workbook with same 8 sheets
3. Update `api.js` baseUrl to point to new endpoint
4. Integrate with Microsoft Entra ID for auth
