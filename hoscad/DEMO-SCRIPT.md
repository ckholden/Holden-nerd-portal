# HOSCAD Demo Script
**Hospital Computer-Aided Dispatch — St. Charles Medical Center**
_Last updated: 2026-02-25 | SW board v209 / field v57_

---

## What Is HOSCAD? (30-Second Pitch)

HOSCAD is a real-time EMS resource tracking and dispatch coordination system built specifically for St. Charles Medical Center. It gives dispatchers a live view of every ambulance unit in Central Oregon — their status, location, and assigned call — and gives field crews a mobile MDT (mobile data terminal) on their phone or tablet. Everything updates every 5–10 seconds. No radio polling required to know where your units are.

**Built for**: SCMC dispatchers, EMS supervisors, and field crews
**Scope**: 60 EMS and fire units across Central Oregon (Bend, Redmond, Prineville, La Pine, Madras, Sisters)
**Access**: Web-based. Board opens in any browser. Field app installs as a PWA on iOS or Android.

---

## Live Demo Walkthrough

> _Follow this order for a clean 10-minute demo. Use DEMO mode (Admin → Demo) to populate realistic test data without touching live incidents._

### 1. Login & Board Overview (1 min)
- Log in as dispatcher (STA1 role)
- Show the unit board: 60 units, color-coded by status (AV green, OS yellow, T blue, OOS red, etc.)
- Point out the live pill (`LIVE • 14:22:05`) — updates every 10 seconds
- Show the Active Calls Bar across the top — all live incidents at a glance

### 2. Creating a New Incident (2 min)
- Type `NC` in the command bar → New Call form opens
- Fill: scene address (autocomplete from address book), incident type, priority
- Show address book autocomplete — pre-loaded SCMC campuses + history
- Create the call — it appears immediately in the incident queue and Active Calls Bar
- Show incident ID format: `26-XXXX` (year-prefixed, sequential)

### 3. Assigning a Unit (1 min)
- Type `ASSIGN 26-XXXX EMS1` — unit goes to PENDING DISPATCH (D)
- Show SUGGEST command — scores units by availability, cert level, agency proximity
- Click the unit row — detail panel opens with status, note, assigned incident
- Show stack: `STACK 26-XXXX BLS1` — second unit queued on same call

### 4. Field MDT (2 min)
- Open field app on phone/tablet (PWA, installed from holdenportal.com/hoscad/field)
- Log in as the assigned unit — shows current status, assigned incident
- Tap DE → status updates live on the board
- Show dispatch tone — 3 repeating tones + ACK button
- Show GPSUL — sends location to board; board map dot updates

### 5. Hospital Diversion (1 min)
- Type `DIVERSION ON STCH-B` — red **DIVERSION ACTIVE: ST CHARLES BEND** banner appears at top of board
- Open field app → tap T (transport status) → TRANSPORT overlay opens with destination buttons
- Point out: `ST CHARLES BEND [DIV]` button is red — field crews can't miss it even on a small phone screen
- Type `DIVERSION OFF STCH-B` — banner disappears in real time on next poll
- Contrast: viewer screen at `holdenportal.com/hoscad/viewer` has a matching diversion bar — hospital staff see the same info

### 6. Board Map (1 min)
- Type `MAP` — Leaflet map opens with unit dots and incident markers
- Hover a unit dot — tooltip shows status, note, assigned call
- Type `MAP EMS1` — map zooms to that unit
- Show color coding: green = AV, yellow = OS, blue = T, grey = OOS

### 7. Incident Lifecycle (1 min)
- Walk through: D → DE → OS → T → TH → HANDOFF → CLOSE
- Show disposition picker on close (TRANSPORTED, CANCELLED, etc.)
- Show timing row in incident modal — elapsed between each milestone, KPI-colored

