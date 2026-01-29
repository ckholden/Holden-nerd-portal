# HOSCAD/EMS Tracking System — Changelog

## Role Updates, Admin Commands, Desktop Removal, Git Repo (Jan 28, 2026)

### New Roles Added
- **MGR1, MGR2** — Managers (admin access)
- **TCRN** — Transfer Center RN
- **PLRN** — Patient Logistics RN
- **IT** — Information Technology (restricted to holdenc only)
- **Removed**: MSC role

### Admin Access Control
- `ADMIN` command shows data management commands (SUPV/MGR/IT only)
- `CLEARDATA` and `PURGE` commands restricted to admin roles
- Added `isAdminRole()` helper function for role checks
- Admin roles: SUPV1, SUPV2, MGR1, MGR2, IT

### Actor Display Format Change
- Changed from `HOLDEN CHRISTOPHER@DISPATCH` to `DISPATCH/HOLDENC` (ROLE/USERNAME format)
- Updated both dispatcher and field unit login actor formats

### UI Updates
- **BOARD** header renamed to **RESOURCE BOARD**
- Login dropdown updated with new roles
- HELP text updated with new roles list

### Bug Fixes
- **WHO/WHODP stale data**: Added cache token invalidation on logout
- **Old messages on Field login**: Added `_loginTime` tracking to filter pre-login messages
- **Logout confirmation**: Added confirm dialog and API result checking
- **HELP/INFO/ADMIN dialogs closing immediately**: Fixed Enter key event handling order - input check now runs before dialog close check

### Desktop Apps Removed
- Deleted `desktop/` folder (HOSCAD Desktop)
- Deleted `desktop-cadradio/` folder (HOSCAD Field Desktop)
- Web/PWA is now the only supported method

### Documentation
- **HOSCAD-USER-GUIDE.md** — New comprehensive user manual
- **ADMIN-COMMANDS.md** — Updated with new roles
- **IT-DEPLOYMENT-GUIDE.md** — Removed radio/desktop references, updated architecture

### Git Repository
- Initialized git repo in `hoscad/` folder
- Pushed to `github.com/ckholden/hoscad-source` (private)
- Source repo now tracks: backend, frontend, documentation

### Deployment Structure
| Repo | Purpose |
|------|---------|
| `ckholden/hoscad-source` | Source code (backend, frontend, docs) |
| `ckholden/Holden-nerd-portal` | GitHub Pages deployment |

---

## Performance, PURGE Command, Auto-Update SW, Testing Deployment (Jan 28, 2026)

### Performance Improvements (app.js)
- **Polling throttle**: Reduces polling from 10s to 60s when tab is hidden (~80% less background CPU/network)
- **Skip unchanged re-renders**: Full DOM rebuild skipped if state data (units, incidents, banners, messages) hasn't changed since last poll
- **Request overlap guard**: Prevents stacking refresh requests when Google Apps Script is slow (prevents Chrome freezing)

### Radio TONE Button — 3x Repeat (radio.js)
- **TONE button plays 3 times** with 300ms gap between repeats (was 1x)

### PURGE Command (backend + frontend)
- **PURGE** command (SUPV/STA1 only): Runs immediate data cleanup and installs daily 3 AM auto-purge trigger
- Cleans: messages >7 days, sessions >7 days inactive, audit >30 days, incident audit >30 days, closed incidents >30 days
- Backend: `apiRunPurge()` endpoint added to Code.js
- Frontend: Command added to app.js with CMD_HINTS and HELP text

### Service Worker Auto-Update (index.html, radio.html, sw.js)
- **`updateViaCache: 'none'`**: Browser always checks network for new sw.js (prevents stale cache)
- **5-minute update check**: Page proactively checks for service worker updates
- **Auto-reload on activation**: Page automatically reloads when new service worker activates — no manual Ctrl+Shift+R needed
- Cache bumped to `cadradio-v8`

### Testing Deployment Guide
- **New doc: TESTING-DEPLOYMENT.md** — instructions for deploying to `ckholden.github.io/hoscad` (separate repo, no CNAME) for testing in environments where holdenportal.com is blocked by corporate network filters
- Step-by-step: repo creation, file copy, GitHub Pages setup, update workflow

### Backend Landing Page Fix
- Updated doGet() landing page URL from `/tccad` to `/hoscad`

