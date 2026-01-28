# HOSCAD/EMS Tracking System — Changelog

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
| `app.js` | Application logic — commands, rendering, view state, modals, cmd hints, night mode, field status listener |
| `api.js` | API wrapper for Google Apps Script backend (fetch-based) |
| `radio.html` | Standalone CADRadio page — PTT, channels, status buttons, preset messages, incident display |
| `radio.js` | CADRadio module — Firebase PTT radio, audio, messaging, notifications |
| `sw.js` | Service worker for PWA support |
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