### 8. Admin Panel (1 min)
- Open admin (Admin link in header)
- Show: Users tab, Roster tab, Sessions tab (who's logged in, CAD ID, last active)
- Show: Issue Reporter — BUG button on board/field → admin Issues tab

### 9. Clinical Type Codes + Reporting (1 min)
- Open New Call form — show category cascade: CCT → CARDIAC-CRITICAL → PRI-1
- Contrast with old system: "VENT" vs "RESPIRATORY-FAILURE", "MULTI-DRIP" vs "MULTI-SYSTEM-FAILURE"
- Show ADMIN category in edit modal: CANCELLED-PRE-DISPATCH, NO-PATIENT, WAITING-BED
- Open Admin → Type Codes tab → click **SHOW LEGACY** to compare old vs. new names side by side
- Click **EDIT** on any nature → inline form expands in place (all fields: group, service level, severity, desc)
- Open Admin → Reports → Export XLSX → **8 sheets** now includes Clinical Group Summary + Service Level Summary
  - "How many CCT calls per shift? What's the avg response time for cardiovascular vs. trauma?" — now answerable

### 10. PulsePoint Feed (30 sec)
- Show PP sync badge (`PP: NOW (4 UNITS)`)
- Units from fire agencies appear with `[PP:INC_ID]` in their notes
- Real-time feed from 11 Central Oregon agencies

---

## Q&A — Hospital Leadership / Administrators

**Q: What does this cost?**
Currently operates on free tiers — Supabase free (database + backend), GitHub Pages (hosting). Zero monthly infrastructure cost. Future commercial deployment would add paid tiers for higher reliability SLAs and dedicated support.

**Q: Is this HIPAA compliant?**
HOSCAD tracks unit status and incident location/type — not patient identifiers. No PHI (Protected Health Information) is stored in the system. Unit notes and incident notes may contain operational shorthand but are not structured patient records. Transport destinations are facility codes (e.g., `STCH-B`), not patient data. The system is designed to avoid the HIPAA boundary entirely.

**Q: What happens if the internet goes down?**
The board and field apps are Progressive Web Apps with service worker caching. The last-loaded app shell works offline. Data polling pauses and the live pill shows `OFFLINE` or `STALE (Ns)` — dispatchers see exactly how old the data is. When connectivity returns, the system resumes automatically.

**Q: What's the reliability/uptime?**
Backend runs on Supabase (Postgres + Edge Functions). Supabase free tier has no uptime SLA; paid tiers offer 99.9% uptime. For live deployment, upgrading to Supabase Pro is recommended for the SLA and no cold-start latency. Frontend is GitHub Pages — 99.99% uptime.

**Q: Who built this and who supports it?**
Built by Christian Holden (SCMC IT). All source code is version-controlled and documented. Architecture is standard (PostgreSQL + Deno serverless + static HTML/JS) — supportable by any web developer familiar with these stacks.

**Q: How long did it take to build?**
Core system took roughly 2 weeks of development. Feature set is now comparable to commercial EMS tracking products that cost $30–80K/year.

---

## Q&A — IT / Engineers

**Q: What's the tech stack?**
- **Database**: PostgreSQL via Supabase (managed, Central Oregon region)
- **Backend**: Deno/TypeScript Edge Functions on Supabase (serverless)
- **Frontend**: Vanilla HTML/CSS/JS — no framework dependencies, no build step
- **Hosting**: GitHub Pages (static), Supabase (backend)
- **Maps**: Leaflet.js + OpenStreetMap (no Google Maps API key required, no cost)
- **Geocoding**: Nominatim (OpenStreetMap, free, no API key)

**Q: How does real-time work? WebSockets?**
HTTP polling — board polls every 10s, field polls every 10s (60s when tab hidden). The backend `getState` endpoint runs 7 parallel Postgres queries via `Promise.all` and returns in <500ms under normal load. WebSocket/SSE is on the roadmap for Phase 3 but polling is sufficient for EMS tracking (vs. true 911 CAD).

**Q: How is authentication handled?**
Custom UUID session tokens stored in a `sessions` table (not Supabase Auth). 24-hour TTL. Brute-force protection: 5 failed attempts → 15-minute lockout. Each user has a unique CAD ID (`CAD-XXXX`) that appears in all audit log entries. Roles: STA1-6 (dispatch stations), SUPV, MGR, EMS, TCRN, PLRN, IT, UNIT (field crews, no password).

**Q: Where is data stored? Who can access it?**
Supabase project `vnqiqxffedudfsdoadqg` — US East region. Service role key is in Edge Function environment variables only, never exposed to clients. The frontend uses only the API endpoint with session tokens. No client has direct database access.

**Q: How is audit logging done?**
Every unit status change writes to `audit` table (immutable insert-only). Every incident update writes to `incident_audit` (timestamped message + actor). CAD IDs appear in all audit entries. No delete or update ever touches audit rows. Full history is searchable via `SEARCH` command on board.

**Q: What's the data model for incidents vs. unit assignments?**
- `incidents` table: core incident data, denormalized `units` field for quick display
- `unit_assignments` table: normalized unit-to-incident assignment with `is_primary`, `cleared_at` — drives stacking system
- `units` table: current unit state with `incident` field (denormalized for fast board render)
- All three stay in sync via `doUpsertUnit` → `syncIncidents` path

**Q: Can this integrate with existing CAD systems (e.g., Spillman, ImageTrend)?**
Not currently as a native integration. HOSCAD is a standalone tracking layer. The architecture supports read-only data ingest — the same pattern used for PulsePoint (poll a public/partner API, normalize the data, surface it on the board). Whether that's achievable for a given agency depends on whether they have an accessible data feed, not on anything in HOSCAD's design.

**Q: Can HOSCAD sync with GMR's Airlink/TCS dispatch system?**
Very likely yes. GMR operates a fleet status viewer at `tcs.gmr.net` (Airlink Dispatch) that shows unit statuses across their fleet. The most practical integration path is a lightweight browser extension that reads TCS when a dispatcher is logged in and relays unit positions/statuses into HOSCAD automatically. No backend changes required — the extension would call HOSCAD's existing `upsertUnit` API. Alternatively, GMR may offer an official data-sharing feed for partner receiving facilities; SCMC would need to request that through GMR. Either path would bring GMR air ambulance and ground unit awareness directly onto the HOSCAD board.

**Q: Can HOSCAD track LifeFlight Network aircraft?**
Yes — and this is one of the most technically straightforward integrations on the roadmap. Every LifeFlight helicopter and fixed-wing aircraft broadcasts ADS-B (FAA-mandated transponder data). FlightAware and ADS-B Exchange both offer APIs that return real-time position, altitude, speed, origin, and destination for any aircraft by tail number — no agreement with LifeFlight required. HOSCAD would poll this the same way it polls PulsePoint: every 60 seconds, normalize the response, and display aircraft as units on the board map. When a flight is en route to SCMC, the board would show it automatically.

**Q: What about Deschutes County 911, Frontier Regional 911, or Crook County 911?**
Deschutes County 911 already pushes public incident data to PulsePoint, which HOSCAD polls — so their fire and EMS activations already surface on the board automatically. Full real-time unit status from their Tyler Enterprise CAD system would require a formal read-only data-sharing agreement with the 911 district, which is a policy conversation, not a technical one. Frontier Regional 911 (covering Jefferson County/Madras) and Crook County 911 (Prineville) use unconfirmed CAD vendors — the first step would be identifying their systems and whether they have any accessible data feeds, then pursuing agreements if so. HOSCAD's architecture is ready to ingest the data once a feed exists.

**Q: How would external data integrations (LifeFlight, GMR, DC911, etc.) work technically?**
All external integrations follow the same read-only polling architecture as the existing PulsePoint feed — no custom protocol or bidirectional sync required:

1. **Poll** — HOSCAD backend polls the external data source on a configurable interval (typically 60s)
2. **Normalize** — External data is mapped to HOSCAD's unit schema: unit ID, display name, status, location, note
3. **Upsert** — External units are written as read-only rows on the board, tagged with a source badge (e.g., `[PP:INC_ID]`, `[ADSB]`, `[TCS]`)
4. **Display** — Units appear on the board and map automatically alongside SCMC units; no dispatcher action required

HOSCAD never writes back to any external system — it is always the read-only consumer. The integration effort per source:

| Source | Feed type | Auth required | Agreement required |
|---|---|---|---|
| PulsePoint (live now) | Public REST API | None | None |
| ADS-B / LifeFlight | Public REST API (FlightAware / ADS-B Exchange) | API key (free tier) | None — FAA data is public |
| GMR Airlink/TCS | Browser extension reads TCS DOM → posts to HOSCAD | Dispatcher's existing TCS login | None (extension path) |
| Deschutes County 911 | Tyler Enterprise CAD partner API | County provisioned key | Read-only MOU with DC911 |
| Frontier / Crook County 911 | TBD (vendor unconfirmed) | TBD | Likely yes |

The board already handles external unit rows — the PulsePoint integration uses the exact same `upsertUnit` path any new feed would use.

**Q: Is there mobile support?**
Yes. Field MDT is a PWA — installs to iOS/Android home screen like a native app. Safe area insets, wake lock, offline caching, push notifications (via service worker, iOS-compatible). Tested on iPhone and Android Chrome.

---

## Q&A — EMS Supervisors / Dispatch Leads

**Q: How does the field crew use it?**
Field crews open the field app on their phone/tablet and log in with their unit ID (e.g., `EMS1`) — no password required. They see their current status, assigned incident details, scene address, destination, crew info, and a command feed. They tap status buttons (EN ROUTE, ON SCENE, TRANSPORTING) — each tap updates the board instantly. The app plays dispatch tones and shows the next queued call automatically.

**Q: Can a crew accidentally change their status?**
Available (AV) requires an 800ms hold-to-confirm. AT HOSPITAL requires a tap + confirm dialog. All other statuses are single-tap. This prevents accidental AV transitions while preventing friction on normal status changes.

**Q: What if a unit has multiple calls stacked?**
The stacking system supports primary + queued assignments. When a unit clears its primary call, the next queued call automatically promotes to primary and the dispatch tone plays. Dispatchers see the full stack in the board — click the stack badge to expand it. Field crews see their next call in the `NEXT CALL` panel.

**Q: What if the field app loses signal?**
The app shell is cached by the service worker. The crew can still view their last-known incident details and status. When connectivity returns, polling resumes automatically and missed status changes sync. Status updates that fail while offline are displayed as errors in the command feed.

**Q: Can dispatchers override field crew status?**
Yes. Dispatchers have override authority — they can set any unit to any status from the board regardless of what the field is doing. The LOGOFF command deactivates the unit entirely and forces the field app to the login screen on next poll.

**Q: How do we track response times?**
Each incident records timestamps for all 6 EMS milestones: Dispatch → Enroute → On Scene → Transport → At Hospital → Handoff. The incident detail panel shows elapsed time between each stage, color-coded against KPI targets (green ≤ target, amber ≤ 1.5×, red > 1.5×). Shift reports and unit reports are available in the admin panel.

**Q: What is PulsePoint integration?**
HOSCAD pulls a live feed from PulsePoint covering 11 Central Oregon fire and EMS agencies. Units from those agencies appear on the board automatically during active incidents, giving dispatchers awareness of mutual aid resources without manual entry. The feed updates every 60 seconds.

**Q: Is there a welfare check feature?**
Yes. The board automatically alerts (audio + banner) when a unit has been in a single status (OS, DE, T) for more than the critical stale threshold. The stale banner shows clickable unit IDs — click to scroll to the unit. Dispatchers can send a welfare check message with `WELF EMS1`.

---

## Current Limitations / Known Gaps (Honest)

- **Polling, not push**: Board updates every 10s. Not real-time instant. Acceptable for EMS tracking; not suitable for true 911 primary PSAP use.
- **No CAD integration**: Standalone system. Does not import/export to Spillman, ImageTrend, or ESO.
- **No patient record linking**: Intentional. HOSCAD is unit tracking only, not a PCR or ePCR system.
- **No SLA on free tier**: Infrastructure is free tier. For production with SLA guarantees, Supabase Pro upgrade recommended.

---

## Roadmap Highlights (What's Coming)

**Shipped:**
- **Mutual Aid module** ✅ SHIPPED — formal request → approve → track → release workflow with agency aliases and auto-broadcast
- **Clinical type code taxonomy** ✅ SHIPPED — 6 categories, structured natures with determinants, inline admin editor, SHOW LEGACY toggle
- **Clinical reporting** ✅ SHIPPED — shift report: P50/P75/P90 response times, hospital wall times, disposition breakdown, clinical group + service level sheets in XLSX (8 total)
- **Auto GPS tracking** ✅ SHIPPED — field app sends location every 60s; adaptive 120s interval when accuracy is poor; skips stale network-location noise
- **Hospital diversion awareness** ✅ SHIPPED — board banner + field TRANSPORT overlay show live diversion; viewer diversion bar already live
- **Field incident history** ✅ SHIPPED — INCLOG command on field MDT shows last 20 calls

**Near-term (no agreements required):**
- **LifeFlight Network aircraft tracking** — ADS-B transponder data via FlightAware/ADS-B Exchange API. Same polling pattern as PulsePoint. No agreement with LifeFlight needed — FAA ADS-B data is public.
  - _What dispatchers would see_: LifeFlight helicopters and fixed-wing aircraft appear as unit rows on the board and as aircraft icons on the map when airborne. Status shows altitude + speed + origin/destination. Board auto-flags any flight with SCMC as its filed destination. If a flight goes off-radar (landed), the row clears automatically.
- **GMR Airlink/TCS sync** — a lightweight browser extension reads the TCS fleet-status page when a dispatcher is logged in and relays unit positions/statuses into HOSCAD. Extension approach requires no GMR cooperation.
  - _What dispatchers would see_: GMR ground units and air ambulances appear on the board with a `[TCS]` source badge. Status (AV, OS, T) reflects what Airlink shows. Dispatchers see GMR unit availability without toggling between systems or making radio calls.

**Medium-term (requires agency cooperation, technically straightforward):**
- **Deschutes County 911 unit status** — public incidents already flow via PulsePoint; real-time unit status from their Tyler Enterprise CAD would need a read-only data-sharing agreement with the district. Policy conversation, not a technical barrier.
  - _What dispatchers would see_: All DC911-dispatched units (Bend Fire, Redmond Fire, DCSO EMS, Sisters-Camp Sherman, Black Butte Ranch) show live status on the board — AV, OS, enroute, etc. — sourced directly from Tyler CAD. Currently those units only appear during active PulsePoint incidents; this would give full at-a-glance availability awareness.
- **Frontier Regional 911 / Crook County 911** — CAD vendor identification needed first; then same path as Deschutes. Both are small-county PSAPs with limited IT capacity — a formal request through SCMC administration is the right entry point.
  - _What dispatchers would see_: Jefferson County (Madras, Metolius, Culver) and Crook County (Prineville) units visible on the board for mutual aid situational awareness. Especially valuable for SCMC Madras and SCMC Prineville coordination.

**Longer-term:**
- **Real-time push** — WebSocket or SSE upgrade for true sub-second board updates (vs. current 10s polling)

---

## Future Integration Capabilities — At a Glance

All future external integrations use the same read-only polling architecture as the live PulsePoint feed. No bidirectional sync. HOSCAD never modifies external agency data.

| Integration | What dispatchers see | Agreement needed? | Est. effort |
|---|---|---|---|
| **PulsePoint** _(live)_ | 11-agency fire/EMS units during active incidents | None | Done |
| **LifeFlight Network** (ADS-B) | Aircraft on board map: tail #, altitude, speed, destination — auto-flagged if en route to SCMC | None (FAA public data) | Low — API key + 60s poll |
| **GMR Airlink/TCS** | GMR ground + air units with live status from Airlink fleet board | None (extension path) | Low — browser extension |
| **Deschutes County 911** | All DC911 units (Bend Fire, DCSO, Redmond Fire, etc.) with live AV/OS/T status from Tyler CAD | Read-only MOU with DC911 | Low once MOU signed |
| **Frontier Regional 911** | Jefferson County units (Madras, Metolius, Culver) for SCMC Madras coordination | Yes — needs CAD vendor ID first | TBD |
| **Crook County 911** | Crook County units (Prineville) for SCMC Prineville coordination | Yes — needs CAD vendor ID first | TBD |

**Technical pattern (same for all):** Backend polls external API → normalizes to HOSCAD unit schema → upserts with source badge → units appear on board and map. No HOSCAD code changes needed between integrations — only a new poll module per source.

---

## Technical Specs Summary

| Item | Detail |
|---|---|
| Board poll interval | 10s (active tab), 60s (hidden tab) |
| Field poll interval | 10s |
| Session TTL | 24 hours |
| Max units | 60 (roster); unlimited active |
| Audit retention | 90 days live, archived indefinitely |
| Incident retention | 180 days live (closed), archived indefinitely |
| Supported browsers | Chrome, Firefox, Safari, Edge (current versions) |
| Field OS support | iOS 15+, Android 8+ |
| Map tiles | OpenStreetMap (no API key) |
| Geocoding | Nominatim (no API key, rate-limited 1 req/1.5s) |
| Backend region | Supabase US East |
| Frontend CDN | GitHub Pages (global CDN) |

---

_Update this file whenever a significant new feature ships or a capability changes._
_File location: `hoscad/DEMO-SCRIPT.md`_