---

## Tone Policy Update, Radio Tone Change, New URL (Jan 28, 2026)

### Tone/Audio Policy Change (app.js)
- **Status board updates are now silent**: All `beepChange()` and `beepNote()` calls produce no audio — unit status changes, incident operations, logon/logoff, ridoff, undo, ok, mass dispatch, field status updates, note banners, and sender-side message confirmations no longer play tones
- **Tones preserved only for**: incoming messages (`beepMessage`), incoming urgent/HT messages (`beepHotMessage`), and alert banners (`beepAlert`) — all play `tone-urgent.wav`
- **Sender-side message tones removed**: Sending MSG, HTMSG, MSGALL, HTALL no longer plays a confirmation tone — only the recipient hears the incoming message tone via polling

### Radio Dispatch Tone Change (radio.js)
- **TONE button now sends `tone-urgent.wav`** instead of `alert-tone.mp3` (Motorola MCC7500) — radio dispatch alert uses the same triple ascending beep as HT message notifications
- Updated `_loadToneChunks()` to fetch `tone-urgent.wav` instead of `alert-tone.mp3`

### New URL: holdenportal.com/hoscad
- **Frontend deployed to `/hoscad`** directory on GitHub Pages (previously `/tccad`)
- **Site navigation updated**: Main holdenportal.com nav now includes HOSCAD and CADRadio links
- Old `/tccad` path also updated and still functional

### Service Worker Update
- Bumped cache to `cadradio-v7` to pick up tone file change
- Added `app.js`, `styles.css`, and `manifest.json` to APP_SHELL cache list

### DEPLOYMENT.md Updated
- Reflects new `/hoscad` path, includes all tone files in deploy script, documents audio/tone policy

---

## Address Lookup, INFO Contacts, DEST Command, Audio Fixes, Radio LO (Jan 28, 2026)

### Address/Facility Lookup System
- **Backend**: New "Addresses" sheet with 97 facility entries (hospitals, urgent care, SNFs, fire stations, LE, jails, airports, air ambulance, dialysis centers)
- **Columns**: addr_id, name, address, city, state, zip, category, aliases, phone, notes
- **API endpoint**: `getAddresses(token)` returns all addresses for client-side caching
- **Client-side fuzzy search**: 3-tier matching (exact alias → starts-with → contains) across id, name, aliases, address, city
- **Custom autocomplete dropdown**: Replaces native `<datalist>` on destination inputs in unit modal and new incident modal
- **Dropdown features**: Keyboard navigation (arrows/enter/escape), mouse selection, shows `[ID] NAME — ADDRESS, CITY [CATEGORY]`
- **Board rendering**: Recognized addresses show in green with full address tooltip on hover
- **Incident queue/review**: Resolved facility names instead of raw IDs
- **ADDR command**: `ADDR` shows full directory grouped by category; `ADDR <query>` searches addresses
- **Storage convention**: Facility ID (e.g., "SCB") stored as destination value, resolved to display name on frontend

### INFO Command — Dispatch & Emergency Contacts
- **INFO** (bare): Shows quick reference with Central Oregon dispatch numbers
- **INFO DISPATCH**: DCSO, Redmond, Bend, La Pine, Prineville, Madras, Warm Springs dispatch numbers
- **INFO AIR**: Air ambulance — AirLink, Life Flight, CalStar base numbers
- **INFO OSP**: Oregon State Police dispatch and field numbers
- **INFO CRISIS**: Deschutes County crisis line, suicide hotline, 988, poison control
- **INFO POISON**: Oregon Poison Center direct line
- **INFO ROAD**: ODOT trip check and road conditions
- **INFO LE**: Law enforcement non-emergency numbers (Bend PD, Redmond PD, DCSO, Prineville PD, etc.)
- **INFO JAIL**: Deschutes, Crook, Jefferson county jail numbers
- **INFO FIRE**: Fire agency non-emergency numbers (Bend, Redmond, La Pine, Sunriver, Cloverdale, Crooked River Ranch)
- **INFO ME**: Oregon State Medical Examiner
- **INFO OTHER**: COCC campus safety, ODFW, Humane Society
- **INFO ALL**: Shows all categories
- Added to CMD_HINTS and HELP text

### DEST Command — Set Unit Location from Command Line
- **DEST <UNIT>; <LOCATION>**: Sets unit destination/location
- Resolves location against address lookup (getById → single search match → freeform text)
- Example: `DEST EMS1; SCB` resolves to recognized address "SCB"
- Example: `DEST EMS1; 1234 Main St` stores freeform text

### Auto-Copy Incident Destination to Unit
- When a unit is assigned to an incident via status command (D/DE with incident), the incident's destination is automatically copied to the unit's destination field

### Audio System Overhaul (app.js + radio.html)
- **Replaced all synthesized oscillators** with pre-rendered WAV audio files — eliminates harsh/clicky tones on mobile and desktop
- **Generated 5 WAV tone files** via Node.js (`generate-tones.js`): tone-change, tone-note, tone-message, tone-alert, tone-urgent
- **All notifications use `tone-urgent.wav`**: triple ascending beep (700→880→1047Hz) with warm harmonics and smooth envelope
- **Motorola MCC 7500 alert tone** (`alert-tone.mp3`): used exclusively by radio TONE button
- **Audio unlock on user gesture**: silent audio play on first touchstart/mousedown/keydown for mobile compatibility
- **Radio.html**: uses same `tone-urgent.wav` for urgent message alerts

### CADRadio Updates (radio.html)
- **LO command**: Typing `LO` or `LOGOUT` in radio command bar logs out of CAD, cleans up Firebase, returns to login screen
- **Address lookup**: Loads facility addresses via API after login and on auto-reconnect
- **Destination resolution**: Incident display, poll updates, and review (R) command show resolved facility names instead of raw IDs
- **HELP updated**: Added LO to command reference

### DEST Command — No Confirmation Popup
- Removed `showAlert()` popup after setting destination — just beeps and refreshes board

### LO Command Fix (radio.html)
- Wrapped logout chain in async IIFE with try/catch so `showLogin()` always runs even if API calls fail

### Service Worker Update
- Bumped cache from `cadradio-v4` to `cadradio-v6` to force refresh of stale cached files
- Added `radio.html` and all WAV tone files to APP_SHELL pre-cache list

### Desktop App Cache Fix
- Added `session.defaultSession.clearCache()` on startup to both HOSCAD and CADRadio Electron apps
- Ensures hosted web app updates (tones, code) load fresh on every launch

### Deployment
- All changes deployed to GitHub Pages (`holdenportal.com/tccad`)
- Backend deployed via clasp (Apps Script version @85+)
- Alert tone MP3 deployed for radio TONE button use

---

## Board Visuals, Night Mode, Command Hints, CADRadio Field Features (Jan 27, 2026)

### Phase A: Board Visual Improvements
- **Status badge pills**: Board status column shows colored pill (D=blue, DE=yellow, OS=red, T=purple, AV=green, etc.) followed by label text
- **Expanded stale detection**: D, DE, OS, T statuses now trigger stale warnings (was OS only). Stale banner groups by status: `"STALE D (>=30M): JC | STALE OS (>=30M): EMS1"`
- **Row hover accent**: Blue left-border highlight on board row hover with CSS transition
- **Incident type dots**: Units with incidents show a colored dot (medical=red, trauma=orange, fire=red-orange, hazmat=purple, rescue=blue) next to the INC# on the board

### Phase B: Command Bar Autocomplete
- **CMD hints dropdown**: Typing in the command bar shows matching command suggestions (max 5)
- **Keyboard navigation**: Arrow keys to navigate hints, Enter to select, Escape to close
- **24 common commands**: D, DE, OS, T, AV, OOS, BRK, F, V, SORT, DEN, NIGHT, NC, R, UH, MSG, LOGON, LOGOFF, PRESET, CLR, HELP

### Phase C: Night Mode
- **NIGHT command**: Toggles dim display (brightness 0.65, saturation 0.8) on main content
- **Toolbar button**: NIGHT button in toolbar bar, highlights when active
- **Persists**: Saved in VIEW state via localStorage, applied on page load
- **Modals excluded**: Dialogs remain at full brightness

### Phase D: CADRadio Field Improvements
- **Status update buttons** (radio.html): ENROUTE, ON SCENE, TRANSPORT, AVAILABLE buttons push status to Firebase `cadradio/statusUpdates`. Dispatcher CAD auto-applies the change with a brief notification banner.
- **Preset message buttons** (radio.html): 10-4, ENROUTE, ON SCENE, NEED HELP, TRANSPORT, CLEAR — one-tap message send
- **Incident info display** (radio.html): Shows active incident assignment (INC#, destination, type, note) from Firebase `cadradio/fieldAssignments/{callsign}`
- **Field assignment writer** (app.js): Dispatching a unit (D/DE) writes assignment to Firebase; setting AV clears it

### Phase E: UI/UX Tweaks
- **Status summary bar**: Added DE, T, F, BRK counts. Each count is clickable to filter the board. Added `quickFilter()` function.
- **Mobile PTT**: `@media (max-width: 600px)` enlarges PTT buttons (20px padding, 16px font). `@media (max-width: 400px)` switches to single-column channel grid.

### Deployment
- Updated DEPLOYMENT.md with full GitHub Pages deploy process (copy + git push)
- Deployed all frontend files including radio.html, radio.js, manifests, service worker, icons

---

## UI Overhaul (Jan 27, 2026)

### Phase 1: View State + New Commands
- Added `VIEW` state object persisted to localStorage
- New commands: `V SIDE/MSG/MET/INC/ALL/NONE`, `F <STATUS>`, `SORT`, `DEN`, `PRESET`, `ELAPSED`, `CLR`
- Row selection model: single-click to select (yellow outline), double-click to open edit modal
- Bare status code applies to selected unit (e.g., select EMS1, type `OS`)

### Phase 2: HTML Restructure
- Removed quick-actions bar (NEW INCIDENT, LOGON UNIT, MESSAGES, OOS REPORT, OK ALL OS buttons)
- Removed per-row action buttons from board
- Added toolbar bar with filter dropdowns, panel toggle buttons (INC, SIDE, MSG, MET), density button, preset buttons
- Added collapsible incident queue with click-to-collapse header
- New board columns: UNIT | STATUS | ELAPSED | DEST/NOTE | INC# | UPDATED
- Board goes full-width by default, sidebar becomes slide-out panel (320px)
- Added status summary bar (AV/D/OS/OOS/TOTAL counts)

### Phase 3: CSS Overhaul
- Removed `.statusPill`, `.unit-actions`, `.cad-btn`, `.quick-actions`, old grid layout
- Added `.board-table` (dense data grid, sticky headers, 24px rows, table-layout:fixed)
- Added `.toolbar` (flex layout, 11px, compact)
- Added `.side-panel` (slide-out with CSS transition)
- Added `.collapsible-panel` for incident queue
- Added density modes: compact (20px/11px), normal (24px/12px), expanded (30px/13px)
- Added `tr.selected` yellow outline for selected row
- Strengthened status row tints (doubled alpha values)
- Added status text color classes per code
- Added elapsed time classes (warn/critical)
- Responsive breakpoints at 980px and 700px

### Phase 4: Render Rewrite
- Rewrote `renderBoard()` without per-row button generation
- Plain text status display instead of status pills
- Added elapsed time column with `formatElapsed(minutes)` (short/long/off modes)
- Added clickable INC# links
- Applied VIEW.filterStatus and VIEW.sort
- Row selection highlight via CSS class
- Single-click = select, double-click = open edit modal
- Added `renderStatusSummary()` for status count bar
- Added helper functions: `cycleDensity()`, `applyPreset()`, `setupColumnSort()`

### Phase 5: Polish
- Updated command bar hint text
- Updated `showHelp()` with all commands documented
- All existing commands preserved
- Keyboard shortcuts maintained (F1-F4, Ctrl+K/L, Escape)

---

## Deployment to GitHub Pages (Jan 27, 2026)
- Installed GitHub CLI on system
- Authenticated as `ckholden`
- Created `/tccad` directory in `Holden-nerd-portal` repo
- Deployed frontend files: `index.html`, `styles.css`, `app.js`, `api.js`
- Live at: https://holdenportal.com/tccad

---

## Incident Panel Fixes (Jan 27, 2026)
- Renamed modal "CLOSE" button to "DISMISS" (only closes dialog)
- Added "CLOSE INCIDENT" button (resolves incident on backend via API)
- Added "REOPEN" button (reopens closed incident)
- Added `btn-warn` CSS style
- Fixed confirm dialog callback bug: `hideConfirm()` was nulling `CONFIRM_CALLBACK` before it could execute. Saved callback reference before hiding.
- Rewrote `closeIncidentAction` and `reopenIncidentAction` to execute directly (no confirm popup) for reliability

---

## Editable Incident Type (Jan 27, 2026)
- Replaced static TYPE display with editable input field in incident review modal
- Backend `apiUpdateIncident` now accepts optional `incidentType` parameter
- Type changes logged in incident audit trail as `[TYPE CHANGED TO: MED]`
- Save button sends both note and type changes
- Updated `api.js` wrapper to pass `incidentType`

---

## Flexible DEL/CAN Commands (Jan 27, 2026)
- Added `DEL` and `CAN` as aliases for closing incidents
- Accepts any order and 3 or 4 digit incident numbers:
  - `DEL 023`, `CAN 0023`, `023 DEL`, `023CAN`, `DEL INC 0023`, `CAN023`
- Auto-pads 3-digit numbers and prefixes current year

---

## Live Message Inbox + Scratch Notes (Jan 27, 2026)
- **Inbox panel**: Shows messages inline below board, auto-updates on refresh
  - Unread messages bold, urgent messages have red left border
  - Click message to mark read and pre-fill reply in command bar
  - Collapsible via header click
- **Scratch Notes panel**: Per-user notepad saved to localStorage
  - Auto-saves on every keystroke
  - Persists across page reloads, keyed by user actor
  - Collapsible via header click
- New commands: `INBOX` (open inbox), `NOTES`/`SCRATCH` (focus notepad)

---

## Complete Help Reference (Jan 27, 2026)
- Every command in `runCommand()` now has a help entry
- Expanded VIEW section: each `V` subcommand listed individually
- Added PANELS section (INBOX, NOTES/SCRATCH)
- Added `H` as alias for `HELP`
- Added `REFRESH` command (was in help but not implemented)
- Added SESSION MANAGEMENT section
- Added F4 to keyboard shortcuts
- Added REPORTS section (REPORTOOS variants)

---

## Backend Fix (Jan 27, 2026)
- Fixed `doGet()` in Google Apps Script — was referencing nonexistent `'Index (2)'` HTML file
- Replaced with simple landing page showing "BACKEND API IS RUNNING" with link to frontend

---

## Files

### Frontend (hoscad-frontend/)
| File | Purpose |
|------|---------|
| `index.html` | Main application HTML, toolbar, modals, board, panels |
| `styles.css` | All styling — dense data grid, panels, density modes, tints, night mode, badges |
| `app.js` | Application logic — commands, rendering, view state, modals, cmd hints, night mode, address lookup, autocomplete, field status listener |
| `api.js` | API wrapper for Google Apps Script backend (fetch-based) |
| `radio.html` | Standalone CADRadio page — PTT, channels, status buttons, LO command, address display, incident display |
| `radio.js` | CADRadio module — Firebase PTT radio, audio, messaging, notifications |
| `sw.js` | Service worker for PWA support (cache v6) |
| `alert-tone.mp3` | Motorola MCC 7500 dispatch alert tone (radio TONE button) |
| `tone-urgent.wav` | Triple ascending beep — used for all UI notifications |
| `tone-change.wav` | Double chirp (generated, available but not currently used) |
| `tone-note.wav` | Descending chime (generated, available but not currently used) |
| `tone-message.wav` | Single chirp (generated, available but not currently used) |
| `tone-alert.wav` | Two-tone dispatch alert (generated, available but not currently used) |
| `manifest.json` | PWA manifest (main app) |
| `manifest-radio.json` | PWA manifest (radio app) |

### Backend
| File | Purpose |
|------|---------|
| `code (1).gs` | Google Apps Script backend — all API handlers, auth, data |

### Deployment
- **GitHub repo**: `ckholden/Holden-nerd-portal`
- **Deploy directory**: `/tccad`
- **Frontend URL**: https://holdenportal.com/tccad
- **Radio URL**: https://holdenportal.com/tccad/radio.html
- **Backend URL**: Google Apps Script Web App (URL in `api.js`)
- **Deploy method**: Copy files to repo, `git push origin main` (GitHub Pages auto-deploys)
