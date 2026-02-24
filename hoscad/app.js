/**
 * HOSCAD/EMS Tracking System - Application Logic
 *
 * Main application module handling all UI interactions, state management,
 * and command processing. Uses the API module for backend communication.
 *
 * PERFORMANCE OPTIMIZATIONS (2026-01):
 * - Granular change detection: Lightweight hash per data section instead of JSON.stringify
 * - Selective rendering: Only re-render sections that actually changed
 * - DOM diffing: Board uses row-level caching, only updates changed rows
 * - Event delegation: Single click/dblclick handler on table body vs per-row
 * - Pre-computed sort keys: Timestamps computed once before sort, not in comparator
 * - Efficient selection: Uses data-unit-id attribute instead of text parsing
 */

// ============================================================
// Global State
// ============================================================
let TOKEN = localStorage.getItem('ems_token') || '';
let ACTOR = '';
let ROLE = '';
let STATE = null;
let ACTIVE_INCIDENT_FILTER = '';
let POLL = null;
let BASELINED = false;
let LAST_MAX_UPDATED_AT = '';
let LAST_NOTE_TS = '';
let LAST_ALERT_TS = '';
let LAST_INCIDENT_TOUCH = '';
let LAST_MSG_COUNT = 0;
let CURRENT_INCIDENT_ID = '';
let CMD_HISTORY = [];
let CMD_INDEX = -1;
let SELECTED_UNIT_ID = null;
let UH_CURRENT_UNIT = '';
let UH_CURRENT_HOURS = 12;
let CONFIRM_CALLBACK = null;
let CONFIRM_CANCEL_CALLBACK = null;
let _newUnitResolve = null;
let _newUnitPendingNote = '';
let _MODAL_UNIT = null;
let _popoutBoardWindow = null;  // viewer popout (used by POPOUT + BOARDS commands)
let _popoutIncWindow   = null;  // incident queue popout
let _showAssisting = true; // Show assisting agency units (law/dot/support) by default
let _ppLastSync    = null;  // Date of last successful PP fetch
let _ppActiveCount = 0;    // # of active PP units in last successful fetch
let _ppTimer       = null; // setInterval handle
let _ppSyncing     = false; // prevents overlapping fetches
const _expandedStacks = new Set(); // unit_ids with expanded stack rows (Phase 2D)

// VIEW state for layout/display controls
let VIEW = {
  sidebar: false,
  incidents: true,
  messages: true,
  density: 'normal',
  sort: 'status',
  sortDir: 'asc',
  filterStatus: null,
  filterType: null,
  preset: 'dispatch',
  elapsedFormat: 'short',
  nightMode: false
};

let BOARD_ZOOM = 100;

// Admin role check - SUPV1, SUPV2, MGR1, MGR2, IT have admin access
function isAdminRole() {
  return ['SUPV1','SUPV2','MGR1','MGR2','IT'].includes(ROLE);
}

// Unit display name mappings
const UNIT_LABELS = {
  "JC": "JEFFERSON COUNTY FIRE/EMS",
  "CC": "CROOK COUNTY FIRE/EMS",
  "BND": "BEND FIRE/EMS",
  "BDN": "BEND FIRE/EMS",
  "RDM": "REDMOND FIRE/EMS",
  "CRR": "CROOKED RIVER RANCH FIRE/EMS",
  "LP": "LA PINE FIRE/EMS",
  "SIS": "SISTERS FIRE/EMS",
  "AL1": "AIRLINK 1 RW",
  "AL2": "AIRLINK 2 FW",
  "ALG": "AIRLINK GROUND",
  "AL": "AIR RESOURCE",
  "ADVMED": "ADVENTURE MEDICS",
  "ADVMED CC": "ADVENTURE MEDICS CRITICAL CARE"
};

const STATUS_RANK = { D: 1, DE: 2, OS: 3, T: 4, TH: 4, AV: 5, IQ: 6, OOS: 7 };
const VALID_STATUSES = new Set(['D', 'DE', 'OS', 'F', 'FD', 'T', 'TH', 'AV', 'UV', 'BRK', 'OOS', 'IQ']);
const KPI_TARGETS = { 'D→DE': 5, 'DE→OS': 10, 'OS→T': 30, 'T→AV': 20 };

// Incident type taxonomy for cascading selects (4A) — overridden by server if admin has customized it
// Transport-type focused for SCMC interfacility dispatch.
// Priority levels (determinants):
//   PRI-1 = ALS / CCT — critical/unstable, time-sensitive, requires advanced life support
//   PRI-2 = ALS       — serious but stable, ALS monitoring needed, prompt transfer
//   PRI-3 = BLS       — stable, basic life support adequate
//   PRI-4 = BLS Routine — scheduled/non-urgent, discharge/dialysis runs
let INC_TYPE_TAXONOMY = {
  CCT: {
    natures: {
      'VENT':             { dets: ['PRI-1'], desc: 'Ventilator dependent / critical airway' },
      'MULTI-DRIP':       { dets: ['PRI-1'], desc: 'Multiple high-risk infusions (pressors, sedation, etc.)' },
      'CRITICAL-TRAUMA':  { dets: ['PRI-1'], desc: 'Unstable trauma requiring CCT team' },
      'ECMO':             { dets: ['PRI-1'], desc: 'ECMO transport' },
      'NICU-PICU':        { dets: ['PRI-1'], desc: 'Neonatal/peds critical care transport' },
      'HIGH-RISK-AIRWAY': { dets: ['PRI-1'], desc: 'Difficult airway / advanced airway risk' }
    }
  },
  'IFT-ALS': {
    natures: {
      'CARDIAC':      { dets: ['PRI-1','PRI-2'], desc: 'Cardiac instability (non-STEMI, arrhythmia risk, etc.)' },
      'CHEST-PAIN':   { dets: ['PRI-1','PRI-2'], desc: 'Chest pain requiring ALS monitoring' },
      'NEURO-STROKE': { dets: ['PRI-1','PRI-2'], desc: 'Stroke/neuro deficits, time-sensitive' },
      'RESPIRATORY':  { dets: ['PRI-1','PRI-2'], desc: 'Respiratory compromise needing ALS' },
      'SEPSIS':       { dets: ['PRI-1','PRI-2'], desc: 'Sepsis concern, unstable vitals' },
      'OB':           { dets: ['PRI-1','PRI-2'], desc: 'High-risk OB transfer' },
      'GI-BLEED':     { dets: ['PRI-1','PRI-2'], desc: 'GI bleed / hemodynamic risk' },
      'TRAUMA':       { dets: ['PRI-1','PRI-2'], desc: 'ALS trauma transfer (not CCT-level)' }
    }
  },
  'IFT-BLS': {
    natures: {
      'POST-OP':       { dets: ['PRI-3'], desc: 'Stable post-op transfer' },
      'DIAGNOSTIC':    { dets: ['PRI-3'], desc: 'Stable transfer for imaging/procedure' },
      'PSYCH':         { dets: ['PRI-3'], desc: 'Behavioral health transfer (stable)' },
      'BASIC-MEDICAL': { dets: ['PRI-3'], desc: 'Stable medical transfer' },
      'FALL-NO-INJURY':{ dets: ['PRI-3'], desc: 'Fall with no acute injury / stable' },
      'WOUND-CARE':    { dets: ['PRI-3'], desc: 'Stable wound care/clinic transfer' }
    }
  },
  DISCHARGE: {
    natures: {
      'STRETCHER':   { dets: ['PRI-4'], desc: 'Discharge stretcher transport' },
      'WHEELCHAIR':  { dets: ['PRI-4'], desc: 'Discharge wheelchair transport' },
      'AMBULATORY':  { dets: ['PRI-4'], desc: 'Discharge ambulatory transport' },
      'HOME':        { dets: ['PRI-4'], desc: 'Discharge to home' },
      'REHAB':       { dets: ['PRI-4'], desc: 'Discharge to rehab' },
      'SNF':         { dets: ['PRI-4'], desc: 'Discharge to SNF/LTC' }
    }
  },
  DIALYSIS: {
    natures: {
      'ROUTINE':    { dets: ['PRI-4'],        desc: 'Scheduled dialysis' },
      'EMERGENT':   { dets: ['PRI-2','PRI-3'], desc: 'Missed dialysis / urgent need' },
      'MISSED-TX':  { dets: ['PRI-3'],        desc: 'Missed treatment reschedule' },
      'RETURN':     { dets: ['PRI-4'],        desc: 'Return trip after dialysis' }
    }
  }
};

// OLD→NEW taxonomy migration: maps old type prefixes to new equivalents for display
const INC_TYPE_MIGRATION = {
  'MED-CARDIAC': 'IFT-ALS-CARDIAC', 'MED-STROKE': 'IFT-ALS-NEURO-STROKE',
  'MED-RESPIRATORY': 'IFT-ALS-RESPIRATORY', 'MED-SEPSIS': 'IFT-ALS-SEPSIS',
  'MED-OB': 'IFT-ALS-OB', 'MED-': 'IFT-BLS-BASIC-MEDICAL',
  'CCT-CARDIAC-DRIP': 'CCT-MULTI-DRIP', 'CCT-ICU': 'CCT-MULTI-DRIP',
  'CCT-TRAUMA': 'CCT-CRITICAL-TRAUMA', 'CCT-MISC': 'CCT-MULTI-DRIP',
  'TRAUMA-': 'IFT-ALS-TRAUMA',
  'DISCHARGE-SNF': 'DISCHARGE-SNF', 'DISCHARGE-': 'DISCHARGE-STRETCHER'
};

// Border colors indexed by getIncidentTypeClass result (4B)
const INC_GROUP_BORDER = {
  'inc-type-delta':    '#ff4444',  // PRI-1 / CCT
  'inc-type-charlie':  '#ff6600',  // PRI-2 / IFT-ALS
  'inc-type-bravo':    '#ffd700',  // PRI-3 / IFT-BLS
  'inc-type-alpha':    '#4fa3e0',  // PRI-4 / DISCHARGE / DIALYSIS
  'inc-type-discharge':'#6a7a8a',
  'inc-type-other':    '#6a7a8a',
};

// PulsePoint Central Oregon agency registry
const PP_AGENCIES = {
  // Deschutes County
  '00231': { name: 'Bend Fire & Rescue',          short: 'BF', color: '#d4380d' },
  '00234': { name: 'Sunriver Fire & Rescue',      short: 'SF', color: '#d46b08' },
  '00235': { name: 'Black Butte Ranch Fire',      short: 'BB', color: '#7c3aed' },
  '00236': { name: 'Redmond Fire & Rescue',       short: 'RF', color: '#0958d9' },
  '00237': { name: 'Sisters-Camp Sherman Fire',   short: 'SS', color: '#389e0d' },
  '00238': { name: 'Crooked River Ranch Fire',    short: 'CR', color: '#c41d7f' },
  '00239': { name: 'La Pine Fire District',       short: 'LP', color: '#d48806' },
  '00240': { name: 'Cloverdale RFPD',             short: 'CV', color: '#08979c' },
  '01172': { name: 'Alfalfa Fire District',       short: 'AF', color: '#7cb305' },
  // Jefferson County
  '01131': { name: 'Jefferson Fire District',     short: 'JF', color: '#531dab' },
  // NOTE: Crook County Fire & Rescue does not appear to have a PulsePoint feed.
  // 00291 is Portland Fire & Rescue (wrong — do NOT add back).
};

const PP_DATA_URL = 'https://ckholden.github.io/hoscad-source/pulsepoint_data.json';
const PP_POLL_INTERVAL = 60 * 1000;  // 1 minute — GH Actions pushes every 5min, poll more often to catch it quickly

// PulsePoint status code → HOSCAD status code
function ppStatusToHoscad(ppCode) {
  const map = {
    DP: 'D',  AK: 'D',  SG: 'D',
    ER: 'DE',
    OS: 'OS', AOS: 'OS',
    TR: 'T',
    TA: 'TH', AT: 'TH',
    AQ: 'AV', CLR: 'AV', AVL: 'AV', AR: 'AV', STN: 'AV',
    OOS: 'OOS',
  };
  return map[String(ppCode || '').toUpperCase()] || 'AV';
}

// Command hints for autocomplete
const CMD_HINTS = [
  { cmd: 'BOARDS', desc: 'BOARDS — re-open unit status board + incident queue windows' },
  { cmd: 'D <UNIT>; <NOTE>', desc: 'Dispatch unit' },
  { cmd: 'DE <UNIT>; <NOTE>', desc: 'Set enroute' },
  { cmd: 'OS <UNIT>; <NOTE>', desc: 'Set on scene' },
  { cmd: 'T <UNIT>; <NOTE>', desc: 'Set transporting' },
  { cmd: 'TH <UNIT>', desc: 'AT HOSPITAL — crew with patient at facility' },
  { cmd: 'AV <UNIT>', desc: 'Set available' },
  { cmd: 'OOS <UNIT>; <NOTE>', desc: 'Set out of service' },
  { cmd: 'BRK <UNIT>; <NOTE>', desc: 'Set on break' },
  { cmd: 'F <STATUS>', desc: 'Filter board by status' },
  { cmd: 'V SIDE', desc: 'Toggle sidebar' },
  { cmd: 'V INC', desc: 'Toggle incident queue' },
  { cmd: 'V MSG', desc: 'Toggle messages' },
  { cmd: 'SORT STATUS', desc: 'Sort by status' },
  { cmd: 'SORT ELAPSED', desc: 'Sort by elapsed time' },
  { cmd: 'DEN', desc: 'Cycle density mode' },
  { cmd: 'NIGHT', desc: 'Toggle night mode' },
  { cmd: 'NC <LOCATION>; <NOTE>; <TYPE>; <PRIORITY>; @<SCENE ADDR>', desc: 'New incident (add MA in note for mutual aid, [CB:PHONE] in note for callback, PRIORITY e.g. PRI-1, @ADDR for scene address)' },
  { cmd: 'R <INC>', desc: 'Review incident' },
  { cmd: 'RQ <INC>', desc: 'Requeue incident (QUEUED, clears unit assignment — for reassignment)' },
  { cmd: 'RO <INC>', desc: 'Reopen closed incident (ACTIVE, keeps existing units)' },
  { cmd: 'UH <UNIT> [HOURS]', desc: 'Unit history' },
  { cmd: 'MSG <ROLE/UNIT>; <TEXT>', desc: 'Send message' },
  { cmd: 'PG <UNIT>', desc: 'Radio page unit (plays fire/EMS tone on field device)' },
  { cmd: 'MSGDP; <TEXT>', desc: 'Message all dispatchers' },
  { cmd: 'HTDP; <TEXT>', desc: 'URGENT message all dispatchers' },
  { cmd: 'MSGU; <TEXT>', desc: 'Message all active field units' },
  { cmd: 'HTU; <TEXT>', desc: 'URGENT message all field units' },
  { cmd: 'DEST <UNIT>; <LOCATION> [NOTE]', desc: 'Set unit location/destination' },
  { cmd: 'L <UNIT>; <NOTE>', desc: 'Logon unit (LOGON also works)' },
  { cmd: 'LO <UNIT>', desc: 'Logoff unit (LOGOFF also works)' },
  { cmd: 'PRESET DISPATCH', desc: 'Dispatch view preset' },
  { cmd: 'CLR', desc: 'Clear all filters' },
  { cmd: 'INFO', desc: 'Quick reference (key numbers)' },
  { cmd: 'INFO ALL', desc: 'Full dispatch/emergency directory' },
  { cmd: 'INFO DISPATCH', desc: '911/PSAP dispatch centers' },
  { cmd: 'INFO AIR', desc: 'Air ambulance dispatch' },
  { cmd: 'INFO CRISIS', desc: 'Mental health / crisis lines' },
  { cmd: 'INFO LE', desc: 'Law enforcement direct lines' },
  { cmd: 'INFO FIRE', desc: 'Fire department admin / BC' },
  { cmd: 'ADDR', desc: 'Address directory / search' },
  { cmd: 'ADMIN', desc: 'Admin commands (SUPV/MGR/IT only)' },
  { cmd: 'REPORT SHIFT [12]', desc: 'Printable shift summary (hours, default 12)' },
  { cmd: 'REPORT INC <ID>',   desc: 'Printable per-incident report' },
  { cmd: 'REPORTUTIL <UNIT> [24]', desc: 'Per-unit utilization report (hours, default 24)' },
  { cmd: 'WHO',               desc: 'Dispatchers currently online' },
  { cmd: 'WHO [ID]',          desc: 'Look up unit crew or dispatcher by role/name' },
  { cmd: 'UR',                desc: 'Active unit roster' },
  { cmd: 'INCQ',              desc: 'Incident queue quick view (queued + active)' },
  { cmd: 'SUGGEST <INC>',     desc: 'Recommend available units for incident' },
  { cmd: 'DIVERSION ON <CODE>',  desc: 'Set hospital/facility on diversion' },
  { cmd: 'DIVERSION OFF <CODE>', desc: 'Clear hospital/facility diversion' },
  { cmd: 'STACK <INC> <UNIT>',   desc: 'Smart-assign: primary if unit free, queued if unit busy' },
  { cmd: 'ASSIGN <INC> <UNIT>',  desc: 'Force primary assignment (displaces current primary to queued)' },
  { cmd: 'QUEUE / QUE <INC> <UNIT>', desc: 'Add incident to unit queue behind primary (explicit)' },
  { cmd: 'PRIMARY <INC> <UNIT>', desc: 'Promote queued assignment to primary' },
  { cmd: 'CLEAR <INC> <UNIT>',   desc: 'Remove assignment from unit stack' },
  { cmd: 'STACK <UNIT>',         desc: 'Show unit assignment stack' },
  { cmd: 'SCOPE ALL',            desc: 'View all agencies (SUPV/MGR/IT only)' },
  { cmd: 'SCOPE AGENCY <ID>',    desc: 'Limit view to one agency' },
  { cmd: 'MSGALL <TEXT>', desc: 'Broadcast to all dispatchers + units' },
  { cmd: 'HTALL <TEXT>', desc: 'URGENT broadcast to all' },
  { cmd: 'NOTE <MESSAGE>', desc: 'Set info banner' },
  { cmd: 'NOTE CLEAR', desc: 'Clear info banner' },
  { cmd: 'ALERT <MESSAGE>', desc: 'Set alert banner (plays tone)' },
  { cmd: 'ALERT CLEAR', desc: 'Clear alert banner' },
  { cmd: 'CLR <UNIT>', desc: 'Clear unit from incident (no status change)' },
  { cmd: 'ETA <UNIT> <MINUTES>', desc: 'Set ETA for unit (e.g. ETA EMS1 8)' },
  { cmd: 'PRIORITY <INC> <PRI>', desc: 'Update incident priority (e.g. PRIORITY 0023 PRI-1)' },
  { cmd: 'STATS', desc: 'Live board summary (units, incidents)' },
  { cmd: 'SHIFT END <UNIT>', desc: 'End shift: set AV, clear assignments, deactivate' },
  { cmd: 'LINK <U1> <U2> <INC>', desc: 'Assign both units to incident' },
  { cmd: 'TRANSFER <FROM> <TO> <INC>', desc: 'Transfer incident between units' },
  { cmd: 'MASS D <DEST> CONFIRM', desc: 'Dispatch all AV units (requires CONFIRM)' },
  { cmd: 'LUI [UNIT]', desc: 'Create temp one-off unit (SUPV/MGR/IT only)' },
  { cmd: 'REL <INC> <PP_ID>', desc: 'REL INC0006 PP12345 — link incident to PulsePoint incident' },
  { cmd: 'HELP', desc: 'Show command reference' },
  { cmd: 'POPOUT', desc: 'Open status board on secondary monitor' },
  { cmd: 'POPIN', desc: 'Restore status board to this screen' },
  { cmd: 'MAP', desc: 'Toggle map panel on board' },
  { cmd: 'MAP <UNIT>', desc: 'Focus map on unit location (opens map if closed)' },
  { cmd: 'MAP <INC>', desc: 'Focus map on incident scene address' },
  { cmd: 'LOC <UNIT> <ADDR>', desc: 'Set unit location for map (chain status: LOC M1 123 MAIN; AV M1)' },
  { cmd: 'LOC <UNIT> CLR', desc: 'Clear unit location' },
  { cmd: 'MAP <ADDRESS>', desc: 'Geocode address and focus map on it' },
  { cmd: 'MAPR', desc: 'Quick map refresh (re-render all markers)' },
  { cmd: 'MAP IN/OUT/FIT/STA/CLR/RESET', desc: 'Map zoom/view controls' },
  { cmd: 'ZOOM IN/OUT/RESET/<N>', desc: 'Board zoom (50-200%)' },
  { cmd: 'POPMAP', desc: 'Pop map out into its own window' },
  { cmd: 'POPINC', desc: 'Pop incident queue into its own window' },
  { cmd: 'BUG', desc: 'Report a bug or system issue (opens form)' },
];
let CMD_HINT_INDEX = -1;

// ============================================================
// Address History Module — per-user localStorage autocomplete
// Key: hoscad_addr_<actor>  Max: 50 entries, deduped, newest first
// ============================================================
const AddrHistory = {
  _key() { return 'hoscad_addr_' + (ACTOR || 'anon'); },
  get() {
    try { return JSON.parse(localStorage.getItem(this._key()) || '[]'); } catch(e) { return []; }
  },
  push(addr) {
    if (!addr || addr.length < 4) return;
    const a = addr.trim().toUpperCase();
    let list = this.get().filter(x => x !== a);
    list.unshift(a);
    if (list.length > 50) list = list.slice(0, 50);
    try { localStorage.setItem(this._key(), JSON.stringify(list)); } catch(e) {}
    this._refresh();
  },
  _refresh() {
    const list = this.get();
    document.querySelectorAll('.addr-history-list').forEach(dl => {
      dl.innerHTML = list.map(a => '<option value="' + a.replace(/"/g, '&quot;') + '">').join('');
    });
  },
  attach(inputId, datalistId) {
    const inp = document.getElementById(inputId);
    const dl = document.getElementById(datalistId);
    if (!inp || !dl) return;
    dl.className = 'addr-history-list';
    inp.setAttribute('list', datalistId);
    inp.setAttribute('autocomplete', 'off');
    this._refresh();
  },
};

// ============================================================
// Address Lookup Module
// ============================================================
const AddressLookup = {
  _cache: [],
  _loaded: false,

  async load() {
    if (!TOKEN) return;
    try {
      const r = await API.getAddresses(TOKEN);
      if (r && r.ok && r.addresses) {
        this._cache = r.addresses;
        this._loaded = true;
      }
    } catch (e) {
      console.error('[AddressLookup] Load failed:', e);
    }
  },

  getById(id) {
    if (!id) return null;
    const u = String(id).trim().toUpperCase();
    return this._cache.find(a => a.id === u) || null;
  },

  search(query, limit) {
    limit = limit || 8;
    if (!query || query.length < 2) return [];
    const q = String(query).trim().toLowerCase();
    const exact = [];
    const starts = [];
    const contains = [];

    for (let i = 0; i < this._cache.length; i++) {
      const a = this._cache[i];
      const idL = a.id.toLowerCase();
      const nameL = a.name.toLowerCase();
      const aliases = a.aliases || [];

      // Exact alias/id match
      if (idL === q || aliases.indexOf(q) >= 0) {
        exact.push(a);
        continue;
      }

      // Starts-with on id, name, aliases
      if (idL.indexOf(q) === 0 || nameL.indexOf(q) === 0 || aliases.some(function(al) { return al.indexOf(q) === 0; })) {
        starts.push(a);
        continue;
      }

      // Contains in id, name, aliases, address, city
      const addressL = (a.address || '').toLowerCase();
      const cityL = (a.city || '').toLowerCase();
      if (idL.indexOf(q) >= 0 || nameL.indexOf(q) >= 0 ||
          aliases.some(function(al) { return al.indexOf(q) >= 0; }) ||
          addressL.indexOf(q) >= 0 || cityL.indexOf(q) >= 0) {
        contains.push(a);
      }
    }

    return exact.concat(starts, contains).slice(0, limit);
  },

  resolve(destValue) {
    if (!destValue) return { recognized: false, addr: null, displayText: '' };
    const v = String(destValue).trim().toUpperCase();
    const addr = this.getById(v);
    if (addr) {
      return { recognized: true, addr: addr, displayText: addr.name };
    }
    return { recognized: false, addr: null, displayText: v };
  },

  /** Parse bracket/paren note from a value: "SCMC [BED 4]" or "123 MAIN ST (BED2)" → { base, note } */
  _parseBracketNote(val) {
    if (!val) return { base: '', note: '' };
    // Check for [note] first, then (note) — used by LOC tags which store bracket notes as parens
    let idx = val.indexOf('[');
    let close = ']';
    if (idx < 0) { idx = val.lastIndexOf('('); close = ')'; }
    if (idx < 0) return { base: val, note: '' };
    const base = val.substring(0, idx).trim();
    let note = val.substring(idx + 1).trim();
    if (note.endsWith(close)) note = note.substring(0, note.length - 1).trim();
    return { base: base || val, note };
  },

  _noteBadge(note) {
    return note ? ' ' + esc(note) : '';
  },

  formatBoard(destValue) {
    if (!destValue) return '<span class="muted">\u2014</span>';
    const v = String(destValue).trim().toUpperCase();
    const { base, note } = this._parseBracketNote(v);
    const lookupKey = base || v;
    const addr = this.getById(lookupKey);
    const destObj = (STATE.destinations || []).find(d => d.code === lookupKey);
    const divBadge = destObj && destObj.diverted ? ' <span class="div-badge">DIV</span>' : '';
    const nBadge = this._noteBadge(note);
    if (addr) {
      const tip = esc(addr.address + ', ' + addr.city + ', ' + addr.state + ' ' + addr.zip + (note ? ' [' + note + ']' : ''));
      return '<span class="dest-recognized destBig" title="' + tip + '">' + esc(addr.name) + '</span>' + nBadge + divBadge;
    }
    return '<span class="destBig">' + esc(lookupKey || '\u2014') + '</span>' + nBadge + divBadge;
  },

  /**
   * Format contextual LOCATION column for a unit on the board.
   * D/DE/OS → scene address from incident
   * T/AT/TH → transport destination (hospital)
   * Fallback → destination field or [LOC:] tag or dash
   */
  formatLocation(unit) {
    const st = String(unit.status || '').toUpperCase();
    // Dispatched/on-scene: show incident scene address
    if (['D', 'DE', 'OS'].includes(st) && unit.incident && STATE) {
      const inc = (STATE.incidents || []).find(i => i.incident_id === unit.incident);
      if (inc && inc.scene_address) {
        const raw = String(inc.scene_address).trim().toUpperCase();
        const { base, note } = this._parseBracketNote(raw);
        // No JS truncation — CSS text-overflow:ellipsis clips to column width
        return '<span class="destBig" title="' + esc(raw) + '">' + esc(base) + '</span>' + this._noteBadge(note);
      }
    }
    // Transporting/at hospital: show destination (hospital)
    if (['T', 'AT', 'TH'].includes(st) && unit.destination) {
      return this.formatBoard(unit.destination);
    }
    // In Quarters: show station name
    if (st === 'IQ' && unit.station) {
      const staName = String(unit.station).trim().toUpperCase();
      return '<span class="destBig" title="IN QUARTERS">' + esc(staName) + '</span>';
    }
    // Fallback: destination if set, or [LOC:] tag, or dash
    if (unit.destination) return this.formatBoard(unit.destination);
    const locTag = (unit.note || '').match(/\[LOC:([^\]]+)\]/);
    if (locTag) {
      const raw = locTag[1].trim().toUpperCase();
      const { base, note } = this._parseBracketNote(raw);
      return '<span class="destBig" title="' + esc(raw) + '">' + esc(base) + '</span>' + this._noteBadge(note);
    }
    return '<span class="muted">\u2014</span>';
  }
};

// ============================================================
// Address Autocomplete Component
// ============================================================
const AddrAutocomplete = {
  attach(inputEl, options) {
    if (!inputEl || inputEl.dataset.acAttached) return;
    inputEl.dataset.acAttached = '1';
    var onSelect = options && options.onSelect;

    // Wrap input in relative container
    const wrapper = document.createElement('div');
    wrapper.className = 'addr-ac-wrapper';
    inputEl.parentNode.insertBefore(wrapper, inputEl);
    wrapper.appendChild(inputEl);

    // Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'addr-ac-dropdown';
    wrapper.appendChild(dropdown);

    let acIndex = -1;
    let acResults = [];

    function showDropdown(results) {
      acResults = results;
      acIndex = -1;
      if (!results.length) {
        dropdown.classList.remove('open');
        dropdown.innerHTML = '';
        return;
      }
      dropdown.innerHTML = results.map(function(a, i) {
        return '<div class="addr-ac-item" data-idx="' + i + '">' +
          '<span class="addr-ac-id">' + esc(a.id) + '</span>' +
          '<span class="addr-ac-name">' + esc(a.name) + '</span>' +
          '<span class="addr-ac-detail">\u2014 ' + esc(a.address + ', ' + a.city) + '</span>' +
          '<span class="addr-ac-cat">' + esc((a.category || '').replace(/_/g, ' ')) + '</span>' +
          '</div>';
      }).join('');
      dropdown.classList.add('open');
    }

    function hideDropdown() {
      dropdown.classList.remove('open');
      dropdown.innerHTML = '';
      acResults = [];
      acIndex = -1;
    }

    function selectItem(idx) {
      if (idx < 0 || idx >= acResults.length) return;
      var a = acResults[idx];
      inputEl.value = a.name;
      inputEl.dataset.addrId = a.id;
      hideDropdown();
      if (onSelect) onSelect(a);
    }

    function highlightItem(idx) {
      var items = dropdown.querySelectorAll('.addr-ac-item');
      items.forEach(function(el) { el.classList.remove('active'); });
      if (idx >= 0 && idx < items.length) {
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      }
    }

    inputEl.addEventListener('input', function() {
      delete inputEl.dataset.addrId;
      var val = inputEl.value.trim();
      if (val.length < 2) {
        hideDropdown();
        return;
      }
      var results = AddressLookup.search(val);
      showDropdown(results);
    });

    inputEl.addEventListener('keydown', function(e) {
      if (!dropdown.classList.contains('open')) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acIndex = Math.min(acIndex + 1, acResults.length - 1);
        highlightItem(acIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acIndex = Math.max(acIndex - 1, 0);
        highlightItem(acIndex);
      } else if (e.key === 'Enter') {
        if (acIndex >= 0) {
          e.preventDefault();
          selectItem(acIndex);
        } else {
          hideDropdown();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideDropdown();
      }
    });

    inputEl.addEventListener('blur', function() {
      setTimeout(hideDropdown, 150);
    });

    dropdown.addEventListener('mousedown', function(e) {
      e.preventDefault(); // Prevent blur
      var item = e.target.closest('.addr-ac-item');
      if (item) {
        var idx = parseInt(item.dataset.idx);
        selectItem(idx);
      }
    });
  }
};

// ============================================================
// View State Persistence
// ============================================================
function boardZoomIn() {
  BOARD_ZOOM = Math.min(200, BOARD_ZOOM + 10);
  applyBoardZoom();
}
function boardZoomOut() {
  BOARD_ZOOM = Math.max(50, BOARD_ZOOM - 10);
  applyBoardZoom();
}
function boardZoomReset() {
  BOARD_ZOOM = 100;
  applyBoardZoom();
}
function applyBoardZoom() {
  const table = document.getElementById('boardTable');
  if (table) {
    const s = BOARD_ZOOM / 100;
    table.style.transform = s !== 1 ? 'scale(' + s + ')' : '';
    table.style.transformOrigin = 'top left';
    table.style.width = s !== 1 ? (10000 / BOARD_ZOOM) + '%' : '';
  }
  const zb = document.getElementById('zoomBadge');
  if (zb) zb.textContent = BOARD_ZOOM !== 100 ? BOARD_ZOOM + '%' : '';
  try { localStorage.setItem('hoscad_board_zoom', String(BOARD_ZOOM)); } catch(e) {}
  showToast('ZOOM: ' + BOARD_ZOOM + '%');
}
function loadBoardZoom() {
  try {
    const z = localStorage.getItem('hoscad_board_zoom');
    if (z) BOARD_ZOOM = Math.max(50, Math.min(200, parseInt(z) || 100));
  } catch(e) {}
  const table = document.getElementById('boardTable');
  if (table) {
    const s = BOARD_ZOOM / 100;
    table.style.transform = s !== 1 ? 'scale(' + s + ')' : '';
    table.style.transformOrigin = 'top left';
    table.style.width = s !== 1 ? (10000 / BOARD_ZOOM) + '%' : '';
  }
  const zb = document.getElementById('zoomBadge');
  if (zb) zb.textContent = BOARD_ZOOM !== 100 ? BOARD_ZOOM + '%' : '';
}

function loadViewState() {
  try {
    const saved = localStorage.getItem('hoscad_view');
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(VIEW, parsed);
    }
  } catch (e) { }
}

function saveViewState() {
  try {
    localStorage.setItem('hoscad_view', JSON.stringify(VIEW));
  } catch (e) { }
}

function applyViewState() {
  // Side panel
  const sp = document.getElementById('sidePanel');
  if (sp) {
    if (VIEW.sidebar) sp.classList.add('open');
    else sp.classList.remove('open');
  }

  // Bottom panels: hide when sidebar is open (messages + scratch move to sidebar)
  const bp = document.querySelector('.bottom-panels');
  if (bp) bp.style.display = VIEW.sidebar ? 'none' : '';

  // Sync scratch notes between bottom pad and side pad when transitioning
  const _scratchMain = document.getElementById('scratchPad');
  const _scratchSide = document.getElementById('scratchPadSide');
  if (VIEW.sidebar) {
    if (_scratchMain && _scratchSide) _scratchSide.value = _scratchMain.value;
  } else {
    if (_scratchMain && _scratchSide) _scratchMain.value = _scratchSide.value;
  }

  // Incident queue
  const iq = document.getElementById('incidentQueueCard');
  if (iq) {
    if (VIEW.incidents) iq.classList.remove('collapsed');
    else iq.classList.add('collapsed');
    iq.style.display = VIEW.incidents ? '' : '';
  }

  // Messages section in sidebar — always show when sidebar is open; only hide when sidebar is closed AND VIEW.messages is off
  const ms = document.getElementById('sideMsgSection');
  if (ms) ms.style.display = (VIEW.sidebar || VIEW.messages) ? '' : 'none';
  if (VIEW.sidebar) renderMessagesPanel();

  // Density
  const wrap = document.querySelector('.wrap');
  if (wrap) {
    wrap.classList.remove('density-compact', 'density-normal', 'density-expanded');
    wrap.classList.add('density-' + VIEW.density);
  }

  // Night mode
  if (VIEW.nightMode) document.body.classList.add('night-mode');
  else document.body.classList.remove('night-mode');

  // Night button state
  const nightBtn = document.getElementById('tbBtnNight');
  if (nightBtn) {
    if (VIEW.nightMode) nightBtn.classList.add('active');
    else nightBtn.classList.remove('active');
  }

  // Toolbar button states
  updateToolbarButtons();

  // Toolbar dropdowns
  const tbFs = document.getElementById('tbFilterStatus');
  if (tbFs) tbFs.value = VIEW.filterStatus || '';

  const tbSort = document.getElementById('tbSort');
  if (tbSort) tbSort.value = VIEW.sort || 'status';

  // Column sort indicators
  updateSortHeaders();

  // PP button initial state
  _applyPpBtn(localStorage.getItem('hoscad_pp_enabled') !== 'false');
}

function updateToolbarButtons() {
  const btns = {
    'tbBtnINC': VIEW.incidents,
    'tbBtnSIDE': VIEW.sidebar,
    'tbBtnMSG': VIEW.messages
  };
  for (const [id, active] of Object.entries(btns)) {
    const el = document.getElementById(id);
    if (el) {
      if (active) el.classList.add('active');
      else el.classList.remove('active');
    }
  }

  const denBtn = document.getElementById('tbBtnDEN');
  if (denBtn) denBtn.textContent = 'DEN: ' + VIEW.density.toUpperCase();
}

function updateSortHeaders() {
  document.querySelectorAll('.board-table th.sortable').forEach(th => {
    th.classList.remove('sort-active', 'sort-desc');
    if (th.dataset.sort === VIEW.sort) {
      th.classList.add('sort-active');
      if (VIEW.sortDir === 'desc') th.classList.add('sort-desc');
    }
  });
}

function toggleView(panel) {
  if (panel === 'sidebar' || panel === 'side') {
    VIEW.sidebar = !VIEW.sidebar;
  } else if (panel === 'incidents' || panel === 'inc') {
    VIEW.incidents = !VIEW.incidents;
  } else if (panel === 'messages' || panel === 'msg') {
    VIEW.messages = !VIEW.messages;
  } else if (panel === 'all') {
    VIEW.sidebar = true;
    VIEW.incidents = true;
    VIEW.messages = true;
  } else if (panel === 'none') {
    VIEW.sidebar = false;
    VIEW.incidents = false;
    VIEW.messages = false;
  }
  saveViewState();
  applyViewState();
}

function toggleNightMode() {
  VIEW.nightMode = !VIEW.nightMode;
  saveViewState();
  applyViewState();
}

function cycleDensity() {
  const modes = ['normal', 'compact', 'expanded'];
  const idx = modes.indexOf(VIEW.density);
  VIEW.density = modes[(idx + 1) % modes.length];
  saveViewState();
  applyViewState();
}

function applyPreset(name) {
  if (name === 'dispatch') {
    VIEW.sidebar = false;
    VIEW.incidents = true;
    VIEW.messages = true;
    VIEW.density = 'normal';
    VIEW.sort = 'status';
    VIEW.sortDir = 'asc';
    VIEW.filterStatus = null;
  } else if (name === 'supervisor') {
    VIEW.sidebar = true;
    VIEW.incidents = true;
    VIEW.messages = true;
    VIEW.density = 'normal';
    VIEW.sort = 'status';
    VIEW.sortDir = 'asc';
    VIEW.filterStatus = null;
  } else if (name === 'field') {
    VIEW.sidebar = false;
    VIEW.incidents = false;
    VIEW.messages = false;
    VIEW.density = 'compact';
    VIEW.sort = 'status';
    VIEW.sortDir = 'asc';
    VIEW.filterStatus = null;
  }
  VIEW.preset = name;
  saveViewState();
  applyViewState();
  renderBoardDiff();
}

function toggleIncidentQueue() {
  VIEW.incidents = !VIEW.incidents;
  saveViewState();
  applyViewState();
}

// Toolbar event handlers
function tbFilterChanged() {
  const val = document.getElementById('tbFilterStatus').value;
  VIEW.filterStatus = val || null;
  saveViewState();
  renderBoardDiff();
}

function tbSortChanged() {
  VIEW.sort = document.getElementById('tbSort').value || 'status';
  saveViewState();
  updateSortHeaders();
  renderBoardDiff();
}

// ============================================================
// Audio Feedback (board/dispatch side)
// ============================================================
function beepChange()     { }
function _boardPlayFile(file) {
  try {
    const a = new Audio(file);
    a.volume = 0.9;
    a.play().catch(() => {});
  } catch(e) {}
}
function beepNote()       { _boardPlayFile('sounds/msg.mp3'); }
// Alert banner set — plays htmsg tone
function beepAlert()      { _boardPlayFile('sounds/htmsg.mp3'); }

// Incoming regular message
function beepMessage()    { _boardPlayFile('sounds/msg.mp3'); }
// Incoming urgent/hot message or alert
function beepHotMessage() { _boardPlayFile('sounds/htmsg.mp3'); }

// ============================================================
// Utility Functions
// ============================================================

// Parse unit_info crew string (CM1:NAME (CERT)|CM2:NAME (CERT)) into readable text
function parseCrewInfo(unitInfo) {
  if (!unitInfo) return '';
  const parts = unitInfo.split('|').map(p => p.trim()).filter(Boolean);
  const crew = parts
    .filter(p => p.startsWith('CM1:') || p.startsWith('CM2:'))
    .map(p => p.replace(/^CM[12]:/, '').trim());
  return crew.join(' / ');
}

function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", "&#039;");
}

// Normalize a timestamp string before passing to new Date().
// Supabase returns TIMESTAMPTZ with microsecond precision, e.g. "2026-02-22T15:30:00.123456+00:00".
// ECMAScript Date.parse only guarantees parsing up to 3 fractional-second digits (milliseconds).
// Older Safari (iOS 15 / macOS 12 and earlier) returns Invalid Date for 6-digit fractional seconds.
// Truncating to 3 decimal places makes the string spec-compliant and cross-browser safe.
function _normalizeTs(i) {
  if (typeof i !== 'string') return i;
  return i.replace(/(\.\d{3})\d+/, '$1');
}

function fmtTime24(i) {
  if (!i) return '—';
  const d = new Date(_normalizeTs(i));
  if (!isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function minutesSince(i) {
  if (!i) return null;
  const t = new Date(_normalizeTs(i)).getTime();
  if (!isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

function formatElapsed(minutes) {
  if (minutes == null) return '—';
  if (VIEW.elapsedFormat === 'off') return '';
  const m = Math.floor(minutes);
  if (VIEW.elapsedFormat === 'long') {
    const hrs = Math.floor(m / 60);
    const mins = m % 60;
    const secs = Math.floor((minutes - m) * 60);
    if (hrs > 0) return hrs + ':' + String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
    return mins + ':' + String(secs).padStart(2, '0');
  }
  // short format
  if (m >= 60) {
    const hrs = Math.floor(m / 60);
    const mins = m % 60;
    return hrs + 'H' + (mins > 0 ? String(mins).padStart(2, '0') + 'M' : '');
  }
  return m + 'M';
}

function statusRank(c) {
  return STATUS_RANK[String(c || '').toUpperCase()] ?? 99;
}

function displayNameForUnit(u) {
  const uu = String(u || '').trim().toUpperCase();
  return UNIT_LABELS[uu] || uu;
}

function canonicalUnit(r) {
  if (!r) return '';
  let u = String(r).trim().toUpperCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
  const k = Object.keys(UNIT_LABELS).sort((a, b) => b.length - a.length);
  for (const kk of k) {
    if (u === kk) return kk;
  }
  return u;
}

function expandShortcutsInText(t) {
  if (!t) return '';
  return t.toUpperCase().split(/\b/).map(w => UNIT_LABELS[w.toUpperCase()] || w).join('');
}

// Levenshtein distance for fuzzy unit matching
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] :
        1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Returns known unit IDs that are within edit distance 2 of the typed ID
function findSimilarUnits(typedId) {
  if (!STATE || !STATE.units) return [];
  const t = typedId.toUpperCase();
  return (STATE.units || [])
    .map(u => (u.unit_id || '').toUpperCase())
    .filter(uid => uid && uid !== t && _levenshtein(uid, t) <= 2)
    .slice(0, 5);
}

function getRoleColor(a) {
  const m = String(a || '').match(/@([A-Z0-9]+)$/);
  if (!m) return '';
  return 'roleColor-' + m[1];
}

function setLive(ok, txt) {
  const e = document.getElementById('livePill');
  e.className = 'pill ' + (ok ? 'live' : 'offline');
  e.textContent = txt || (ok ? 'LIVE' : 'OFFLINE');
}

function offline(e) {
  console.error(e);
  setLive(false, 'OFFLINE');
}

function autoFocusCmd() {
  setTimeout(() => document.getElementById('cmd').focus(), 100);
}

// ============================================================
// Dialog Functions
// ============================================================
function showConfirm(title, message, callback, cancelCallback, cancelLabel) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  CONFIRM_CALLBACK = callback;
  CONFIRM_CANCEL_CALLBACK = cancelCallback || null;
  const closeBtn = document.getElementById('confirmClose');
  if (closeBtn) {
    if (cancelCallback) {
      closeBtn.textContent = cancelLabel || 'CANCEL';
      closeBtn.style.display = '';
    } else {
      closeBtn.style.display = 'none';
    }
  }
  document.getElementById('confirmDialog').classList.add('active');
}

function hideConfirm() {
  document.getElementById('confirmDialog').classList.remove('active');
  const closeBtn = document.getElementById('confirmClose');
  if (closeBtn) { closeBtn.style.display = 'none'; closeBtn.textContent = 'CLOSE'; }
  CONFIRM_CALLBACK = null;
  CONFIRM_CANCEL_CALLBACK = null;
}

function showConfirmAsync(title, msg) {
  return new Promise((resolve) => {
    showConfirm(title, msg, () => resolve(true), () => resolve(false), 'BACK');
  });
}

// ── OOS Reason Dialog ─────────────────────────────────────────
let _oosResolve = null;
const OOS_REASONS = ['MECHANICAL','FUEL','CREW REST','DOCUMENTATION','TRAINING','HOSPITAL','OTHER'];

function promptOOSReason(unitId) {
  return new Promise(resolve => {
    _oosResolve = resolve;
    document.getElementById('oosUnitLabel').textContent = unitId;
    const btns = document.getElementById('oosReasonBtns');
    btns.innerHTML = OOS_REASONS.map(r =>
      `<button class="btn-secondary" style="text-align:left;" onclick="selectOOSReason('${r}')">${r}</button>`
    ).join('');
    const dlg = document.getElementById('oosReasonDialog');
    dlg.style.display = 'flex';
  });
}

function selectOOSReason(reason) {
  document.getElementById('oosReasonDialog').style.display = 'none';
  if (_oosResolve) { _oosResolve(reason); _oosResolve = null; }
}

function cancelOOSReason() {
  document.getElementById('oosReasonDialog').style.display = 'none';
  if (_oosResolve) { _oosResolve(null); _oosResolve = null; }
}

// New unit confirmation dialog — [BACK] or [LOG ON NEW UNIT]
function showNewUnitDialog(unitId, msg, note) {
  const dlg = document.getElementById('newUnitDialog');
  if (!dlg) {
    // Fallback for cached old board.html without the dialog element
    return showConfirmAsync('NEW UNIT: ' + unitId, msg).then(ok => ok ? 'logon' : 'back');
  }
  return new Promise(resolve => {
    _newUnitResolve = resolve;
    _newUnitPendingNote = note || '';
    document.getElementById('newUnitDialogId').textContent = unitId;
    document.getElementById('newUnitDialogMsg').textContent = msg;
    dlg.style.display = 'flex';
  });
}

function _newUnitBack() {
  document.getElementById('newUnitDialog').style.display = 'none';
  const r = _newUnitResolve;
  _newUnitResolve = null;
  if (r) r('back');
}

function _newUnitOpen() {
  document.getElementById('newUnitDialog').style.display = 'none';
  const uid = document.getElementById('newUnitDialogId').textContent;
  const note = _newUnitPendingNote;
  const r = _newUnitResolve;
  _newUnitResolve = null;
  _newUnitPendingNote = '';
  // Open modal pre-filled (same as LUI <UNIT>)
  const dN = displayNameForUnit(uid);
  const fakeUnit = { unit_id: uid, display_name: dN, type: '', active: true, status: 'AV', note: note, unit_info: '', incident: '', destination: '', updated_at: '', updated_by: '' };
  openModal(fakeUnit);
  if (r) r('logon');
}

function updateScopeIndicator(scope) {
  const el = document.getElementById('scopeIndicator');
  if (!el) return;
  el.textContent = scope === 'ALL' ? 'SCOPE: ALL AGENCIES' : 'SCOPE: ' + scope.replace('AGENCY ', '');
  el.style.display = scope && scope !== 'AGENCY SCMC' ? '' : 'none';
}

function showToast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  setTimeout(() => {
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}

// ============================================================
// Bug / Issue Report Modal
// ============================================================
// Auto-captured context snapshot — built when modal opens, sent with submission
let _bugContext = null;

function openBugReport() {
  const back = document.getElementById('bugReportBack');
  if (!back) return;
  document.getElementById('bugReporterLabel').textContent = ACTOR || '—';
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('bugTimeLabel').textContent =
    (now.getMonth() + 1) + '/' + now.getDate() + ' ' + hh + ':' + mm;
  document.getElementById('bugDescription').value = '';
  document.getElementById('bugSeverity').value = 'MED';
  document.getElementById('bugStatus').textContent = '';

  // Capture auto-context snapshot
  _bugContext = {
    actor:           ACTOR || '',
    role:            ROLE || '',
    selectedUnit:    SELECTED_UNIT_ID || null,
    openIncident:    CURRENT_INCIDENT_ID || null,
    lastCmds:        CMD_HISTORY.slice(-8),
    unitsOnline:     STATE ? (STATE.units || []).filter(u => u.active).length : null,
    activeIncidents: STATE ? (STATE.incidents || []).filter(i => i.status === 'ACTIVE').length : null,
    online:          navigator.onLine,
    ua:              navigator.userAgent.substring(0, 120),
    vp:              window.innerWidth + 'x' + window.innerHeight,
    ts:              now.toISOString(),
  };

  // Render context preview in modal
  const ctxEl = document.getElementById('bugContextPreview');
  if (ctxEl) {
    const lines = [
      'UNIT: '    + (SELECTED_UNIT_ID || 'none'),
      'INCIDENT: '+ (CURRENT_INCIDENT_ID || 'none'),
      'LAST CMDS: ' + (_bugContext.lastCmds.slice(-4).join(' → ') || 'none'),
      'BOARD: '   + (_bugContext.unitsOnline ?? '?') + ' units / ' + (_bugContext.activeIncidents ?? '?') + ' active inc',
      'ONLINE: '  + (navigator.onLine ? 'yes' : 'NO'),
    ];
    ctxEl.textContent = lines.join('\n');
  }

  back.style.display = 'flex';
  setTimeout(() => document.getElementById('bugDescription').focus(), 80);
}

function closeBugReport() {
  const back = document.getElementById('bugReportBack');
  if (back) back.style.display = 'none';
  autoFocusCmd();
}

async function submitBugReport() {
  const sev  = document.getElementById('bugSeverity').value;
  const desc = (document.getElementById('bugDescription').value || '').trim().toUpperCase();
  const stat = document.getElementById('bugStatus');
  if (!desc) { stat.textContent = 'DESCRIPTION REQUIRED.'; return; }
  if (!TOKEN) { stat.textContent = 'NOT LOGGED IN.'; return; }
  stat.textContent = 'SUBMITTING...';
  const ctx = _bugContext ? JSON.stringify(_bugContext) : '';
  try {
    const r = await API.submitIssue(TOKEN, 'BOARD', sev, desc, ctx);
    if (!r.ok) { stat.textContent = 'ERROR: ' + (r.error || 'UNKNOWN'); return; }
    _bugContext = null;
    closeBugReport();
    showToast('ISSUE REPORT SUBMITTED. THANK YOU.', 'success');
  } catch (e) {
    stat.textContent = 'NETWORK ERROR.';
  }
}

function showAlert(title, message, style) {
  const titleEl = document.getElementById('alertTitle');
  const msgEl = document.getElementById('alertMessage');
  const dialogEl = document.getElementById('alertDialog');
  if (!titleEl || !msgEl || !dialogEl) {
    alert(title + '\n\n' + message);
    return;
  }
  titleEl.textContent = title;
  msgEl.textContent = message;
  msgEl.style.color = style === 'yellow' ? 'var(--yellow)' : '';
  dialogEl.classList.add('active');
}

function hideAlert() {
  document.getElementById('alertDialog').classList.remove('active');
}

function showErr(r) {
  if (r && r.conflict) {
    showConfirm('CONFLICT', r.error + '\n\nCURRENT: ' + r.current.status + '\nUPDATED: ' + r.current.updated_at + '\nBY: ' + r.current.updated_by, () => refresh());
    return;
  }
  showAlert('ERROR', r && r.error ? r.error : 'UNKNOWN ERROR.');
  refresh();
}

// ============================================================
// Authentication
// ============================================================
async function login() {
  const r = (document.getElementById('loginRole').value || '').trim().toUpperCase();
  const cadId = (document.getElementById('loginCadId').value || '').trim();
  const p = (document.getElementById('loginPassword').value || '').trim();
  const e = document.getElementById('loginErr');
  e.textContent = '';

  if (!r) { e.textContent = 'SELECT ROLE.'; return; }
  if (!cadId || cadId.length < 2) { e.textContent = 'ENTER CAD ID.'; return; }
  if (!p) { e.textContent = 'ENTER PASSWORD.'; return; }

  const res = await API.login(r, cadId, p, 'board');
  if (!res || !res.ok) {
    if (res && res.mustChangePassword) {
      showMustChangePassword(res.username || cadId, p);
      return;
    }
    e.textContent = (res && res.error) ? res.error : 'LOGIN FAILED.';
    return;
  }

  TOKEN = res.token;
  ACTOR = res.actor;
  ROLE = r;
  localStorage.setItem('ems_token', TOKEN);
  document.getElementById('loginBack').style.display = 'none';
  document.getElementById('userLabel').textContent = ACTOR;
  const adminLink = document.getElementById('adminLink');
  if (adminLink) adminLink.style.display = ['SUPV1','SUPV2','MGR1','MGR2','IT'].includes(ROLE) ? '' : 'none';
  start();
  setTimeout(openPopouts, 500);
}

async function showMustChangePassword(cadIdOrUsername, oldPassword) {
  const newPw = window.prompt('YOUR PASSWORD MUST BE CHANGED BEFORE LOGGING IN.\n\nENTER NEW PASSWORD (MIN 5 CHARACTERS):');
  if (!newPw || newPw.trim().length < 5) {
    showToast('PASSWORD MUST BE AT LEAST 5 CHARACTERS.', 'error');
    return;
  }
  const confirm = window.prompt('CONFIRM NEW PASSWORD:');
  if (newPw !== confirm) {
    showToast('PASSWORDS DO NOT MATCH.', 'error');
    return;
  }
  const r = await API.changePasswordNoAuth(cadIdOrUsername, oldPassword, newPw);
  if (r && r.ok) {
    showToast('PASSWORD CHANGED. LOGGING IN...', 'success');
    // Re-attempt login with the new password
    const role = (document.getElementById('loginRole').value || '').trim().toUpperCase();
    const cadId = (document.getElementById('loginCadId').value || '').trim();
    const res2 = await API.login(role, cadId, newPw, 'board');
    if (!res2 || !res2.ok) {
      document.getElementById('loginErr').textContent = (res2 && res2.error) ? res2.error : 'LOGIN FAILED AFTER PASSWORD CHANGE.';
      return;
    }
    TOKEN = res2.token;
    ACTOR = res2.actor;
    ROLE = role;
    localStorage.setItem('ems_token', TOKEN);
    document.getElementById('loginBack').style.display = 'none';
    document.getElementById('userLabel').textContent = ACTOR;
    const adminLink = document.getElementById('adminLink');
    if (adminLink) adminLink.style.display = ['SUPV1','SUPV2','MGR1','MGR2','IT'].includes(ROLE) ? '' : 'none';
    start();
  } else {
    showToast('ERROR: ' + ((r && r.error) || 'COULD NOT CHANGE PASSWORD'), 'error');
  }
}

// ============================================================
// Data Refresh
// ============================================================
// Performance: Granular change detection instead of JSON.stringify
let _lastUnitsHash = '';
let _lastIncidentsHash = '';
let _lastBannersHash = '';
let _lastMessagesHash = '';
let _refreshing = false;
let _pendingRender = false;
let _changedSections = { units: false, incidents: false, banners: false, messages: false };

// Performance: Cache for row data to enable DOM diffing
let _rowCache = new Map(); // unit_id -> { html, status, updated_at, ... }

// M-6: Banner acknowledgment tracking — persisted in sessionStorage (resets on page reload)
// Key format: "<kind>:<message>" — stale when message changes, so ack reappears for new content
const _ackedBanners = new Set(
  JSON.parse(sessionStorage.getItem('_ackedBanners') || '[]')
);
function _saveBannerAcks() {
  sessionStorage.setItem('_ackedBanners', JSON.stringify([..._ackedBanners]));
}
function _bannerKey(kind, message) {
  return kind + ':' + (message || '');
}
function _ackBanner(kind) {
  const b = (STATE && STATE.banners) ? STATE.banners : {};
  const msg = (b[kind] && b[kind].message) ? b[kind].message : '';
  const key = _bannerKey(kind, msg);
  _ackedBanners.add(key);
  _saveBannerAcks();
  renderBanners();
  // Fire-and-forget audit call — backend receives kind + actor token
  API.call('bannerAck', TOKEN, kind).catch(() => {});
}

// Compute lightweight hash for change detection (no JSON.stringify)
function _computeUnitsHash(units) {
  if (!units || !units.length) return '0';
  let h = units.length + ':';
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    h += (u.unit_id || '') + (u.status || '') + (u.updated_at || '') + (u.incident || '') + (u.destination || '') + (u.note || '') + (u.active ? '1' : '0') + '|';
  }
  return h;
}

function _computeIncidentsHash(incidents) {
  if (!incidents || !incidents.length) return '0';
  let h = incidents.length + ':';
  for (let i = 0; i < incidents.length; i++) {
    const inc = incidents[i];
    h += (inc.incident_id || '') + (inc.status || '') + (inc.last_update || '') + '|';
  }
  return h;
}

function _computeBannersHash(banners) {
  if (!banners) return '0';
  return (banners.alert?.message || '') + (banners.alert?.ts || '') + (banners.note?.message || '') + (banners.note?.ts || '');
}

function _computeMessagesHash(messages) {
  if (!messages || !messages.length) return '0';
  let h = messages.length + ':';
  for (let i = 0; i < messages.length; i++) {
    h += (messages[i].message_id || '') + (messages[i].read ? '1' : '0') + '|';
  }
  return h;
}

async function refresh(forceFull) {
  if (!TOKEN || _refreshing) return;
  _refreshing = true;

  try {
    // PERF-3: Pass sinceTs on background polls to enable delta responses.
    // forceFull=true (used by forceRefresh) always requests a complete state.
    const sinceTs = (!forceFull && BASELINED && LAST_MAX_UPDATED_AT) ? LAST_MAX_UPDATED_AT : null;
    const r = await API.getState(TOKEN, sinceTs);
    if (!r || !r.ok) {
      // Detect session invalidation (kicked by another login or expired)
      if (r && r.error && (r.error.includes('NOT AUTHENTICATED') || r.error.includes('TOKEN EXPIRED'))) {
        showAlert('SESSION ENDED — ANOTHER USER LOGGED INTO THIS POSITION OR SESSION EXPIRED. PLEASE LOG IN AGAIN.');
        localStorage.removeItem('ems_token');
        TOKEN = '';
        ACTOR = '';
        if (POLL) clearInterval(POLL);
        stopPpPolling();
        document.getElementById('loginBack').style.display = 'flex';
        document.getElementById('userLabel').textContent = '—';
        return;
      }
      setLive(false, 'OFFLINE');
      return;
    }

    // PERF-3: Merge delta responses into existing STATE rather than replacing entirely.
    // A delta response has isDelta=true and contains only units changed since sinceTs.
    if (r.isDelta && STATE) {
      // Merge changed/new units; keep units not in delta untouched
      if (r.units && r.units.length > 0) {
        const updatedIds = new Set(r.units.map(function(u) { return u.unit_id; }));
        const kept = (STATE.units || []).filter(function(u) { return !updatedIds.has(u.unit_id); });
        STATE.units = kept.concat(r.units);
      }
      // Always replace small payloads returned in full
      if (r.incidents !== undefined) STATE.incidents = r.incidents;
      if (r.banners !== undefined) STATE.banners = r.banners;
      if (r.destinations !== undefined) STATE.destinations = r.destinations;
      if (r.messages !== undefined) STATE.messages = r.messages;
      if (r.assignments !== undefined) STATE.assignments = r.assignments;
      STATE.serverTime = r.serverTime;
      STATE.actor = r.actor || STATE.actor;
    } else {
      // Full state replace (cache hit, sinceTs=null, or forceFull)
      STATE = r;
    }
    if (!STATE.staleThresholds) STATE.staleThresholds = { WARN: 10, ALERT: 20, CRITICAL: 30 };

    if (r.incTypeTaxonomy && typeof r.incTypeTaxonomy === 'object' && Object.keys(r.incTypeTaxonomy).length > 0) {
      INC_TYPE_TAXONOMY = r.incTypeTaxonomy;
    }
    setLive(true, 'LIVE • ' + fmtTime24(STATE.serverTime));
    ACTOR = STATE.actor || ACTOR;
    document.getElementById('userLabel').textContent = ACTOR;
    tryBeepOnStateChange();

    // Granular change detection — only re-render what actually changed
    const unitsHash = _computeUnitsHash(STATE.units);
    const incidentsHash = _computeIncidentsHash(STATE.incidents);
    const bannersHash = _computeBannersHash(STATE.banners);
    const messagesHash = _computeMessagesHash(STATE.messages);

    _changedSections.units = (unitsHash !== _lastUnitsHash);
    _changedSections.incidents = (incidentsHash !== _lastIncidentsHash);
    _changedSections.banners = (bannersHash !== _lastBannersHash);
    _changedSections.messages = (messagesHash !== _lastMessagesHash);

    _lastUnitsHash = unitsHash;
    _lastIncidentsHash = incidentsHash;
    _lastBannersHash = bannersHash;
    _lastMessagesHash = messagesHash;

    const anyChange = _changedSections.units || _changedSections.incidents || _changedSections.banners || _changedSections.messages;

    if (anyChange) {
      if (document.hidden) {
        _pendingRender = true;
      } else {
        renderSelective();
      }
    }
  } finally {
    _refreshing = false;
  }
}

async function forceRefresh() {
  _lastUnitsHash = null;
  _lastIncidentsHash = null;
  _lastBannersHash = null;
  _lastMessagesHash = null;
  await refresh(true); // forceFull=true: bypass delta, get complete state
  showToast('REFRESHED.', 'success');
}

function toggleAssisting() {
  _showAssisting = !_showAssisting;
  const btn = document.getElementById('btnToggleAssisting');
  if (btn) btn.textContent = _showAssisting ? 'AUX ON' : 'AUX OFF';
  if (btn) btn.style.opacity = _showAssisting ? '1' : '0.45';
  renderBoardDiff(STATE);
}

function togglePP() {
  const enabled = localStorage.getItem('hoscad_pp_enabled') !== 'false';
  const next = !enabled;
  localStorage.setItem('hoscad_pp_enabled', next ? 'true' : 'false');
  _applyPpBtn(next);
  if (next) { startPpPolling(); showToast('PULSEPOINT FEED ON.'); }
  else { stopPpPolling(); showToast('PULSEPOINT FEED OFF.'); }
}

function _applyPpBtn(enabled) {
  const btn = document.getElementById('btnTogglePP');
  if (!btn) return;
  btn.textContent = enabled ? 'PP ON' : 'PP OFF';
  btn.style.opacity = enabled ? '1' : '0.45';
}

function runQuickCmd(cmd) {
  const inp = document.getElementById('cmd');
  if (inp) inp.value = cmd;
  runCommand();
}

// Performance: Selective rendering — only update changed sections
function renderSelective() {
  if (!STATE) return;

  // Populate status dropdown once
  const sS = document.getElementById('mStatus');
  if (!sS.options.length) {
    (STATE.statuses || []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.code;
      o.textContent = s.code + ' — ' + s.label;
      sS.appendChild(o);
    });
  }

  // Only render what changed
  if (_changedSections.banners) renderBanners();
  if (_changedSections.units) renderStatusSummary();
  // Board re-renders on unit OR incident changes (board rows display incident notes)
  if (_changedSections.units || _changedSections.incidents) renderBoardDiff();
  if (_changedSections.incidents) renderIncidentQueue();
  if (_changedSections.units || _changedSections.incidents) renderActiveCallsBar();
  if (_changedSections.units || _changedSections.incidents) renderBoardMap();
  if (_changedSections.messages) {
    renderMessagesPanel();
    renderMessages();
    renderInboxPanel();
  }

}

function tryBeepOnStateChange() {
  let mU = '';
  (STATE.units || []).forEach(u => {
    if (u && u.updated_at && (!mU || u.updated_at > mU)) mU = u.updated_at;
  });

  const nTs = (STATE.banners && STATE.banners.note && STATE.banners.note.ts) ? STATE.banners.note.ts : '';
  const aTs = (STATE.banners && STATE.banners.alert && STATE.banners.alert.ts) ? STATE.banners.alert.ts : '';

  let mI = '';
  (STATE.incidents || []).forEach(i => {
    if (i && i.last_update && (!mI || i.last_update > mI)) mI = i.last_update;
  });

  const mC = (STATE.messages || []).length;
  const uU = (STATE.messages || []).filter(m => m.urgent && !m.read).length;

  if (!BASELINED) {
    BASELINED = true;
    LAST_MAX_UPDATED_AT = mU;
    LAST_NOTE_TS = nTs;
    LAST_ALERT_TS = aTs;
    LAST_INCIDENT_TOUCH = mI;
    LAST_MSG_COUNT = mC;
    return;
  }

  if (aTs && aTs !== LAST_ALERT_TS) {
    LAST_ALERT_TS = aTs;
    beepAlert();
    // Browser notification for alert banner
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try {
        const alertText = (STATE.banners && STATE.banners.alert && STATE.banners.alert.message) || 'ALERT';
        const n = new Notification('HOSCAD ALERT', { body: alertText, tag: 'hoscad-alert', icon: 'download.png' });
        n.onclick = function() { window.focus(); n.close(); };
        setTimeout(function() { n.close(); }, 10000);
      } catch (e) {}
    }
  }
  if (nTs && nTs !== LAST_NOTE_TS) { LAST_NOTE_TS = nTs; beepNote(); }
  if (mC > LAST_MSG_COUNT) {
    LAST_MSG_COUNT = mC;
    if (uU > 0) beepHotMessage(); else beepMessage();
  }
  if (mI && mI !== LAST_INCIDENT_TOUCH) { LAST_INCIDENT_TOUCH = mI; beepChange(); }
  if (mU && mU !== LAST_MAX_UPDATED_AT) { LAST_MAX_UPDATED_AT = mU; beepChange(); }
}

// ============================================================
// Rendering Functions
// ============================================================
function renderAll() {
  if (!STATE) return;

  // Populate status dropdown
  const sS = document.getElementById('mStatus');
  if (!sS.options.length) {
    (STATE.statuses || []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.code;
      o.textContent = s.code + ' — ' + s.label;
      sS.appendChild(o);
    });
  }

  renderBanners();
  renderStatusSummary();
  renderActiveCallsBar();
  renderIncidentQueue();
  renderMessagesPanel();
  renderMessages();
  renderInboxPanel();
  renderBoardDiff(); // Use optimized DOM diffing
  applyViewState();
}

function renderBanners() {
  const a = document.getElementById('alertBanner');
  const n = document.getElementById('noteBanner');
  const b = (STATE && STATE.banners) ? STATE.banners : { alert: null, note: null };

  // M-6: Prune acks whose banner content no longer matches current state
  // (keeps the Set small; also means message changes auto-show ACK button again)
  const validKeys = new Set();
  for (const kind of ['alert', 'note']) {
    if (b[kind] && b[kind].message) validKeys.add(_bannerKey(kind, b[kind].message));
  }
  let acksChanged = false;
  for (const k of [..._ackedBanners]) {
    if (!validKeys.has(k)) { _ackedBanners.delete(k); acksChanged = true; }
  }
  if (acksChanged) _saveBannerAcks();

  // M-6: Helper to build banner inner HTML with optional ACK button
  function bannerInner(prefix, kind, bannerObj) {
    const msg = bannerObj.message || '';
    const actor = bannerObj.actor || '';
    const key = _bannerKey(kind, msg);
    const isAcked = _ackedBanners.has(key);
    const ackHtml = isAcked
      ? ' <span class="banner-acked" title="Acknowledged">[ACK\'D]</span>'
      : ' <button class="banner-ack-btn" onclick="_ackBanner(\'' + kind + '\')" title="Acknowledge this banner">[ACK]</button>';
    return prefix + esc(msg) + ' \u2014 ' + esc(actor) + ackHtml;
  }

  if (b.alert && b.alert.message) {
    a.style.display = 'block';
    a.innerHTML = bannerInner('ALERT: ', 'alert', b.alert);
  } else {
    a.style.display = 'none';
  }

  if (b.note && b.note.message) {
    n.style.display = 'block';
    n.innerHTML = bannerInner('NOTE: ', 'note', b.note);
  } else {
    n.style.display = 'none';
  }
}

function renderStatusSummary() {
  const el = document.getElementById('statusSummary');
  if (!el) return;

  const units = (STATE.units || []).filter(u => u.active);
  const counts = { AV: 0, D: 0, DE: 0, OS: 0, T: 0, TH: 0, F: 0, BRK: 0, OOS: 0 };

  units.forEach(u => {
    const st = String(u.status || '').toUpperCase();
    if (counts[st] !== undefined) counts[st]++;
  });

  el.innerHTML = `
    <span class="sum-item sum-av" onclick="quickFilter('AV')">AV: <strong>${counts.AV}</strong></span>
    <span class="sum-item sum-d" onclick="quickFilter('D')">D: <strong>${counts.D}</strong></span>
    <span class="sum-item sum-de" onclick="quickFilter('DE')">DE: <strong>${counts.DE}</strong></span>
    <span class="sum-item sum-os" onclick="quickFilter('OS')">OS: <strong>${counts.OS}</strong></span>
    <span class="sum-item sum-t" onclick="quickFilter('T')">T: <strong>${counts.T}</strong></span>
    <span class="sum-item sum-th" onclick="quickFilter('TH')">TH: <strong>${counts.TH}</strong></span>
    <span class="sum-item sum-f" onclick="quickFilter('F')">F: <strong>${counts.F}</strong></span>
    <span class="sum-item sum-brk" onclick="quickFilter('BRK')">BRK: <strong>${counts.BRK}</strong></span>
    <span class="sum-item sum-oos" onclick="quickFilter('OOS')">OOS: <strong>${counts.OOS}</strong></span>
    <span class="sum-item sum-total" onclick="quickFilter('')">TOTAL: <strong>${units.length}</strong></span>
  `;
}

function quickFilter(status) {
  VIEW.filterStatus = status || null;
  const tbFs = document.getElementById('tbFilterStatus');
  if (tbFs) tbFs.value = VIEW.filterStatus || '';
  saveViewState();
  renderBoardDiff();
}

// Active Calls Bar — compact cards for all ACTIVE incidents above the board
function renderActiveCallsBar() {
  const bar = document.getElementById('activeCallsBar');
  if (!bar || !STATE) return;

  const active = (STATE.incidents || []).filter(i => i.status === 'ACTIVE');
  if (!active.length) { bar.style.display = 'none'; return; }

  active.sort((a, b) => new Date(_normalizeTs(a.created_at)) - new Date(_normalizeTs(b.created_at)));

  const now = Date.now();
  const cards = active.map(inc => {
    const shortId = String(inc.incident_id).replace(/^\d{2}-0*/, '');
    const elapsedMs = now - new Date(_normalizeTs(inc.dispatch_time || inc.created_at)).getTime();
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const elapsedStr = elapsedMin >= 60
      ? Math.floor(elapsedMin / 60) + 'H ' + (elapsedMin % 60) + 'M'
      : elapsedMin + 'M';
    const assignedUnits = (STATE.units || []).filter(u => u.active && u.incident === inc.incident_id);
    const unitStr = assignedUnits.length
      ? assignedUnits.map(u => u.unit_id).join(' · ')
      : 'NO UNITS';
    const pri = inc.priority || '';
    const incType = (inc.incident_type || '').toUpperCase();
    const typeCl = getIncidentTypeClass(incType);
    const isUrgent = (inc.incident_note || '').includes('[URGENT]') || pri === 'PRI-1' || pri === 'CRITICAL';
    const cardCl = 'acb-card' + (isUrgent ? ' acb-urgent' : '');
    const priBadgeHtml = pri ? '<span class="acb-pri ' + esc('priority-' + pri) + '">' + esc(pri) + '</span>' : '';
    const isStale = elapsedMin > 60;
    const elCl = isStale ? 'acb-elapsed stale' : elapsedMin > 30 ? 'acb-elapsed warn' : 'acb-elapsed';

    return '<div class="' + cardCl + '" data-inc-id="' + esc(inc.incident_id) + '" onclick="openIncident(\'' + esc(inc.incident_id) + '\')" title="' + esc(inc.scene_address || '') + '">' +
      '<div class="acb-id">INC' + esc(shortId) + priBadgeHtml + '</div>' +
      '<div class="acb-type ' + typeCl + '">' + esc(incType || '—') + '</div>' +
      '<div class="' + elCl + '">' + esc(elapsedStr) + ' · ' + assignedUnits.length + ' UNIT' + (assignedUnits.length !== 1 ? 'S' : '') + '</div>' +
      '<div class="acb-units">' + esc(unitStr) + '</div>' +
    '</div>';
  }).join('');

  bar.innerHTML = cards;
  bar.style.display = 'flex';
}

function renderMessages() {
  const m = STATE.messages || [];
  const u = m.filter(mm => !mm.read).length;
  const uu = m.filter(mm => mm.urgent && !mm.read).length;
  const b = document.getElementById('msgBadge');
  const c = document.getElementById('msgCount');

  if (u > 0) {
    b.style.display = 'inline-block';
    c.textContent = u;
    if (uu > 0) {
      b.classList.add('hasUrgent');
    } else {
      b.classList.remove('hasUrgent');
    }
  } else {
    b.style.display = 'none';
  }
}

function getIncidentTypeClass(type) {
  const t = String(type || '').toUpperCase().trim();
  // Priority-based matching (new transport taxonomy)
  if (t.endsWith('-PRI-1') || t === 'PRI-1') return 'inc-type-delta';
  if (t.endsWith('-PRI-2') || t === 'PRI-2') return 'inc-type-charlie';
  if (t.endsWith('-PRI-3') || t === 'PRI-3') return 'inc-type-bravo';
  if (t.endsWith('-PRI-4') || t === 'PRI-4') return 'inc-type-alpha';
  // Category-based fallback for partially-formed types
  if (t.startsWith('CCT')) return 'inc-type-delta';
  if (t.startsWith('IFT-ALS')) return 'inc-type-charlie';
  if (t.startsWith('IFT-BLS')) return 'inc-type-bravo';
  if (t.startsWith('DISCHARGE') || t.startsWith('DIALYSIS')) return 'inc-type-alpha';
  // Priority suffix detection: PRI-1 / PRI-2 / PRI-3 / PRI-4 (regex fallback)
  const priMatch = t.match(/PRI-?(\d)$/);
  if (priMatch) {
    const n = priMatch[1];
    if (n === '1') return 'inc-type-delta';
    if (n === '2') return 'inc-type-charlie';
    if (n === '3') return 'inc-type-bravo';
    if (n === '4') return 'inc-type-alpha';
  }
  // Old-style EMD determinants (backward compat)
  const det = t.split('-').pop();
  if (det === 'DELTA')   return 'inc-type-delta';
  if (det === 'CHARLIE') return 'inc-type-charlie';
  if (det === 'BRAVO')   return 'inc-type-bravo';
  if (det === 'ALPHA')   return 'inc-type-alpha';
  // Category-based fallback (legacy)
  if (t.startsWith('IFT'))         return 'inc-type-bravo';
  if (t.includes('STRETCHER') || t.includes('WHEELCHAIR')) return 'inc-type-discharge';
  if (t) return 'inc-type-other';
  return '';
}

// ── Phase 2D: Stack badge + stack state helpers ──────────────────────────

/**
 * Render a stack depth badge for a unit row.
 * @param {number} stackDepth - total assignments in stack (including primary)
 * @param {boolean} hasUrgent - true if any stacked assignment is PRI-1/urgent
 * @param {string} unitId - unit_id (used to check _expandedStacks)
 * @returns {string} HTML string for the badge, or '' if depth < 2
 */
function renderStackBadge(stackDepth, hasUrgent, unitId) {
  if (!stackDepth || stackDepth < 2) return '';
  const cls = hasUrgent ? 'stack-badge stack-badge-urgent' : 'stack-badge';
  const chevron = _expandedStacks.has(unitId) ? '▲' : '▼';
  return '<span class="' + cls + '" data-stack-unit="' + esc(unitId) + '">' + stackDepth + 'Q ' + chevron + '</span>';
}

/**
 * Extract stack info for a unit from STATE.
 * Reads STATE.assignments (array of {unit_id, incident_id, role, assigned_at}).
 * Returns { depth, hasUrgent } or null if no stack data available.
 * @param {string} unitId
 * @returns {{ depth: number, hasUrgent: boolean }|null}
 */
function getUnitStackData(unitId) {
  if (!STATE || !STATE.assignments || !Array.isArray(STATE.assignments)) return null;
  const unitAssignments = STATE.assignments.filter(a => a.unit_id === unitId);
  if (!unitAssignments.length) return null;
  const depth = unitAssignments.length;
  const hasUrgent = unitAssignments.some(a => {
    const inc = STATE.incidents ? STATE.incidents.find(i => i.incident_id === a.incident_id) : null;
    return inc && (inc.priority === 'PRI-1' || inc.priority === 'CRITICAL' || (inc.incident_note && inc.incident_note.includes('[URGENT]')));
  });
  return { depth, hasUrgent };
}

/**
 * Append stack sub-rows to a DocumentFragment after a unit row.
 * Called in renderBoardDiff for both cached and rebuilt rows.
 */
function _appendStackSubRows(unitId, fragment) {
  if (!_expandedStacks.has(unitId)) return;
  if (!STATE || !STATE.assignments) return;
  const assignments = STATE.assignments
    .filter(a => a.unit_id === unitId)
    .sort((a, b) => (a.assignment_order || 0) - (b.assignment_order || 0));
  // Self-heal: if unit no longer has a stack, clear the stale expanded entry
  if (!assignments.length) { _expandedStacks.delete(unitId); return; }
  assignments.forEach(a => {
    const isPrimary = a.role === 'primary';
    const roleLabel = isPrimary ? 'PRIMARY' : 'QUEUED #' + (a.assignment_order || '?');
    const inc = (STATE.incidents || []).find(i => i.incident_id === a.incident_id);
    const typeLabel = inc ? (inc.incident_type || '') : '';
    const shortId = String(a.incident_id).replace(/^\d{2}-0*/, '');
    const subTr = document.createElement('tr');
    subTr.className = 'stack-detail-row';
    subTr.innerHTML =
      '<td colspan="2" class="stack-detail-role">' + esc(roleLabel) + '</td>' +
      '<td colspan="3" class="stack-detail-inc">' +
        '<span class="clickableIncidentNum" style="cursor:pointer;" data-inc="' + esc(a.incident_id) + '">INC' + esc(shortId) + '</span> ' + esc(typeLabel) +
      '</td>' +
      '<td colspan="2" class="stack-detail-actions">' +
        (isPrimary ? '' : '<button class="stack-row-btn" onclick="event.stopPropagation();_execCmd(\'PRIMARY ' + esc(a.incident_id) + ' ' + esc(unitId) + '\')">&#9650; PRIMARY</button>') +
        '<button class="stack-row-btn" style="border-color:#f8514960;color:#f85149;" onclick="event.stopPropagation();_execCmd(\'CLEAR ' + esc(a.incident_id) + ' ' + esc(unitId) + '\')">&#x2715; REMOVE</button>' +
      '</td>';
    fragment.appendChild(subTr);
  });
}

/** Resolve AGENCY_ID from M### or C### unit ID pattern. Returns null if no match. */
function resolveAgencyFromUnitId(uid) {
  const m = String(uid || '').toUpperCase().match(/^[MC](\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n >= 100  && n <= 199)  return 'LAPINE_FD';
  if (n >= 200  && n <= 299)  return 'SUNRIVER_FD';
  if (n >= 300  && n <= 399)  return 'BEND_FIRE';
  if (n >= 400  && n <= 499)  return 'REDMOND_FIRE';
  if (n >= 500  && n <= 599)  return 'CROOK_COUNTY_FIRE';
  if (n >= 600  && n <= 699)  return 'CLOVERDALE_FD';
  if (n >= 700  && n <= 799)  return 'SISTERS_CAMP_SHERMAN';
  if (n >= 800  && n <= 899)  return 'BLACK_BUTTE_RANCH';
  if (n >= 900  && n <= 999)  return 'ALFALFA_FD';
  if (n >= 1100 && n <= 1199) return 'CRESCENT_RFPD';
  if (n >= 1200 && n <= 1299) return 'PRINEVILLE_FIRE';
  if (n >= 1300 && n <= 1399) return 'THREE_RIVERS_FD';
  if (n >= 1700 && n <= 1799) return 'JEFFCO_FIRE_EMS';
  if (n >= 2200 && n <= 2299) return 'WARM_SPRINGS_FD';
  return null;
}

function computeRecommendations() {
  const incType = (document.getElementById('newIncType')?.value || '').trim().toUpperCase();
  const pri = (document.getElementById('newIncPriority')?.value || '').trim().toUpperCase();
  const available = ((STATE && STATE.units) || []).filter(u =>
    u.active && (u.status === 'AV' || u.status === 'BRK') && u.include_in_recommendations !== false
  );
  if (!available.length) return [];

  const needsALS  = /^CCT|^IFT-ALS/.test(incType) || pri === 'PRI-1';
  const preferALS = pri === 'PRI-2';
  const blsOk     = /^IFT-BLS|^DISCHARGE|^DIALYSIS/.test(incType) || pri === 'PRI-3' || pri === 'PRI-4';

  const scored = available.map(u => {
    const level = (u.level || '').toUpperCase();
    let score = 100;
    // BRK penalty
    if (u.status === 'BRK') score -= 10;
    if (needsALS) {
      if (level === 'ALS')        score += 60;
      else if (level === 'AEMT')  score += 30;
      else if (level === 'BLS' || level === 'EMT')  score += 5;
    } else if (preferALS) {
      if (level === 'ALS')        score += 40;
      else if (level === 'AEMT')  score += 25;
      else if (level === 'BLS' || level === 'EMT')  score += 15;
    } else if (blsOk) {
      if (level === 'BLS' || level === 'EMT') score += 40;
      else if (level === 'AEMT')  score += 35;
      else if (level === 'ALS')   score += 20;
    } else {
      if (level === 'ALS')        score += 30;
      else if (level === 'AEMT')  score += 20;
      else if (level === 'BLS' || level === 'EMT')  score += 10;
    }
    return { unit: u, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => s.unit);
}

function renderIncSuggest() {
  const el = document.getElementById('incSuggest');
  if (!el) return;
  const recs = computeRecommendations();
  if (!recs.length) { el.innerHTML = ''; return; }

  const chips = recs.map(u => {
    const level = u.level ? '<span class="suggest-level">' + esc(u.level) + '</span>' : '';
    const sta   = u.station ? '<span class="muted" style="font-size:10px;margin-left:2px;">' + esc(u.station) + '</span>' : '';
    return '<button type="button" class="suggest-chip" onclick="selectSuggestedUnit(\'' + esc(u.unit_id) + '\')">' +
      esc(u.unit_id) + level + sta + '</button>';
  }).join('');

  el.innerHTML = '<div class="inc-suggest-row">' +
    '<span class="muted" style="font-size:11px;white-space:nowrap;">SUGGESTED:</span>' +
    chips + '</div>';
}

function selectSuggestedUnit(unitId) {
  const sel = document.getElementById('newIncUnit');
  if (!sel) return;
  sel.value = unitId;
  sel.classList.add('row-flash');
  setTimeout(() => sel.classList.remove('row-flash'), 600);
}

function renderIncidentQueue() {
  const panel = document.getElementById('incidentQueue');
  const countEl = document.getElementById('incQueueCount');
  const incidents = (STATE.incidents || []).filter(i => i.status === 'QUEUED');

  if (countEl) countEl.textContent = incidents.length > 0 ? '(' + incidents.length + ' QUEUED)' : '';

  if (!incidents.length) {
    panel.innerHTML = '<div class="muted" style="padding:8px;text-align:center;">NO QUEUED INCIDENTS</div>';
    return;
  }

  incidents.sort((a, b) => new Date(_normalizeTs(a.created_at)) - new Date(_normalizeTs(b.created_at)));

  let html = '<table class="inc-queue-table"><thead><tr>';
  html += '<th>INC#</th><th>LOCATION</th><th>TYPE</th><th>NOTE</th><th>SCENE</th><th>WAIT</th><th>ACTIONS</th>';
  html += '</tr></thead><tbody>';

  incidents.forEach(inc => {
    const urgent = inc.incident_note && inc.incident_note.includes('[URGENT]');
    const pri = inc.priority || '';
    let rawNote = inc.incident_note || '';
    const isMutualAid = /\[MA\]/i.test(rawNote);
    const cbMatch = rawNote.match(/\[CB:([^\]]+)\]/i);
    const maBadge = isMutualAid ? '<span class="ma-badge">MA</span>' : '';
    const cbBadge = cbMatch ? '<span class="cb-badge">CB:' + esc(cbMatch[1].trim()) + '</span>' : '';
    const ppBadge = inc.pp_incident_id ? '<span class="pp-rel-badge" title="PulsePoint Link">PP:' + esc(inc.pp_incident_id) + '</span>' : '';
    const relIds = Array.isArray(inc.related_incidents) ? inc.related_incidents : [];
    const relBadge = relIds.map(function(rid) {
      const shortRel = String(rid).replace(/^\d{2}-/, '');
      return '<span class="rel-badge" title="Linked Incident" onclick="event.stopPropagation();openIncident(\'' + esc(rid) + '\')">REL:' + esc(shortRel) + '</span>';
    }).join('');
    let rowCl = (urgent || pri === 'PRI-1' || pri === 'CRITICAL' ? 'inc-urgent' : '') + (isMutualAid ? ' inc-mutual-aid' : '');
    const mins = minutesSince(inc.created_at);
    const age = mins != null ? Math.floor(mins) + 'M' : '--';
    const waitMins = Math.floor((Date.now() - new Date(_normalizeTs(inc.created_at)).getTime()) / 60000);
    const isStale = waitMins >= 240;
    const staleBadge = isStale ? '<span class="stale-badge">STALE</span>' : '';
    if (isStale) rowCl += ' inc-stale';
    const waitCls = isStale ? 'inc-stale-wait blink' : waitMins > 20 ? 'inc-overdue' : waitMins > 10 ? 'inc-wait' : '';
    const shortId = inc.incident_id.replace(/^\d{2}-/, '');
    let note = rawNote.replace(/^\[URGENT\]\s*/i, '').replace(/\[MA\]\s*/gi, '').replace(/\[CB:[^\]]+\]\s*/gi, '').trim();
    const incType = inc.incident_type || '';
    const typeCl = getIncidentTypeClass(incType);
    const priBadge = pri ? `<span class="priority-${esc(pri)}" style="font-size:10px;font-weight:900;margin-left:4px;">${esc(pri)}</span>` : '';
    const sceneDisplay = (inc.scene_address || '').substring(0, 20) || '—';

    html += `<tr class="${rowCl}" data-inc-id="${esc(inc.incident_id)}" onclick="openIncident('${esc(inc.incident_id)}')">`;
    html += `<td class="inc-id">${urgent ? 'HOT ' : ''}INC${esc(shortId)}${priBadge}${maBadge}${cbBadge}${ppBadge}${relBadge}${staleBadge}</td>`;
    const incDestResolved = AddressLookup.resolve(inc.destination);
    const incDestDisplay = incDestResolved.recognized ? incDestResolved.addr.name : (inc.destination || 'NO DEST');
    html += `<td class="inc-dest${incDestResolved.recognized ? ' dest-recognized' : ''}">${esc(incDestDisplay)}</td>`;
    html += `<td>${incType ? '<span class="inc-type ' + typeCl + '">' + esc(incType) + '</span>' : '<span class="muted">--</span>'}</td>`;
    html += `<td class="inc-note" title="${esc(note)}">${esc(note || '--')}</td>`;
    html += `<td style="font-size:11px;color:var(--muted);">${esc(sceneDisplay)}</td>`;
    html += `<td class="${waitCls}">${waitMins}M</td>`;
    html += `<td style="white-space:nowrap;">`;
    html += `<button class="toolbar-btn toolbar-btn-accent" onclick="event.stopPropagation(); assignIncidentToUnit('${esc(inc.incident_id)}')">ASSIGN</button> `;
    html += `<button class="toolbar-btn" onclick="event.stopPropagation(); openIncident('${esc(inc.incident_id)}')">REVIEW</button> `;
    html += `<button class="btn-danger mini" style="padding:3px 6px;font-size:10px;" onclick="event.stopPropagation(); closeIncidentFromQueue('${esc(inc.incident_id)}')">CLOSE</button>`;
    html += `</td>`;
    html += '</tr>';
  });

  html += '</tbody></table>';
  panel.innerHTML = html;
  updatePopoutStats();
}

function renderMessagesPanel() {
  const panel = document.getElementById('messagesPanel');
  if (!STATE) return;
  const m = STATE.messages || [];
  const unread = m.filter(msg => !msg.read).length;
  const countEl = document.getElementById('msgPanelCount');

  if (countEl) {
    countEl.textContent = m.length > 0 ? `(${m.length} TOTAL, ${unread} UNREAD)` : '';
  }

  if (!m.length) {
    panel.innerHTML = '<div class="muted" style="padding:20px;text-align:center;">NO MESSAGES</div>';
    return;
  }

  panel.innerHTML = m.map(msg => {
    const cl = ['messageDisplayItem'];
    if (msg.urgent) cl.push('urgent');
    const fr = msg.from_initials + '@' + msg.from_role;
    const fC = getRoleColor(fr);
    const uH = msg.urgent ? '[HOT] ' : '';
    const replyCmd = 'MSG ' + msg.from_role + ' ';
    return `<div class="${cl.join(' ')}">
      <div class="messageDisplayHeader ${fC}">${uH}FROM ${esc(fr)} TO ${esc(msg.to_role)}</div>
      <div class="messageDisplayText">${esc(msg.message)}</div>
      <div class="messageDisplayTime">${fmtTime24(msg.ts)}<button class="btn-secondary mini" style="margin-left:10px;" onclick="replyToMessage('${esc(replyCmd)}')">REPLY</button></div>
    </div>`;
  }).join('');
}

// ============================================================
// Inbox Panel (live message display)
// ============================================================
function renderInboxPanel() {
  const panel = document.getElementById('msgInboxList');
  if (!panel) return;
  const m = STATE.messages || [];
  const unread = m.filter(msg => !msg.read).length;
  const badge = document.getElementById('inboxBadge');
  if (badge) badge.textContent = m.length > 0 ? `(${unread} NEW / ${m.length} TOTAL)` : '(EMPTY)';

  if (!m.length) {
    panel.innerHTML = '<div class="muted" style="padding:10px;text-align:center;">NO MESSAGES</div>';
    return;
  }

  panel.innerHTML = m.map(msg => {
    const cl = ['inbox-msg'];
    if (!msg.read) cl.push('unread');
    if (msg.urgent) cl.push('urgent');
    const fr = (msg.from_initials || '?') + '@' + (msg.from_role || '?');
    const ts = msg.ts ? fmtTime24(msg.ts) : '';
    const text = String(msg.message || '').substring(0, 120);
    const replyCmd = 'MSG ' + msg.from_role + ' ';
    return `<div class="${cl.join(' ')}" onclick="readAndReplyInbox('${esc(msg.message_id)}', '${esc(replyCmd)}')">
      <div><span class="inbox-from">${msg.urgent ? 'HOT ' : ''}${esc(fr)}</span> <span class="inbox-time">${esc(ts)}</span></div>
      <div class="inbox-text">${esc(text)}</div>
    </div>`;
  }).join('');
}

async function readAndReplyInbox(msgId, replyCmd) {
  if (TOKEN && msgId) {
    await API.readMessage(TOKEN, msgId);
  }
  const cmd = document.getElementById('cmd');
  if (cmd) {
    cmd.value = replyCmd;
    cmd.focus();
    cmd.setSelectionRange(replyCmd.length, replyCmd.length);
  }
  refresh();
}

// ============================================================
// Bottom Panel Toggle
// ============================================================
function toggleBottomPanel(panel) {
  const el = document.getElementById(panel === 'msgInbox' ? 'msgInboxPanel' : 'scratchPanel');
  if (el) el.classList.toggle('collapsed');
}

// ============================================================
// Scratch Notes (localStorage, per-user)
// ============================================================
function getScratchKey() {
  return 'hoscad_scratch_' + (ACTOR || 'anon');
}

function loadScratch() {
  const val = localStorage.getItem(getScratchKey()) || '';
  const pad = document.getElementById('scratchPad');
  if (pad) {
    pad.value = val;
    if (!pad.dataset.scratchAttached) {
      pad.addEventListener('input', saveScratch);
      pad.dataset.scratchAttached = '1';
    }
  }
  const side = document.getElementById('scratchPadSide');
  if (side) side.value = val;
}

function saveScratch() {
  const pad = document.getElementById('scratchPad');
  if (!pad) return;
  localStorage.setItem(getScratchKey(), pad.value);
  const side = document.getElementById('scratchPadSide');
  if (side) side.value = pad.value;
}

function saveScratchSide() {
  const side = document.getElementById('scratchPadSide');
  if (!side) return;
  localStorage.setItem(getScratchKey(), side.value);
  const pad = document.getElementById('scratchPad');
  if (pad) pad.value = side.value;
}

function renderBoard() {
  const tb = document.getElementById('boardBody');
  const q = document.getElementById('search').value.trim().toUpperCase();
  const sI = document.getElementById('showInactive').checked;
  const boardCountEl = document.getElementById('boardCount');

  let us = (STATE.units || []).filter(u => {
    if (!sI && !u.active) return false;
    // Filter assisting agency units if toggle is off
    if (!_showAssisting) {
      const t = (u.type || '').toLowerCase();
      if (t === 'law' || t === 'dot' || t === 'support') return false;
    }
    const h = (u.unit_id + ' ' + (u.display_name || '') + ' ' + (u.note || '') + ' ' + (u.destination || '') + ' ' + (u.incident || '')).toUpperCase();
    if (q && !h.includes(q)) return false;
    if (ACTIVE_INCIDENT_FILTER && String(u.incident || '') !== ACTIVE_INCIDENT_FILTER) return false;
    // VIEW filter
    if (VIEW.filterStatus) {
      const uSt = String(u.status || '').toUpperCase();
      if (uSt !== VIEW.filterStatus.toUpperCase()) return false;
    }
    return true;
  });

  // Sort based on VIEW.sort
  us.sort((a, b) => {
    let cmp = 0;
    switch (VIEW.sort) {
      case 'unit':
        cmp = String(a.unit_id || '').localeCompare(String(b.unit_id || ''));
        break;
      case 'elapsed': {
        const mA = minutesSince(a.updated_at) ?? -1;
        const mB = minutesSince(b.updated_at) ?? -1;
        cmp = mB - mA;
        break;
      }
      case 'updated': {
        const tA = a.updated_at ? new Date(_normalizeTs(a.updated_at)).getTime() : 0;
        const tB = b.updated_at ? new Date(_normalizeTs(b.updated_at)).getTime() : 0;
        cmp = tB - tA;
        break;
      }
      case 'status':
      default: {
        const ra = statusRank(a.status);
        const rb = statusRank(b.status);
        cmp = ra - rb;
        if (cmp === 0 && String(a.status || '').toUpperCase() === 'D') {
          const ta = a.updated_at ? new Date(_normalizeTs(a.updated_at)).getTime() : 0;
          const tbb = b.updated_at ? new Date(_normalizeTs(b.updated_at)).getTime() : 0;
          cmp = tbb - ta;
        }
        if (cmp === 0) cmp = String(a.unit_id || '').localeCompare(String(b.unit_id || ''));
        break;
      }
    }
    return VIEW.sortDir === 'desc' ? -cmp : cmp;
  });

  // Stale detection — expanded to D, DE, OS, T, TH
  const STALE_STATUSES = new Set(['D', 'DE', 'OS', 'T', 'TH']);
  const staleGroups = {};
  us.forEach(u => {
    if (!u.active) return;
    const st = String(u.status || '').toUpperCase();
    if (!STALE_STATUSES.has(st)) return;
    const mi = minutesSince(u.updated_at);
    if (mi != null && mi >= STATE.staleThresholds.CRITICAL) {
      if (!staleGroups[st]) staleGroups[st] = [];
      staleGroups[st].push(u.unit_id);
    }
  });

  const ba = document.getElementById('staleBanner');
  const staleEntries = Object.keys(staleGroups).map(s => 'STALE ' + s + ' (≥' + STATE.staleThresholds.CRITICAL + 'M): ' + staleGroups[s].join(', '));
  if (staleEntries.length) {
    ba.style.display = 'block';
    ba.textContent = staleEntries.join(' | ');
  } else {
    ba.style.display = 'none';
  }

  const activeCount = us.filter(u => u.active).length;
  if (boardCountEl) boardCountEl.textContent = '(' + activeCount + ' ACTIVE)';

  tb.innerHTML = '';
  us.forEach(u => {
    const tr = document.createElement('tr');
    const mi = minutesSince(u.updated_at);

    // Stale classes — expanded to D, DE, OS, T
    if (u.active && STALE_STATUSES.has(String(u.status || '').toUpperCase()) && mi != null) {
      if (mi >= STATE.staleThresholds.CRITICAL) tr.classList.add('stale30');
      else if (mi >= STATE.staleThresholds.ALERT) tr.classList.add('stale20');
      else if (mi >= STATE.staleThresholds.WARN) tr.classList.add('stale10');
    }

    // Status row tint
    tr.classList.add('status-' + (u.status || '').toUpperCase());

    // Selected row
    if (SELECTED_UNIT_ID && String(u.unit_id || '').toUpperCase() === SELECTED_UNIT_ID) {
      tr.classList.add('selected');
    }

    // UNIT column
    const uId = (u.unit_id || '').toUpperCase();
    const di = (u.display_name || '').toUpperCase();
    const sD = di && di !== uId;
    const lvlBadge = u.level ? ' <span class="level-badge level-' + esc(u.level) + '">' + esc(u.level) + '</span>' : '';
    const ppBadge = (() => {
      if (!u.source || !u.source.startsWith('PP:')) return '';
      const agencyId = u.source.replace('PP:', '');
      const ag = PP_AGENCIES[agencyId];
      if (!ag) return ' <span class="pp-agency-badge" style="background:#55555522;border-color:#55555566;color:#aaa">PP</span>';
      return ' <span class="pp-agency-badge" style="background:' + ag.color + '22;border-color:' + ag.color + '66;color:' + ag.color + '">' + ag.short + '</span>';
    })();
    const crewParts = u.unit_info ? String(u.unit_info).split('|').filter(p => /^CM\d:/i.test(p)) : [];
    const crewHtml = crewParts.length ? '<div class="crew-sub">' + crewParts.map(p => esc(p.replace(/^CM\d:/i, '').trim())).join(' / ') + '</div>' : '';
    const unitHtml = '<span class="unit">' + esc(uId) + '</span>' + lvlBadge + ppBadge +
      (u.active ? '' : ' <span class="muted">(I)</span>') +
      (sD ? ' <span class="muted" style="font-size:10px;">' + esc(di) + '</span>' : '') +
      crewHtml;

    // STATUS column — CAD reader board style: large code + dimmer label
    const sL = (STATE.statuses || []).find(s => s.code === u.status)?.label || u.status;
    const stCode = (u.status || '').toUpperCase();
    const statusHtml = '<span class="statusCode status-text-' + esc(stCode) + '" title="' + esc(sL) + '">' + esc(stCode) + '</span>';

    // ELAPSED column — coloring for D, DE, OS, T
    const elapsedVal = formatElapsed(mi);
    let elapsedClass = 'elapsed-cell';
    if (mi != null && STALE_STATUSES.has(stCode)) {
      if (STATE.staleThresholds && mi >= STATE.staleThresholds.CRITICAL) elapsedClass += ' elapsed-critical';
      else if (STATE.staleThresholds && mi >= STATE.staleThresholds.WARN) elapsedClass += ' elapsed-warn';
    }

    // LOCATION column
    const destHtml = AddressLookup.formatLocation(u);

    // NOTES column — incident notes if on incident, status notes otherwise
    let noteText = '';
    if (u.incident) {
      const incObj = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (incObj && incObj.incident_note) noteText = incObj.incident_note.replace(/^\[URGENT\]\s*/i, '').trim();
    }
    if (!noteText) noteText = (u.note || '').replace(/^\[OOS:[^\]]+\]\s*/, '').replace(/\[LOC:[^\]]*\]\s*/g, '').replace(/\[ETA:\d+\]\s*/g, '');
    noteText = noteText.toUpperCase();
    const oosMatch = (u.note || '').match(/^\[OOS:([^\]]+)\]/);
    const oosBadge = oosMatch ? '<span class="oos-badge">' + esc(oosMatch[1]) + '</span>' : '';
    const patMatch = (u.note || '').match(/\[PAT:([^\]]+)\]/);
    const patBadge = patMatch ? '<span class="pat-badge">PAT:' + esc(patMatch[1]) + '</span>' : '';
    const locMatch = (u.note || '').match(/\[LOC:([^\]]+)\]/);
    const locBadge = locMatch ? '<span class="loc-badge" title="' + esc(locMatch[1]) + '">LOC</span>' : '';
    const etaMatch = (u.note || '').match(/\[ETA:(\d+)\]/);
    const etaBadge = etaMatch ? '<span class="eta-badge" title="ETA SET">ETA:' + esc(etaMatch[1]) + 'M</span>' : '';
    // ASSIST badge — for law/dot/support units or units explicitly excluded from recommendations
    const uTypeL = (u.type || '').toLowerCase();
    const isAssistType = uTypeL === 'law' || uTypeL === 'dot' || uTypeL === 'support';
    const assistBadge = isAssistType ? '<span class="cap-badge-assist">ASSIST</span>' : '';
    const noteHtml = (noteText ? '<span class="noteBig">' + esc(noteText) + '</span>' : '<span class="muted">—</span>') + oosBadge + patBadge + locBadge + etaBadge + assistBadge;

    // INC# column — with type dot
    let incHtml = '<span class="muted">—</span>';
    let groupBorderColor = '';
    if (u.incident) {
      const shortInc = String(u.incident).replace(/^\d{2}-/, '');
      let dotHtml = '';
      const incObj = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (incObj && incObj.incident_type) {
        const typCl = getIncidentTypeClass(incObj.incident_type);
        const dotCl = typCl.replace('inc-type-', 'inc-type-dot-');
        if (dotCl) dotHtml = '<span class="inc-type-dot ' + dotCl + '"></span>';
        // Group border: show if 2+ active units share this incident
        const sharedCount = (STATE.units || []).filter(ou => ou.active && ou.unit_id !== u.unit_id && ou.incident === u.incident).length;
        if (sharedCount > 0) groupBorderColor = INC_GROUP_BORDER[typCl] || '#6a7a8a';
      }
      const stackData = getUnitStackData(u.unit_id);
      const stackBadgeHtml = stackData ? renderStackBadge(stackData.depth, stackData.hasUrgent, u.unit_id) : '';
      incHtml = dotHtml + '<span class="clickableIncidentNum" onclick="event.stopPropagation(); openIncident(\'' + esc(u.incident) + '\')">' + esc('INC' + shortInc) + '</span>' + stackBadgeHtml;
    }
    // Apply border-left: incident group border takes priority; fall back to unit type accent
    if (groupBorderColor) {
      tr.style.borderLeft = '3px solid ' + groupBorderColor;
    } else if (uTypeL === 'law') {
      tr.style.borderLeft = '3px solid #4a6fa5';
    } else if (uTypeL === 'dot') {
      tr.style.borderLeft = '3px solid #e6841a';
    } else if (uTypeL === 'support') {
      tr.style.borderLeft = '3px solid #888';
    }

    // UPDATED column
    const aC = getRoleColor(u.updated_by);
    const updatedHtml = fmtTime24(u.updated_at) + ' <span class="muted ' + aC + '" style="font-size:10px;">' + esc((u.updated_by || '').toUpperCase()) + '</span>';

    tr.innerHTML = '<td>' + unitHtml + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td class="' + elapsedClass + '">' + elapsedVal + '</td>' +
      '<td>' + destHtml + '</td>' +
      '<td>' + noteHtml + '</td>' +
      '<td>' + incHtml + '</td>' +
      '<td>' + updatedHtml + '</td>';

    // Single-click = select row
    tr.onclick = (e) => {
      e.stopPropagation();
      selectUnit(u.unit_id);
    };

    // Double-click = open edit modal
    tr.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (u.source && u.source.startsWith('PP:')) { openPpUnitActions(u); return; }
      openModal(u);
    };

    tr.style.cursor = 'pointer';
    tb.appendChild(tr);
  });
  updatePopoutStats();
}

// Performance: DOM diffing version — only updates changed rows
function renderBoardDiff() {
  const tb = document.getElementById('boardBody');
  const q = document.getElementById('search').value.trim().toUpperCase();
  const sI = document.getElementById('showInactive').checked;
  const boardCountEl = document.getElementById('boardCount');

  // Pre-compute uppercase filter status once (not in loop)
  const filterStatusUpper = VIEW.filterStatus ? VIEW.filterStatus.toUpperCase() : null;

  let us = (STATE.units || []).filter(u => {
    if (!sI && !u.active) return false;
    // Filter assisting agency units if toggle is off
    if (!_showAssisting) {
      const t = (u.type || '').toLowerCase();
      if (t === 'law' || t === 'dot' || t === 'support') return false;
    }
    const h = (u.unit_id + ' ' + (u.display_name || '') + ' ' + (u.note || '') + ' ' + (u.destination || '') + ' ' + (u.incident || '')).toUpperCase();
    if (q && !h.includes(q)) return false;
    if (ACTIVE_INCIDENT_FILTER && String(u.incident || '') !== ACTIVE_INCIDENT_FILTER) return false;
    if (filterStatusUpper) {
      if (String(u.status || '').toUpperCase() !== filterStatusUpper) return false;
    }
    return true;
  });

  // Pre-compute timestamps for sorting (avoid new Date() in comparator)
  const tsCache = new Map();
  us.forEach(u => {
    tsCache.set(u.unit_id, u.updated_at ? new Date(_normalizeTs(u.updated_at)).getTime() : 0);
  });

  us.sort((a, b) => {
    let cmp = 0;
    switch (VIEW.sort) {
      case 'unit':
        cmp = String(a.unit_id || '').localeCompare(String(b.unit_id || ''));
        break;
      case 'elapsed':
      case 'updated': {
        cmp = tsCache.get(b.unit_id) - tsCache.get(a.unit_id);
        break;
      }
      case 'status':
      default: {
        const ra = statusRank(a.status);
        const rb = statusRank(b.status);
        cmp = ra - rb;
        if (cmp === 0 && String(a.status || '').toUpperCase() === 'D') {
          cmp = tsCache.get(b.unit_id) - tsCache.get(a.unit_id);
        }
        if (cmp === 0) cmp = String(a.unit_id || '').localeCompare(String(b.unit_id || ''));
        break;
      }
    }
    return VIEW.sortDir === 'desc' ? -cmp : cmp;
  });

  // Stale detection
  const STALE_STATUSES = new Set(['D', 'DE', 'OS', 'T', 'TH']);
  const staleGroups = {};
  us.forEach(u => {
    if (!u.active) return;
    const st = String(u.status || '').toUpperCase();
    if (!STALE_STATUSES.has(st)) return;
    const mi = minutesSince(u.updated_at);
    if (mi != null && mi >= STATE.staleThresholds.CRITICAL) {
      if (!staleGroups[st]) staleGroups[st] = [];
      staleGroups[st].push(u.unit_id);
    }
  });

  const ba = document.getElementById('staleBanner');
  const staleEntries = Object.keys(staleGroups).map(s => 'STALE ' + s + ' (≥' + STATE.staleThresholds.CRITICAL + 'M): ' + staleGroups[s].join(', '));
  if (staleEntries.length) {
    ba.style.display = 'block';
    ba.textContent = staleEntries.join(' | ');
  } else {
    ba.style.display = 'none';
  }

  const activeCount = us.filter(u => u.active).length;
  if (boardCountEl) boardCountEl.textContent = '(' + activeCount + ' ACTIVE)';

  // Build new row order
  const newOrder = us.map(u => u.unit_id);
  const existingRows = tb.querySelectorAll('tr[data-unit-id]');
  const existingMap = new Map();
  existingRows.forEach(tr => existingMap.set(tr.dataset.unitId, tr));

  // Precompute incident lookup map — O(1) per unit vs O(n) find() per unit
  const incidentMap = new Map((STATE.incidents || []).map(i => [i.incident_id, i]));

  // Track which rows we've processed
  const processedIds = new Set();

  // Build/update rows using DocumentFragment for batch insert
  const fragment = document.createDocumentFragment();

  us.forEach((u, idx) => {
    const unitId = u.unit_id;
    processedIds.add(unitId);

    // Generate row hash to check if update needed
    // Include linked incident's last_update so note changes on the incident invalidate the row
    const _incObj = u.incident && STATE.incidents ? (STATE.incidents.find(i => i.incident_id === u.incident) || {}) : {};
    const _iLU = _incObj.last_update || '';
    const _iSA = _incObj.scene_address || '';
    const rowHash = unitId + '|' + (u.status || '') + '|' + (u.updated_at || '') + '|' + (u.destination || '') + '|' + (u.note || '') + '|' + (u.incident || '') + '|' + (u.active ? '1' : '0') + '|' + (u.level || '') + '|' + _iLU + '|' + (u.unit_info || '') + '|' + (u.source || '') + '|' + _iSA + '|' + (_expandedStacks.has(unitId) ? 'E' : '');
    const cached = _rowCache.get(unitId);

    let tr = existingMap.get(unitId);

    // If row exists and hash matches, just reposition if needed
    if (tr && cached && cached.hash === rowHash) {
      // Update stale/selected classes only
      updateRowClasses(tr, u, STALE_STATUSES);
      fragment.appendChild(tr);
      _appendStackSubRows(unitId, fragment);
      return;
    }

    // Build new row HTML
    const mi = minutesSince(u.updated_at);

    // Build classes
    let rowClasses = 'status-' + (u.status || '').toUpperCase();
    const stCode = (u.status || '').toUpperCase();
    if (u.active && STALE_STATUSES.has(stCode) && mi != null) {
      if (mi >= STATE.staleThresholds.CRITICAL) rowClasses += ' stale30';
      else if (mi >= STATE.staleThresholds.ALERT) rowClasses += ' stale20';
      else if (mi >= STATE.staleThresholds.WARN) rowClasses += ' stale10';
    }
    if (SELECTED_UNIT_ID && String(unitId).toUpperCase() === SELECTED_UNIT_ID) {
      rowClasses += ' selected';
    }

    // UNIT column
    const uId = (u.unit_id || '').toUpperCase();
    const di = (u.display_name || '').toUpperCase();
    const sD = di && di !== uId;
    const lvlBadge = u.level ? ' <span class="level-badge level-' + esc(u.level) + '">' + esc(u.level) + '</span>' : '';
    const ppBadge = (() => {
      if (!u.source || !u.source.startsWith('PP:')) return '';
      const agencyId = u.source.replace('PP:', '');
      const ag = PP_AGENCIES[agencyId];
      if (!ag) return ' <span class="pp-agency-badge" style="background:#55555522;border-color:#55555566;color:#aaa">PP</span>';
      return ' <span class="pp-agency-badge" style="background:' + ag.color + '22;border-color:' + ag.color + '66;color:' + ag.color + '">' + ag.short + '</span>';
    })();
    const crewParts = u.unit_info ? String(u.unit_info).split('|').filter(p => /^CM\d:/i.test(p)) : [];
    const crewHtml = crewParts.length ? '<div class="crew-sub">' + crewParts.map(p => esc(p.replace(/^CM\d:/i, '').trim())).join(' / ') + '</div>' : '';
    const unitHtml = '<span class="unit">' + esc(uId) + '</span>' + lvlBadge + ppBadge +
      (u.active ? '' : ' <span class="muted">(I)</span>') +
      (sD ? ' <span class="muted" style="font-size:10px;">' + esc(di) + '</span>' : '') +
      crewHtml;

    // STATUS column — CAD reader board style: large code + dimmer label
    const sL = (STATE.statuses || []).find(s => s.code === u.status)?.label || u.status;
    const statusHtml = '<span class="statusCode status-text-' + esc(stCode) + '" title="' + esc(sL) + '">' + esc(stCode) + '</span>';

    // ELAPSED column
    const elapsedVal = formatElapsed(mi);
    let elapsedClass = 'elapsed-cell';
    if (mi != null && STALE_STATUSES.has(stCode)) {
      if (STATE.staleThresholds && mi >= STATE.staleThresholds.CRITICAL) elapsedClass += ' elapsed-critical';
      else if (STATE.staleThresholds && mi >= STATE.staleThresholds.WARN) elapsedClass += ' elapsed-warn';
    }

    // LOCATION column
    const destHtml = AddressLookup.formatLocation(u);

    // NOTES column
    let noteText = '';
    if (u.incident) {
      const incObj = incidentMap.get(u.incident);
      if (incObj && incObj.incident_note) noteText = incObj.incident_note.replace(/^\[URGENT\]\s*/i, '').trim();
    }
    if (!noteText) noteText = (u.note || '').replace(/^\[OOS:[^\]]+\]\s*/, '').replace(/\[LOC:[^\]]*\]\s*/g, '').replace(/\[ETA:\d+\]\s*/g, '');
    noteText = noteText.toUpperCase();
    const oosMatch = (u.note || '').match(/^\[OOS:([^\]]+)\]/);
    const oosBadge = oosMatch ? '<span class="oos-badge">' + esc(oosMatch[1]) + '</span>' : '';
    const patMatch = (u.note || '').match(/\[PAT:([^\]]+)\]/);
    const patBadge = patMatch ? '<span class="pat-badge">PAT:' + esc(patMatch[1]) + '</span>' : '';
    const locMatch2 = (u.note || '').match(/\[LOC:([^\]]+)\]/);
    const locBadge2 = locMatch2 ? '<span class="loc-badge" title="' + esc(locMatch2[1]) + '">LOC</span>' : '';
    const etaMatch2 = (u.note || '').match(/\[ETA:(\d+)\]/);
    const etaBadge2 = etaMatch2 ? '<span class="eta-badge" title="ETA SET">ETA:' + esc(etaMatch2[1]) + 'M</span>' : '';
    // ASSIST badge — for law/dot/support units or units explicitly excluded from recommendations
    const uTypeL2 = (u.type || '').toLowerCase();
    const isAssistType2 = uTypeL2 === 'law' || uTypeL2 === 'dot' || uTypeL2 === 'support';
    const assistBadge2 = (isAssistType2 || u.include_in_recommendations === false) ? '<span class="cap-badge-assist">ASSIST</span>' : '';
    const noteHtml = (noteText ? '<span class="noteBig">' + esc(noteText) + '</span>' : '<span class="muted">—</span>') + oosBadge + patBadge + locBadge2 + etaBadge2 + assistBadge2;

    // INC# column
    let incHtml = '<span class="muted">—</span>';
    let groupBorderColor2 = '';
    if (u.incident) {
      const shortInc = String(u.incident).replace(/^\d{2}-/, '');
      let dotHtml = '';
      const incObj = incidentMap.get(u.incident);
      if (incObj && incObj.incident_type) {
        const typCl2 = getIncidentTypeClass(incObj.incident_type);
        const dotCl = typCl2.replace('inc-type-', 'inc-type-dot-');
        if (dotCl) dotHtml = '<span class="inc-type-dot ' + dotCl + '"></span>';
        const sharedCount2 = (STATE.units || []).filter(ou => ou.active && ou.unit_id !== u.unit_id && ou.incident === u.incident).length;
        if (sharedCount2 > 0) groupBorderColor2 = INC_GROUP_BORDER[typCl2] || '#6a7a8a';
      }
      const stackData2 = getUnitStackData(u.unit_id);
      const stackBadgeHtml2 = stackData2 ? renderStackBadge(stackData2.depth, stackData2.hasUrgent, u.unit_id) : '';
      incHtml = dotHtml + '<span class="clickableIncidentNum" data-inc="' + esc(u.incident) + '">' + esc('INC' + shortInc) + '</span>' + stackBadgeHtml2;
    }

    // Compute border-left: incident group border takes priority; fall back to unit type accent
    const typeBorderStyle = groupBorderColor2 ? '3px solid ' + groupBorderColor2
      : uTypeL2 === 'law'     ? '3px solid #4a6fa5'
      : uTypeL2 === 'dot'     ? '3px solid #e6841a'
      : uTypeL2 === 'support' ? '3px solid #888'
      : '';

    // UPDATED column
    const aC = getRoleColor(u.updated_by);
    const updatedHtml = fmtTime24(u.updated_at) + ' <span class="muted ' + aC + '" style="font-size:10px;">' + esc((u.updated_by || '').toUpperCase()) + '</span>';

    const rowHtml = '<td>' + unitHtml + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td class="' + elapsedClass + '">' + elapsedVal + '</td>' +
      '<td>' + destHtml + '</td>' +
      '<td>' + noteHtml + '</td>' +
      '<td>' + incHtml + '</td>' +
      '<td>' + updatedHtml + '</td>';

    if (tr) {
      // Update existing row
      tr.className = rowClasses;
      tr.innerHTML = rowHtml;
      tr.style.borderLeft = typeBorderStyle;
      tr.classList.add('row-flash');
      tr.addEventListener('animationend', () => tr.classList.remove('row-flash'), { once: true });
    } else {
      // Create new row
      tr = document.createElement('tr');
      tr.dataset.unitId = unitId;
      tr.className = rowClasses;
      tr.innerHTML = rowHtml;
      tr.style.cursor = 'pointer';
      tr.style.borderLeft = typeBorderStyle;
    }

    // Cache the row
    _rowCache.set(unitId, { hash: rowHash });

    fragment.appendChild(tr);
    _appendStackSubRows(unitId, fragment);
  });

  // Clear and append all at once
  tb.innerHTML = '';
  tb.appendChild(fragment);

  // Clean up cache for removed units
  for (const key of _rowCache.keys()) {
    if (!processedIds.has(key)) _rowCache.delete(key);
  }

  // Keep quick-action bar current after every board render
  updateQuickBar();
}

// Helper: update row classes without rebuilding HTML
function updateRowClasses(tr, u, STALE_STATUSES) {
  const mi = minutesSince(u.updated_at);
  const stCode = (u.status || '').toUpperCase();

  let classes = ['status-' + stCode];

  if (u.active && STALE_STATUSES.has(stCode) && mi != null) {
    if (mi >= STATE.staleThresholds.CRITICAL) classes.push('stale30');
    else if (mi >= STATE.staleThresholds.ALERT) classes.push('stale20');
    else if (mi >= STATE.staleThresholds.WARN) classes.push('stale10');
  }

  if (SELECTED_UNIT_ID && String(u.unit_id).toUpperCase() === SELECTED_UNIT_ID) {
    classes.push('selected');
  }

  tr.className = classes.join(' ');
}

function selectUnit(unitId) {
  const id = String(unitId || '').toUpperCase();
  const prevId = SELECTED_UNIT_ID;

  if (SELECTED_UNIT_ID === id) {
    // Deselecting — collapse stack if it was auto-expanded
    SELECTED_UNIT_ID = null;
    if (prevId) _expandedStacks.delete(prevId);
  } else {
    // Deselect previous — collapse its auto-expanded stack
    if (prevId) _expandedStacks.delete(prevId);
    SELECTED_UNIT_ID = id;
    // Auto-expand stack if unit has multiple assignments
    const stackData = getUnitStackData(id);
    if (stackData && stackData.depth > 1) _expandedStacks.add(id);
  }

  // Performance: Use data-unit-id attribute for O(1) lookup instead of text parsing
  const tb = document.getElementById('boardBody');
  const rows = tb.querySelectorAll('tr[data-unit-id]');
  rows.forEach(tr => {
    if (SELECTED_UNIT_ID && tr.dataset.unitId.toUpperCase() === SELECTED_UNIT_ID) {
      tr.classList.add('selected');
    } else {
      tr.classList.remove('selected');
    }
  });
  renderBoardDiff();
  updateQuickBar();
  autoFocusCmd();
}

function getStatusLabel(code) {
  if (!STATE || !STATE.statuses) return code;
  const s = STATE.statuses.find(s => s.code === code);
  return s ? s.label : code;
}

// ============================================================
// Column Sort Setup
// ============================================================
function setupColumnSort() {
  document.querySelectorAll('.board-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const sortKey = th.dataset.sort;
      if (VIEW.sort === sortKey) {
        VIEW.sortDir = VIEW.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        VIEW.sort = sortKey;
        VIEW.sortDir = 'asc';
      }
      // Sync toolbar dropdown
      const tbSort = document.getElementById('tbSort');
      if (tbSort) tbSort.value = VIEW.sort;
      saveViewState();
      updateSortHeaders();
      renderBoardDiff();
    });
  });
}

// ============================================================
// Quick Actions
// ============================================================

/** Update the quick-action bar to reflect the currently selected unit. */
function updateQuickBar() {
  const bar = document.getElementById('quickBar');
  if (!bar) return;

  if (!SELECTED_UNIT_ID) {
    bar.style.display = 'none';
    const qbNote = document.getElementById('qbNote');
    if (qbNote) qbNote.value = '';
    return;
  }

  const u = STATE && STATE.units ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === SELECTED_UNIT_ID) : null;
  if (!u) { bar.style.display = 'none'; return; }

  bar.style.display = 'flex';
  const qbUnit = document.getElementById('qbUnit');
  const qbStatus = document.getElementById('qbStatus');
  if (qbUnit) qbUnit.textContent = u.unit_id;
  if (qbStatus) qbStatus.textContent = u.status + (u.incident ? ' · INC' + u.incident.replace(/^\d{2}-/, '') : '');

  // Disable the button that matches current status
  bar.querySelectorAll('.qb-btn').forEach(btn => {
    const code = btn.getAttribute('onclick').match(/'([^']+)'/)?.[1];
    btn.disabled = code === u.status;
  });
}

/** Called by quick-action bar buttons — sets selected unit to status code. */
async function qbStatus(code) {
  if (!SELECTED_UNIT_ID) return;
  const u = STATE && STATE.units ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === SELECTED_UNIT_ID) : null;
  if (!u) return;
  if (u.source && u.source.startsWith('PP:') && u.status !== 'AV') { showToast('PP-MANAGED — STATUS DRIVEN BY PULSEPOINT.'); return; }
  const btn = document.querySelector('.qb-' + code);
  if (btn) btn.disabled = true;
  const note = (document.getElementById('qbNote')?.value || '').trim().toUpperCase();
  let oosPrefix = '';
  if (code === 'OOS') {
    const reason = await promptOOSReason(SELECTED_UNIT_ID);
    if (!reason) { if (btn) btn.disabled = false; return; }
    oosPrefix = `[OOS:${reason}] `;
  }
  const patch = { status: code };
  if (oosPrefix || note) patch.note = oosPrefix + note;
  setLive(true, 'LIVE • UPDATE');
  const r = await API.upsertUnit(TOKEN, u.unit_id, patch, u.updated_at || '');
  if (btn) btn.disabled = false;
  if (!r.ok) return showErr(r);
  beepChange();
  document.getElementById('qbNote').value = '';
  refresh();
}

function quickStatus(u, c) {
  const msg = 'SET ' + u.unit_id + ' → ' + c + '?' + (c === 'AV' && (u.incident || u.destination || u.note) ? '\n\nNOTE: AV CLEARS INCIDENT.' : '');
  showConfirm('CONFIRM STATUS CHANGE', msg, async () => {
    setLive(true, 'LIVE • UPDATE');
    const r = await API.upsertUnit(TOKEN, u.unit_id, { status: c, displayName: u.display_name }, u.updated_at || '');
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    autoFocusCmd();
  });
}

async function okUnit(u) {
  if (!u || !u.unit_id) return;
  setLive(true, 'LIVE • OK');
  const r = await API.touchUnit(TOKEN, u.unit_id, u.updated_at || '');
  if (!r || !r.ok) return showErr(r);
  beepChange();
  refresh();
  autoFocusCmd();
}

function okAllOS() {
  showConfirm('CONFIRM OKALL', 'OKALL: RESET STATIC TIMER FOR ALL ON SCENE (OS) UNITS?', async () => {
    setLive(true, 'LIVE • OKALL');
    const r = await API.touchAllOS(TOKEN);
    if (!r || !r.ok) return showErr(r);
    beepChange();
    refresh();
    autoFocusCmd();
  });
}

function undoUnit(uId) {
  showConfirm('CONFIRM UNDO', 'UNDO LAST ACTION FOR ' + uId + '?', async () => {
    setLive(true, 'LIVE • UNDO');
    const r = await API.undoUnit(TOKEN, uId);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    autoFocusCmd();
  });
}

// ============================================================
// Modal Functions
// ============================================================
function openPpUnitActions(u) {
  showConfirmAsync('PP UNIT: ' + u.unit_id, 'SOURCE: ' + (u.source || 'UNKNOWN') + '\n\nLOG THIS UNIT OFF THE BOARD?')
    .then(function(confirmed) {
      if (!confirmed) return;
      API.upsertUnit(TOKEN, u.unit_id, { active: false, status: 'AV', source: null }, u.updated_at || '')
        .then(function(r) {
          if (r && r.ok) { showToast(u.unit_id + ' LOGGED OFF.'); refresh(); }
          else showToast((r && r.error) || 'ERROR LOGGING OFF UNIT.');
        });
    });
}

function openModal(u, f = false) {
  _MODAL_UNIT = u;
  const b = document.getElementById('modalBack');
  b.style.display = 'flex';
  document.getElementById('mUnitId').value = u ? u.unit_id : '';
  document.getElementById('mDisplayName').value = u ? (u.display_name || '') : '';
  document.getElementById('mType').value = u ? (u.type || '') : '';
  document.getElementById('mStatus').value = u ? u.status : 'AV';
  const destEl = document.getElementById('mDestination');
  if (u && u.destination) {
    const resolved = AddressLookup.resolve(u.destination);
    destEl.value = resolved.displayText;
    if (resolved.recognized) destEl.dataset.addrId = resolved.addr.id;
    else delete destEl.dataset.addrId;
  } else {
    destEl.value = '';
    delete destEl.dataset.addrId;
  }
  document.getElementById('mIncident').value = u ? (u.incident || '') : '';
  // Parse [LOC:...] from note
  const rawNote = u ? (u.note || '') : '';
  const locMatch = rawNote.match(/\[LOC:([^\]]*)\]/);
  const mLocationEl = document.getElementById('mLocation');
  if (mLocationEl) mLocationEl.value = locMatch ? locMatch[1] : '';
  document.getElementById('mNote').value = rawNote.replace(/\s*\[LOC:[^\]]*\]\s*/g, '').trim();
  // Parse unit_info into structured crew fields + notes
  const rawInfo = u ? (u.unit_info || '') : '';
  const infoParts = rawInfo.split('|').map((p) => p.trim()).filter(Boolean);
  let cm1Name = '', cm1Cert = '', cm2Name = '', cm2Cert = '', extraNotes = '';
  infoParts.forEach((p) => {
    const crewMatch = p.match(/^CM([12]):(.*?)\s*\(([^)]+)\)\s*$/);
    if (crewMatch) {
      if (crewMatch[1] === '1') { cm1Name = crewMatch[2].trim(); cm1Cert = crewMatch[3].trim(); }
      else                      { cm2Name = crewMatch[2].trim(); cm2Cert = crewMatch[3].trim(); }
    } else if (!p.startsWith('CM')) {
      extraNotes = p;
    }
  });
  const mCrew1Name = document.getElementById('mCrew1Name');
  const mCrew1Cert = document.getElementById('mCrew1Cert');
  const mCrew2Name = document.getElementById('mCrew2Name');
  const mCrew2Cert = document.getElementById('mCrew2Cert');
  const mUnitNotes = document.getElementById('mUnitNotes');
  if (mCrew1Name) mCrew1Name.value = cm1Name;
  if (mCrew1Cert) mCrew1Cert.value = cm1Cert;
  if (mCrew2Name) mCrew2Name.value = cm2Name;
  if (mCrew2Cert) mCrew2Cert.value = cm2Cert;
  if (mUnitNotes) mUnitNotes.value = extraNotes;
  const mLevel = document.getElementById('mLevel');
  const mStation = document.getElementById('mStation');
  if (mLevel) mLevel.value = u ? (u.level || '') : '';
  if (mStation) mStation.value = u ? (u.station || '') : '';
  document.getElementById('modalTitle').textContent = u ? 'EDIT ' + u.unit_id : 'LOGON UNIT';
  document.getElementById('modalFoot').textContent = u ? 'UPDATED: ' + (u.updated_at || '—') + ' BY ' + (u.updated_by || '—') : 'TIP: SET STATUS TO D WITH INCIDENT BLANK TO AUTO-GENERATE.';
  b.dataset.expectedUpdatedAt = u ? (u.updated_at || '') : '';
}

function closeModal() {
  const b = document.getElementById('modalBack');
  b.style.display = 'none';
  b.dataset.expectedUpdatedAt = '';
  autoFocusCmd();
}

function openLogon() {
  openModal(null);
}

async function saveModal() {
  let uId = canonicalUnit(document.getElementById('mUnitId').value);
  if (!uId) { showConfirm('ERROR', 'UNIT REQUIRED.', () => { }); return; }

  // PP units are read-only — never allow editing via modal
  if (_MODAL_UNIT && _MODAL_UNIT.source && _MODAL_UNIT.source.startsWith('PP:')) {
    showToast('PP UNITS ARE READ-ONLY. MANAGED BY PULSEPOINT FEED.', 'warn');
    return;
  }

  if (!_MODAL_UNIT) {
    const info = await API.getUnitInfo(TOKEN, uId);
    if (info.ok && !info.everSeen) {
      const similar = findSimilarUnits(uId);
      let confirmMsg = `"${uId}" HAS NEVER LOGGED ON BEFORE.\nCONFIRM THIS IS NOT A DUPLICATE OR TYPO?`;
      if (similar.length) confirmMsg += '\n\nSIMILAR KNOWN UNITS: ' + similar.join(', ');
      const ok = await showConfirmAsync('NEW UNIT', confirmMsg);
      if (!ok) return;
    }
  }

  let dN = (document.getElementById('mDisplayName').value || '').trim().toUpperCase();
  if (!dN) dN = displayNameForUnit(uId);

  const destEl = document.getElementById('mDestination');
  const destVal = destEl.dataset.addrId || (destEl.value || '').trim().toUpperCase();

  const newStatus = document.getElementById('mStatus').value;
  let modalNote = (document.getElementById('mNote').value || '').toUpperCase();
  // Reassemble [LOC:address] from location field
  const mLocVal = (document.getElementById('mLocation')?.value || '').trim().toUpperCase();
  if (mLocVal) {
    const resolved = AddressLookup.getById(mLocVal);
    const locAddr = resolved ? (resolved.address || resolved.name || mLocVal) : mLocVal;
    modalNote = '[LOC:' + locAddr + '] ' + modalNote;
  }
  if (newStatus === 'OOS') {
    const prevStatus = _MODAL_UNIT ? (_MODAL_UNIT.status || '') : '';
    if (prevStatus !== 'OOS') {
      const reason = await promptOOSReason(uId);
      if (!reason) return;
      if (!modalNote.startsWith('[OOS:')) modalNote = `[OOS:${reason}] ` + modalNote;
    }
  }

  const p = {
    displayName: dN,
    type: (document.getElementById('mType').value || '').trim().toUpperCase(),
    status: newStatus,
    destination: destVal,
    incident: (document.getElementById('mIncident').value || '').trim().toUpperCase(),
    note: modalNote,
    unitInfo: (() => {
      const c1n = (document.getElementById('mCrew1Name')?.value || '').trim().toUpperCase();
      const c1c = (document.getElementById('mCrew1Cert')?.value || '').trim().toUpperCase();
      const c2n = (document.getElementById('mCrew2Name')?.value || '').trim().toUpperCase();
      const c2c = (document.getElementById('mCrew2Cert')?.value || '').trim().toUpperCase();
      const notes = (document.getElementById('mUnitNotes')?.value || '').trim();
      const parts = [];
      if (c1n) parts.push('CM1:' + c1n + (c1c ? ' (' + c1c + ')' : ''));
      if (c2n) parts.push('CM2:' + c2n + (c2c ? ' (' + c2c + ')' : ''));
      if (notes) parts.push(notes);
      return parts.join('|');
    })(),
    level: (document.getElementById('mLevel')?.value || '').trim().toUpperCase(),
    station: (document.getElementById('mStation')?.value || '').trim(),
    active: true
  };

  const eUA = document.getElementById('modalBack').dataset.expectedUpdatedAt || '';
  setLive(true, 'LIVE • SAVING');
  const r = await API.upsertUnit(TOKEN, uId, p, eUA);
  if (!r.ok) {
    if (r.conflict) {
      // Unit was updated by someone else — refresh modal with latest data and let dispatcher retry
      const cur = r.current;
      const msg = 'CONFLICT: UNIT UPDATED BY ' + (cur.updated_by || 'ANOTHER USER') +
        ' (' + (cur.status || '?') + '). CLOSE AND REOPEN TO RETRY.';
      showConfirm('CONFLICT', msg, () => { closeModal(); refresh(); });
    } else {
      showErr(r);
    }
    return;
  }
  beepChange();
  closeModal();
  refresh();
}

async function confirmLogoff() {
  const uId = canonicalUnit(document.getElementById('mUnitId').value);
  if (!uId) return;
  // Always pass '' for expectedUpdatedAt on logoff — dispatcher has override authority
  // regardless of whether field app recently changed the unit's updated_at timestamp
  const currentStatus = document.getElementById('mStatus').value;
  const currentIncident = (document.getElementById('mIncident').value || '').trim().toUpperCase();

  // Check for active incident first
  if (currentIncident) {
    const okInc = await showConfirmAsync(
      'WARNING',
      'LOG OFF ' + uId + '? UNIT IS STILL ASSIGNED TO INCIDENT ' + currentIncident + '. LOG OFF ANYWAY?'
    );
    if (!okInc) return;
  } else if (['OS', 'T', 'D', 'DE'].includes(currentStatus)) {
    const okSt = await showConfirmAsync('LOG OFF', 'LOG OFF ' + uId + '? UNIT WILL BE REMOVED FROM BOARD.');
    if (!okSt) return;
  }

  setLive(true, 'LIVE • LOGOFF');
  const r = await API.logoffUnit(TOKEN, uId, '');
  if (!r.ok) return showErr(r);
  beepChange();
  showToast('LOGGED OFF: ' + uId);
  closeModal();
  refresh();
}

function confirmRidoff() {
  const uId = canonicalUnit(document.getElementById('mUnitId').value);
  if (!uId) return;
  const eUA = document.getElementById('modalBack').dataset.expectedUpdatedAt || '';
  showConfirm('CONFIRM RIDOFF', 'RIDOFF ' + uId + '? (SETS AV + CLEARS NOTE/INCIDENT/DEST)', async () => {
    setLive(true, 'LIVE • RIDOFF');
    const r = await API.ridoffUnit(TOKEN, uId, eUA);
    if (!r.ok) return showErr(r);
    beepChange();
    closeModal();
    refresh();
  });
}

// ============================================================
// New Incident Modal
// ============================================================
function openNewIncident() {
  const unitSelect = document.getElementById('newIncUnit');
  unitSelect.innerHTML = '<option value="">ASSIGN UNIT (OPTIONAL)</option>';

  const units = ((STATE && STATE.units) || []).filter(u => u.active && u.status === 'AV');
  units.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.unit_id;
    opt.textContent = u.unit_id + (u.display_name && u.display_name !== u.unit_id ? ' - ' + u.display_name : '');
    unitSelect.appendChild(opt);
  });

  const newIncDestEl = document.getElementById('newIncDest');
  newIncDestEl.value = '';
  delete newIncDestEl.dataset.addrId;
  const newIncSceneEl = document.getElementById('newIncScene');
  if (newIncSceneEl) newIncSceneEl.value = '';
  const newIncPriorityEl = document.getElementById('newIncPriority');
  if (newIncPriorityEl) newIncPriorityEl.value = '';
  document.getElementById('newIncType').value = '';
  document.getElementById('newIncNote').value = '';
  // Cascading selects reset + dynamic category population
  const catEl = document.getElementById('newIncCat');
  if (catEl) {
    catEl.innerHTML = '<option value="">CATEGORY...</option>' +
      Object.keys(INC_TYPE_TAXONOMY).map(c => '<option value="' + c + '">' + c + '</option>').join('');
    catEl.value = '';
  }
  const natureEl = document.getElementById('newIncNature');
  if (natureEl) { natureEl.value = ''; natureEl.style.display = 'none'; }
  const detEl = document.getElementById('newIncDet');
  if (detEl) { detEl.value = ''; detEl.style.display = 'none'; }
  // Callback + MA reset
  const cbEl = document.getElementById('newIncCallback');
  if (cbEl) cbEl.value = '';
  const maEl = document.getElementById('newIncMA');
  if (maEl) maEl.checked = false;
  // legacy urgent checkbox — may not exist in newer HTML
  const newIncUrgentEl = document.getElementById('newIncUrgent');
  if (newIncUrgentEl) newIncUrgentEl.checked = false;
  document.getElementById('newIncBack').style.display = 'flex';
  AddrHistory.attach('newIncScene', 'addrHistList1');
  renderIncSuggest();
  setTimeout(() => newIncDestEl.focus(), 50);
}

function closeNewIncident() {
  document.getElementById('newIncBack').style.display = 'none';
  autoFocusCmd();
}

// ============================================================
// MAP MODAL — Leaflet + Nominatim geocoding
// ============================================================

let _mapLeafletLoaded  = false;
let _mapLeafletLoading = false;
let _mapInstance       = null;
let _mapMarker         = null;
let _mapTargetFieldId  = null;
let _mapSelectedAddr   = null;

// Central Oregon viewbox for Nominatim bias
const MAP_VIEWBOX = '-122.5,43.0,-119.5,45.2';
const MAP_DEFAULT_CENTER = [44.058, -121.315]; // Bend, OR

function _loadLeaflet(cb) {
  if (_mapLeafletLoaded) { cb(); return; }
  if (_mapLeafletLoading) { const t = setInterval(() => { if (_mapLeafletLoaded) { clearInterval(t); cb(); } }, 100); return; }
  _mapLeafletLoading = true;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(css);
  const js = document.createElement('script');
  js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  js.onload = () => { _mapLeafletLoaded = true; cb(); };
  document.head.appendChild(js);
}

function openMapModal(fieldId) {
  _mapTargetFieldId = fieldId;
  _mapSelectedAddr  = null;
  const el = document.getElementById(fieldId);
  const existing = el ? el.value.trim() : '';
  document.getElementById('mapSearchInput').value = existing;
  document.getElementById('mapResults').style.display = 'none';
  document.getElementById('mapResults').innerHTML = '';
  document.getElementById('mapSelectedAddr').textContent = 'SELECT A RESULT TO USE IT';
  document.getElementById('mapUseBtn').disabled = true;
  document.getElementById('mapUseBtn').style.opacity = '.5';
  document.getElementById('mapModalBack').style.display = 'flex';
  _loadLeaflet(() => {
    _initMapInstance();
    setTimeout(() => {
      if (_mapInstance) _mapInstance.invalidateSize();
      if (existing) _mapSearch();
    }, 150);
    document.getElementById('mapSearchInput').focus();
  });
}

function closeMapModal() {
  document.getElementById('mapModalBack').style.display = 'none';
}

function _initMapInstance() {
  if (_mapInstance) return;
  const container = document.getElementById('mapContainer');
  if (!container || !window.L) return;
  _mapInstance = L.map(container).setView(MAP_DEFAULT_CENTER, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(_mapInstance);
  _mapInstance.on('click', function(e) { _mapPinAt(e.latlng.lat, e.latlng.lng, null); });
}

async function _mapSearch() {
  const raw = document.getElementById('mapSearchInput').value.trim();
  if (!raw) return;
  // Append Oregon if no state hint
  const q = /\bOR\b|\boregon\b/i.test(raw) ? raw : raw + ', Oregon';
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
    encodeURIComponent(q) + '&viewbox=' + MAP_VIEWBOX + '&bounded=0';
  const resultsEl = document.getElementById('mapResults');
  resultsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--muted);">SEARCHING...</div>';
  resultsEl.style.display = 'block';
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.length) { resultsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--muted);">NO RESULTS.</div>'; return; }
    resultsEl.innerHTML = data.map((r, i) =>
      '<div class="map-result-row" onclick="_mapSelectResult(' + i + ')" data-lat="' + r.lat + '" data-lon="' + r.lon + '" data-addr="' + esc(r.display_name) + '">' +
        esc(r.display_name) +
      '</div>'
    ).join('');
  } catch(e) {
    resultsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:#e05050;">GEOCODE FAILED. CHECK CONNECTION.</div>';
  }
}

function _mapSelectResult(idx) {
  const rows = document.querySelectorAll('.map-result-row');
  const row  = rows[idx];
  if (!row) return;
  rows.forEach(r => r.classList.remove('map-result-selected'));
  row.classList.add('map-result-selected');
  const lat  = parseFloat(row.dataset.lat);
  const lon  = parseFloat(row.dataset.lon);
  const addr = row.dataset.addr;
  _mapPinAt(lat, lon, addr);
}

function _mapPinAt(lat, lon, addr) {
  if (!_mapInstance || !window.L) return;
  if (_mapMarker) _mapInstance.removeLayer(_mapMarker);
  _mapMarker = L.marker([lat, lon]).addTo(_mapInstance);
  _mapInstance.setView([lat, lon], 16);
  // Use short address: everything before the first comma that looks like a county/state
  const short = addr ? addr.split(',').slice(0, 3).join(',').trim() : (lat.toFixed(5) + ', ' + lon.toFixed(5));
  _mapSelectedAddr = short;
  document.getElementById('mapSelectedAddr').textContent = short;
  document.getElementById('mapUseBtn').disabled = false;
  document.getElementById('mapUseBtn').style.opacity = '1';
}

function _mapUseSelected() {
  if (!_mapSelectedAddr || !_mapTargetFieldId) return;
  const el = document.getElementById(_mapTargetFieldId);
  if (el) {
    el.value = _mapSelectedAddr.toUpperCase();
    el.dispatchEvent(new Event('input'));
  }
  closeMapModal();
}

// ── Incident type parsing helper (for review modal) ──────────────────────────
function parseIncType(typeStr) {
  if (!typeStr) return { cat: '', nature: '' };
  const cats = Object.keys(INC_TYPE_TAXONOMY || {});
  for (const cat of cats) {
    if (typeStr === cat) return { cat, nature: '' };
    if (typeStr.startsWith(cat + '-')) {
      const rest = typeStr.slice(cat.length + 1);
      const natures = Object.keys((INC_TYPE_TAXONOMY[cat]?.natures || INC_TYPE_TAXONOMY[cat] || {}));
      for (const nature of natures) {
        if (rest === nature || rest.startsWith(nature + '-')) return { cat, nature };
      }
      return { cat, nature: rest };
    }
  }
  return { cat: '', nature: '' };
}

function onIncEditCatChange() {
  const cat = document.getElementById('incEditCat').value;
  const natureEl = document.getElementById('incEditNature');
  const typeEl = document.getElementById('incTypeEdit');
  if (!cat || !INC_TYPE_TAXONOMY[cat]) {
    natureEl.style.display = 'none';
    natureEl.value = '';
    typeEl.value = cat || '';
    return;
  }
  const natures = Object.keys(INC_TYPE_TAXONOMY[cat]?.natures || INC_TYPE_TAXONOMY[cat] || {});
  natureEl.innerHTML = '<option value="">—</option>' +
    natures.map(n => '<option value="' + n + '">' + n + '</option>').join('');
  natureEl.style.display = '';
  natureEl.value = '';
  typeEl.value = cat;
}

function onIncEditNatureChange() {
  const cat = document.getElementById('incEditCat').value;
  const nature = document.getElementById('incEditNature').value;
  document.getElementById('incTypeEdit').value = nature ? (cat + '-' + nature) : cat;
}

function onIncCatChange() {
  const cat = document.getElementById('newIncCat').value;
  const natureEl = document.getElementById('newIncNature');
  const detEl = document.getElementById('newIncDet');
  const typeEl = document.getElementById('newIncType');
  if (!cat || !INC_TYPE_TAXONOMY[cat]) {
    natureEl.style.display = 'none';
    detEl.style.display = 'none';
    typeEl.value = cat || '';
    return;
  }
  const natures = Object.keys(INC_TYPE_TAXONOMY[cat]?.natures || INC_TYPE_TAXONOMY[cat] || {});
  natureEl.innerHTML = '<option value="">NATURE...</option>' +
    natures.map(n => '<option value="' + n + '">' + n + '</option>').join('');
  natureEl.style.display = '';
  natureEl.value = '';
  detEl.style.display = 'none';
  detEl.value = '';
  typeEl.value = cat;
  renderIncSuggest();
}

function onIncNatureChange() {
  const cat = document.getElementById('newIncCat').value;
  const nature = document.getElementById('newIncNature').value;
  const detEl = document.getElementById('newIncDet');
  const typeEl = document.getElementById('newIncType');
  if (!nature) {
    detEl.style.display = 'none';
    typeEl.value = cat;
    return;
  }
  const _natMap = INC_TYPE_TAXONOMY[cat]?.natures || INC_TYPE_TAXONOMY[cat] || {};
  const _natVal = _natMap[nature];
  const dets = (_natVal?.dets || (Array.isArray(_natVal) ? _natVal : []));
  if (dets.length) {
    detEl.innerHTML = '<option value="">DET...</option>' +
      dets.map(d => '<option value="' + d + '">' + d + '</option>').join('');
    detEl.style.display = '';
    detEl.value = '';
  } else {
    detEl.style.display = 'none';
  }
  typeEl.value = cat + '-' + nature;
  renderIncSuggest();
}

function onIncDetChange() {
  const cat = document.getElementById('newIncCat').value;
  const nature = document.getElementById('newIncNature').value;
  const det = document.getElementById('newIncDet').value;
  const typeEl = document.getElementById('newIncType');
  typeEl.value = det ? (cat + '-' + nature + '-' + det) : (cat + '-' + nature);
  // Auto-set priority if determinant is a PRI-n value
  const priMatch = det.match(/^PRI-(\d)$/);
  const priEl = document.getElementById('newIncPriority');
  if (priEl && priMatch) priEl.value = 'PRI-' + priMatch[1];
  // Direct priority determinants (new transport taxonomy)
  if (priEl) {
    if (det === 'PRI-1') priEl.value = 'PRI-1';
    else if (det === 'PRI-2') priEl.value = 'PRI-2';
    else if (det === 'PRI-3') priEl.value = 'PRI-3';
    else if (det === 'PRI-4') priEl.value = 'PRI-4';
  }
  renderIncSuggest();
}

async function createNewIncident() {
  const destEl = document.getElementById('newIncDest');
  const dest = destEl.dataset.addrId || destEl.value.trim().toUpperCase();
  let note = document.getElementById('newIncNote').value.trim().toUpperCase();
  const priority = (document.getElementById('newIncPriority')?.value || '').trim().toUpperCase();
  const unitId = document.getElementById('newIncUnit').value;
  const incType = (document.getElementById('newIncType').value || '').trim().toUpperCase();
  const sceneAddress = (document.getElementById('newIncScene')?.value || '').trim().toUpperCase();
  const callback = (document.getElementById('newIncCallback')?.value || '').trim();
  const mutualAid = document.getElementById('newIncMA')?.checked || false;

  if (!dest) {
    showAlert('ERROR', 'LOCATION REQUIRED. ENTER RECEIVING FACILITY CODE (E.G. STCH, BEND).');
    return;
  }

  // Duplicate dispatch guard — warn if same destination+type created in last 30 seconds
  const thirtySecAgo = Date.now() - 30000;
  const dupe = (STATE && STATE.incidents || []).find(inc => {
    if (inc.status === 'CLOSED') return false;
    const created = inc.created_at ? new Date(inc.created_at).getTime() : 0;
    if (created < thirtySecAgo) return false;
    const sameDest = (inc.destination || '').toUpperCase() === dest.toUpperCase();
    const sameType = incType && (inc.incident_type || '').toUpperCase() === incType.toUpperCase();
    return sameDest && (!incType || sameType);
  });
  if (dupe) {
    const shortId = String(dupe.incident_id || '').replace(/^\d{2}-/, '');
    const ok = await showConfirmAsync('POSSIBLE DUPLICATE',
      'INC' + shortId + ' (' + (dupe.incident_type || 'UNKNOWN') + ') AT ' + dupe.destination +
      ' WAS CREATED ' + Math.round((Date.now() - new Date(dupe.created_at).getTime()) / 1000) +
      'S AGO.\n\nCREATE ANYWAY?');
    if (!ok) return;
  }

  // Prepend prefixes (MA first, then CB)
  const prefixes = [];
  if (mutualAid) prefixes.push('[MA]');
  if (callback) prefixes.push('[CB:' + callback + ']');
  if (prefixes.length) note = prefixes.join(' ') + (note ? ' ' + note : '');

  setLive(true, 'LIVE • CREATE INCIDENT');
  const r = await API.createQueuedIncident(TOKEN, dest, note, priority, unitId, incType, sceneAddress);
  if (!r.ok) return showErr(r);
  if (sceneAddress) { AddrHistory.push(sceneAddress); _geoVerifyAddress(sceneAddress); }
  beepChange();
  closeNewIncident();
  refresh();
}

function closeIncidentFromQueue(incidentId) {
  showConfirm('CLOSE INCIDENT', 'CLOSE INCIDENT ' + incidentId + '?\n\nTHIS WILL REMOVE IT FROM THE QUEUE.', async () => {
    setLive(true, 'LIVE • CLOSE INCIDENT');
    try {
      const r = await API.closeIncident(TOKEN, incidentId);
      if (!r.ok) { showAlert('ERROR', r.error || 'FAILED TO CLOSE INCIDENT'); return; }
      refresh();
    } catch (e) {
      showAlert('ERROR', 'FAILED: ' + e.message);
    }
  });
}

function assignIncidentToUnit(incidentId) {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'UNIT ID (E.G. EMS1, WC1)';
  input.style.cssText = 'width:100%;padding:10px;background:var(--panel);color:var(--text);border:2px solid var(--line);font-family:inherit;text-transform:uppercase;font-size:14px;margin-top:10px;';

  const shortId = incidentId.replace(/^\d{2}-/, '');

  const message = document.createElement('div');
  message.innerHTML = 'ASSIGN INC' + esc(shortId) + ' TO UNIT:';
  message.appendChild(input);

  document.getElementById('alertTitle').textContent = 'ASSIGN INCIDENT';
  document.getElementById('alertMessage').innerHTML = '';
  document.getElementById('alertMessage').appendChild(message);
  document.getElementById('alertDialog').classList.add('active');

  setTimeout(() => input.focus(), 100);

  const handleAssign = () => {
    const unitInput = input.value.trim();
    if (!unitInput) {
      hideAlert();
      return;
    }

    const unitId = canonicalUnit(unitInput);
    if (!unitId) {
      showAlert('ERROR', 'INVALID UNIT ID');
      return;
    }

    hideAlert();
    const cmd = `D ${unitId} ${incidentId}`;
    document.getElementById('cmd').value = cmd;
    runCommand();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleAssign();
    } else if (e.key === 'Escape') {
      hideAlert();
    }
  });
}

// ============================================================
// Incident Review Modal
// ============================================================
async function openIncidentFromServer(iId) {
  setLive(true, 'LIVE • INCIDENT REVIEW');
  const r = await API.getIncident(TOKEN, iId);
  if (!r.ok) return showErr(r);

  const inc = r.incident;
  CURRENT_INCIDENT_ID = String(inc.incident_id || '').toUpperCase();
  document.getElementById('incTitle').textContent = 'INCIDENT ' + CURRENT_INCIDENT_ID;
  document.getElementById('incUnits').textContent = (inc.units || '—').toUpperCase();
  const incDestR = AddressLookup.resolve(inc.destination);
  const incDestEl = document.getElementById('incDestEdit');
  incDestEl.value = (incDestR.recognized ? incDestR.addr.name : (inc.destination || '')).toUpperCase();
  if (incDestR.recognized) incDestEl.dataset.addrId = incDestR.addr.id;
  else delete incDestEl.dataset.addrId;
  // Populate type selects from existing incident_type
  const incTypeRaw = (inc.incident_type || '').toUpperCase();
  const catEl2 = document.getElementById('incEditCat');
  const natureEl2 = document.getElementById('incEditNature');
  if (catEl2) {
    catEl2.innerHTML = '<option value="">—</option>' +
      Object.keys(INC_TYPE_TAXONOMY).map(c => '<option value="' + c + '">' + c + '</option>').join('');
    const parsed = parseIncType(incTypeRaw);
    catEl2.value = parsed.cat;
    if (parsed.cat && INC_TYPE_TAXONOMY[parsed.cat]) {
      const nats = Object.keys(INC_TYPE_TAXONOMY[parsed.cat]?.natures || INC_TYPE_TAXONOMY[parsed.cat] || {});
      natureEl2.innerHTML = '<option value="">—</option>' +
        nats.map(n => '<option value="' + n + '">' + n + '</option>').join('');
      natureEl2.style.display = '';
      natureEl2.value = parsed.nature;
    } else {
      natureEl2.style.display = 'none';
      natureEl2.value = '';
    }
  }
  document.getElementById('incTypeEdit').value = incTypeRaw;
  document.getElementById('incUpdated').textContent = inc.last_update ? fmtTime24(inc.last_update) : '—';

  const bC = getRoleColor(inc.updated_by);
  const bE = document.getElementById('incBy');
  bE.textContent = (inc.updated_by || '—').toUpperCase();
  bE.className = bC;

  document.getElementById('incNote').value = (inc.incident_note || '').toUpperCase();

  const relEl = document.getElementById('incRelated');
  if (relEl) {
    const parts = [];
    const relIds = inc.related_incidents || [];
    if (relIds.length) {
      parts.push('<span class="muted" style="font-size:10px;">RELATED: </span>' +
        relIds.map(function(id) {
          const shortRel = id.replace(/^\d{2}-/, '');
          return '<button type="button" class="related-inc-chip" onclick="openIncident(\'' + esc(id) + '\')">' + 'INC' + esc(shortRel) + '</button>';
        }).join(''));
    }
    if (inc.pp_incident_id) {
      parts.push('<span class="muted" style="font-size:10px;margin-left:' + (relIds.length ? '10px' : '0') + ';">PP: </span>' +
        '<span class="pp-rel-badge" style="font-size:11px;">' + esc(inc.pp_incident_id) + '</span>');
    }
    if (parts.length) {
      relEl.innerHTML = parts.join('');
      relEl.style.display = '';
    } else {
      relEl.innerHTML = '';
      relEl.style.display = 'none';
    }
  }

  const incSceneEl = document.getElementById('incSceneAddress');
  if (incSceneEl) incSceneEl.value = (inc.scene_address || '').toUpperCase();
  AddrHistory.attach('incSceneAddress', 'addrHistList2');

  // Timing row — show all 6 EMS timestamps with elapsed-minute deltas between stages
  const tr2 = document.getElementById('incTimingRow');
  if (tr2) {
    const _minsApart = (a, b) => {
      if (!a || !b) return null;
      const d = Math.round((new Date(b) - new Date(a)) / 60000);
      return d > 0 ? d + 'M' : null;
    };
    const stages = [
      { key: 'dispatch_time',    label: 'DISP' },
      { key: 'enroute_time',     label: 'ENRTE' },
      { key: 'arrival_time',     label: 'ARR' },
      { key: 'transport_time',   label: 'TRANS' },
      { key: 'at_hospital_time', label: 'AT HOSP' },
      { key: 'handoff_time',     label: 'HOFF' },
    ];
    const parts = [];
    let prevTime = null;
    stages.forEach(s => {
      const t = inc[s.key];
      if (!t) { prevTime = null; return; }
      const delta = _minsApart(prevTime, t);
      const elapsed = delta ? ' (+' + delta + ')' : '';
      parts.push(s.label + ': ' + fmtTime24(t) + elapsed);
      prevTime = t;
    });
    tr2.textContent = parts.join('  |  ');
    tr2.style.display = parts.length ? '' : 'none';
  }

  renderIncidentAudit(r.audit || []);
  document.getElementById('incBack').style.display = 'flex';
  setTimeout(() => document.getElementById('incNote').focus(), 50);
}

function openIncident(iId) {
  openIncidentFromServer(iId);
}

// Agency-level approximate coordinates for proximity scoring in SUGGEST
// Used when exact geocode is unavailable — coarse but correct directionally
const _SUGGEST_AGENCY_COORDS = {
  'LAPINE_FD':            [43.6679, -121.5036],
  'SUNRIVER_FD':          [43.8758, -121.4363],
  'BEND_FIRE':            [44.0489, -121.3153],
  'REDMOND_FIRE':         [44.2783, -121.1785],
  'CROOK_COUNTY_FIRE':    [44.3050, -120.7271],
  'SISTERS_CAMP_SHERMAN': [44.2879, -121.5490],
  'AIRLINK_CCT':          [44.0613, -121.2832],
  'JEFFCO_FIRE_EMS':      [44.6289, -121.1278],
  'WARM_SPRINGS_FD':      [44.7640, -121.2660],
  'BLACK_BUTTE_RANCH':    [44.3988, -121.6282],
  'ALFALFA_FD':           [44.0084, -121.1091],
  'CRESCENT_RFPD':        [43.4644, -121.7168],
  'THREE_RIVERS_FD':      [44.3524, -121.1781],
  'SCMC':                 [44.0613, -121.2832],
};

// Central Oregon bounding box for geo-verification warnings
const _GEO_BBOX = { n: 44.72, s: 43.49, e: -120.68, w: -122.07 };

// Fire-and-forget: geocode addr and warn if outside Central Oregon
// Never blocks the caller — always resolves silently on error
function _geoVerifyAddress(addr) {
  if (!addr || addr.length < 6) return;
  const a = addr.trim().toUpperCase();
  // Check cache first — instant
  if (_bmGeoCache && _bmGeoCache[a]) {
    const c = _bmGeoCache[a];
    const lat = c.lat, lon = c.lon;
    if (lat < _GEO_BBOX.s || lat > _GEO_BBOX.n || lon < _GEO_BBOX.w || lon > _GEO_BBOX.e) {
      showToast('⚠ SCENE ADDRESS MAY BE OUTSIDE CENTRAL OREGON — VERIFY CORRECT LOCATION', 'error', 8000);
    }
    return;
  }
  // Not in cache — async Nominatim lookup (non-blocking)
  const q = /\bOR\b|\boregon\b/i.test(a) ? a : a + ', Oregon';
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
  fetch(url).then(function(res) { return res.json(); }).then(function(data) {
    if (!data || !data[0]) return;
    const lat = parseFloat(data[0].lat), lon = parseFloat(data[0].lon);
    if (isNaN(lat) || isNaN(lon)) return;
    if (lat < _GEO_BBOX.s || lat > _GEO_BBOX.n || lon < _GEO_BBOX.w || lon > _GEO_BBOX.e) {
      showToast('⚠ SCENE ADDRESS MAY BE OUTSIDE CENTRAL OREGON — VERIFY CORRECT LOCATION', 'error', 8000);
    }
  }).catch(function() {});
}

function _haversineDist(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function suggestUnits(incId) {
  let iId = (incId || CURRENT_INCIDENT_ID || '').trim().toUpperCase();
  if (!iId) { showAlert('ERROR', 'NO INCIDENT OPEN. USE: SUGGEST INC0001'); return; }
  // Normalize: INC0014 → 26-0014 (strip INC prefix, add year if no dash present)
  iId = iId.replace(/^INC-?/i, '');
  if (!iId.includes('-')) iId = (new Date().getFullYear() % 100) + '-' + iId;

  const inc = (STATE.incidents || []).find(i => i.incident_id === iId);
  if (!inc) { showAlert('NOT FOUND', 'INCIDENT ' + iId + ' NOT IN CURRENT STATE. REFRESH AND TRY AGAIN.'); return; }

  const incType  = (inc.incident_type || '').toUpperCase();
  const pri      = (inc.priority || '').toUpperCase();
  // Exclude units already assigned (primary or queued) to this incident
  const assigned = (STATE.assignments || [])
    .filter(a => a.incident_id === iId && !a.cleared_at)
    .map(a => a.unit_id);

  const available = (STATE.units || []).filter(u =>
    u.active &&
    (u.status === 'AV' || u.status === 'BRK') &&
    u.include_in_recommendations !== false &&
    !assigned.includes(u.unit_id)
  );

  // Try proximity scoring using geocache
  const sceneAddr = (inc.scene_address || '').trim().toUpperCase();
  const geoHit    = sceneAddr && _bmGeoCache ? _bmGeoCache[sceneAddr] : null;
  const incLatLon = geoHit ? [geoHit.lat, geoHit.lon] : null;

  const needsALS  = /^CCT|^IFT-ALS/.test(incType) || pri === 'PRI-1';
  const preferALS = pri === 'PRI-2';
  const blsOk     = /^IFT-BLS|^DISCHARGE|^DIALYSIS/.test(incType) || pri === 'PRI-3' || pri === 'PRI-4';

  const scored = available.map(u => {
    const level  = (u.level || '').toUpperCase();
    const agency = (u.agency_id || '').toUpperCase();
    let score = 100;

    // BRK penalty — available but less ideal than AV
    if (u.status === 'BRK') score -= 10;

    // ALS/level scoring
    if (needsALS) {
      if (level === 'ALS')                    score += 60;
      else if (level === 'AEMT')              score += 30;
      else if (level === 'BLS' || level === 'EMT') score += 5;
    } else if (preferALS) {
      if (level === 'ALS')                    score += 40;
      else if (level === 'AEMT')              score += 25;
      else if (level === 'BLS' || level === 'EMT') score += 15;
    } else if (blsOk) {
      if (level === 'BLS' || level === 'EMT') score += 40;
      else if (level === 'AEMT')              score += 35;
      else if (level === 'ALS')               score += 20;
    } else {
      if (level === 'ALS')                    score += 30;
      else if (level === 'AEMT')              score += 20;
      else if (level === 'BLS' || level === 'EMT') score += 10;
    }

    // Station proximity bonus (if geocache hit)
    if (incLatLon) {
      const agencyCoords = _SUGGEST_AGENCY_COORDS[agency];
      if (agencyCoords) {
        const dist = _haversineDist(incLatLon[0], incLatLon[1], agencyCoords[0], agencyCoords[1]);
        if      (dist < 5)  score += 30;
        else if (dist < 15) score += 20;
        else if (dist < 30) score += 10;
        else if (dist > 60) score -= 10;
      }
    }

    return { unit: u, score, agency };
  });

  scored.sort((a, b) => b.score - a.score);
  const recs = scored.slice(0, 5);

  // Render inline chips in the incident panel instead of a modal
  const resultEl = document.getElementById('incSuggestResult');
  if (resultEl) {
    if (!recs.length) {
      resultEl.innerHTML =
        '<div class="muted" style="font-size:11px;padding:4px 0;">NO AVAILABLE UNITS TO SUGGEST.</div>';
      resultEl.style.display = '';
      return;
    }
    const chips = recs.map(function(s) {
      const u = s.unit;
      const levelBadge = u.level ? ' <span style="font-size:9px;opacity:.7;">' + esc(u.level) + '</span>' : '';
      const brkBadge   = u.status === 'BRK' ? ' <span style="font-size:9px;color:#ffd66b;">BRK</span>' : '';
      return '<button type="button" class="suggest-chip" style="margin:2px 3px;" ' +
        'title="Click to fill ASSIGN command" ' +
        'onclick="fillAssignCmd(\'' + esc(u.unit_id) + '\',\'' + esc(iId) + '\')">' +
        esc(u.unit_id) + levelBadge + brkBadge +
        '</button>';
    }).join('');
    const proximity = incLatLon ? '' : ' <span class="muted" style="font-size:9px;">(no geo)</span>';
    resultEl.innerHTML =
      '<div class="inc-suggest-row">' +
      '<span class="muted" style="font-size:11px;white-space:nowrap;">SUGGESTED' + proximity + ':</span>' +
      chips +
      '<button type="button" onclick="document.getElementById(\'incSuggestResult\').style.display=\'none\'" ' +
      'style="font-size:10px;padding:1px 6px;background:transparent;border:1px solid #30363d;color:#8b949e;cursor:pointer;font-family:inherit;margin-left:4px;">✕</button>' +
      '</div>';
    resultEl.style.display = '';
  } else {
    // Fallback if panel not open
    let msg = 'TYPE: ' + (inc.incident_type || '—');
    if (inc.priority) msg += '  |  PRIORITY: ' + inc.priority;
    if (assigned.length) msg += '\nALREADY ASSIGNED: ' + assigned.join(', ');
    msg += '\n\nSUGGESTED:\n';
    recs.forEach((s, i) => {
      const u = s.unit;
      msg += (i + 1) + '. ' + u.unit_id + ' [' + u.status + ']';
      if (u.level) msg += ' ' + u.level;
      msg += '\n';
    });
    msg += '\nUSE: ASSIGN <UNIT>; ' + iId;
    showAlert('SUGGESTIONS — ' + iId, msg);
  }
}

function fillAssignCmd(unitId, incId) {
  const inp = document.getElementById('cmdInput');
  if (inp) {
    inp.value = 'ASSIGN ' + unitId + '; ' + incId;
    inp.focus();
    inp.select();
  }
}

function closeIncidentPanel() {
  document.getElementById('incBack').style.display = 'none';
  CURRENT_INCIDENT_ID = '';
}

// Keep old name as alias for ESC key handler etc.
function closeIncident() { closeIncidentPanel(); }

async function alertAllIncident() {
  const incId = CURRENT_INCIDENT_ID;
  if (!incId) { showAlert('ERROR', 'NO INCIDENT OPEN'); return; }
  const inc = (STATE && STATE.incidents || []).find(i => i.incident_id === incId);
  const parts = [incId];
  if (inc) {
    if (inc.priority) parts.push('[' + inc.priority + ']');
    if (inc.incident_type) parts.push(inc.incident_type);
    if (inc.destination) parts.push('DEST: ' + inc.destination);
    if (inc.scene_address) parts.push('SCENE: ' + inc.scene_address);
    if (inc.incident_note) parts.push(inc.incident_note.replace(/^\[URGENT\]\s*/i,'').replace(/\[MA\]\s*/gi,'').trim());
  }
  const msg = 'CRITICAL INCIDENT ALERT — ' + parts.join(' | ');
  const ok = await showConfirmAsync('ALERT ALL?', 'Send hot message to ALL dispatchers and ALL field units:\n\n' + msg);
  if (!ok) return;
  setLive(true, 'LIVE • ALERT ALL');
  const [r1, r2] = await Promise.all([
    API.sendToDispatchers(TOKEN, msg, true),
    API.sendToUnits(TOKEN, msg, true)
  ]);
  setLive(false);
  if (!r1.ok && !r2.ok) return showErr(r1);
  const dp = (r1.ok ? r1.recipients : 0);
  const un = (r2.ok ? r2.recipients : 0);
  showToast('CRITICAL ALERT SENT — ' + dp + ' DISPATCHER(S), ' + un + ' UNIT(S)');
  refresh();
}

async function closeIncidentAction() {
  const incId = CURRENT_INCIDENT_ID;
  if (!incId) { showAlert('ERROR', 'NO INCIDENT OPEN'); return; }
  const ok = await showConfirmAsync('CLOSE INCIDENT', 'Close incident ' + incId + '? All unit assignments will be cleared.');
  if (!ok) return;
  setLive(true, 'LIVE • CLOSE INCIDENT');
  try {
    const r = await API.closeIncident(TOKEN, incId);
    if (!r.ok) { showAlert('ERROR', r.error || 'FAILED TO CLOSE INCIDENT'); return; }
    closeIncidentPanel();
    showToast('INCIDENT ' + incId + ' CLOSED.');
    refresh();
  } catch (e) {
    showAlert('ERROR', 'FAILED TO CLOSE INCIDENT: ' + e.message);
  }
}

async function reopenIncidentAction() {
  const incId = CURRENT_INCIDENT_ID;
  if (!incId) { showAlert('ERROR', 'NO INCIDENT OPEN'); return; }
  const ok = await showConfirmAsync('REOPEN INCIDENT ' + incId + '?');
  if (!ok) return;
  setLive(true, 'LIVE • REOPEN INCIDENT');
  try {
    const r = await API.reopenIncident(TOKEN, incId);
    if (!r.ok) { showAlert('ERROR', r.error || 'FAILED TO REOPEN INCIDENT'); return; }
    closeIncidentPanel();
    beepChange();
    showToast('INCIDENT ' + incId + ' REOPENED.');
    refresh();
  } catch (e) {
    showAlert('ERROR', 'FAILED TO REOPEN INCIDENT: ' + e.message);
  }
}

async function saveIncidentNote() {
  const m = (document.getElementById('incNote').value || '').trim().toUpperCase();
  const newType = (document.getElementById('incTypeEdit').value || '').trim().toUpperCase();
  const destEl = document.getElementById('incDestEdit');
  const newDest = destEl.dataset.addrId || (destEl.value || '').trim().toUpperCase();
  const newScene = (document.getElementById('incSceneAddress')?.value || '').trim().toUpperCase() || undefined;
  if (!CURRENT_INCIDENT_ID) return;

  // Get current incident to compare destination and scene address
  const curInc = (STATE.incidents || []).find(i => i.incident_id === CURRENT_INCIDENT_ID);
  const curDest = curInc ? (curInc.destination || '') : '';
  const curScene = curInc ? (curInc.scene_address || '') : '';
  const destChanged = newDest !== curDest.toUpperCase();
  const sceneChanged = newScene !== undefined && newScene !== curScene.toUpperCase();

  // If anything changed, use updateIncident
  if (newType || m || destChanged || sceneChanged) {
    setLive(true, 'LIVE • UPDATE INCIDENT');
    const r = await API.updateIncident(TOKEN, CURRENT_INCIDENT_ID, m, newType, destChanged ? newDest : undefined, sceneChanged ? newScene : undefined);
    if (!r.ok) return showErr(r);
    if (sceneChanged && newScene) { AddrHistory.push(newScene); _geoVerifyAddress(newScene); }
    beepChange();
    closeIncidentPanel();
    refresh();
    return;
  }

  showConfirm('ERROR', 'ENTER INCIDENT NOTE, CHANGE TYPE, UPDATE DESTINATION, OR SCENE ADDRESS.', () => { });
}

function renderIncidentAudit(aR) {
  const e = document.getElementById('incAudit');
  const rs = aR || [];
  if (!rs.length) {
    e.innerHTML = '<div class="muted">NO HISTORY.</div>';
    return;
  }
  e.innerHTML = rs.map(r => {
    const ts = r.ts ? fmtTime24(r.ts) : '—';
    const aC = getRoleColor(r.actor);
    return `<div style="border-bottom:1px solid var(--line); padding:8px 6px;">
      <div class="muted ${aC}">${esc(ts)} • ${esc((r.actor || '').toUpperCase())}</div>
      <div style="font-weight:900; color:var(--yellow); margin-top:2px;">${esc(String(r.message || ''))}</div>
    </div>`;
  }).join('');
}

// ============================================================
// Unit History Modal
// ============================================================
function closeUH() {
  document.getElementById('uhBack').style.display = 'none';
  UH_CURRENT_UNIT = '';
}

function reloadUH() {
  if (!UH_CURRENT_UNIT) return;
  const h = Number(document.getElementById('uhHours').value || 12);
  openHistory(UH_CURRENT_UNIT, h);
}

async function openHistory(uId, h) {
  if (!TOKEN) { showConfirm('ERROR', 'NOT LOGGED IN.', () => { }); return; }
  const u = canonicalUnit(uId);
  if (!u) { showConfirm('ERROR', 'USAGE: UH <UNIT> [HOURS]', () => { }); return; }

  UH_CURRENT_UNIT = u;
  UH_CURRENT_HOURS = Number(h || 12);
  document.getElementById('uhTitle').textContent = 'UNIT HISTORY';
  document.getElementById('uhUnit').textContent = u;
  document.getElementById('uhHours').value = String(UH_CURRENT_HOURS);
  document.getElementById('uhBack').style.display = 'flex';
  document.getElementById('uhBody').innerHTML = '<tr><td colspan="7" class="muted">LOADING…</td></tr>';

  setLive(true, 'LIVE • UNIT HISTORY');
  const r = await API.getUnitHistory(TOKEN, u, UH_CURRENT_HOURS);
  if (!r || !r.ok) return showErr(r);

  const rs = r.rows || [];
  if (!rs.length) {
    document.getElementById('uhBody').innerHTML = '<tr><td colspan="7" class="muted">NO HISTORY IN THIS WINDOW.</td></tr>';
    return;
  }

  rs.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  document.getElementById('uhBody').innerHTML = rs.map(rr => {
    const ts = rr.ts ? fmtTime24(rr.ts) : '—';
    const nx = rr.next || {};
    const st = String(nx.status || '').toUpperCase();
    const aC = getRoleColor(rr.actor);
    return `<tr>
      <td>${esc(ts)}</td>
      <td>${esc((rr.action || '').toUpperCase())}</td>
      <td>${esc(st || '—')}</td>
      <td>${nx.note ? esc(String(nx.note || '').toUpperCase()) : '<span class="muted">—</span>'}</td>
      <td>${nx.incident ? esc(String(nx.incident || '').toUpperCase()) : '<span class="muted">—</span>'}</td>
      <td>${nx.destination ? esc(String(nx.destination || '').toUpperCase()) : '<span class="muted">—</span>'}</td>
      <td class="muted ${aC}">${rr.actor ? esc(String(rr.actor || '').toUpperCase()) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ============================================================
// Messages Modal
// ============================================================
function openMessages() {
  if (!TOKEN) { showConfirm('ERROR', 'NOT LOGGED IN.', () => { }); return; }
  const ms = STATE.messages || [];
  const li = document.getElementById('msgList');
  document.getElementById('msgModalCount').textContent = ms.length;

  if (!ms.length) {
    li.innerHTML = '<div class="muted" style="padding:20px; text-align:center;">NO MESSAGES</div>';
  } else {
    li.innerHTML = ms.map(m => {
      const cl = ['msgItem'];
      if (!m.read) cl.push('unread');
      if (m.urgent) cl.push('urgent');
      const fr = m.from_initials + '@' + m.from_role;
      const fC = getRoleColor(fr);
      const uH = m.urgent ? '<div class="msgUrgent">URGENT</div>' : '';
      return `<div class="${cl.join(' ')}" onclick="viewMessage('${esc(m.message_id)}')">
        <div class="msgHeader">
          <span class="msgFrom ${fC}">FROM ${esc(fr)}</span>
          <span class="msgTime">${fmtTime24(m.ts)}</span>
        </div>
        ${uH}
        <div class="msgText">${esc(m.message)}</div>
      </div>`;
    }).join('');
  }
  document.getElementById('msgBack').style.display = 'flex';
}

function closeMessages() {
  document.getElementById('msgBack').style.display = 'none';
  refresh();
}

async function viewMessage(mId) {
  const r = await API.readMessage(TOKEN, mId);
  if (!r.ok) return showErr(r);
  refresh();
}

async function deleteMessage(mId) {
  const r = await API.deleteMessage(TOKEN, mId);
  if (!r.ok) return showErr(r);
  beepChange();
  closeMessages();
  refresh();
}

async function deleteAllMessages() {
  const r = await API.deleteAllMessages(TOKEN);
  if (!r.ok) return showErr(r);
  beepChange();
  closeMessages();
  refresh();
}

function replyToMessage(cmd) {
  document.getElementById('cmd').value = cmd;
  document.getElementById('cmd').focus();
}

// ============================================================
// Export & Metrics
// ============================================================
async function exportCsv(h) {
  const r = await API.exportAuditCsv(TOKEN, h);
  if (!r.ok) return showErr(r);
  const b = new Blob([r.csv], { type: 'text/csv;charset=utf-8;' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u;
  a.download = r.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(u);
}

// ============================================================
// Command Parser & Runner
// ============================================================
async function runCommand() {
  const cE = document.getElementById('cmd');
  let tx = (cE.value || '').trim();
  if (!tx) return;

  CMD_HISTORY.push(tx);
  if (CMD_HISTORY.length > 50) CMD_HISTORY.shift();
  CMD_INDEX = CMD_HISTORY.length;
  cE.value = '';

  // Command chaining: split on ; (NC uses ; internally, so consume remainder)
  const segments = [];
  let _remaining = tx;
  while (_remaining.length > 0) {
    const _trimmed = _remaining.trimStart();
    if (/^NC\s/i.test(_trimmed) || /^NC$/i.test(_trimmed)) {
      segments.push(_trimmed.trim());
      break;
    }
    const _semiIdx = _remaining.indexOf(';');
    if (_semiIdx < 0) {
      segments.push(_remaining.trim());
      break;
    }
    const _seg = _remaining.substring(0, _semiIdx).trim();
    if (_seg) segments.push(_seg);
    _remaining = _remaining.substring(_semiIdx + 1);
  }
  for (const segment of segments) {
    await _execCmd(segment);
  }
}

const _ONE_TOKEN_CMDS = new Set([
  'NC', 'MSGALL', 'HTALL', 'MSGU', 'HTU', 'HTMSU', 'MSGDP', 'HTDP',
  'NOTE', 'ALERT', 'NEWUSER', 'DELUSER', 'CLEARDATA', 'PASSWD',
  'REPORTOOS', 'REPORT', 'REPORTUTIL', 'REPORTSHIFT',
  'MAP', 'LOC'
]);

async function _execCmd(tx) {
  const tokens = tx.split(/\s+/);
  const cmd = (tokens[0] || '').toUpperCase();

  let ma, no;
  if (_ONE_TOKEN_CMDS.has(cmd)) {
    ma = cmd;
    no = tokens.slice(1).join(' ');
  } else if (tokens.length <= 2) {
    ma = tx;
    no = '';
  } else {
    const idx1 = tx.indexOf(' ');
    const idx2 = idx1 >= 0 ? tx.indexOf(' ', idx1 + 1) : -1;
    if (idx2 >= 0) {
      ma = tx.substring(0, idx2);
      no = tx.substring(idx2 + 1);
    } else {
      ma = tx;
      no = '';
    }
  }

  const mU = ma.toUpperCase();
  const nU = expandShortcutsInText(no || '');

  if (mU === 'HELP' || mU === 'H') return showHelp();
  if (mU === 'BUG') { openBugReport(); return; }
  if (mU === 'ADMIN') return showAdmin();
  if (mU === 'REFRESH') { forceRefresh(); return; }
  if (mU === 'POPOUT') { openPopout(); return; }
  if (mU === 'POPIN')  { closePopin(); return; }
  if (mU === 'POPMAP') { openPopoutMap(); return; }
  if (mU === 'POPINC') { openPopoutInc(); return; }
  if (mU === 'MAPIN')  { mapZoomIn(); return; }
  if (mU === 'MAPOUT') { mapZoomOut(); return; }
  if (mU === 'MAPFIT') { mapFitAll(); return; }
  if (mU === 'MAPSTA') { mapShowStations(); return; }
  if (mU === 'MAPINC') { mapShowIncidents(); return; }
  if (mU === 'MAPRESET') { mapReset(); return; }
  if (mU === 'MAPR') { _ensureMapOpen(() => { renderBoardMap(); showToast('MAP REFRESHED'); }); return; }
  if (mU === 'MAP') {
    const mapArg = (nU || '').toUpperCase().trim();
    if (!mapArg) { toggleBoardMap(); return; }
    if (mapArg === 'IN') { mapZoomIn(); return; }
    if (mapArg === 'OUT') { mapZoomOut(); return; }
    if (mapArg === 'FIT') { mapFitAll(); return; }
    if (mapArg === 'STA' || mapArg === 'STATIONS') { mapShowStations(); return; }
    if (mapArg === 'INC') { mapShowIncidents(); return; }
    if (mapArg === 'RESET') { mapReset(); return; }
    if (mapArg === 'R' || mapArg === 'REFRESH') {
      _ensureMapOpen(() => { renderBoardMap(); showToast('MAP REFRESHED'); });
      return;
    }
    if (mapArg === 'CLR' || mapArg === 'CLEAR') {
      _bmGeoCache = {};
      _clearSearchPin();
      _ensureMapOpen(() => { renderBoardMap(); showToast('MAP CACHE CLEARED + REFRESHED'); });
      return;
    }
    // MAP INC<id> — focus on incident scene
    if (/^INC\s*\d+$|^\d{2}-\d+$/.test(mapArg)) {
      focusIncidentOnMap(mapArg.replace(/\s+/g, ''));
      return;
    }
    // Check if arg matches a known unit — if not, treat as address to geocode
    const knownUnit = (STATE && STATE.units || []).find(u => u.unit_id === mapArg.split(/\s/)[0]);
    if (knownUnit) {
      focusUnitOnMap(mapArg.split(/\s/)[0]);
    } else {
      // MAP <address> — geocode and focus
      mapGeoFocus(mapArg);
    }
    return;
  }

  // ── ZOOM COMMANDS ──
  if (mU === 'ZOOM IN' || mU === 'Z+' || mU === 'ZIN') { boardZoomIn(); return; }
  if (mU === 'ZOOM OUT' || mU === 'Z-' || mU === 'ZOUT') { boardZoomOut(); return; }
  if (mU === 'ZOOM RESET' || mU === 'Z0' || mU === 'ZRESET') { boardZoomReset(); return; }
  {
    const zoomValMatch = mU.match(/^ZOOM\s+(\d+)$/);
    if (zoomValMatch) {
      BOARD_ZOOM = Math.max(50, Math.min(200, parseInt(zoomValMatch[1])));
      applyBoardZoom();
      return;
    }
  }

  // ── VIEW / DISPLAY COMMANDS ──

  // V SIDE/MSG/MET/INC/ALL/NONE
  if (/^V\s+/i.test(mU)) {
    const panel = mU.substring(2).trim();
    if (panel === 'SIDE') toggleView('sidebar');
    else if (panel === 'MSG') toggleView('messages');
    else if (panel === 'INC') toggleView('incidents');
    else if (panel === 'ALL') toggleView('all');
    else if (panel === 'NONE') toggleView('none');
    else { showAlert('ERROR', 'USAGE: V SIDE/MSG/INC/ALL/NONE'); }
    return;
  }

  // F <STATUS> / F ALL — filter
  if (/^F\s+/i.test(mU) || mU === 'F') {
    const arg = mU.substring(2).trim();
    if (!arg || arg === 'ALL') {
      VIEW.filterStatus = null;
    } else if (VALID_STATUSES.has(arg)) {
      VIEW.filterStatus = arg;
    } else {
      showAlert('ERROR', 'USAGE: F <STATUS> OR F ALL\nVALID: D, DE, OS, F, FD, T, TH, AV, UV, BRK, OOS, IQ');
      return;
    }
    const tbFs = document.getElementById('tbFilterStatus');
    if (tbFs) tbFs.value = VIEW.filterStatus || '';
    saveViewState();
    renderBoardDiff();
    return;
  }

  // SORT STATUS/UNIT/ELAPSED/UPDATED/REV
  if (/^SORT\s+/i.test(mU)) {
    const arg = mU.substring(5).trim();
    if (arg === 'REV') {
      VIEW.sortDir = VIEW.sortDir === 'asc' ? 'desc' : 'asc';
    } else if (['STATUS', 'UNIT', 'ELAPSED', 'UPDATED'].includes(arg)) {
      VIEW.sort = arg.toLowerCase();
      VIEW.sortDir = 'asc';
    } else {
      showAlert('ERROR', 'USAGE: SORT STATUS/UNIT/ELAPSED/UPDATED/REV');
      return;
    }
    const tbSort = document.getElementById('tbSort');
    if (tbSort) tbSort.value = VIEW.sort;
    saveViewState();
    updateSortHeaders();
    renderBoardDiff();
    return;
  }

  // NIGHT — toggle night mode
  if (mU === 'NIGHT') {
    toggleNightMode();
    return;
  }

  // DEN / DEN COMPACT/NORMAL/EXPANDED
  if (/^DEN$/i.test(mU)) {
    cycleDensity();
    return;
  }
  if (/^DEN\s+/i.test(mU)) {
    const arg = mU.substring(4).trim();
    if (['COMPACT', 'NORMAL', 'EXPANDED'].includes(arg)) {
      VIEW.density = arg.toLowerCase();
      saveViewState();
      applyViewState();
    } else {
      showAlert('ERROR', 'USAGE: DEN COMPACT/NORMAL/EXPANDED');
    }
    return;
  }

  // PRESET DISPATCH/SUPERVISOR/FIELD
  if (/^PRESET\s+/i.test(mU)) {
    const arg = mU.substring(7).trim().toLowerCase();
    if (['dispatch', 'supervisor', 'field'].includes(arg)) {
      applyPreset(arg);
    } else {
      showAlert('ERROR', 'USAGE: PRESET DISPATCH/SUPERVISOR/FIELD');
    }
    return;
  }

  // ELAPSED SHORT/LONG/OFF
  if (/^ELAPSED\s+/i.test(mU)) {
    const arg = mU.substring(8).trim().toLowerCase();
    if (['short', 'long', 'off'].includes(arg)) {
      VIEW.elapsedFormat = arg;
      saveViewState();
      renderBoardDiff();
    } else {
      showAlert('ERROR', 'USAGE: ELAPSED SHORT/LONG/OFF');
    }
    return;
  }

  // CLR <UNIT> - clear unit from incident without status change
  if (mU.startsWith('CLR ')) {
    const unitId = mU.substring(4).trim().toUpperCase();
    if (unitId) {
      setLive(true, 'LIVE • CLR UNIT');
      const r = await API.clearUnitIncident(TOKEN, unitId);
      if (!r.ok) return showErr(r);
      showToast('CLEARED ' + unitId + ' FROM ' + (r.clearedIncident || 'INCIDENT'));
      refresh();
      return;
    }
  }

  // CLR - clear filters + search
  if (mU === 'CLR') {
    VIEW.filterStatus = null;
    ACTIVE_INCIDENT_FILTER = '';
    document.getElementById('search').value = '';
    const tbFs = document.getElementById('tbFilterStatus');
    if (tbFs) tbFs.value = '';
    saveViewState();
    renderBoardDiff();
    return;
  }


  // INBOX - open/focus inbox panel
  if (mU === 'INBOX') {
    const p = document.getElementById('msgInboxPanel');
    if (p && p.classList.contains('collapsed')) p.classList.remove('collapsed');
    const list = document.getElementById('msgInboxList');
    if (list) list.scrollTop = 0;
    return;
  }

  // NOTES / SCRATCH - focus scratch notes
  if (mU === 'NOTES' || mU === 'SCRATCH') {
    if (VIEW.sidebar) {
      const pad = document.getElementById('scratchPadSide');
      if (pad) pad.focus();
    } else {
      const p = document.getElementById('scratchPanel');
      if (p && p.classList.contains('collapsed')) p.classList.remove('collapsed');
      const pad = document.getElementById('scratchPad');
      if (pad) pad.focus();
    }
    return;
  }

  // IQ <UNIT> — set in quarters (returns to station address)
  if (mU.startsWith('IQ ') || (mU === 'IQ' && SELECTED_UNIT_ID)) {
    const targetUnit = mU === 'IQ' ? SELECTED_UNIT_ID : canonicalUnit(mU.substring(3).trim());
    if (!targetUnit) { showAlert('ERROR', 'USAGE: IQ <UNIT>'); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === targetUnit) : null;
    if (!uO) { showAlert('ERROR', 'UNIT NOT FOUND: ' + targetUnit); return; }
    const station = (uO.station || '').trim();
    if (!station) {
      showAlert('ERROR', targetUnit + ' HAS NO STATION/QUARTERS ASSIGNED.\nUPDATE VIA UNIT MODAL OR ADMIN ROSTER.');
      return;
    }
    setLive(true, 'LIVE \u2022 IQ');
    const patch = { status: 'IQ', displayName: uO.display_name };
    const r = await API.upsertUnit(TOKEN, targetUnit, patch, uO.updated_at || '');
    if (!r.ok) return showErr(r);
    beepChange();
    showToast(targetUnit + ': IN QUARTERS @ ' + station);
    refresh();
    return;
  }

  // SUP <UNIT> <MESSAGE> — supplemental update to unit's incident
  if (mU.startsWith('SUP ')) {
    const supUnit = canonicalUnit(mU.substring(4).trim());
    if (!supUnit) { showAlert('ERROR', 'USAGE: SUP <UNIT> <MESSAGE>'); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === supUnit) : null;
    if (!uO) { showAlert('ERROR', 'UNIT NOT FOUND: ' + supUnit); return; }
    if (!uO.incident) { showAlert('ERROR', supUnit + ' IS NOT ASSIGNED TO AN INCIDENT.'); return; }
    if (!nU) { showAlert('ERROR', 'USAGE: SUP <UNIT> <MESSAGE>'); return; }
    setLive(true, 'LIVE \u2022 SUP');
    const r = await API.appendIncidentNote(TOKEN, uO.incident, '[SUP] ' + nU);
    if (!r.ok) return showErr(r);
    beepChange();
    showToast('SUP SENT TO ' + supUnit + ' (INC' + uO.incident.replace(/^\d{2}-/, '') + ')');
    refresh();
    return;
  }

  // ── BARE STATUS CODE with selected unit ──
  if (SELECTED_UNIT_ID && VALID_STATUSES.has(mU) && !no) {
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === SELECTED_UNIT_ID) : null;
    if (uO) {
      quickStatus(uO, mU);
      return;
    }
  }

  // ── EXISTING COMMANDS (unchanged) ──

  // LUI - Create temp one-off unit
  if (mU === 'LUI' || mU.startsWith('LUI ')) {
    const luiPrefill = mU.startsWith('LUI ') ? ma.substring(4).trim().toUpperCase() : '';
    const dN = luiPrefill ? displayNameForUnit(canonicalUnit(luiPrefill)) : '';
    const fakeUnit = {
      unit_id: luiPrefill,
      display_name: dN || luiPrefill,
      active: false,
      status: 'AV',
      note: '[TEMP]',
      type: 'EMS',
      level: '',
      station: ''
    };
    openModal(fakeUnit);
    showToast('LUI: CREATING TEMP UNIT. FILL IN DETAILS AND SAVE.');
    return;
  }

  // User management
  if (mU === 'NEWUSER' && nU) {
    const parts = nU.trim().split(',');
    if (parts.length !== 2) { showAlert('ERROR', 'USAGE: NEWUSER lastname,firstname'); return; }
    const r = await API.newUser(TOKEN, parts[0].trim(), parts[1].trim());
    if (!r.ok) return showErr(r);
    const collisionMsg = r.collision ? '\n\nUSERNAME COLLISION - NUMBER ADDED' : '';
    showAlert('USER CREATED', `NEW USER CREATED:${collisionMsg}\n\nNAME: ${r.firstName} ${r.lastName}\nUSERNAME: ${r.username}\nPASSWORD: ${r.password}\n\nUser can now log in with this username and password.`);
    return;
  }

  if (mU === 'DELUSER' && nU) {
    const deluserRaw = nU.trim();
    const deluserParts = deluserRaw.split(/\s+/);
    const deluserHasConfirm = deluserParts[deluserParts.length - 1].toUpperCase() === 'CONFIRM';
    const u = deluserHasConfirm ? deluserParts.slice(0, -1).join(' ') : deluserRaw;
    if (!u) { showAlert('ERROR', 'USAGE: DELUSER username CONFIRM'); return; }
    if (!deluserHasConfirm) {
      showErr({ error: 'CONFIRMATION REQUIRED. RE-RUN WITH CONFIRM. EXAMPLE: DELUSER ' + u + ' CONFIRM' });
      return;
    }
    showConfirm('CONFIRM DELETE USER', 'DELETE USER: ' + u + '?', async () => {
      const r = await API.delUser(TOKEN, u);
      if (!r.ok) return showErr(r);
      showAlert('USER DELETED', 'USER DELETED: ' + r.username);
    });
    return;
  }

  // REPORTOOS - Out of Service report
  if (mU === 'REPORTOOS' || /^REPORTOOS\d/.test(mU)) {
    const ts = (mU === 'REPORTOOS' ? (nU || '') : mU.substring(9)).trim().toUpperCase();
    let hrs = 24;
    if (ts) {
      const m = ts.match(/^(\d+)(H|D)?$/);
      if (m) {
        const n = parseInt(m[1]);
        const ut = m[2] || 'H';
        hrs = ut === 'D' ? n * 24 : n;
      } else {
        showAlert('ERROR', 'USAGE: REPORTOOS [24H|7D|30D]\nH=HOURS, D=DAYS\nExample: REPORTOOS 24H or REPORTOOS 7D');
        return;
      }
    }
    const r = await API.reportOOS(TOKEN, hrs);
    if (!r.ok) return showErr(r);
    const rp = r.report || {};
    let out = `OUT OF SERVICE REPORT\n${hrs}H PERIOD (${rp.startTime} TO ${rp.endTime})\n\n`;
    out += '='.repeat(47) + '\n';
    out += `TOTAL OOS TIME: ${rp.totalOOSMinutes} MINUTES (${rp.totalOOSHours} HOURS)\n`;
    out += `TOTAL UNITS: ${rp.unitCount}\n`;
    out += '='.repeat(47) + '\n\n';
    if (rp.units && rp.units.length > 0) {
      out += 'UNIT BREAKDOWN:\n\n';
      rp.units.forEach(u => {
        out += `${u.unit.padEnd(12)} ${String(u.oosMinutes).padStart(6)} MIN  ${u.oosHours} HRS\n`;
        if (u.periods && u.periods.length > 0) {
          u.periods.forEach(p => {
            out += `  ${p.start} -> ${p.end} (${p.duration}M)\n`;
          });
        }
        out += '\n';
      });
    } else {
      out += 'NO OOS TIME RECORDED IN THIS PERIOD\n';
    }
    showAlert('OOS REPORT', out);
    return;
  }

  // REPORT SHIFT — printable shift summary
  if (mU === 'REPORT' && /^SHIFT\b/i.test(nU)) {
    const hrs = parseFloat(nU.replace(/^SHIFT\s*/i, '').trim()) || 12;
    setLive(true, 'LIVE • SHIFT REPORT');
    const r = await API.getShiftReport(TOKEN, hrs);
    if (!r.ok) return showErr(r);
    openShiftReportWindow(r);
    return;
  }
  if (mU === 'REPORTSHIFT') {
    const hrs = parseFloat(nU || '') || 12;
    setLive(true, 'LIVE • SHIFT REPORT');
    const r = await API.getShiftReport(TOKEN, hrs);
    if (!r.ok) return showErr(r);
    openShiftReportWindow(r);
    return;
  }

  // REPORT INC — printable per-incident report
  if (mU === 'REPORT' && /^INC/i.test(nU)) {
    const iId = nU.replace(/^INC\s*/i, '').trim();
    if (!iId) { showAlert('USAGE', 'REPORT INC <ID>\nExample: REPORT INC1234'); return; }
    setLive(true, 'LIVE • INCIDENT REPORT');
    const r = await API.getIncident(TOKEN, iId);
    if (!r.ok) return showErr(r);
    openIncidentPrintWindow(r);
    return;
  }

  // REPORTUTIL — per-unit utilization report
  if (mU === 'REPORTUTIL') {
    const parts = (nU || '').trim().split(/\s+/);
    const uId  = parts[0] || '';
    const hrs  = parseFloat(parts[1]) || 24;
    if (!uId) { showAlert('USAGE', 'REPORTUTIL <UNIT> [HOURS]\nExample: REPORTUTIL EMS1 24'); return; }
    setLive(true, 'LIVE • UNIT REPORT');
    const r = await API.getUnitReport(TOKEN, uId, hrs);
    if (!r.ok) return showErr(r);
    openUnitReportWindow(r);
    return;
  }

  // SUGGEST — recommend available units for an incident
  if (mU.startsWith('SUGGEST ')) {
    const iId = ma.substring(8).trim().toUpperCase();
    if (!iId) { showAlert('USAGE', 'SUGGEST INC0001'); return; }
    return suggestUnits(iId);
  }

  // DIVERSION — set/clear hospital diversion
  if (mU.startsWith('DIVERSION ')) {
    const parts = (mU + ' ' + nU).trim().split(/\s+/);
    const onOff = parts[1] || '';
    const code = parts[2] || '';
    if ((onOff !== 'ON' && onOff !== 'OFF') || !code) {
      showAlert('USAGE', 'DIVERSION ON <CODE>\nDIVERSION OFF <CODE>\n\nExample: DIVERSION ON SCMC');
      return;
    }
    const active = onOff === 'ON';
    setLive(true, 'LIVE');
    const r = await API.setDiversion(TOKEN, code, active);
    if (!r.ok) return showErr(r);
    showToast((active ? 'DIVERSION ON: ' : 'DIVERSION OFF: ') + r.code, active ? 'warn' : 'ok');
    return;
  }

  // SCOPE — set board view scope to all agencies or a specific agency
  if (mU.startsWith('SCOPE ')) {
    const parts = (mU + ' ' + nU).trim().split(/\s+/);
    const scopeArg = parts.slice(1).join(' ').trim().toUpperCase();
    if (!scopeArg) {
      showAlert('ERROR', 'USAGE: SCOPE ALL | SCOPE AGENCY <ID>');
    } else {
      const r = await API.setScope(TOKEN, scopeArg);
      if (r.ok) {
        showToast('SCOPE SET: ' + r.scope, 'success');
        updateScopeIndicator(r.scope);
      } else {
        showErr(r);
      }
    }
    return;
  }

  // ── Phase 2D: Stacked Assignment Commands ──────────────────────────

  // ASSIGN <INC> <UNIT>  — set incident as unit's primary assignment
  if (mU.startsWith('ASSIGN ')) {
    const parts = (mU + ' ' + nU).trim().split(/\s+/);
    if (parts.length >= 3) {
      const incArg = parts[1].replace(/^INC-?/i, '').trim();
      const unitArg = parts[2].trim().toUpperCase();
      const incId = incArg.includes('-') ? incArg : (new Date().getFullYear() % 100 + '-' + incArg);
      setLive(true, 'LIVE • ASSIGN');
      const r = await API.assignUnit(TOKEN, incId, unitArg);
      if (r.ok) { showToast(unitArg + ' ASSIGNED TO ' + incId + ' AS PRIMARY.', 'success'); refresh(); }
      else showErr(r);
    } else {
      showAlert('ERROR', 'USAGE: ASSIGN <INC> <UNIT>\nExample: ASSIGN 26-0023 EMS1');
    }
    return;
  }

  // QUEUE <INC> <UNIT>  — add incident to unit's queue (behind primary)
  // QUE / QUEU accepted as common misspellings
  if (mU.startsWith('QUEUE ') || mU.startsWith('QUE ') || mU.startsWith('QUEU ')) {
    const parts = (mU + ' ' + nU).trim().split(/\s+/);
    if (parts.length >= 3) {
      const incArg = parts[1].replace(/^INC-?/i, '').trim();
      const unitArg = parts[2].trim().toUpperCase();
      const incId = incArg.includes('-') ? incArg : (new Date().getFullYear() % 100 + '-' + incArg);
      setLive(true, 'LIVE • QUEUE');
      const r = await API.queueUnit(TOKEN, incId, unitArg);
      if (r.ok) { showToast(unitArg + ': ' + incId + (r.action === 'queued' ? ' QUEUED.' : ' ASSIGNED.'), 'success'); refresh(); }
      else showErr(r);
    } else {
      showAlert('ERROR', 'USAGE: QUEUE <INC> <UNIT>\nExample: QUEUE 26-0024 EMS1');
    }
    return;
  }

  // PRIMARY <INC> <UNIT>  — promote queued assignment to primary
  if (mU.startsWith('PRIMARY ')) {
    const parts = (mU + ' ' + nU).trim().split(/\s+/);
    if (parts.length >= 3) {
      const incArg = parts[1].replace(/^INC-?/i, '').trim();
      const unitArg = parts[2].trim().toUpperCase();
      const incId = incArg.includes('-') ? incArg : (new Date().getFullYear() % 100 + '-' + incArg);
      setLive(true, 'LIVE • PRIMARY');
      const r = await API.primaryUnit(TOKEN, incId, unitArg);
      if (r.ok) { showToast(incId + ' IS NOW PRIMARY FOR ' + unitArg + '.', 'success'); refresh(); }
      else showErr(r);
    } else {
      showAlert('ERROR', 'USAGE: PRIMARY <INC> <UNIT>\nExample: PRIMARY 26-0023 EMS1');
    }
    return;
  }

  // CLEAR <INC> <UNIT>  — remove assignment from unit stack
  // Note: placed before CLEARDATA check is irrelevant because CLEARDATA uses startsWith('CLEARDATA ')
  // and this check requires exactly 3 parts starting with CLEAR (not CLEARDATA).
  if (mU.startsWith('CLEAR ') && !mU.startsWith('CLEARDATA ')) {
    const parts = (mU + ' ' + nU).trim().split(/\s+/);
    if (parts.length >= 3) {
      const incArg = parts[1].replace(/^INC-?/i, '').trim();
      const unitArg = parts[2].trim().toUpperCase();
      const incId = incArg.includes('-') ? incArg : (new Date().getFullYear() % 100 + '-' + incArg);
      const confirmed = await showConfirmAsync('CLEAR ASSIGNMENT', 'CLEAR ' + incId + ' FROM ' + unitArg + "'S STACK?");
      if (!confirmed) return;
      setLive(true, 'LIVE • CLEAR');
      const r = await API.clearUnitAssignment(TOKEN, incId, unitArg);
      if (r.ok) {
        const msg = r.promoted
          ? unitArg + ': ' + incId + ' CLEARED. ' + r.promoted + ' PROMOTED TO PRIMARY.'
          : unitArg + ': ' + incId + ' CLEARED.';
        showToast(msg, 'success'); refresh();
      } else {
        showErr(r);
      }
    } else {
      showAlert('ERROR', 'USAGE: CLEAR <INC> <UNIT>\nExample: CLEAR 26-0024 EMS1');
    }
    return;
  }

  // STACK <INC> <UNIT>  — smart-assign: primary if unit free, queued if unit busy
  // STACK <UNIT>        — show unit's assignment stack (read)
  // Disambiguates by checking if 2nd token looks like an incident ID
  if (mU.startsWith('STACK ')) {
    const stackParts = (mU + ' ' + nU).trim().split(/\s+/);
    const secondToken = stackParts[1] || '';
    const looksLikeInc = /^\d{2}-\d{4}$/i.test(secondToken) || /^INC/i.test(secondToken) || /^0\d{3}$/.test(secondToken);
    if (stackParts.length >= 3 && looksLikeInc) {
      // Write path: STACK <INC> <UNIT>
      const incArg = stackParts[1].replace(/^INC-?/i, '').trim();
      const unitArg = stackParts[2].trim().toUpperCase();
      const incId = incArg.includes('-') ? incArg : (new Date().getFullYear() % 100 + '-' + incArg);
      setLive(true, 'LIVE • STACK');
      const r = await API.queueUnit(TOKEN, incId, unitArg);
      if (r.ok) {
        showToast(unitArg + ': ' + incId + (r.action === 'queued' ? ' STACKED (QUEUED).' : ' STACKED (PRIMARY).'), 'success');
        refresh();
      } else { showErr(r); }
    } else if (stackParts.length >= 2) {
      // Read path: STACK <UNIT>
      const unitArg = stackParts[1].trim().toUpperCase();
      setLive(true, 'LIVE • STACK');
      const r = await API.getUnitStack(TOKEN, unitArg);
      if (!r.ok) { showErr(r); return; }
      if (!r.stack || !r.stack.length) {
        showAlert('UNIT STACK — ' + unitArg, unitArg + ' HAS NO QUEUED ASSIGNMENTS.');
      } else {
        let lines = [unitArg + ' STACK [' + r.stack.length + ' ASSIGNMENT' + (r.stack.length !== 1 ? 'S' : '') + ']:'];
        r.stack.forEach(a => {
          const lbl = a.is_primary ? '#' + a.assignment_order + ' PRIMARY ' : '#' + a.assignment_order + ' QUEUED  ';
          const dest = a.destination ? '/ ' + a.destination : '';
          lines.push('  ' + lbl + a.incident_id + '  ' + (a.incident_type || '--') + ' ' + dest);
        });
        showAlert('UNIT STACK — ' + unitArg, lines.join('\n'));
      }
    } else {
      showAlert('ERROR', 'USAGE: STACK <INC> <UNIT>  or  STACK <UNIT>');
    }
    return;
  }

  if (mU === 'LISTUSERS') {
    const r = await API.listUsers(TOKEN);
    if (!r.ok) return showErr(r);
    const users = r.users || [];
    if (!users.length) { showAlert('USERS', 'NO USERS IN SYSTEM'); return; }
    const userList = users.map(u => `${u.username} - ${u.firstName} ${u.lastName}`).join('\n');
    showAlert('SYSTEM USERS (' + users.length + ')', userList);
    return;
  }

  if (mU === 'PASSWD' && nU) {
    const parts = nU.trim().split(/\s+/);
    if (parts.length !== 2) { showAlert('ERROR', 'USAGE: PASSWD oldpassword newpassword'); return; }
    const r = await API.changePassword(TOKEN, parts[0], parts[1]);
    if (!r.ok) return showErr(r);
    showAlert('PASSWORD CHANGED', 'YOUR PASSWORD HAS BEEN CHANGED SUCCESSFULLY.');
    return;
  }

  // Search
  if (mU.startsWith('! ')) {
    const query = (ma.substring(2).trim() + (no ? ' ' + no : '')).trim().toUpperCase();
    if (!query || query.length < 2) { showAlert('ERROR', 'USAGE: ! searchtext (min 2 chars)'); return; }
    const r = await API.search(TOKEN, query);
    if (!r.ok) return showErr(r);
    const results = r.results || [];
    if (!results.length) { showAlert('SEARCH RESULTS', 'NO RESULTS FOUND FOR: ' + query); return; }
    let report = 'SEARCH RESULTS FOR: ' + query + '\n\n';
    results.forEach(res => { report += `[${res.type}] ${res.summary}\n`; });
    showAlert('SEARCH RESULTS (' + results.length + ')', report);
    return;
  }

  // Clear data (admin roles only)
  if (mU === 'CLEARDATA' && nU) {
    if (!isAdminRole()) {
      showAlert('ACCESS DENIED', 'CLEARDATA COMMANDS REQUIRE ADMIN LOGIN (SUPV/MGR/IT).');
      return;
    }
    const whatRaw = nU.trim().toUpperCase();
    const whatParts = whatRaw.split(/\s+/);
    const hasConfirm = whatParts[whatParts.length - 1] === 'CONFIRM';
    const what = hasConfirm ? whatParts.slice(0, -1).join(' ') : whatRaw;
    if (!['UNITS', 'INACTIVE', 'AUDIT', 'INCIDENTS', 'MESSAGES', 'SESSIONS', 'ALL'].includes(what)) {
      showAlert('ERROR', 'USAGE: CLEARDATA [UNITS|INACTIVE|AUDIT|INCIDENTS|MESSAGES|SESSIONS|ALL]');
      return;
    }
    if (!hasConfirm) {
      showErr({ error: 'CONFIRMATION REQUIRED. RE-RUN WITH CONFIRM.\nExample: CLEARDATA ' + what + ' CONFIRM' });
      return;
    }
    // SESSIONS uses a different API endpoint
    if (what === 'SESSIONS') {
      showConfirm('CONFIRM SESSION CLEAR', 'LOG OUT ALL USERS?\n\nTHIS WILL FORCE EVERYONE TO RE-LOGIN.', async () => {
        const r = await API.clearSessions(TOKEN);
        if (!r.ok) return showErr(r);
        showAlert('SESSIONS CLEARED', `${r.deleted} SESSIONS CLEARED. ALL USERS LOGGED OUT.`);
      });
      return;
    }
    showConfirm('CONFIRM DATA CLEAR', `CLEAR ALL ${what} DATA?\n\nTHIS CANNOT BE UNDONE!`, async () => {
      const r = await API.clearData(TOKEN, what);
      if (!r.ok) return showErr(r);
      showAlert('DATA CLEARED', `${what} DATA CLEARED: ${r.deleted} ROWS DELETED`);
      refresh();
    });
    return;
  }

  // Unit status report
  if (mU === 'US') {
    if (!STATE || !STATE.units) { showAlert('ERROR', 'NO DATA LOADED'); return; }
    const units = (STATE.units || []).filter(u => u.active).sort((a, b) => {
      const ra = statusRank(a.status);
      const rb = statusRank(b.status);
      if (ra !== rb) return ra - rb;
      return String(a.unit_id || '').localeCompare(String(b.unit_id || ''));
    });
    let report = 'UNIT STATUS REPORT\n\n';
    units.forEach(u => {
      const statusLabel = (STATE.statuses || []).find(s => s.code === u.status)?.label || u.status;
      const mins = minutesSince(u.updated_at);
      const age = mins != null ? Math.floor(mins) + 'M' : '—';
      report += `${u.unit_id.padEnd(12)} ${u.status.padEnd(4)} ${statusLabel.padEnd(20)} ${age.padEnd(6)}\n`;
      if (u.incident) report += `  INC: ${u.incident}\n`;
      if (u.destination) {
        const dr = AddressLookup.resolve(u.destination);
        report += `  DEST: ${dr.recognized ? dr.addr.name + ' [' + dr.addr.id + ']' : u.destination}\n`;
      }
      if (u.note) report += `  NOTE: ${u.note}\n`;
    });
    showAlert('UNIT STATUS', report);
    return;
  }

  // WHO [identifier] — dispatchers online, or look up specific unit/role/user
  if (mU === 'WHO' || mU.startsWith('WHO ')) {
    const filter = mU.startsWith('WHO ') ? ma.substring(4).trim().toUpperCase() : '';

    if (filter) {
      // First: check if it's an active unit on the board (field device lookup)
      const unit = ((STATE && STATE.units) || []).find(u => u.unit_id.toUpperCase() === filter);
      if (unit) {
        if (!unit.active) {
          showAlert('WHO ' + filter, filter + ' IS NOT LOGGED IN', 'yellow');
        } else {
          const crew = parseCrewInfo(unit.unit_info);
          const st = unit.status || '--';
          const inc = unit.incident ? '\nINCIDENT: ' + unit.incident : '';
          const dest = unit.destination ? '\nDESTINATION: ' + unit.destination : '';
          const crewLine = crew ? '\nCREW: ' + crew : '\nNO CREW INFO ON FILE';
          showAlert('WHO ' + filter, 'STATUS: ' + st + inc + dest + crewLine, 'yellow');
        }
        return;
      }

      // Otherwise: look up dispatcher by role or username in active sessions
      const r = await API.who(TOKEN, filter);
      if (!r.ok) return showErr(r);
      const users = r.users || [];
      if (!users.length) {
        showAlert('WHO ' + filter, filter + ' IS NOT LOGGED IN', 'yellow');
      } else {
        const userList = users.map(u => `${u.actor} (${u.minutesAgo}M AGO)`).join('\n');
        showAlert('WHO ' + filter, userList, 'yellow');
      }
      return;
    }

    // WHO with no args — list all online dispatchers
    const r = await API.who(TOKEN);
    if (!r.ok) return showErr(r);
    const users = r.users || [];
    if (!users.length) { showAlert('WHO', 'NO DISPATCHERS ONLINE', 'yellow'); return; }
    const userList = users.map(u => {
      const cad = u.cadId ? ' [' + u.cadId + ']' : '';
      return `${u.actor}${cad}  (${u.minutesAgo}M AGO)`;
    }).join('\n');
    showAlert('DISPATCHERS ONLINE (' + users.length + ')', userList, 'yellow');
    return;
  }

  // UR - active unit roster
  if (mU === 'UR') {
    const units = ((STATE && STATE.units) || []).filter(u => u.active);
    if (!units.length) { showAlert('UNIT ROSTER', 'NO ACTIVE UNITS ON BOARD', 'yellow'); return; }
    const lines = units.map(u => {
      const st = (u.status || '--').padEnd(4);
      const level = u.level ? ` [${u.level}]` : '';
      const inc = u.incident ? ` INC${u.incident}` : '';
      const dest = u.destination ? ` → ${u.destination}` : '';
      return `${String(u.unit_id).padEnd(8)} ${st}${level}${inc}${dest}`;
    }).join('\n');
    showAlert('UNIT ROSTER (' + units.length + ' ACTIVE)', lines, 'yellow');
    return;
  }

  // INCQ - incident queue quick view
  if (mU === 'INCQ') {
    const incidents = ((STATE && STATE.incidents) || []);
    const queued = incidents.filter(i => i.status === 'QUEUED');
    const active = incidents.filter(i => i.status === 'ACTIVE');
    if (!queued.length && !active.length) { showAlert('INCIDENT QUEUE', 'NO ACTIVE OR QUEUED INCIDENTS.', 'yellow'); return; }
    let report = '';
    if (queued.length) {
      report += '── QUEUED (' + queued.length + ') ──────────────────\n';
      queued.forEach(inc => {
        const shortId = String(inc.incident_id).replace(/^\d{2}-/, '');
        const pri = inc.priority ? ' ' + inc.priority : '';
        const dest = inc.destination ? ' → ' + inc.destination : '';
        const typ = inc.incident_type ? ' [' + inc.incident_type + ']' : '';
        const wait = inc.created_at ? Math.floor((Date.now() - new Date(inc.created_at).getTime()) / 60000) + 'M' : '';
        const note = (inc.incident_note || '').replace(/\[URGENT\]\s*/i, '').replace(/\[MA\]\s*/gi, '').replace(/\[CB:[^\]]+\]\s*/gi, '').trim();
        report += `INC${shortId}${pri}${dest}${typ}  ${wait}\n`;
        if (note) report += `  ${note.substring(0, 60)}\n`;
      });
    }
    if (active.length) {
      if (report) report += '\n';
      report += '── ACTIVE (' + active.length + ') ─────────────────\n';
      active.forEach(inc => {
        const shortId = String(inc.incident_id).replace(/^\d{2}-/, '');
        const pri = inc.priority ? ' ' + inc.priority : '';
        const dest = inc.destination ? ' → ' + inc.destination : '';
        const typ = inc.incident_type ? ' [' + inc.incident_type + ']' : '';
        const units = inc.units ? ' UNITS: ' + inc.units : '';
        const scene = inc.scene_address ? ' @ ' + inc.scene_address : '';
        report += `INC${shortId}${pri}${dest}${typ}${units}\n`;
        if (scene) report += `  SCENE: ${scene.substring(0, 50)}\n`;
      });
    }
    showAlert('INCIDENT QUEUE (' + queued.length + ' QUEUED / ' + active.length + ' ACTIVE)', report, 'yellow');
    return;
  }

  // PURGE - clean old data + install daily trigger (admin roles only)
  if (mU === 'PURGE') {
    if (!isAdminRole()) {
      showAlert('ACCESS DENIED', 'PURGE COMMAND REQUIRES ADMIN LOGIN (SUPV/MGR/IT).');
      return;
    }
    setLive(true, 'LIVE • PURGE');
    const r = await API.runPurge(TOKEN);
    if (!r.ok) return showErr(r);
    showAlert('PURGE COMPLETE', r.message || ('DELETED ' + (r.deleted || 0) + ' OLD ROWS.'));
    return;
  }

  // INFO
  if (mU === 'INFO') {
    showAlert('SCMC HOSCAD — QUICK REFERENCE',
      'QUICK REFERENCE — MOST USED NUMBERS\n' +
      '═══════════════════════════════════════════════\n\n' +
      'DISPATCH CENTERS:\n' +
      '  DESCHUTES 911 NON-EMERG:  (541) 693-6911\n' +
      '  CROOK 911 NON-EMERG:      (541) 447-4168\n' +
      '  JEFFERSON NON-EMERG:      (541) 384-2080\n\n' +
      'AIR AMBULANCE:\n' +
      '  AIRLINK CCT:              1-800-621-5433\n' +
      '  LIFE FLIGHT NETWORK:      1-800-232-0911\n\n' +
      'CRISIS:\n' +
      '  988 SUICIDE/CRISIS:       988\n' +
      '  DESCHUTES CRISIS:         (541) 322-7500 X9\n\n' +
      'OTHER:\n' +
      '  POISON CONTROL:           1-800-222-1222\n' +
      '  OSP NON-EMERGENCY:        *677 (*OSP)\n' +
      '  ODOT ROAD CONDITIONS:     511\n\n' +
      '═══════════════════════════════════════════════\n' +
      'SUB-COMMANDS FOR DETAILED INFO:\n\n' +
      '  INFO DISPATCH    911/PSAP CENTERS\n' +
      '  INFO AIR         AIR AMBULANCE DISPATCH\n' +
      '  INFO OSP         OREGON STATE POLICE\n' +
      '  INFO CRISIS      MENTAL HEALTH / CRISIS\n' +
      '  INFO POISON      POISON CONTROL\n' +
      '  INFO ROAD        ROAD CONDITIONS / ODOT\n' +
      '  INFO LE          LAW ENFORCEMENT DIRECT\n' +
      '  INFO JAIL        JAILS\n' +
      '  INFO FIRE        FIRE DEPARTMENT ADMIN\n' +
      '  INFO ME          MEDICAL EXAMINER\n' +
      '  INFO OTHER       OTHER USEFUL NUMBERS\n' +
      '  INFO ALL         SHOW EVERYTHING\n' +
      '  INFO <UNIT>      DETAILED UNIT INFO\n');
    return;
  }

  // ADDR — Address directory / search
  if (mU === 'ADDR' || mU.startsWith('ADDR ')) {
    const addrQuery = mU === 'ADDR' ? '' : mU.substring(5).trim();
    if (!AddressLookup._loaded) {
      showAlert('ADDRESS DIRECTORY', 'ADDRESS DATA NOT YET LOADED. PLEASE TRY AGAIN.');
      return;
    }
    if (!addrQuery) {
      // Full directory grouped by category
      const cats = {};
      AddressLookup._cache.forEach(function(a) {
        const c = a.category || 'OTHER';
        if (!cats[c]) cats[c] = [];
        cats[c].push(a);
      });
      let out = 'ADDRESS DIRECTORY (' + AddressLookup._cache.length + ' ENTRIES)\n\n';
      Object.keys(cats).sort().forEach(function(c) {
        out += '═══ ' + c.replace(/_/g, ' ') + ' (' + cats[c].length + ') ═══\n';
        cats[c].forEach(function(a) {
          out += '  ' + a.id.padEnd(10) + a.name + '\n';
          out += '  ' + ''.padEnd(10) + a.address + ', ' + a.city + ', ' + a.state + ' ' + a.zip + '\n';
          if (a.phone) out += '  ' + ''.padEnd(10) + 'PH: ' + a.phone + '\n';
          if (a.notes) out += '  ' + ''.padEnd(10) + a.notes + '\n';
        });
        out += '\n';
      });
      showAlert('ADDRESS DIRECTORY', out);
    } else {
      const results = AddressLookup.search(addrQuery, 20);
      if (!results.length) {
        showAlert('ADDRESS SEARCH', 'NO RESULTS FOR: ' + addrQuery);
      } else {
        let out = 'ADDRESS SEARCH: ' + addrQuery + ' (' + results.length + ' RESULTS)\n\n';
        results.forEach(function(a) {
          out += '[' + a.id + '] ' + a.name + '\n';
          out += '  ' + a.address + ', ' + a.city + ', ' + a.state + ' ' + a.zip + '\n';
          out += '  CATEGORY: ' + (a.category || '').replace(/_/g, ' ');
          if (a.phone) out += '  |  PH: ' + a.phone;
          if (a.notes) out += '  |  ' + a.notes;
          out += '\n\n';
        });
        showAlert('ADDRESS SEARCH', out);
      }
    }
    return;
  }

  // STATUS
  if (mU === 'STATUS') {
    const r = await API.getSystemStatus(TOKEN);
    if (!r.ok) return showErr(r);
    const s = r.status;
    showConfirm('SYSTEM STATUS', 'SYSTEM STATUS\n\nUNITS: ' + s.totalUnits + ' TOTAL, ' + s.activeUnits + ' ACTIVE\n\nBY STATUS:\n  D:   ' + (s.byStatus.D || 0) + '\n  DE:  ' + (s.byStatus.DE || 0) + '\n  OS:  ' + (s.byStatus.OS || 0) + '\n  T:   ' + (s.byStatus.T || 0) + '\n  AV:  ' + (s.byStatus.AV || 0) + '\n  OOS: ' + (s.byStatus.OOS || 0) + '\n\nINCIDENTS:\n  ACTIVE: ' + s.activeIncidents + '\n  STALE:  ' + s.staleIncidents + '\n\nLOGGED IN AS: ' + s.actor, () => { });
    return;
  }

  // OKALL
  if (mU === 'OKALL') return okAllOS();

  // LO / LOGOUT — session logout (no args); LO <UNIT> routes to unit logoff below
  if (mU === 'LO' || mU === 'LOGOUT') {
    const ok = await showConfirmAsync('LOG OUT', 'LOG OUT OF HOSCAD?');
    if (!ok) return;
    const logoutResult = await API.logout(TOKEN);
    if (!logoutResult.ok) {
      showAlert('LOGOUT ERROR', logoutResult.error || 'FAILED TO LOG OUT. SESSION MAY STILL BE ACTIVE.');
    }
    localStorage.removeItem('ems_token');
    TOKEN = '';
    ACTOR = '';
    document.getElementById('loginBack').style.display = 'flex';
    document.getElementById('userLabel').textContent = '—';
    if (POLL) clearInterval(POLL);
    stopPpPolling();
    return;
  }

  // OK - Touch unit or incident
  if (mU.startsWith('OK ')) {
    const re = ma.substring(3).trim().toUpperCase();
    if (re.startsWith('INC')) {
      const iId = re.replace(/^INC\s*/i, '');
      const r = await API.touchIncident(TOKEN, iId);
      if (!r.ok) return showErr(r);
      beepChange();
      refresh();
      return;
    }
    const u = canonicalUnit(re);
    if (!u) { showConfirm('ERROR', 'USAGE: OK <UNIT> OR OK INC0001', () => { }); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === u) : null;
    if (!uO) { showConfirm('ERROR', 'UNIT NOT FOUND: ' + u, () => { }); return; }
    return okUnit(uO);
  }

  // NOTE/ALERT banners
  if (mU === 'NOTE') {
    setLive(true, 'LIVE • NOTE');
    const r = await API.setBanner(TOKEN, 'NOTE', nU || 'CLEAR');
    if (!r.ok) return showErr(r);
    beepNote();
    refresh();
    return;
  }

  if (mU === 'ALERT') {
    setLive(true, 'LIVE • ALERT');
    const r = await API.setBanner(TOKEN, 'ALERT', nU || 'CLEAR');
    if (!r.ok) return showErr(r);
    beepAlert();
    refresh();
    return;
  }

  // UI - Unit info modal
  if (mU.startsWith('UI ')) {
    const u = canonicalUnit(ma.substring(3).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: UI <UNIT>', () => { }); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === u) : null;
    if (uO) openModal(uO, true);
    else openModal({ unit_id: u, display_name: displayNameForUnit(u), type: '', active: true, status: 'AV', note: '', unit_info: '', incident: '', destination: '', updated_at: '', updated_by: '' }, true);
    return;
  }

  // INFO for specific unit
  if (mU.startsWith('INFO ')) {
    const infoArg = mU.substring(5).trim();

    // INFO sub-commands for dispatch/emergency reference
    const INFO_SECTIONS = {
      'DISPATCH': {
        title: 'INFO — 911 / PSAP DISPATCH CENTERS',
        text:
          '911 / PSAP CENTERS (PUBLIC SAFETY ANSWERING POINTS)\n' +
          '═══════════════════════════════════════════════\n\n' +
          'DESCHUTES COUNTY 911\n' +
          '  NON-EMERGENCY:  (541) 693-6911\n' +
          '  ADMIN/BUSINESS: (541) 388-0185\n' +
          '  DISPATCHES FOR: BEND PD, REDMOND PD, DCSO,\n' +
          '    ALL DESCHUTES FIRE/EMS\n\n' +
          'CROOK COUNTY 911\n' +
          '  NON-EMERGENCY:  (541) 447-4168\n' +
          '  DISPATCHES FOR: PRINEVILLE PD, CCSO,\n' +
          '    CROOK COUNTY FIRE & RESCUE\n\n' +
          'JEFFERSON COUNTY DISPATCH\n' +
          '  NON-EMERGENCY:  (541) 384-2080\n' +
          '  ADMIN/BUSINESS: (541) 475-6520\n' +
          '  DISPATCHES FOR: JCSO, JEFFERSON COUNTY\n' +
          '    FIRE & EMS\n'
      },
      'AIR': {
        title: 'INFO — AIR AMBULANCE DISPATCH',
        text:
          'AIR AMBULANCE DISPATCH\n' +
          '═══════════════════════════════════════════════\n\n' +
          'AIRLINK CCT\n' +
          '  DISPATCH:  1-800-621-5433\n' +
          '  ALT:       (541) 280-3624\n' +
          '  BEND-BASED HELICOPTER (EC-135)\n' +
          '  & FIXED WING (PILATUS PC-12)\n\n' +
          'LIFE FLIGHT NETWORK\n' +
          '  DISPATCH:  1-800-232-0911\n' +
          '  REDMOND-BASED HELICOPTER (A-119)\n' +
          '  24/7 DISPATCH\n'
      },
      'OSP': {
        title: 'INFO — OREGON STATE POLICE',
        text:
          'OREGON STATE POLICE\n' +
          '═══════════════════════════════════════════════\n\n' +
          'NON-EMERGENCY:  *677 (*OSP) FROM CELL\n' +
          '  COVERS DESCHUTES, CROOK, JEFFERSON COUNTIES\n\n' +
          'TOLL-FREE:      1-800-452-7888\n' +
          '  NORTHERN COMMAND CENTER\n\n' +
          'DIRECT:         (503) 375-3555\n' +
          '  SALEM DISPATCH\n'
      },
      'CRISIS': {
        title: 'INFO — MENTAL HEALTH / CRISIS LINES',
        text:
          'MENTAL HEALTH / CRISIS LINES\n' +
          '═══════════════════════════════════════════════\n\n' +
          '988 SUICIDE & CRISIS LIFELINE\n' +
          '  CALL OR TEXT:  988\n' +
          '  24/7\n\n' +
          'DESCHUTES COUNTY CRISIS LINE\n' +
          '  (541) 322-7500 EXT. 9\n' +
          '  24/7\n\n' +
          'DESCHUTES STABILIZATION CENTER\n' +
          '  (541) 585-7210\n' +
          '  NON-EMERGENCY, WALK-IN 24/7\n\n' +
          'OREGON YOUTHLINE\n' +
          '  1-877-968-8491\n' +
          '  TEEN-TO-TEEN 4-10PM; ADULTS OTHER HOURS\n\n' +
          'VETERANS CRISIS LINE\n' +
          '  988, THEN PRESS 1\n\n' +
          'TRANS LIFELINE\n' +
          '  1-877-565-8860\n' +
          '  LIMITED HOURS\n\n' +
          'OREGON CRISIS TEXT LINE\n' +
          '  TEXT HOME TO 741741\n' +
          '  24/7\n'
      },
      'POISON': {
        title: 'INFO — POISON CONTROL',
        text:
          'POISON CONTROL\n' +
          '═══════════════════════════════════════════════\n\n' +
          'OREGON POISON CENTER\n' +
          '  1-800-222-1222\n' +
          '  24/7, MULTILINGUAL\n\n' +
          'POISONHELP.ORG\n' +
          '  ONLINE TOOL — NON-EMERGENCY\n'
      },
      'ROAD': {
        title: 'INFO — ROAD CONDITIONS / ODOT',
        text:
          'ROAD CONDITIONS / ODOT\n' +
          '═══════════════════════════════════════════════\n\n' +
          'TRIPCHECK 511\n' +
          '  511 FROM ANY PHONE IN OREGON\n\n' +
          'ODOT TOLL-FREE\n' +
          '  1-800-977-6368 (1-800-977-ODOT)\n\n' +
          'ODOT OUTSIDE OREGON\n' +
          '  (503) 588-2941\n\n' +
          'TRIPCHECK.COM\n' +
          '  LIVE CAMERAS, CONDITIONS\n'
      },
      'LE': {
        title: 'INFO — LAW ENFORCEMENT DIRECT LINES',
        text:
          'LAW ENFORCEMENT DIRECT LINES\n' +
          '═══════════════════════════════════════════════\n\n' +
          'DESCHUTES COUNTY SHERIFF   (541) 388-6655\n' +
          'CROOK COUNTY SHERIFF       (541) 447-6398\n' +
          'JEFFERSON COUNTY SHERIFF   (541) 475-6520\n' +
          'PRINEVILLE POLICE          (541) 447-4168\n' +
          '  (SHARES LINE WITH CROOK 911)\n' +
          'BEND POLICE ADMIN          (541) 322-2960\n' +
          'REDMOND POLICE             (541) 504-1810\n'
      },
      'JAIL': {
        title: 'INFO — JAILS',
        text:
          'JAILS — CONTROL ROOM NUMBERS\n' +
          '═══════════════════════════════════════════════\n\n' +
          'DESCHUTES COUNTY JAIL      (541) 388-6661\n' +
          'CROOK COUNTY JAIL          (541) 416-3620\n' +
          '  86 BEDS\n' +
          'JEFFERSON COUNTY JAIL      (541) 475-2869\n'
      },
      'FIRE': {
        title: 'INFO — FIRE DEPARTMENT ADMIN',
        text:
          'FIRE DEPARTMENT ADMIN\n' +
          '═══════════════════════════════════════════════\n\n' +
          'BEND FIRE & RESCUE         (541) 322-6300\n' +
          '  HQ: STATION 301\n' +
          'REDMOND FIRE & RESCUE      (541) 504-5000\n' +
          '  HQ: STATION 401\n' +
          'CROOK COUNTY FIRE & RESCUE (541) 447-5011\n' +
          '  HQ: PRINEVILLE\n' +
          'JEFFERSON COUNTY FIRE/EMS  (541) 475-7274\n' +
          '  HQ: MADRAS\n\n' +
          'BATTALION CHIEFS\n' +
          '═══════════════════════════════════════════════\n' +
          'BEND FIRE BC               TBD\n' +
          'REDMOND FIRE BC            TBD\n' +
          'CROOK COUNTY FIRE BC       TBD\n' +
          'JEFFERSON COUNTY FIRE BC   TBD\n'
      },
      'ME': {
        title: 'INFO — MEDICAL EXAMINER',
        text:
          'MEDICAL EXAMINER\n' +
          '═══════════════════════════════════════════════\n\n' +
          'DESCHUTES COUNTY ME\n' +
          '  MEDICAL.EXAMINER@DESCHUTES.ORG\n' +
          '  VIA DA\'S OFFICE\n\n' +
          'STATE MEDICAL EXAMINER\n' +
          '  (971) 673-8200\n' +
          '  CLACKAMAS (AUTOPSIES)\n'
      },
      'OTHER': {
        title: 'INFO — OTHER USEFUL NUMBERS',
        text:
          'OTHER USEFUL NUMBERS\n' +
          '═══════════════════════════════════════════════\n\n' +
          'DHS — ADULT PROTECTIVE SERVICES\n' +
          '  (541) 475-6773  (MADRAS)\n\n' +
          'DHS — DEVELOPMENTAL DISABILITIES\n' +
          '  (541) 322-7554  (BEND)\n\n' +
          'OUTDOOR BURN LINE (JEFFERSON CO)\n' +
          '  (541) 475-1789\n\n' +
          'COIDC (WILDFIRE DISPATCH)\n' +
          '  CENTRAL OREGON INTERAGENCY DISPATCH\n' +
          '  TBD\n'
      }
    };

    // Check for known sub-commands
    if (INFO_SECTIONS[infoArg]) {
      const sec = INFO_SECTIONS[infoArg];
      showAlert(sec.title, sec.text);
      return;
    }

    // INFO ALL — show everything
    if (infoArg === 'ALL') {
      let all = 'SCMC HOSCAD — COMPLETE REFERENCE DIRECTORY\n';
      all += '═══════════════════════════════════════════════\n\n';
      const order = ['DISPATCH', 'AIR', 'OSP', 'CRISIS', 'POISON', 'ROAD', 'LE', 'JAIL', 'FIRE', 'ME', 'OTHER'];
      order.forEach(function(k) {
        all += INFO_SECTIONS[k].text + '\n';
      });
      showAlert('INFO — COMPLETE DIRECTORY', all);
      return;
    }

    // Fall through to unit info lookup
    const u = canonicalUnit(ma.substring(5).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: INFO <UNIT> OR INFO DISPATCH/AIR/CRISIS/LE/FIRE/JAIL/ALL', () => { }); return; }
    const r = await API.getUnitInfo(TOKEN, u);
    if (!r.ok) return showErr(r);
    if (!r.unit) {
      showErr({ error: 'UNIT ' + u + ' NOT FOUND IN SYSTEM.' });
      return;
    }
    const un = r.unit;
    const destR = AddressLookup.resolve(un.destination);
    const destDisplay = destR.recognized ? destR.addr.name + ' [' + destR.addr.id + ']' : (un.destination || '—');
    showConfirm('UNIT INFO: ' + un.unit_id, 'UNIT INFO: ' + un.unit_id + '\n\nDISPLAY: ' + (un.display_name || '—') + '\nTYPE: ' + (un.type || '—') + '\nSTATUS: ' + (un.status || '—') + '\nACTIVE: ' + (un.active ? 'YES' : 'NO') + '\n\nINCIDENT: ' + (un.incident || '—') + '\nDESTINATION: ' + destDisplay + '\nNOTE: ' + (un.note || '—') + '\n\nUNIT INFO:\n' + (un.unit_info || '(NONE)') + '\n\nUPDATED: ' + (un.updated_at || '—') + '\nBY: ' + (un.updated_by || '—'), () => { });
    return;
  }

  // R - Review incident
  if (mU.startsWith('R ')) {
    const iR = ma.substring(2).trim().toUpperCase();
    if (!iR) { showConfirm('ERROR', 'USAGE: R INC0001 OR R 0001', () => { }); return; }
    return openIncidentFromServer(iR);
  }

  // U - Update incident note
  if (mU.startsWith('U ')) {
    const iR = ma.substring(2).trim().toUpperCase();
    if (!iR) { showConfirm('ERROR', 'USAGE: U INC0001 MESSAGE', () => { }); return; }
    if (!nU) { showConfirm('ERROR', 'USAGE: U INC0001 MESSAGE (MESSAGE REQUIRED)', () => { }); return; }
    setLive(true, 'LIVE • ADD NOTE');
    const r = await API.appendIncidentNote(TOKEN, iR, nU);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // NC - New incident in queue
  if (mU.startsWith('NC ') || mU === 'NC') {
    const ncRaw = tx.substring(2).trim();
    if (!ncRaw) { showAlert('ERROR', 'USAGE: NC <LOCATION>; <NOTE>; <TYPE>; <PRIORITY>; @<SCENE ADDR>\nNOTE, TYPE, PRIORITY, AND SCENE ADDRESS ARE OPTIONAL. ADD "MA" IN NOTE FOR MUTUAL AID. USE [CB:PHONE] IN NOTE FOR CALLBACK. PREFIX SCENE ADDRESS WITH @.'); return; }
    const ncParts = ncRaw.split(';').map(p => p.trim().toUpperCase());
    const dest     = ncParts[0] || '';
    let   noteRaw  = ncParts[1] || '';
    const incType  = ncParts[2] || '';
    const priority = ncParts[3] || '';
    // Scene address: 5th segment, OR any segment prefixed with @ (e.g. @1234 MAIN ST)
    let sceneAddress = '';
    if (ncParts[4] && ncParts[4].startsWith('@')) {
      sceneAddress = ncParts[4].substring(1).trim();
    } else if (ncParts[4]) {
      sceneAddress = ncParts[4].trim();
    }
    // Also scan all segments for @-prefixed token in case dispatcher puts it elsewhere
    for (let _si = 1; _si < ncParts.length; _si++) {
      if (ncParts[_si].startsWith('@') && _si !== 4) {
        sceneAddress = ncParts[_si].substring(1).trim();
        // Remove it from noteRaw if it appeared in position 1
        if (_si === 1) noteRaw = '';
        break;
      }
    }
    if (!dest) { showAlert('ERROR', 'USAGE: NC <LOCATION>; <NOTE>; <TYPE>; <PRIORITY>; @<SCENE ADDR>'); return; }
    // MA token in note
    const isMa = /\bMA\b/.test(noteRaw.toUpperCase());
    let note = noteRaw.replace(/\bMA\b\s*/gi, '').trim();
    const prefixes = [];
    if (isMa) prefixes.push('[MA]');
    if (prefixes.length) note = prefixes.join(' ') + (note ? ' ' + note : '');
    setLive(true, 'LIVE • CREATE INCIDENT');
    const r = await API.createQueuedIncident(TOKEN, dest, note, priority || '', '', incType, sceneAddress);
    if (!r.ok) return showErr(r);
    if (sceneAddress) { AddrHistory.push(sceneAddress); _geoVerifyAddress(sceneAddress); }
    beepChange();
    refresh();
    autoFocusCmd();
    return;
  }

  // ETA <UNIT> <MINUTES>
  const etaMatch = (mU + ' ' + nU).trim().match(/^ETA\s+(\S+)\s+(\d+)$/);
  if (etaMatch) {
    const etaUnitId = etaMatch[1].toUpperCase();
    const etaMins = etaMatch[2];
    setLive(true, 'LIVE • SET ETA');
    const r = await API.setUnitETA(TOKEN, etaUnitId, etaMins);
    if (!r.ok) return showErr(r);
    showToast('ETA ' + etaMins + 'M SET FOR ' + etaUnitId);
    refresh();
    return;
  }

  // PRIORITY <INC> <PRI-N>
  const priMatch = (mU + ' ' + nU).trim().match(/^PRIORITY\s+(\S+)\s+(PRI-[1-4])$/);
  if (priMatch) {
    let priIncId = priMatch[1].toUpperCase().replace(/^INC/i, '');
    if (/^\d{3}$/.test(priIncId)) priIncId = '0' + priIncId;
    const pri = priMatch[2].toUpperCase();
    setLive(true, 'LIVE • SET PRIORITY');
    const r = await API.setIncidentPriority(TOKEN, priIncId, pri);
    if (!r.ok) return showErr(r);
    showToast('PRIORITY UPDATED: ' + priIncId + ' → ' + pri);
    refresh();
    return;
  }

  // STATS - Live board summary
  if (mU === 'STATS') {
    const statsUnits = (STATE && STATE.units || []).filter(u => u.active);
    const statsIncidents = (STATE && STATE.incidents || []);
    const byStatus = {};
    ['AV','D','DE','OS','T','TH','OOS','BRK','IQ','UV','F','FD'].forEach(s => byStatus[s] = 0);
    statsUnits.forEach(u => { const s = (u.status||'').toUpperCase(); if (byStatus[s] !== undefined) byStatus[s]++; });
    const activeInc = statsIncidents.filter(i => i.status === 'ACTIVE');
    const queuedInc = statsIncidents.filter(i => i.status === 'QUEUED');
    const now = Date.now();
    let longestId = null, longestMins = 0;
    activeInc.forEach(i => {
      const m = Math.floor((now - new Date(_normalizeTs(i.created_at)).getTime()) / 60000);
      if (m > longestMins) { longestMins = m; longestId = i.incident_id; }
    });
    const fmtLong = (m) => m >= 60 ? Math.floor(m/60) + 'H ' + (m%60) + 'M' : m + 'M';
    const showIf = (label, count) => count > 0 ? (label + ' ' + count) : null;
    const lines = [
      'BOARD STATUS SUMMARY',
      '═'.repeat(36),
      'INCIDENTS — ACTIVE: ' + activeInc.length + '  QUEUED: ' + queuedInc.length,
      '═'.repeat(36),
      'AVAILABLE:    ' + String(byStatus['AV']).padStart(3),
      showIf('DISPATCHED:   ', byStatus['D']),
      showIf('EN ROUTE:     ', byStatus['DE']),
      'ON SCENE:     ' + String(byStatus['OS']).padStart(3),
      'TRANSPORT:    ' + String(byStatus['T']).padStart(3),
      showIf('AT HOSPITAL:  ', byStatus['TH']),
      showIf('IN QUARTERS:  ', byStatus['IQ']),
      'OOS:          ' + String(byStatus['OOS']).padStart(3),
      showIf('ON BREAK:     ', byStatus['BRK']),
      '═'.repeat(36),
      longestId ? 'LONGEST INC:  ' + String(longestId).replace(/^\d{2}-0*/,'') + ' (' + fmtLong(longestMins) + ')' : 'NO ACTIVE INCIDENTS',
      'TOTAL UNITS:  ' + statsUnits.length,
    ].filter(l => l !== null);
    showAlert('BOARD STATS', lines.join('\n'));
    return;
  }

  // SHIFT END <UNIT>
  const _shiftFull = (mU + ' ' + nU).trim();
  const shiftEndMatch = _shiftFull.match(/^SHIFT\s+END\s+(\S+)$/);
  if (shiftEndMatch) {
    const shiftEndUnit = shiftEndMatch[1].toUpperCase();
    const confirmed = await showConfirmAsync('SHIFT END: ' + shiftEndUnit + '?', 'Set AV, clear assignments, then deactivate ' + shiftEndUnit + '?');
    if (!confirmed) return;
    setLive(true, 'LIVE • SHIFT END');
    const r = await API.ridoffUnit(TOKEN, shiftEndUnit, '');
    if (!r.ok) { setLive(false); return showErr(r); }
    const r2 = await API.logoffUnit(TOKEN, shiftEndUnit, '');
    setLive(false);
    if (!r2.ok) { showToast('RIDOFF OK, LOGOFF FAILED: ' + r2.error); }
    else showToast('SHIFT END COMPLETE: ' + shiftEndUnit + ' DEACTIVATED');
    refresh();
    return;
  }

  // LINK - Link two units to incident
  if (mU.startsWith('LINK ')) {
    const ps = (ma + ' ' + no).trim().substring(5).trim().split(/\s+/);
    if (ps.length < 3) { showConfirm('ERROR', 'USAGE: LINK UNIT1 UNIT2 INC0001', () => { }); return; }
    const inc = ps[ps.length - 1].toUpperCase();
    const u2R = ps[ps.length - 2];
    const u1R = ps.slice(0, -2).join(' ');
    const u1 = canonicalUnit(u1R);
    const u2 = canonicalUnit(u2R);
    if (!u1 || !u2) { showConfirm('ERROR', 'USAGE: LINK UNIT1 UNIT2 INC0001', () => { }); return; }
    const r = await API.linkUnits(TOKEN, u1, u2, inc);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // TRANSFER
  if (mU.startsWith('TRANSFER ')) {
    const ps = (ma + ' ' + no).trim().substring(9).trim().split(/\s+/);
    if (ps.length < 3) { showConfirm('ERROR', 'USAGE: TRANSFER UNIT1 UNIT2 INC0001', () => { }); return; }
    const inc = ps[ps.length - 1].toUpperCase();
    const u2R = ps[ps.length - 2];
    const u1R = ps.slice(0, -2).join(' ');
    const u1 = canonicalUnit(u1R);
    const u2 = canonicalUnit(u2R);
    if (!u1 || !u2) { showConfirm('ERROR', 'USAGE: TRANSFER UNIT1 UNIT2 INC0001', () => { }); return; }
    const r = await API.transferIncident(TOKEN, u1, u2, inc);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // DEL / CAN / CLOSE incident — flexible syntax
  // Accepts: DEL 023, CAN 0023, 023 DEL, DEL INC 0023, CLOSE 0023, etc.
  {
    const _delFull = (mU + ' ' + nU).trim();
    const delCanMatch = _delFull.match(/^(?:DEL|CAN)\s+(?:INC\s*)?(\d{3,4})$/) ||
                        _delFull.match(/^(\d{3,4})\s+(?:DEL|CAN)$/) ||
                        _delFull.match(/^(?:DEL|CAN)(\d{3,4})$/) ||
                        _delFull.match(/^(\d{3,4})(?:DEL|CAN)$/);
    if (delCanMatch) {
      let incNum = delCanMatch[1];
      if (incNum.length === 3) incNum = '0' + incNum;
      const yy = String(new Date().getFullYear()).slice(-2);
      const fullInc = yy + '-' + incNum;
      setLive(true, 'LIVE • CLOSE INCIDENT');
      try {
        const r = await API.closeIncident(TOKEN, fullInc);
        if (!r.ok) { showAlert('ERROR', r.error || 'FAILED TO CLOSE INCIDENT ' + fullInc); return; }
        refresh();
      } catch (e) {
        showAlert('ERROR', 'FAILED: ' + e.message);
      }
      return;
    }
  }

  // CLOSE incident
  if (mU.startsWith('CLOSE ')) {
    const inc = ma.substring(6).trim().toUpperCase();
    if (!inc) { showConfirm('ERROR', 'USAGE: CLOSE 0001 OR DEL 023 OR CAN 023', () => { }); return; }
    const r = await API.closeIncident(TOKEN, inc);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

      if (mU === 'BOARDS' || mU === 'BOARD') {
        openPopouts();
        return;
      }

  // REL - Link HOSCAD incident to PulsePoint incident (or HOSCAD-to-HOSCAD)
  if (mU.startsWith('REL ') || mU === 'REL') {
    const parts = (mU + ' ' + nU).trim().split(/\s+/);
    let relIncId = (parts[1] || '').toUpperCase();
    const relTarget = (parts[2] || '').toUpperCase().replace(/^PP:/i, function(m) { return m; });
    const relFlag = (parts[3] || '').toUpperCase();
    if (!relIncId || !relTarget) { showAlert('ERROR', 'USAGE: REL <INC#> <INC#|PP_ID> [CLR]  — LINK INCIDENTS OR LINK TO PULSEPOINT ID'); return; }
    // Normalize incident IDs: add year prefix if missing (e.g. 0023 → 26-0023)
    if (/^\d+$/.test(relIncId)) relIncId = (new Date().getFullYear() % 100) + '-' + relIncId;
    if (relIncId.startsWith('INC')) relIncId = relIncId.replace(/^INC/i, '');
    // Detect HOSCAD-to-HOSCAD link: target starts with INC or looks like a year-seq id
    const isHoscadLink = /^INC\d+/i.test(relTarget) || /^\d{2}-\d+$/.test(relTarget) || /^\d{4,}$/.test(relTarget);
    if (isHoscadLink) {
      let normTarget = relTarget;
      if (/^\d+$/.test(normTarget)) normTarget = (new Date().getFullYear() % 100) + '-' + normTarget;
      if (normTarget.startsWith('INC')) normTarget = normTarget.replace(/^INC/i, '');
      const unlink = relFlag === 'CLR' || relFlag === 'CLEAR';
      const relRes = await API.linkIncidents(TOKEN, relIncId, normTarget, unlink ? 'UNLINK' : '');
      if (!relRes.ok) { showAlert('ERROR', relRes.error || 'ERROR.'); return; }
      showToast(unlink ? 'INC LINK REMOVED: ' + relIncId + ' ↔ ' + normTarget : 'INC LINKED: ' + relIncId + ' ↔ ' + normTarget, 'success');
    } else {
      // PP link
      let relPpId = relTarget.replace(/^PP:/i, '');
      if (relPpId === 'CLR' || relPpId === 'CLEAR') relPpId = '';
      const relRes = await API.relateIncident(TOKEN, relIncId, relPpId);
      if (!relRes.ok) { showAlert('ERROR', relRes.error || 'ERROR.'); return; }
      showToast(relPpId ? 'PP LINK SAVED: ' + relIncId + ' → PP:' + relPpId : 'PP LINK CLEARED: ' + relIncId, 'success');
    }
    refresh();
    return;
  }

  // RQ - Requeue incident (back to QUEUED, clears unit assignment)
  if (mU.startsWith('RQ ')) {
    const inc = ma.substring(3).trim().toUpperCase();
    if (!inc) { showConfirm('ERROR', 'USAGE: RQ INC0001', () => { }); return; }
    showConfirm('REQUEUE INCIDENT', `REQUEUE INC ${inc}?\n\nThis clears the current unit assignment and sets the incident back to QUEUED for reassignment.`, async () => {
      const r = await API.requeueIncident(TOKEN, inc);
      if (!r.ok) return showErr(r);
      beepChange();
      refresh();
    });
    return;
  }

  // RO - Reopen incident (CLOSED → ACTIVE, keeps existing units)
  if (mU.startsWith('RO ')) {
    const inc = ma.substring(3).trim().toUpperCase();
    if (!inc) { showConfirm('ERROR', 'USAGE: RO INC0001', () => { }); return; }
    const r = await API.reopenIncident(TOKEN, inc);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // MASS D - Mass dispatch
  if (mU.startsWith('MASS D ') || (mU === 'MASS D' && nU)) {
    const massRaw = (ma.substring(7).trim() + (nU ? ' ' + nU : '')).trim().toUpperCase();
    const massParts = massRaw.split(/\s+/);
    const massHasConfirm = massParts[massParts.length - 1] === 'CONFIRM';
    const de = massHasConfirm ? massParts.slice(0, -1).join(' ') : massRaw;
    if (!de) { showConfirm('ERROR', 'USAGE: MASS D <DESTINATION> CONFIRM', () => { }); return; }
    if (!massHasConfirm) {
      showErr({ error: 'CONFIRMATION REQUIRED. RE-RUN WITH CONFIRM. EXAMPLE: MASS D ' + de + ' CONFIRM' });
      return;
    }
    showConfirm('CONFIRM MASS DISPATCH', 'MASS DISPATCH ALL AV UNITS TO ' + de + '?', async () => {
      const r = await API.massDispatch(TOKEN, de);
      if (!r.ok) return showErr(r);
      const ct = (r.updated || []).length;
      showConfirm('MASS DISPATCH COMPLETE', 'MASS DISPATCH: ' + ct + ' UNITS DISPATCHED TO ' + de + '\n\n' + (r.updated || []).join(', '), () => { });
      beepChange();
      refresh();
    });
    return;
  }

  // UH - Unit history
  if (mU.startsWith('UH ')) {
    const ps = (ma + ' ' + no).trim().split(/\s+/);
    let hr = 12;
    const la = ps[ps.length - 1];
    if (/^\d+$/.test(la)) { hr = Number(la); ps.pop(); }
    const uR = ps.slice(1).join(' ').trim();
    const u = canonicalUnit(uR);
    if (!u) { showConfirm('ERROR', 'USAGE: UH <UNIT> [12|24|48|168]', () => { }); return; }
    return openHistory(u, hr);
  }

  // Alternate UH syntax: EMS1 UH 12
  {
    const ps = (ma + ' ' + no).trim().split(/\s+/).filter(Boolean);
    if (ps.length >= 2 && ps[1].toUpperCase() === 'UH') {
      let hr = 12;
      const la = ps[ps.length - 1];
      const hH = /^\d+$/.test(la);
      if (hH) hr = Number(la);
      const en = hH ? ps.length - 1 : ps.length;
      const uR = ps.slice(0, en).filter((x, i) => i !== 1).join(' ');
      const u = canonicalUnit(uR);
      if (!u) { showConfirm('ERROR', 'USAGE: <UNIT> UH [12|24|48|168]', () => { }); return; }
      return openHistory(u, hr);
    }
  }

  // UNDO
  if (mU.startsWith('UNDO ')) {
    const u = canonicalUnit(ma.substring(5).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: UNDO <UNIT>', () => { }); return; }
    return undoUnit(u);
  }

  // L / LOGON — logon unit
  if (mU.startsWith('L ') || mU.startsWith('LOGON ')) {
    const u = canonicalUnit(ma.substring(mU.startsWith('L ') ? 2 : 6).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: LOGON <UNIT> <NOTE>', () => { }); return; }
    // Check everSeen — same barrier as the modal
    setLive(true, 'LIVE • CHECK UNIT');
    const info = await API.getUnitInfo(TOKEN, u);
    if (info.ok && !info.everSeen) {
      const similar = findSimilarUnits(u);
      let msg = '"' + u + '" HAS NEVER BEEN LOGGED ON BEFORE.\nIS THIS A NEW UNIT, OR A TYPO / DUPLICATE?';
      if (similar.length) msg += '\n\nSIMILAR KNOWN UNITS: ' + similar.join(', ');
      // Show dialog: [BACK] cancels, [LOG ON NEW UNIT] opens modal pre-filled
      const choice = await showNewUnitDialog(u, msg, nU);
      autoFocusCmd();
      if (choice === 'logon') {
        const dN = displayNameForUnit(u);
        const fakeUnit = {
          unit_id: u, display_name: dN, type: '', active: true, status: 'AV',
          note: nU || '', unit_info: '', incident: '', destination: '',
          updated_at: '', updated_by: ''
        };
        openModal(fakeUnit);
      }
      return;
    }
    // Roster unit (first logon, or level back-filled from roster): open modal pre-filled so dispatcher can confirm
    if (info.ok && info.unit && (info.unit.updated_at === null || info.levelFromRoster)) {
      openModal(Object.assign({}, info.unit, { active: true, status: 'AV', note: nU || '' }));
      return;
    }
    const dN = displayNameForUnit(u);
    setLive(true, 'LIVE • LOGON');
    const r = await API.upsertUnit(TOKEN, u, { active: true, status: 'AV', note: nU, displayName: dN }, '');
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // LO <UNIT> / LOGOFF — logoff unit from board
  if (mU.startsWith('LO ') || mU.startsWith('LOGOFF ')) {
    const u = canonicalUnit(ma.substring(mU.startsWith('LO ') ? 3 : 7).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: LOGOFF <UNIT>', () => { }); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === u) : null;
    const currentStatus = uO ? uO.status : '';
    const needsConfirm = ['OS', 'T', 'D', 'DE'].includes(currentStatus);
    const doLogoff = async () => {
      setLive(true, 'LIVE • LOGOFF');
      const r = await API.logoffUnit(TOKEN, u, '');
      if (!r.ok) return showErr(r);
      beepChange();
      showToast('LOGGED OFF: ' + u);
      refresh();
    };
    if (needsConfirm) {
      showConfirm('CONFIRM LOGOFF', 'LOGOFF ' + u + ' (CURRENTLY ' + currentStatus + ')?', doLogoff);
    } else {
      await doLogoff();
    }
    return;
  }

  // RIDOFF
  if (mU.startsWith('RIDOFF ')) {
    const u = canonicalUnit(ma.substring(7).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: RIDOFF <UNIT>', () => { }); return; }
    showConfirm('CONFIRM RIDOFF', 'RIDOFF ' + u + '? (SETS AV + CLEARS NOTE/INC/DEST)', async () => {
      setLive(true, 'LIVE • RIDOFF');
      const r = await API.ridoffUnit(TOKEN, u, '');
      if (!r.ok) return showErr(r);
      beepChange();
      refresh();
    });
    return;
  }

  // DEST <UNIT>; <LOCATION> — set unit destination
  if (mU.startsWith('DEST ')) {
    const uRaw = ma.substring(5).trim();
    const u = canonicalUnit(uRaw);
    if (!u) { showAlert('ERROR', 'USAGE: DEST <UNIT> <LOCATION>\nDEST <UNIT> (CLEAR DESTINATION)'); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === u) : null;
    if (!uO) { showAlert('ERROR', 'UNIT NOT FOUND: ' + u); return; }
    let destVal = (nU || '').trim().toUpperCase();
    if (destVal) {
      // Parse bracket note: SCMC [BED 4] → base=SCMC, note=BED 4
      const { base: destBase, note: destNote } = AddressLookup._parseBracketNote(destVal);
      const lookupVal = destBase || destVal;
      // Try to resolve to a known address ID
      const byId = AddressLookup.getById(lookupVal);
      if (byId) {
        destVal = byId.id + (destNote ? ' [' + destNote + ']' : '');
      } else {
        const results = AddressLookup.search(lookupVal, 3);
        if (results.length === 1) destVal = results[0].id + (destNote ? ' [' + destNote + ']' : '');
        else if (destNote) destVal = lookupVal + ' [' + destNote + ']';
      }
    }
    setLive(true, 'LIVE • SET DEST');
    const r = await API.upsertUnit(TOKEN, u, { destination: destVal, displayName: uO.display_name }, uO.updated_at || '');
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // LOC <UNIT> <LOCATION> — set unit location for map + board
  if (mU === 'LOC') {
    if (!nU) { showAlert('ERROR', 'USAGE: LOC <UNIT> <ADDR>\nLOC <UNIT> CLR — clear location'); return; }
    const locRaw = nU.trim().toUpperCase();
    const spIdx = locRaw.indexOf(' ');
    const locUnit = canonicalUnit(spIdx > 0 ? locRaw.substring(0, spIdx) : locRaw);
    const locAddr = spIdx > 0 ? locRaw.substring(spIdx + 1).trim().toUpperCase() : '';
    if (!locUnit) { showAlert('ERROR', 'USAGE: LOC <UNIT> <ADDR>\nLOC <UNIT> CLR — clear location\nChain status: LOC M1 123 MAIN; AV M1'); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === locUnit) : null;
    if (!uO) { showAlert('ERROR', 'UNIT NOT FOUND: ' + locUnit); return; }

    // Resolve address shortcodes — parse bracket note first
    let resolvedAddr = locAddr;
    let locBracketNote = '';
    if (locAddr && locAddr !== 'CLR' && locAddr !== 'CLEAR') {
      const { base: locBase, note: locNote } = AddressLookup._parseBracketNote(locAddr);
      locBracketNote = locNote;
      const lookupAddr = locBase || locAddr;
      const byId = AddressLookup.getById(lookupAddr);
      if (byId) {
        resolvedAddr = byId.address ? (byId.address + (byId.city ? ', ' + byId.city : '')) : byId.name;
      } else {
        const results = AddressLookup.search(lookupAddr, 1);
        if (results.length === 1) resolvedAddr = results[0].address ? (results[0].address + (results[0].city ? ', ' + results[0].city : '')) : results[0].name;
        else resolvedAddr = lookupAddr;
      }
      // Append bracket note as parens inside LOC tag to avoid nested bracket issues
      if (locBracketNote) resolvedAddr += ' (' + locBracketNote + ')';
    }

    // Build note: strip old [LOC:...], add new
    let curNote = (uO.note || '').replace(/\s*\[LOC:[^\]]*\]\s*/g, '').trim();
    if (resolvedAddr && resolvedAddr !== 'CLR' && resolvedAddr !== 'CLEAR') {
      curNote = '[LOC:' + resolvedAddr + '] ' + curNote;
    }
    curNote = curNote.trim();

    const patch = { note: curNote, displayName: uO.display_name };

    setLive(true, 'LIVE • SET LOC');
    const r = await API.upsertUnit(TOKEN, locUnit, patch, uO.updated_at || '');
    if (!r.ok) return showErr(r);
    beepChange();
    if (resolvedAddr === 'CLR' || resolvedAddr === 'CLEAR') {
      showToast(locUnit + ': LOCATION CLEARED.');
    } else {
      showToast(locUnit + ': ' + resolvedAddr);
    }
    refresh();
    return;
  }

  // Messaging
  if (mU === 'MSGALL') {
    if (!nU) { showAlert('ERROR', 'USAGE: MSGALL MESSAGE TEXT'); return; }
    const r = await API.sendBroadcast(TOKEN, nU, false);
    if (!r.ok) return showErr(r);
    showAlert('MESSAGE SENT', `BROADCAST MESSAGE SENT TO ${r.recipients} RECIPIENTS`);
    beepChange();
    refresh();
    return;
  }

  if (mU === 'HTALL') {
    if (!nU) { showAlert('ERROR', 'USAGE: HTALL URGENT MESSAGE TEXT'); return; }
    const r = await API.sendBroadcast(TOKEN, nU, true);
    if (!r.ok) return showErr(r);
    showAlert('URGENT MESSAGE SENT', `URGENT BROADCAST SENT TO ${r.recipients} RECIPIENTS`);
    refresh();
    return;
  }

  if (mU === 'MSGDP' && nU) {
    setLive(true, 'LIVE • MSG DISPATCHERS');
    const r = await API.sendToDispatchers(TOKEN, nU, false);
    if (!r.ok) return showErr(r);
    showToast('MSG SENT TO ALL DISPATCHERS');
    setLive(false);
    refresh();
    return;
  }
  if (mU === 'HTDP' && nU) {
    setLive(true, 'LIVE • HTMSG DISPATCHERS');
    const r = await API.sendToDispatchers(TOKEN, nU, true);
    if (!r.ok) return showErr(r);
    showToast('URGENT MSG SENT TO ALL DISPATCHERS');
    setLive(false);
    refresh();
    return;
  }
  if (mU === 'MSGU' && nU) {
    setLive(true, 'LIVE • MSG ALL UNITS');
    const r = await API.sendToUnits(TOKEN, nU, false);
    if (!r.ok) return showErr(r);
    showToast('MSG SENT TO ALL FIELD UNITS');
    setLive(false);
    refresh();
    return;
  }
  if ((mU === 'HTU' || mU === 'HTMSU') && nU) {
    setLive(true, 'LIVE • HTMSG ALL UNITS');
    const r = await API.sendToUnits(TOKEN, nU, true);
    if (!r.ok) return showErr(r);
    showToast('URGENT MSG SENT TO ALL FIELD UNITS');
    setLive(false);
    refresh();
    return;
  }

  if (mU.startsWith('MSG ')) {
    const tR = ma.substring(4).trim().toUpperCase();
    if (!tR || !nU) { showAlert('ERROR', 'USAGE: MSG STA2 MESSAGE TEXT'); return; }
    const r = await API.sendMessage(TOKEN, tR, nU, false);
    if (!r.ok) return showErr(r);
    refresh();
    return;
  }

  if (mU.startsWith('HTMSG ')) {
    const tR = ma.substring(6).trim().toUpperCase();
    if (!tR || !nU) { showConfirm('ERROR', 'USAGE: HTMSG STA2 URGENT MESSAGE', () => { }); return; }
    const r = await API.sendMessage(TOKEN, tR, nU, true);
    if (!r.ok) return showErr(r);
    refresh();
    return;
  }

  if (/^MSG\d+$/i.test(mU)) {
    return viewMessage(mU);
  }

  if (mU.startsWith('PG ')) {
    const pgUnit = mU.substring(3).trim();
    if (!pgUnit) { showAlert('ERROR', 'USAGE: PG <UNIT>  (e.g. PG M1)'); return; }
    setLive(true, 'LIVE • PAGING ' + pgUnit);
    const r = await API.sendMessage(TOKEN, pgUnit, '[PAGE] RADIO PAGE FROM DISPATCH', true);
    setLive(false);
    if (!r.ok) return showErr(r);
    showToast('PAGE SENT TO ' + pgUnit);
    return;
  }

  // M <UNIT> <MESSAGE> — add note to unit's incident (no alert)
  if (cmd === 'M' && mU.startsWith('M ')) {
    const mTarget = canonicalUnit(mU.substring(2).trim());
    if (mTarget) {
      const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === mTarget) : null;
      if (uO && uO.incident) {
        if (!nU) { showAlert('ERROR', 'USAGE: M <UNIT> <MESSAGE>'); return; }
        setLive(true, 'LIVE \u2022 MSG');
        const r = await API.appendIncidentNote(TOKEN, uO.incident, nU);
        if (!r.ok) return showErr(r);
        beepChange();
        showToast('NOTE ADDED TO INC' + uO.incident.replace(/^\d{2}-/, ''));
        refresh();
        return;
      }
      if (uO && !uO.incident) { showAlert('ERROR', mTarget + ' IS NOT ASSIGNED TO AN INCIDENT.'); return; }
      if (!uO) { showAlert('ERROR', 'UNIT NOT FOUND: ' + mTarget); return; }
    }
  }

  if ((mU + ' ' + nU).trim().toUpperCase().startsWith('DEL ALL MSG')) {
    return deleteAllMessages();
  }

  if (mU.startsWith('DEL MSG') || (mU === 'DEL' && /^MSG/i.test(nU))) {
    const re = mU.startsWith('DEL MSG') ? mU.substring(7).trim() : nU.trim();
    if (!re) { showConfirm('ERROR', 'USAGE: DEL MSG1 OR DEL ALL MSG', () => { }); return; }
    const msgId = re.toUpperCase();
    if (/^MSG\d+$/i.test(msgId) || /^\d+$/.test(re)) {
      const finalId = /^\d+$/.test(re) ? 'MSG' + re : msgId;
      return deleteMessage(finalId);
    }
    showConfirm('ERROR', 'USAGE: DEL MSG1 OR DEL ALL MSG', () => { });
    return;
  }

  // Parse status + unit commands (D JC, JC OS, etc.)
  const tk = ma.trim().split(/\s+/).filter(Boolean);

  function parseStatusUnit(t) {
    if (t.length >= 2 && VALID_STATUSES.has(t[0].toUpperCase())) {
      return { status: t[0].toUpperCase(), unit: t.slice(1).join(' ') };
    }
    if (t.length >= 2 && VALID_STATUSES.has(t[t.length - 1].toUpperCase())) {
      return { status: t[t.length - 1].toUpperCase(), unit: t.slice(0, -1).join(' ') };
    }
    if (t.length === 2 && VALID_STATUSES.has(t[1].toUpperCase())) {
      return { status: t[1].toUpperCase(), unit: t[0] };
    }
    if (t.length === 3 && VALID_STATUSES.has(t[0].toUpperCase())) {
      return { status: t[0].toUpperCase(), unit: t.slice(1).join(' ') };
    }
    return null;
  }

  const pa = parseStatusUnit(tk);
  if (!pa) {
    showAlert('ERROR', 'UNKNOWN COMMAND. TYPE HELP FOR ALL COMMANDS.');
    return;
  }

  const stCmd = pa.status;
  let rawUnit = pa.unit;
  let incidentId = '';

  // OOS reason intercept for command-line OOS
  let oosNotePrefix = '';
  if (stCmd === 'OOS') {
    const oosUnit = canonicalUnit(rawUnit) || rawUnit;
    const reason = await promptOOSReason(oosUnit);
    if (!reason) return;
    oosNotePrefix = `[OOS:${reason}] `;
  }

  // Check for incident ID at end of unit (e.g. "D AMWC1 INC-0001")
  const incMatch = rawUnit.match(/\s+(INC\s*\d{2}-\d{4}|INC\s*\d{4}|\d{2}-\d{4}|\d{4})$/i);
  if (incMatch) {
    incidentId = incMatch[1].replace(/^INC\s*/i, '').trim().toUpperCase();
    if (/^\d{4}$/.test(incidentId)) {
      const year = new Date().getFullYear();
      const yy = String(year).slice(-2);
      incidentId = yy + '-' + incidentId;
    }
    rawUnit = rawUnit.substring(0, incMatch.index).trim();
  }

  // Also check if nU looks like an incident ID (e.g. "D AMWC1 INC-0001")
  let nuUsedAsIncident = false;
  const dispatchLikeStatuses = new Set(['D', 'DE', 'AT', 'TH']);
  if (!incidentId && dispatchLikeStatuses.has(stCmd) && nU) {
    const nuIncMatch = nU.trim().match(/^(INC[-\s]?\d{2}-\d{4}|INC[-\s]?\d{4}|\d{2}-\d{4}|\d{4})$/i);
    if (nuIncMatch) {
      incidentId = nuIncMatch[1].replace(/^INC[-\s]*/i, '').trim().toUpperCase();
      if (/^\d{4}$/.test(incidentId)) {
        const yy = String(new Date().getFullYear()).slice(-2);
        incidentId = yy + '-' + incidentId;
      }
      nuUsedAsIncident = true;
    }
  }

  // AV FORCE check
  let avForce = false;
  if (stCmd === 'AV') {
    const forceMatch = rawUnit.match(/^(.+?)\s+FORCE$/i);
    if (forceMatch) {
      avForce = true;
      rawUnit = forceMatch[1].trim();
    } else {
      // No FORCE — check if unit has active incident
      const avUnitId = canonicalUnit(rawUnit);
      const avUnitObj = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === avUnitId) : null;
      if (avUnitObj && avUnitObj.incident) {
        showErr({ error: 'UNIT HAS ACTIVE INCIDENT (' + avUnitObj.incident + '). USE: AV ' + rawUnit.toUpperCase() + ' FORCE' });
        return;
      }
    }
  }

  const u = canonicalUnit(rawUnit);
  const boardUnit = (STATE && STATE.units) ? STATE.units.find(function(x) { return String(x.unit_id || '').toUpperCase() === u; }) : null;
  if (!boardUnit) {
    showErr({ error: 'UNIT ' + u + ' NOT ON BOARD. USE LOGON ' + u + ' TO ACTIVATE FROM ROSTER.' });
    return;
  }
  const dN = displayNameForUnit(u);
  const p = { status: stCmd, displayName: dN };
  if (oosNotePrefix || (nU && !nuUsedAsIncident)) p.note = oosNotePrefix + nU;
  else if (avForce) p.note = '[AV-FORCE]';
  if (incidentId) {
    p.incident = incidentId;
    // Auto-copy incident destination to unit
    const incObj = (STATE.incidents || []).find(i => i.incident_id === incidentId);
    if (incObj && incObj.destination) {
      p.destination = incObj.destination;
    }
  }

  setLive(true, 'LIVE • UPDATE');
  const r = await API.upsertUnit(TOKEN, u, p, '');
  if (!r.ok) return showErr(r);

  beepChange();
  refresh();
  autoFocusCmd();
}

// ============================================================
// Command Hints Autocomplete
// ============================================================
function showCmdHints(query) {
  const el = document.getElementById('cmdHints');
  if (!el) return;
  if (!query || query.length < 1) { hideCmdHints(); return; }

  const q = query.toUpperCase();
  const matches = CMD_HINTS.filter(h => h.cmd.toUpperCase().includes(q)).slice(0, 5);

  if (!matches.length) { hideCmdHints(); return; }

  CMD_HINT_INDEX = -1;
  el.innerHTML = matches.map((h, i) =>
    '<div class="cmd-hint-item" data-index="' + i + '" onmousedown="selectCmdHint(' + i + ')">' +
    '<span class="hint-cmd">' + esc(h.cmd) + '</span>' +
    '<span class="hint-desc">' + esc(h.desc) + '</span>' +
    '</div>'
  ).join('');
  el.classList.add('open');
}

function hideCmdHints() {
  const el = document.getElementById('cmdHints');
  if (el) { el.classList.remove('open'); el.innerHTML = ''; }
  CMD_HINT_INDEX = -1;
}

function selectCmdHint(index) {
  const el = document.getElementById('cmdHints');
  if (!el) return;
  const items = el.querySelectorAll('.cmd-hint-item');
  if (index < 0 || index >= items.length) return;

  const cmdText = CMD_HINTS.filter(h => {
    const q = (document.getElementById('cmd').value || '').toUpperCase();
    return h.cmd.toUpperCase().startsWith(q);
  })[index];

  if (cmdText) {
    // Extract the fixed prefix of the command (before first <)
    const raw = cmdText.cmd;
    const angleBracket = raw.indexOf('<');
    const prefix = angleBracket > 0 ? raw.substring(0, angleBracket).trimEnd() + ' ' : raw;
    const cmdEl = document.getElementById('cmd');
    cmdEl.value = prefix;
    cmdEl.focus();
    cmdEl.setSelectionRange(prefix.length, prefix.length);
  }
  hideCmdHints();
}

function navigateCmdHints(dir) {
  const el = document.getElementById('cmdHints');
  if (!el || !el.classList.contains('open')) return false;
  const items = el.querySelectorAll('.cmd-hint-item');
  if (!items.length) return false;

  items.forEach(it => it.classList.remove('active'));
  CMD_HINT_INDEX += dir;
  if (CMD_HINT_INDEX < 0) CMD_HINT_INDEX = items.length - 1;
  if (CMD_HINT_INDEX >= items.length) CMD_HINT_INDEX = 0;
  items[CMD_HINT_INDEX].classList.add('active');
  return true;
}

function openShiftReportWindow(rpt) {
  const w = window.open('', '_blank');
  if (!w) { showAlert('BLOCKED', 'ALLOW POPUPS FOR SHIFT REPORT.'); return; }
  const av = rpt.metrics.averagesMinutes || {};
  let html = `<!DOCTYPE html><html><head><title>SHIFT REPORT</title>
  <style>body{font-family:monospace;background:#0d1117;color:#e6edf3;padding:24px}
  h2{color:#58a6ff}table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #30363d;padding:6px 10px;font-size:12px}
  th{background:#161b22;text-align:left}.good{color:#7fffb2}.warn{color:#ffd66b}.bad{color:#ff6b6b}
  </style></head><body>`;
  html += `<h2>SHIFT REPORT — ${rpt.windowHours}H WINDOW</h2>`;
  html += `<p style="font-size:11px;color:#8b949e">GENERATED ${new Date(rpt.generatedAt).toLocaleString('en-US',{hour12:false})} | INCIDENTS: ${rpt.incidentCount}</p>`;

  html += '<h3>RESPONSE TIMES</h3><table><tr><th>METRIC</th><th>AVG (MIN)</th><th>TARGET</th><th>STATUS</th></tr>';
  Object.keys(KPI_TARGETS).forEach(k => {
    const val = av[k];
    const tgt = KPI_TARGETS[k];
    const cls = val == null ? '' : val <= tgt ? 'good' : val <= tgt*1.5 ? 'warn' : 'bad';
    html += `<tr><td>${k}</td><td class="${cls}">${val ?? '—'}</td><td>${tgt}</td><td class="${cls}">${val == null ? '—' : val <= tgt ? 'OK' : 'OVER'}</td></tr>`;
  });
  html += '</table>';

  if (rpt.incidents.length) {
    html += '<h3>INCIDENTS</h3><table><tr><th>ID</th><th>TYPE</th><th>PRIORITY</th><th>SCENE</th><th>UNITS</th><th>STATUS</th></tr>';
    rpt.incidents.forEach(inc => {
      html += `<tr><td>${esc(inc.incident_id)}</td><td>${esc(inc.incident_type||'—')}</td><td>${esc(inc.priority||'—')}</td><td>${esc(inc.scene_address||'—')}</td><td>${esc(inc.units||'—')}</td><td>${esc(inc.status)}</td></tr>`;
    });
    html += '</table>';
  }

  if (rpt.unitSummaries.length) {
    html += '<h3>UNIT ACTIVITY</h3><table><tr><th>UNIT</th><th>DISPATCHES</th><th>D (MIN)</th><th>OS (MIN)</th><th>T (MIN)</th><th>OOS (MIN)</th></tr>';
    rpt.unitSummaries.forEach(u => {
      const ts = u.timeInStatus;
      html += `<tr><td>${esc(u.unit_id)}</td><td>${u.dispatches}</td><td>${ts['D']||0}</td><td>${ts['OS']||0}</td><td>${ts['T']||0}</td><td>${ts['OOS']||0}</td></tr>`;
    });
    html += '</table>';
  }

  html += '</body></html>';
  w.document.write(html);
  w.document.close();
}

function openIncidentPrintWindow(r) {
  const w = window.open('', '_blank');
  if (!w) { showAlert('BLOCKED', 'ALLOW POPUPS FOR INCIDENT REPORT.'); return; }
  const inc = r.incident;

  const fmt = (v) => v ? fmtTime24(v) : '—';
  const fmtMin = (a, b) => {
    if (!a || !b) return null;
    const m = Math.round((new Date(b) - new Date(a)) / 60000);
    return m > 0 ? m + ' min' : null;
  };
  let html = `<!DOCTYPE html><html><head><title>INCIDENT ${inc.incident_id}</title>
  <style>body{font-family:monospace;background:#0d1117;color:#e6edf3;padding:24px}
  h2{color:#58a6ff}h3{color:#79c0ff;margin-top:20px}table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #30363d;padding:6px 10px;font-size:12px}
  th{background:#161b22;text-align:left;width:160px}
  .audit{font-size:11px;color:#8b949e;margin-top:4px}
  .good{color:#7fffb2}.warn{color:#ffd66b}.bad{color:#ff6b6b}
  </style></head><body>`;
  html += `<h2>INCIDENT ${inc.incident_id}</h2>`;
  html += `<table>
    <tr><th>TYPE</th><td>${esc(inc.incident_type||'—')}</td></tr>
    <tr><th>PRIORITY</th><td>${esc(inc.priority||'—')}</td></tr>
    <tr><th>SCENE</th><td>${esc(inc.scene_address||'—')}</td></tr>
    <tr><th>DESTINATION</th><td>${esc(inc.destination||'—')}</td></tr>
    <tr><th>UNITS</th><td>${esc(inc.units||'—')}</td></tr>
    <tr><th>STATUS</th><td>${esc(inc.status)}</td></tr>
    <tr><th>CREATED</th><td>${fmt(inc.created_at)} by ${esc(inc.created_by||'?')}</td></tr>
    <tr><th>DISPATCH TIME</th><td>${fmt(inc.dispatch_time)}</td></tr>
    <tr><th>ENROUTE TIME</th><td>${fmt(inc.enroute_time)}</td></tr>
    <tr><th>ARRIVAL TIME</th><td>${fmt(inc.arrival_time)}</td></tr>
    <tr><th>TRANSPORT TIME</th><td>${fmt(inc.transport_time)}</td></tr>
    <tr><th>AT HOSPITAL TIME</th><td>${fmt(inc.at_hospital_time)}</td></tr>
    <tr><th>HANDOFF TIME</th><td>${fmt(inc.handoff_time)}</td></tr>
    <tr><th>NOTE</th><td>${esc(inc.incident_note||'—')}</td></tr>
  </table>`;
  // Response time calculations
  const rtRows = [
    { label: 'DISPATCH → ENROUTE', a: inc.dispatch_time,   b: inc.enroute_time,    target: KPI_TARGETS['D→DE']  || 5  },
    { label: 'ENROUTE → ON SCENE', a: inc.enroute_time,    b: inc.arrival_time,    target: KPI_TARGETS['DE→OS'] || 10 },
    { label: 'ON SCENE → TRANSPORT', a: inc.arrival_time,  b: inc.transport_time,  target: KPI_TARGETS['OS→T']  || 30 },
    { label: 'TRANSPORT → AT HOSP', a: inc.transport_time, b: inc.at_hospital_time, target: null },
    { label: 'AT HOSP → HANDOFF',  a: inc.at_hospital_time, b: inc.handoff_time,   target: KPI_TARGETS['T→AV']  || 20 },
  ];
  const rtAvail = rtRows.filter(r => r.a && r.b);
  if (rtAvail.length) {
    html += '<h3>RESPONSE TIMES</h3><table><tr><th>INTERVAL</th><th>ELAPSED</th><th>TARGET</th><th>STATUS</th></tr>';
    rtAvail.forEach(r => {
      const m = fmtMin(r.a, r.b);
      const mNum = m ? parseInt(m) : null;
      const cls = !r.target || mNum == null ? '' : mNum <= r.target ? 'good' : mNum <= r.target * 1.5 ? 'warn' : 'bad';
      const status = !r.target ? '—' : mNum == null ? '—' : mNum <= r.target ? 'OK' : 'OVER';
      html += `<tr><td>${esc(r.label)}</td><td class="${cls}">${m || '—'}</td><td>${r.target ? r.target + ' min' : '—'}</td><td class="${cls}">${status}</td></tr>`;
    });
    html += '</table>';
  }

  if (r.audit && r.audit.length) {
    html += '<h3>AUDIT TRAIL</h3>';
    r.audit.forEach(a => {
      html += `<div class="audit">[${fmt(a.ts)}] ${esc(a.actor)}: ${esc(a.message)}</div>`;
    });
  }

  html += '</body></html>';
  w.document.write(html);
  w.document.close();
}

function openUnitReportWindow(rpt) {
  const w = window.open('', '_blank');
  if (!w) { showAlert('BLOCKED', 'ALLOW POPUPS FOR UNIT REPORT.'); return; }
  const ts = rpt.timeInStatus || {};
  const STATUS_ORDER = ['D','OS','T','OOS','AV','BRK'];
  const fmtMin = (m) => {
    if (!m) return '0M';
    if (m < 60) return m + 'M';
    return Math.floor(m / 60) + 'H ' + (m % 60) + 'M';
  };

  let html = `<!DOCTYPE html><html><head><title>UNIT REPORT — ${rpt.unit_id}</title>
  <style>body{font-family:monospace;background:#0d1117;color:#e6edf3;padding:24px}
  h2{color:#58a6ff}h3{color:#79c0ff;margin-top:20px}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #30363d;padding:6px 10px;font-size:12px}
  th{background:#161b22;text-align:left}
  .good{color:#7fffb2}.warn{color:#ffd66b}.bad{color:#ff6b6b}
  .audit{font-size:11px;color:#8b949e;margin:2px 0}
  </style></head><body>`;

  html += `<h2>UNIT REPORT — ${rpt.unit_id}</h2>`;
  html += `<p style="font-size:11px;color:#8b949e">WINDOW: ${rpt.windowHours}H | ` +
          `${new Date(rpt.startIso).toLocaleString('en-US',{hour12:false})} → ${new Date(rpt.endIso).toLocaleString('en-US',{hour12:false})} | ` +
          `GENERATED ${new Date(rpt.generatedAt).toLocaleString('en-US',{hour12:false})}</p>`;

  // Status time breakdown
  html += '<h3>STATUS TIME BREAKDOWN</h3><table><tr><th>STATUS</th><th>TIME</th><th>MINUTES</th></tr>';
  const allKeys = [...new Set([...STATUS_ORDER, ...Object.keys(ts)])];
  let totalMin = 0;
  allKeys.forEach(k => { totalMin += ts[k] || 0; });
  allKeys.forEach(k => {
    if (!ts[k]) return;
    const pct = totalMin ? Math.round((ts[k] / totalMin) * 100) : 0;
    html += `<tr><td>${k}</td><td>${fmtMin(ts[k])} (${pct}%)</td><td>${ts[k]}</td></tr>`;
  });
  html += `<tr><td><strong>TOTAL</strong></td><td>${fmtMin(totalMin)}</td><td>${totalMin}</td></tr>`;
  html += '</table>';

  html += `<p style="font-size:12px">DISPATCHES: <strong>${rpt.dispatches}</strong> | AUDIT EVENTS: <strong>${rpt.eventCount}</strong></p>`;

  // Incidents served
  if (rpt.incidents && rpt.incidents.length) {
    html += `<h3>INCIDENTS SERVED (${rpt.incidents.length})</h3>`;
    html += '<table><tr><th>ID</th><th>TYPE</th><th>PRI</th><th>SCENE</th><th>DEST</th><th>DISPATCH</th><th>ARRIVAL</th><th>TRANSPORT</th><th>HANDOFF</th></tr>';
    rpt.incidents.forEach(inc => {
      const fmt = (v) => v ? (() => { try { return new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false}); } catch(e) { return v; } })() : '—';
      html += `<tr><td>${esc(inc.incident_id)}</td><td>${esc(inc.incident_type||'—')}</td><td>${esc(inc.priority||'—')}</td>` +
              `<td>${esc(inc.scene_address||'—')}</td><td>${esc(inc.destination||'—')}</td>` +
              `<td>${fmt(inc.dispatch_time)}</td><td>${fmt(inc.arrival_time)}</td>` +
              `<td>${fmt(inc.transport_time)}</td><td>${fmt(inc.handoff_time)}</td></tr>`;
    });
    html += '</table>';
  } else {
    html += '<p style="color:#8b949e;font-size:12px">NO INCIDENTS FOUND IN WINDOW.</p>';
  }

  // Audit trail
  if (rpt.events && rpt.events.length) {
    html += `<h3>AUDIT TRAIL</h3>`;
    rpt.events.forEach(e => {
      const t = (() => { try { return new Date(e.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); } catch(x) { return e.ts; } })();
      const dest = e.new_dest ? ` → ${e.new_dest}` : '';
      const inc  = e.new_incident ? ` INC:${e.new_incident}` : '';
      html += `<div class="audit">[${t}] ${esc(e.action)} ${esc(e.prev_status)}→${esc(e.new_status)}${esc(dest)}${esc(inc)} (by ${esc(e.actor)})</div>`;
    });
  }

  html += '</body></html>';
  w.document.write(html);
  w.document.close();
}

function showHelp() {
  window.open('help/', '_blank');
}
/* showHelpLegacy removed — dead code (HV-5) */
function _showHelpLegacy_REMOVED() {
  showAlert('HELP - COMMAND REFERENCE', `SCMC HOSCAD/EMS TRACKING - COMMAND REFERENCE

═══════════════════════════════════════════════════
VIEW / DISPLAY COMMANDS
═══════════════════════════════════════════════════
V SIDE                  Toggle sidebar panel
V MSG                   Toggle messages in sidebar
V INC                   Toggle incident queue
V ALL                   Show all panels
V NONE                  Hide all panels
F <STATUS>              Filter board by status
F ALL                   Clear status filter
SORT STATUS             Sort by status
SORT UNIT               Sort by unit ID
SORT ELAPSED            Sort by elapsed time
SORT UPDATED            Sort by last updated
SORT REV                Reverse sort direction
DEN                     Cycle density (compact/normal/expanded)
DEN COMPACT             Set compact density
DEN NORMAL              Set normal density
DEN EXPANDED            Set expanded density
PRESET DISPATCH         Dispatch view preset
PRESET SUPERVISOR       Supervisor view preset
PRESET FIELD            Field view preset
ELAPSED SHORT           Elapsed: 12M, 1H30M
ELAPSED LONG            Elapsed: 1:30:45
ELAPSED OFF             Hide elapsed time
NIGHT                   Toggle night mode (dim display)
CLR                     Clear all filters + search

═══════════════════════════════════════════════════
GENERAL COMMANDS
═══════════════════════════════════════════════════
H / HELP                Show this help
STATUS                  System status summary
REFRESH                 Reload board data
INFO                    Quick reference (key numbers)
INFO ALL                Full dispatch/emergency directory
INFO DISPATCH           911/PSAP centers
INFO AIR                Air ambulance dispatch
INFO OSP                Oregon State Police
INFO CRISIS             Mental health / crisis lines
INFO POISON             Poison control
INFO ROAD               Road conditions / ODOT
INFO LE                 Law enforcement direct lines
INFO JAIL               Jails
INFO FIRE               Fire department admin / BC
INFO ME                 Medical examiner
INFO OTHER              Other useful numbers
INFO <UNIT>             Detailed unit info from server
WHO                     Dispatchers currently online
UR                      Active unit roster
US                      Unit status report (all units)
LO                      Logout session and return to login
! <TEXT>                Search audit/incidents
ADDR                    Show full address directory
ADDR <QUERY>            Search addresses / facilities

═══════════════════════════════════════════════════
PANELS
═══════════════════════════════════════════════════
INBOX                   Open/show message inbox
NOTES / SCRATCH         Open/focus scratch notepad
  (Scratch notes save per-user to your browser)

═══════════════════════════════════════════════════
UNIT OPERATIONS
═══════════════════════════════════════════════════
<STATUS> <UNIT>; <NOTE>    Set unit status with note
<UNIT> <STATUS>; <NOTE>    Alternate syntax
<STATUS>                   Apply to selected row

STATUS CODES: D, DE, OS, F, FD, T, AV, UV, BRK, OOS
  D   = Pending Dispatch (flashing blue)
  DE  = Enroute
  OS  = On Scene
  F   = Follow Up
  FD  = Flagged Down
  T   = Transporting
  AV  = Available
  UV  = Unavailable
  BRK = Break/Lunch
  OOS = Out of Service

Examples:
  D JC; MADRAS ED
  D WC1 0023              Dispatch + assign incident
  EMS1 OS; ON SCENE
  F EMS2; FOLLOW UP NEEDED
  BRK WC1; LUNCH BREAK

DEST <UNIT>; <LOCATION> [NOTE]  Set unit location/destination
  DEST EMS1; SCB           → resolves to ST. CHARLES BEND
  DEST EMS1; SCB [BED 4]  → with room/note
  DEST EMS1; BEND ED      → freeform text
  DEST EMS1               → clears destination

L <UNIT>; <NOTE>        Logon unit (LOGON also works)
LO <UNIT>               Logoff unit (LOGOFF also works)
RIDOFF <UNIT>           Set AV + clear all fields
LUI                     Open logon modal (empty)
LUI <UNIT>              Open logon modal (pre-filled)
UI <UNIT>               Open unit info modal
UNDO <UNIT>             Undo last action

═══════════════════════════════════════════════════
UNIT TIMING (STALE DETECTION)
═══════════════════════════════════════════════════
OK <UNIT>               Touch timer (reset staleness)
OKALL                   Touch all OS units

═══════════════════════════════════════════════════
INCIDENT MANAGEMENT
═══════════════════════════════════════════════════
NC <LOCATION>; <NOTE>; <TYPE>; <PRIORITY>  Create new incident
  Example: NC BEND ED; CHEST PAIN; MED; PRI-2
  Note, type, and priority are optional: NC BEND ED

DE <UNIT> <INC>         Assign queued incident to unit
  Example: DE EMS1 0023

R <INC>                 Review incident + history
  R 0001 (auto-year) or R INC26-0001

U <INC>; <MESSAGE>      Add note to incident
  U 0001; PT IN WTG RM

OK INC<ID>              Touch incident timestamp
LINK <U1> <U2> <INC>    Assign both units to incident
TRANSFER <FROM> <TO> <INC>   Transfer incident
CLOSE <INC>             Manually close incident
DEL/CAN <INC>           Close incident (flexible)
  DEL 023, CAN 0023, 023 DEL, DEL INC 0023
  023CAN, CAN023 — all work (3 or 4 digits)
RQ <INC>                Reopen incident

═══════════════════════════════════════════════════
UNIT HISTORY
═══════════════════════════════════════════════════
UH <UNIT> [HOURS]       View unit history
  UH EMS1 24
<UNIT> UH [HOURS]       Alternate syntax
  EMS1 UH 12

═══════════════════════════════════════════════════
REPORTS
═══════════════════════════════════════════════════
REPORTOOS               OOS report (default 24H)
REPORTOOS24H            OOS report for 24 hours
REPORTOOS7D             OOS report for 7 days
REPORTOOS30D            OOS report for 30 days

REPORT SHIFT [H]        Printable shift summary (default 12H)
REPORT INC <ID>         Printable per-incident report
REPORTUTIL <UNIT> [H]   Per-unit utilization report (default 24H)
SUGGEST <INC>           Recommend available units for incident

═══════════════════════════════════════════════════
INCIDENT CREATION (EXTENDED)
═══════════════════════════════════════════════════
NC <DEST>; <NOTE>; <TYPE>; <PRIORITY>; @<SCENE ADDR>
  TYPE format: CAT-NATURE-DET (e.g. MED-CARDIAC-CHARLIE)
  Add "MA" anywhere in NOTE to flag as mutual aid
  Use [CB:PHONE] in NOTE for callback number (e.g. [CB:5415550123])
  PRIORITY = PRI-1 / PRI-2 / PRI-3 / PRI-4
  SCENE ADDR: 5th segment, prefix with @ (e.g. @1234 MAIN ST, BEND)

  Examples:
    NC ST CHARLES; MA 67 YOF CARDIAC [CB:5415550123]; MED-CARDIAC-CHARLIE; PRI-1; @5TH FLOOR TOWER B
    NC BEND RURAL; MVC WITH ENTRAPMENT; TRAUMA-MVA-DELTA; PRI-2
    NC SCMC; IFT CARDIAC; IFT-ALS-CARDIAC; PRI-2; @789 SW CANAL BLVD

═══════════════════════════════════════════════════
MASS OPERATIONS
═══════════════════════════════════════════════════
MASS D <DEST>           Dispatch all AV units
  MASS D MADRAS ED

═══════════════════════════════════════════════════
BANNERS
═══════════════════════════════════════════════════
NOTE; <MESSAGE>         Set info banner
NOTE; CLEAR             Clear banner
ALERT; <MESSAGE>        Set alert banner (alert tone)
ALERT; CLEAR            Clear alert

═══════════════════════════════════════════════════
MESSAGING SYSTEM
═══════════════════════════════════════════════════
MSG <ROLE/UNIT>; <TEXT> Send normal message
  MSG STA2; NEED COVERAGE AT 1400
  MSG EMS12; CALL ME

HTMSG <ROLE/UNIT>; <TEXT> Send URGENT message (hot)
  HTMSG SUPV1; CALLBACK ASAP

MSGALL; <TEXT>          Broadcast to all active stations
  MSGALL; RADIO CHECK AT 1400

HTALL; <TEXT>           Urgent broadcast to all
  HTALL; SEVERE WEATHER WARNING

PG <UNIT>               Radio page unit (plays fire/EMS tone on field device)
  PG M1
MSGDP; <TEXT>           Message all dispatchers only
HTDP; <TEXT>            URGENT message all dispatchers
MSGU; <TEXT>            Message all active field units
HTU; <TEXT>             URGENT message all field units

ROLES: STA1-6, SUPV1-2, MGR1-2, EMS, TCRN, PLRN, IT

DEL ALL MSG             Delete all your messages

═══════════════════════════════════════════════════
USER MANAGEMENT
═══════════════════════════════════════════════════
NEWUSER lastname,firstname   Create new user
  NEWUSER smith,john → creates username smithj
  (Default password: 12345)

DELUSER <username>      Delete user
  DELUSER smithj

LISTUSERS               Show all system users
PASSWD <old> <new>      Change your password
  PASSWD 12345 myNewPass

═══════════════════════════════════════════════════
SESSION MANAGEMENT
═══════════════════════════════════════════════════
WHO                     Show logged-in users
LO                      Logout current session
ADMIN                   Admin commands (SUPV/MGR/IT only)

═══════════════════════════════════════════════════
INTERACTION
═══════════════════════════════════════════════════
CLICK ROW               Select unit (yellow outline)
DBLCLICK ROW            Open edit modal
TYPE STATUS CODE        Apply to selected unit
  (e.g. select EMS1, type OS → sets OS)

═══════════════════════════════════════════════════
KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════
CTRL+K / F1 / F3        Focus command bar
CTRL+L                  Open logon modal
CTRL+D                  Cycle density mode
UP/DOWN ARROWS          Command history
ENTER                   Run command
F2                      New incident
F4                      Open messages
ESC                     Close dialogs`);
}

function showAdmin() {
  if (!isAdminRole()) {
    showAlert('ACCESS DENIED', 'ADMIN COMMANDS REQUIRE SUPV, MGR, OR IT LOGIN.');
    return;
  }
  showAlert('ADMIN COMMANDS', `SCMC HOSCAD - ADMIN COMMANDS
ACCESS: SUPV1, SUPV2, MGR1, MGR2, IT

═══════════════════════════════════════════════════
DATA MANAGEMENT
═══════════════════════════════════════════════════
PURGE                   Clean old data (>7 days) + install auto-purge
CLEARDATA UNITS         Clear ALL units from board
CLEARDATA INACTIVE      Clear only inactive/logged-off units
CLEARDATA AUDIT         Clear unit audit history
CLEARDATA INCIDENTS     Clear all incidents
CLEARDATA MESSAGES      Clear all messages
CLEARDATA SESSIONS      Log out all users (force re-login)
CLEARDATA ALL           Clear all data

═══════════════════════════════════════════════════
USER MANAGEMENT
═══════════════════════════════════════════════════
NEWUSER lastname,firstname   Create new user
  (Default password: 12345)
DELUSER <username>      Delete user
LISTUSERS               Show all system users

═══════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════
• PURGE automatically runs daily once triggered
• CLEARDATA operations cannot be undone
• CLEARDATA SESSIONS will log you out too`);
}

// ============================================================
// Popout / Secondary Monitor
// ============================================================
// ── CAD Popout Windows (auto-opened on login) ─────────────────────────────
function openPopouts() {
  // Board (viewer)
  if (!_popoutBoardWindow || _popoutBoardWindow.closed) {
    _popoutBoardWindow = window.open('/hoscad/viewer/', 'hoscad-board',
      'width=1280,height=800,left=0,top=0');
    if (_popoutBoardWindow) {
      monitorPopout(_popoutBoardWindow, 'board');
      // Explicit token relay (same belt-and-suspenders pattern as incident queue)
      function _relayTokenToBoard() {
        if (_popoutBoardWindow && !_popoutBoardWindow.closed && TOKEN) {
          _popoutBoardWindow.postMessage({ type: 'HOSCAD_RELAY_TOKEN', token: TOKEN }, window.location.origin);
        }
      }
      _popoutBoardWindow.addEventListener('load', _relayTokenToBoard);
      window.addEventListener('message', function _relayBoardHandler(e) {
        if (e.origin !== window.location.origin) return;
        if (e.data && e.data.type === 'HOSCAD_REQUEST_RELAY_TOKEN') {
          window.removeEventListener('message', _relayBoardHandler);
          _relayTokenToBoard();
        }
      });
    }
  } else {
    try { _popoutBoardWindow.focus(); } catch(e){}
  }
  // Incident queue
  if (!_popoutIncWindow || _popoutIncWindow.closed) {
    _popoutIncWindow = window.open('/hoscad/popout-inc/', 'hoscad-inc',
      'width=480,height=950,left=0,top=0');
    if (_popoutIncWindow) {
      monitorPopout(_popoutIncWindow, 'inc');
      // Explicit token relay (same belt-and-suspenders pattern as viewer)
      function _relayTokenToInc() {
        if (_popoutIncWindow && !_popoutIncWindow.closed && TOKEN) {
          _popoutIncWindow.postMessage({ type: 'HOSCAD_RELAY_TOKEN', token: TOKEN }, window.location.origin);
        }
      }
      _popoutIncWindow.addEventListener('load', _relayTokenToInc);
      // Also relay on request (in case load fires before listener is attached)
      window.addEventListener('message', function _relayIncHandler(e) {
        if (e.origin !== window.location.origin) return;
        if (e.data && e.data.type === 'HOSCAD_REQUEST_RELAY_TOKEN') {
          window.removeEventListener('message', _relayIncHandler);
          _relayTokenToInc();
        }
      });
    }
  } else {
    try { _popoutIncWindow.focus(); } catch(e){}
  }
  if (!_popoutBoardWindow && !_popoutIncWindow) {
    showToast('POPUPS BLOCKED — TYPE BOARDS TO RETRY. ALLOW POPUPS FOR THIS SITE.', 'warn');
  } else {
    showToast('BOARDS OPENED.');
  }
}

function openPopoutInc() {
  if (_popoutIncWindow && !_popoutIncWindow.closed) {
    _popoutIncWindow.focus();
    showToast('INCIDENT QUEUE ALREADY OPEN.');
    return;
  }
  _popoutIncWindow = window.open('/hoscad/popout-inc/', 'hoscad-inc',
    'width=480,height=950,left=0,top=0');
  if (!_popoutIncWindow) {
    showToast('POPUP BLOCKED — ALLOW POPUPS FOR THIS SITE.', 'warn');
    return;
  }
  monitorPopout(_popoutIncWindow, 'inc');
  function _relayTokenToInc() {
    if (_popoutIncWindow && !_popoutIncWindow.closed && TOKEN) {
      _popoutIncWindow.postMessage({ type: 'HOSCAD_RELAY_TOKEN', token: TOKEN }, window.location.origin);
    }
  }
  _popoutIncWindow.addEventListener('load', _relayTokenToInc);
  window.addEventListener('message', function _relayIncHandler(e) {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'HOSCAD_REQUEST_RELAY_TOKEN') {
      window.removeEventListener('message', _relayIncHandler);
      _relayTokenToInc();
    }
  });
  showToast('INCIDENT QUEUE OPENED.');
}

function monitorPopout(win, name) {
  const check = setInterval(function() {
    if (win.closed) {
      clearInterval(check);
      if (name === 'board') _popoutBoardWindow = null;
      if (name === 'inc')   _popoutIncWindow   = null;
    }
  }, 3000);
}

function openPopout() {
  if (_popoutBoardWindow && !_popoutBoardWindow.closed) {
    _popoutBoardWindow.focus();
    showToast('BOARD ALREADY ON SECONDARY MONITOR.');
    return;
  }
  _popoutBoardWindow = window.open('/hoscad/viewer/', 'hoscad-board', 'width=1280,height=800');
  if (!_popoutBoardWindow) {
    showErr({ error: 'POPUP BLOCKED. ALLOW POPUPS FOR THIS SITE.' });
    return;
  }
  monitorPopout(_popoutBoardWindow, 'board');
  // Relay token to viewer
  function _relayTokenToViewer() {
    if (_popoutBoardWindow && !_popoutBoardWindow.closed && TOKEN) {
      _popoutBoardWindow.postMessage({ type: 'HOSCAD_RELAY_TOKEN', token: TOKEN }, window.location.origin);
    }
  }
  _popoutBoardWindow.addEventListener('load', _relayTokenToViewer);
  // Show placeholder on main board
  const boardEl = document.getElementById('boardMain');
  const popoutPlaceholder = document.getElementById('popoutPlaceholder');
  if (boardEl) boardEl.style.display = 'none';
  if (popoutPlaceholder) popoutPlaceholder.style.display = 'flex';
  showToast('BOARD OPENED ON SECONDARY MONITOR.');
  // Poll for window close to auto-restore
  const closeCheck = setInterval(function() {
    if (_popoutBoardWindow && _popoutBoardWindow.closed) {
      clearInterval(closeCheck);
      closePopin();
    }
  }, 2000);
}

function closePopin() {
  if (_popoutBoardWindow && !_popoutBoardWindow.closed) _popoutBoardWindow.close();
  _popoutBoardWindow = null;
  const boardEl = document.getElementById('boardMain');
  const popoutPlaceholder = document.getElementById('popoutPlaceholder');
  if (boardEl) boardEl.style.display = '';
  if (popoutPlaceholder) popoutPlaceholder.style.display = 'none';
  showToast('BOARD RESTORED.');
}

function updatePopoutClock() {
  const el = document.getElementById('popoutClock');
  if (!el) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  el.textContent = hh + ':' + mm;
  const dateEl = document.getElementById('popoutDate');
  if (dateEl) {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    dateEl.textContent = days[now.getDay()] + ', ' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
  }
}

function updatePopoutStats() {
  const el = document.getElementById('popoutStats');
  if (!el || !STATE) return;
  const activeUnits = (STATE.units || []).filter(u => u.active).length;
  const queued = (STATE.incidents || []).filter(i => i.status === 'QUEUED').length;
  el.textContent = activeUnits + ' UNITS ACTIVE  ·  ' + queued + ' QUEUED';
}

// ════════════════════════════════════════════════════════════════════════════
// ── PulsePoint Mutual Aid Feed ───────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

function startPpPolling() {
  if (_ppTimer) return;
  fetchPpFeed();  // immediate first fetch
  _ppTimer = setInterval(fetchPpFeed, PP_POLL_INTERVAL);
}

function stopPpPolling() {
  if (_ppTimer) { clearInterval(_ppTimer); _ppTimer = null; }
}

async function fetchPpFeed() {
  if (_ppSyncing || !TOKEN) return;
  if (localStorage.getItem('hoscad_pp_enabled') === 'false') return;
  _ppSyncing = true;
  try {
    const res = await fetch(PP_DATA_URL + '?t=' + Date.now());
    if (!res.ok) return;
    const data = await res.json();
    await applyPpFeed(data);
    _ppLastSync = new Date();
    updatePpSyncBadge();
  } catch (e) {
    console.warn('[PP] fetchPpFeed error:', e);
  } finally {
    _ppSyncing = false;
  }
}

async function applyPpFeed(data) {
  const activeIncidents  = data.active_incidents  || [];
  const recentIncidents  = data.recent_incidents  || [];
  const ppAgencyIds = new Set(Object.keys(PP_AGENCIES));

  // ── Phase 1: active incidents → current status ────────────────────────────
  const unitMap      = {};  // unit_id → best PP record
  const activeUnitIds = new Set();  // only units currently on a call

  const RANK = { D:1, DE:2, OS:3, T:4, TH:5, AV:6, OOS:7 };

  for (const inc of activeIncidents) {
    if (!ppAgencyIds.has(inc.agency_id)) continue;
    for (const u of (inc.units || [])) {
      const uid = String(u.unit_id || '').trim().toUpperCase();
      if (!uid) continue;
      // Skip bare place-name unit IDs (all letters, no digits, > 5 chars) — these are mutual aid location markers, not units
      if (/^[A-Z]{6,}$/.test(uid)) continue;
      const hStatus = ppStatusToHoscad(u.status_code);
      const existing = unitMap[uid];
      if (!existing || (RANK[hStatus] || 9) < (RANK[existing.status] || 9)) {
        unitMap[uid] = { unit_id: uid, agency_id: inc.agency_id, status: hStatus,
                         display_name: uid, incident_id: inc.incident_id,
                         address: inc.address || null,
                         call_type: inc.call_type_description || inc.call_type || null };
      }
      activeUnitIds.add(uid);
    }
  }

  // ── Phase 2: recent (cleared) incidents → populate roster as AV ──────────
  // Ensures units we missed while active still appear on the board.
  for (const inc of recentIncidents) {
    if (!ppAgencyIds.has(inc.agency_id)) continue;
    for (const u of (inc.units || [])) {
      const uid = String(u.unit_id || '').trim().toUpperCase();
      if (!uid || unitMap[uid]) continue;  // active takes priority
      // Skip bare place-name unit IDs (all letters, no digits, > 5 chars) — these are mutual aid location markers, not units
      if (/^[A-Z]{6,}$/.test(uid)) continue;
      unitMap[uid] = { unit_id: uid, agency_id: inc.agency_id, status: 'AV',
                       display_name: uid, incident_id: null };
    }
  }

  const ppUnits = Object.values(unitMap);
  _ppActiveCount = activeUnitIds.size;  // count only truly active units

  // Batch upsert to backend (fire-and-forget, don't block board)
  try {
    await API.upsertPpUnits(TOKEN, ppUnits, [...activeUnitIds]);
    // Trigger a board refresh so new PP units appear immediately
    refresh();
  } catch (e) { console.warn('[PP] upsertPpUnits error:', e); }
}

function updatePpSyncBadge() {
  const el = document.getElementById('ppSyncBadge');
  if (!el) return;
  if (!_ppLastSync) { el.textContent = 'PP: --'; el.style.opacity = '.4'; el.style.color = 'var(--muted)'; return; }
  const mins = Math.floor((Date.now() - _ppLastSync.getTime()) / 60000);
  const age = mins === 0 ? 'NOW' : mins + 'M';
  const cnt = _ppActiveCount > 0 ? ' (' + _ppActiveCount + ' UNIT' + (_ppActiveCount !== 1 ? 'S' : '') + ')' : '';
  el.textContent = 'PP: ' + age + cnt;
  el.style.opacity = mins > 10 ? '.4' : '1';
  el.style.color   = _ppActiveCount > 0 ? '#52c41a' : (mins > 10 ? 'var(--muted)' : '#4fa3e0');
}

// ════════════════════════════════════════════════════════════════════════════
// ── Board Map (inline panel + POPMAP popout) ──────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// Per-unit home base coords keyed by unit_id — used for map positioning (priority 3)
const BM_UNIT_HOME = {
  // La Pine Fire
  'M171': [43.6679, -121.5036], 'M172': [43.8208, -121.4421], 'C171': [43.6679, -121.5036],
  // Sunriver Fire
  'M271': [43.8758, -121.4363], 'C271': [43.8758, -121.4363],
  // Bend Fire
  'M371': [44.0489, -121.3153], 'M372': [44.0550, -121.2679], 'C371': [44.0618, -121.2995],
  // Redmond Fire
  'M471': [44.2783, -121.1785], 'M472': [44.2590, -121.1617], 'C471': [44.2783, -121.1785],
  // Crook County Fire
  'M571': [44.3050, -120.7271], 'M572': [44.3050, -120.7271], 'C571': [44.3050, -120.7271],
  // Cloverdale
  'M671': [44.2225, -121.4090], 'C671': [44.2225, -121.4090],
  // Sisters-Camp Sherman
  'M771': [44.2879, -121.5490], 'M772': [44.2879, -121.5490], 'C771': [44.2879, -121.5490],
  // Black Butte Ranch
  'M871': [44.3988, -121.6282], 'C871': [44.3988, -121.6282],
  // Alfalfa
  'M971': [44.0084, -121.1091], 'C971': [44.0084, -121.1091],
  // Crescent
  'M1171': [43.4644, -121.7168], 'M1172': [43.4743, -121.6937], 'C1171': [43.4644, -121.7168],
  // Prineville
  'M1271': [44.3050, -120.7271], 'M1272': [44.3050, -120.7271], 'C1271': [44.3050, -120.7271],
  // Three Rivers
  'M1371': [44.3524, -121.1781], 'C1371': [44.3524, -121.1781],
  // Jefferson County
  'M1771': [44.6289, -121.1278], 'M1772': [44.6289, -121.1278], 'C1771': [44.6289, -121.1278],
  // Warm Springs
  'M2271': [44.7640, -121.2660], 'M2272': [44.7640, -121.2660], 'C2271': [44.7640, -121.2660],
  // AirLink CCT
  'AL1': [44.0613, -121.2832], 'AL2': [44.0946, -121.2000], 'AL4': [42.1561, -121.7339], 'ALG1': [44.0946, -121.2000],
  // Life Flight
  'LF11': [44.2570, -121.1599], 'LF45': [45.2385, -122.7548],
  // OHSU PANDA
  'PANDA1': [45.4990, -122.6855],
  // AMR
  'AMRP1': [44.0613, -121.2832],
  // Adventure Medics
  'AMALS1': [44.1024, -121.2799], 'AMBLS1': [44.1024, -121.2799], 'AMSTR1': [44.1024, -121.2799], 'AMWC1': [44.1024, -121.2799],
  // Law Enforcement
  'BPD301': [44.0630, -121.2975], 'BPD320': [44.0630, -121.2975],
  'DCSO214': [44.0584, -121.3615], 'DCSO250': [44.0584, -121.3615],
  'RPD401': [44.2715, -121.1752],
  'OSP315': [44.0882, -121.2870], 'OSP422': [44.0882, -121.2870],
  // ODOT
  'ODOT-R4-1': [44.1045, -121.2987], 'ODOT-R4-2': [44.1045, -121.2987],
};
// Station bases for MAP STA command — unique fire/EMS station locations
const BM_STATION_BASES = {
  'LA PINE STA101':    [43.6679, -121.5036],
  'LA PINE STA102':    [43.8208, -121.4421],
  'SUNRIVER':          [43.8758, -121.4363],
  'BEND STA301':       [44.0489, -121.3153],
  'BEND STA304':       [44.0550, -121.2679],
  'BEND STA306':       [44.0618, -121.2995],
  'REDMOND STA401':    [44.2783, -121.1785],
  'REDMOND STA403':    [44.2590, -121.1617],
  'CROOK STA1201':     [44.3050, -120.7271],
  'CLOVERDALE':        [44.2225, -121.4090],
  'SISTERS STA701':    [44.2879, -121.5490],
  'BLACK BUTTE':       [44.3988, -121.6282],
  'ALFALFA':           [44.0084, -121.1091],
  'CRESCENT STA1':     [43.4644, -121.7168],
  'CRESCENT STA2':     [43.4743, -121.6937],
  'THREE RIVERS':      [44.3524, -121.1781],
  'JEFFCO MADRAS':     [44.6289, -121.1278],
  'WARM SPRINGS':      [44.7640, -121.2660],
  'AIRLINK SCMC':      [44.0613, -121.2832],
  'AIRLINK KBDN':      [44.0946, -121.2000],
  'LIFE FLIGHT RDM':   [44.2570, -121.1599],
  'ADV MEDICS':        [44.1024, -121.2799],
};
const BM_STATUS_COLORS = {
  AV: '#4caf50', D: '#ff9800', DE: '#ff9800',
  OS: '#f44336', T: '#ffd700', AT: '#2196f3', OOS: '#607d8b',
};
const BM_MAP_CENTER  = [44.05, -120.85];
const BM_MAP_ZOOM    = 9;
const BM_MAP_VIEWBOX = '-122.5,43.0,-119.5,45.5';
const BM_TRICOUNTY   = [[43.3, -122.0], [45.0, -119.4]];

let _bmLoaded         = false;
let _bmLoading        = false;
let _bmMap            = null;
let _bmMarkers        = [];
let _bmGeoCache       = {};
let _bmGeoQueue       = [];
let _bmGeoTimer       = null;
let _popoutMapWindow  = null;

function toggleBoardMap() {
  const open = document.body.classList.toggle('board-map-open');
  const btn  = document.getElementById('tbBtnMAP');
  if (btn) btn.classList.toggle('active', open);
  if (open) {
    _loadBoardLeaflet(() => {
      setTimeout(() => {
        if (!_bmMap) _initBoardMap();
        if (_bmMap) _bmMap.invalidateSize();
        renderBoardMap();
        _startBmGeoQueue();
      }, 300);
    });
  } else {
    _stopBmGeoQueue();
  }
}

function _loadBoardLeaflet(cb) {
  if (_bmLoaded)  { cb(); return; }
  if (_bmLoading) { setTimeout(() => _loadBoardLeaflet(cb), 120); return; }
  _bmLoading = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(link);
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  script.onload  = () => { _bmLoaded = true; _bmLoading = false; cb(); };
  script.onerror = () => { _bmLoading = false; };
  document.body.appendChild(script);
}

function _initBoardMap() {
  const el = document.getElementById('boardMapContainer');
  if (!el || !window.L) return;
  _bmMap = L.map('boardMapContainer', { zoomControl: true, attributionControl: false })
    .setView(BM_MAP_CENTER, BM_MAP_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, opacity: 0.7
  }).addTo(_bmMap);
  const dimData = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[-180,-90],[180,-90],[180,90],[-180,90],[-180,-90]],
        [[BM_TRICOUNTY[0][1], BM_TRICOUNTY[0][0]], [BM_TRICOUNTY[0][1], BM_TRICOUNTY[1][0]],
         [BM_TRICOUNTY[1][1], BM_TRICOUNTY[1][0]], [BM_TRICOUNTY[1][1], BM_TRICOUNTY[0][0]],
         [BM_TRICOUNTY[0][1], BM_TRICOUNTY[0][0]]]
      ]
    }
  };
  L.geoJSON(dimData, { style: { fillColor: '#000', fillOpacity: 0.35, stroke: false, color: 'transparent', weight: 0 } }).addTo(_bmMap);
  L.rectangle(BM_TRICOUNTY, { color: 'rgba(91,163,230,0.4)', weight: 2, fill: false, dashArray: '4 4' }).addTo(_bmMap);
  _bmMap.fitBounds(BM_TRICOUNTY, { padding: [20, 20] });
}

function renderBoardMap() {
  if (!document.body.classList.contains('board-map-open')) return;
  if (!_bmMap || !window.L || !STATE) return;
  // Clear all markers EXCEPT the persistent search pin
  _bmMarkers.forEach(m => { if (m !== _bmSearchPin) { try { _bmMap.removeLayer(m); } catch(e) {} } });
  _bmMarkers = _bmSearchPin ? [_bmSearchPin] : [];

  // Only show units that are active AND updated within last 12 hours (filter stale DB rows)
  const _mapStaleMs = 12 * 60 * 60 * 1000;
  const _mapNow = Date.now();
  const units     = (STATE.units || []).filter(u => u.active && u.updated_at && (_mapNow - new Date(u.updated_at).getTime()) < _mapStaleMs);
  const incidents = (STATE.incidents || []).filter(i => i.status === 'ACTIVE' || i.status === 'QUEUED');

  // Incident pins
  incidents.forEach(inc => {
    const addr = (inc.scene_address || '').trim();
    if (!addr) return;
    const geo = _bmGeoCache[addr];
    if (geo) {
      const pri = inc.priority || '';
      const color = pri === 'PRI-1' ? '#f44336' : pri === 'PRI-2' ? '#ff9800' : '#4fa3e0';
      const shortId = String(inc.incident_id).replace(/^\d{2}-/, '');
      const tip = '<b>INC' + shortId + '</b>' + (inc.incident_type ? '<br>' + inc.incident_type : '') + (addr ? '<br>' + addr : '');
      const m = L.circleMarker(geo, { radius: 9, color, weight: 2, fillColor: color, fillOpacity: 0.35 })
        .bindTooltip(tip, { permanent: false, direction: 'top' });
      m.addTo(_bmMap);
      _bmMarkers.push(m);
    } else if (!_bmGeoCache.hasOwnProperty(addr) && !_bmGeoQueue.some(q => q.addr === addr)) {
      _bmGeoQueue.push({ addr, near: null, bounded: 0 });
    }
  });
  // Ensure geocoding queue is processing if there are pending addresses
  if (_bmGeoQueue.length) _startBmGeoQueue();

  // Unit dots
  const posUsage = {};
  units.forEach(u => {
    let pos = null;
    const stCode = String(u.status || '').toUpperCase();
    // Priority 1: incident scene address
    if (u.incident && ['D','DE','OS','T','AT'].includes(stCode)) {
      const inc = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (inc && inc.scene_address) {
        const geo = _bmGeoCache[(inc.scene_address || '').trim()];
        if (geo) pos = [geo[0], geo[1]];
      }
    }
    // Priority 2: [LOC:address] tag in note
    if (!pos) {
      const locAddr = _parseLocTag(u.note);
      if (locAddr) {
        const geo = _bmGeoCache[locAddr];
        if (geo) pos = [geo[0], geo[1]];
        else if (!_bmGeoCache.hasOwnProperty(locAddr) && !_bmGeoQueue.some(q => q.addr === locAddr)) {
          const uid2 = String(u.unit_id || '').toUpperCase();
          _bmGeoQueue.push({ addr: locAddr, near: BM_UNIT_HOME[uid2] || null, bounded: 1 });
        }
      }
    }
    // Priority 3: unit home base coords
    if (!pos) {
      const uid = String(u.unit_id || '').toUpperCase();
      pos = BM_UNIT_HOME[uid] ? [...BM_UNIT_HOME[uid]] : [...BM_MAP_CENTER];
    }
    const posKey = pos[0].toFixed(4) + ',' + pos[1].toFixed(4);
    const n = posUsage[posKey] = (posUsage[posKey] || 0) + 1;
    if (n > 1) {
      const angle = ((n - 1) * 137.5) * (Math.PI / 180);
      pos = [pos[0] + Math.sin(angle) * 0.0012, pos[1] + Math.cos(angle) * 0.0012];
    }
    const dotColor = BM_STATUS_COLORS[stCode] || '#607d8b';
    const uId = String(u.unit_id || '').toUpperCase();
    // Contextual location in tooltip
    let tipLoc = '';
    if (['D','DE','OS'].includes(stCode) && u.incident) {
      const tInc = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (tInc && tInc.scene_address) tipLoc = tInc.scene_address;
    }
    if (!tipLoc && u.destination) tipLoc = u.destination;
    if (!tipLoc) { const lt = _parseLocTag(u.note); if (lt) tipLoc = lt; }
    const tip = '<b>' + uId + '</b> — ' + stCode + (tipLoc ? '<br>' + esc(tipLoc) : '');
    const circle = L.circleMarker(pos, { radius: 7, color: dotColor, weight: 2, fillColor: dotColor, fillOpacity: 0.9 })
      .bindTooltip(tip, { permanent: false, direction: 'top' });
    circle.addTo(_bmMap);
    _bmMarkers.push(circle);
    const label = L.marker(pos, {
      icon: L.divIcon({ html: '<div class="v-map-label">' + uId + '</div>', className: '', iconSize: [0, 0] }),
      interactive: false
    }).addTo(_bmMap);
    _bmMarkers.push(label);
  });
}

function _parseLocTag(note) {
  if (!note) return null;
  const m = String(note).match(/\[LOC:([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

function _getUnitMapPos(unitId) {
  if (!STATE) return null;
  const u = (STATE.units || []).find(x => String(x.unit_id).toUpperCase() === unitId.toUpperCase());
  if (!u) return null;
  const stCode = String(u.status || '').toUpperCase();
  // Priority 1: incident scene address (if actively dispatched)
  if (u.incident && ['D','DE','OS','T','AT'].includes(stCode)) {
    const inc = (STATE.incidents || []).find(i => i.incident_id === u.incident);
    if (inc && inc.scene_address) {
      const geo = _bmGeoCache[(inc.scene_address || '').trim()];
      if (geo) return { pos: [geo[0], geo[1]], unit: u, source: 'incident' };
    }
  }
  // Priority 2: [LOC:address] tag in note
  const locAddr = _parseLocTag(u.note);
  if (locAddr) {
    const geo = _bmGeoCache[locAddr];
    if (geo) return { pos: [geo[0], geo[1]], unit: u, source: 'loc' };
    // Queue for geocoding if not yet known (bounded=1 forces Central OR; use home coords as tiebreaker)
    if (!_bmGeoCache.hasOwnProperty(locAddr) && !_bmGeoQueue.some(q => q.addr === locAddr)) {
      const uid = String(u.unit_id || '').toUpperCase();
      _bmGeoQueue.push({ addr: locAddr, near: BM_UNIT_HOME[uid] || null, bounded: 1 });
      if (_bmGeoQueue.length) _startBmGeoQueue();
    }
  }
  // Priority 2.5: PP note address — note format is "[PP] 1234 NW MAIN ST · CALL TYPE"
  // Only apply when unit is actively dispatched (not AV/OOS)
  if ((u.source || '').startsWith('PP:') && stCode !== 'AV' && stCode !== 'OOS') {
    const ppNoteMatch = (u.note || '').match(/^\[PP\]\s+([^·\n]+)/i);
    if (ppNoteMatch) {
      const ppAddr = ppNoteMatch[1].trim();
      if (ppAddr && ppAddr.length > 5) {
        const geo = _bmGeoCache[ppAddr.toUpperCase()];
        if (geo) return { pos: [geo[0], geo[1]], unit: u, source: 'pp' };
        if (!_bmGeoCache.hasOwnProperty(ppAddr.toUpperCase()) && !_bmGeoQueue.some(q => q.addr === ppAddr.toUpperCase())) {
          _bmGeoQueue.push({ addr: ppAddr.toUpperCase(), near: null, bounded: 1 });
          if (_bmGeoQueue.length) _startBmGeoQueue();
        }
      }
    }
  }
  // Priority 3: unit home base coordinates
  const uid = String(u.unit_id || '').toUpperCase();
  if (BM_UNIT_HOME[uid]) return { pos: [...BM_UNIT_HOME[uid]], unit: u, source: 'station' };
  return { pos: [...BM_MAP_CENTER], unit: u, source: 'default' };
}

function _getIncidentMapPos(incArg) {
  if (!STATE) return null;
  const id = incArg.replace(/^INC/i, '');
  const inc = (STATE.incidents || []).find(i => {
    const iid = String(i.incident_id || '');
    return iid === incArg || iid.endsWith('-' + id) || iid === id;
  });
  if (!inc) return null;
  const addr = (inc.scene_address || '').trim();
  if (!addr) return { inc, pos: null, source: 'no-address' };
  const geo = _bmGeoCache[addr];
  if (geo) return { inc, pos: [geo[0], geo[1]], source: 'scene' };
  // Queue for geocoding (bounded=0 — incident scenes may be outside Central OR for interfacility transfers)
  if (!_bmGeoCache.hasOwnProperty(addr) && !_bmGeoQueue.some(q => q.addr === addr)) {
    _bmGeoQueue.push({ addr, near: null, bounded: 0 });
    if (_bmGeoQueue.length) _startBmGeoQueue();
  }
  return { inc, pos: null, source: 'geocoding' };
}

function focusUnitOnMap(unitId) {
  if (!STATE) { showToast('NO DATA — WAIT FOR FIRST POLL.'); return; }
  const info = _getUnitMapPos(unitId);
  if (!info) { showToast('UNIT NOT FOUND: ' + unitId); return; }

  // If a better position is pending geocoding, wait and retry rather than focusing on station
  const u = info.unit;
  const stCode = String(u.status || '').toUpperCase();
  if (info.source === 'station' || info.source === 'default') {
    let pendingAddr = null;
    if (u.incident && ['D','DE','OS','T','AT'].includes(stCode)) {
      const inc = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (inc && inc.scene_address) {
        const a = (inc.scene_address || '').trim();
        if (!_bmGeoCache.hasOwnProperty(a)) pendingAddr = a;
      }
    }
    if (!pendingAddr) {
      const locAddr = _parseLocTag(u.note);
      if (locAddr && !_bmGeoCache.hasOwnProperty(locAddr)) pendingAddr = locAddr;
    }
    if (pendingAddr) {
      showToast('GEOCODING ' + unitId.toUpperCase() + ' — FOCUSING IN 3s...');
      _ensureMapOpen(() => { renderBoardMap(); });
      setTimeout(() => focusUnitOnMap(unitId), 3000);
      return;
    }
  }

  function doFocus() {
    if (!_bmMap || !window.L) { showToast('MAP NOT READY.'); return; }
    renderBoardMap();
    _bmMap.setView(info.pos, 14, { animate: true });

    // Highlight pulse ring
    const ring = L.circleMarker(info.pos, {
      radius: 20, color: '#ffffff', weight: 3, fillColor: '#4fa3e0',
      fillOpacity: 0.25, dashArray: '6 4', className: 'map-focus-ring'
    }).addTo(_bmMap);
    _bmMarkers.push(ring);

    // Open tooltip on the unit's marker
    for (const m of _bmMarkers) {
      if (m.getTooltip && m.getTooltip()) {
        const tip = m.getTooltip().getContent();
        if (tip && tip.includes('<b>' + unitId.toUpperCase() + '</b>')) {
          m.openTooltip();
          break;
        }
      }
    }

    // Animate pulse ring away after 3s
    setTimeout(() => {
      try { _bmMap.removeLayer(ring); } catch(e) {}
      const idx = _bmMarkers.indexOf(ring);
      if (idx !== -1) _bmMarkers.splice(idx, 1);
    }, 3000);

    const loc = info.source === 'incident' ? 'SCENE' : info.source === 'loc' ? 'LOC' : info.source === 'station' ? info.unit.station : 'DEFAULT';
    showToast('FOCUSED: ' + unitId.toUpperCase() + ' (' + loc + ')');
  }

  _ensureMapOpen(doFocus);
}

function focusIncidentOnMap(incArg) {
  if (!STATE) { showToast('NO DATA — WAIT FOR FIRST POLL.'); return; }
  const info = _getIncidentMapPos(incArg);
  if (!info) { showToast('INCIDENT NOT FOUND: ' + incArg); return; }
  if (!info.pos && info.source === 'no-address') { showToast('NO SCENE ADDRESS FOR ' + info.inc.incident_id); return; }
  if (!info.pos && info.source === 'geocoding') { showToast('GEOCODING SCENE ADDRESS — TRY AGAIN IN A FEW SECONDS.'); _ensureMapOpen(() => { renderBoardMap(); }); return; }

  function doFocus() {
    if (!_bmMap || !window.L) { showToast('MAP NOT READY.'); return; }
    renderBoardMap();
    _bmMap.setView(info.pos, 15, { animate: true });

    const ring = L.circleMarker(info.pos, {
      radius: 22, color: '#ff5555', weight: 3, fillColor: '#ff5555',
      fillOpacity: 0.2, dashArray: '6 4', className: 'map-focus-ring'
    }).addTo(_bmMap);
    _bmMarkers.push(ring);

    // Open tooltip on the incident marker
    for (const m of _bmMarkers) {
      if (m.getTooltip && m.getTooltip()) {
        const tip = m.getTooltip().getContent();
        if (tip && tip.includes('INC') && tip.includes(String(info.inc.incident_id).replace(/^\d{2}-/, ''))) {
          m.openTooltip();
          break;
        }
      }
    }

    setTimeout(() => {
      try { _bmMap.removeLayer(ring); } catch(e) {}
      const idx = _bmMarkers.indexOf(ring);
      if (idx !== -1) _bmMarkers.splice(idx, 1);
    }, 3000);

    showToast('FOCUSED: ' + info.inc.incident_id + (info.inc.scene_address ? ' @ ' + info.inc.scene_address : ''));
  }

  _ensureMapOpen(doFocus);
}

function _ensureMapOpen(cb) {
  if (!document.body.classList.contains('board-map-open')) {
    document.body.classList.add('board-map-open');
    const btn = document.getElementById('tbBtnMAP');
    if (btn) btn.classList.add('active');
    _loadBoardLeaflet(() => {
      setTimeout(() => {
        if (!_bmMap) _initBoardMap();
        if (_bmMap) _bmMap.invalidateSize();
        cb();
        _startBmGeoQueue();
      }, 300);
    });
  } else {
    cb();
  }
}

// ── Map zoom/focus commands ─────────────────────────────────

function mapZoomIn() {
  _ensureMapOpen(() => {
    if (!_bmMap) return;
    _bmMap.zoomIn(1, { animate: true });
    showToast('ZOOM: ' + _bmMap.getZoom());
  });
}

function mapZoomOut() {
  _ensureMapOpen(() => {
    if (!_bmMap) return;
    _bmMap.zoomOut(1, { animate: true });
    showToast('ZOOM: ' + _bmMap.getZoom());
  });
}

function mapFitAll() {
  if (!STATE) { showToast('NO DATA — WAIT FOR FIRST POLL.'); return; }
  _ensureMapOpen(() => {
    if (!_bmMap || !window.L) return;
    renderBoardMap();
    const pts = [];
    (STATE.units || []).filter(u => u.active).forEach(u => {
      const info = _getUnitMapPos(u.unit_id);
      if (info && info.pos) pts.push(info.pos);
    });
    (STATE.incidents || []).filter(i => i.status === 'ACTIVE' || i.status === 'QUEUED').forEach(inc => {
      const addr = (inc.scene_address || '').trim();
      if (addr && _bmGeoCache[addr]) pts.push(_bmGeoCache[addr]);
    });
    if (pts.length > 1) {
      _bmMap.fitBounds(pts, { padding: [30, 30], animate: true });
      showToast('FIT: ' + pts.length + ' MARKERS');
    } else if (pts.length === 1) {
      _bmMap.setView(pts[0], 13, { animate: true });
      showToast('FIT: 1 MARKER');
    } else {
      _bmMap.fitBounds(BM_TRICOUNTY, { padding: [20, 20], animate: true });
      showToast('NO MARKERS — SHOWING REGION');
    }
  });
}

function mapShowStations() {
  _ensureMapOpen(() => {
    if (!_bmMap || !window.L) return;
    renderBoardMap();
    const pts = [];
    Object.entries(BM_STATION_BASES).forEach(([name, coords]) => {
      pts.push(coords);
      const m = L.circleMarker(coords, {
        radius: 12, color: '#ffffff', weight: 2, fillColor: '#2196f3', fillOpacity: 0.4,
        dashArray: '4 3', className: 'map-focus-ring'
      }).bindTooltip('<b>' + name + '</b>', { permanent: true, direction: 'top', className: 'v-map-label' })
        .addTo(_bmMap);
      _bmMarkers.push(m);
    });
    if (pts.length) {
      _bmMap.fitBounds(pts, { padding: [40, 40], animate: true });
    }
    showToast('STATIONS: ' + pts.length + ' SHOWN');
  });
}

function mapShowIncidents() {
  if (!STATE) { showToast('NO DATA — WAIT FOR FIRST POLL.'); return; }
  const active = (STATE.incidents || []).filter(i => i.status === 'ACTIVE' || i.status === 'QUEUED');
  if (!active.length) { showToast('NO ACTIVE INCIDENTS.'); return; }
  _ensureMapOpen(() => {
    if (!_bmMap || !window.L) return;
    renderBoardMap();
    const pts = [];
    active.forEach(inc => {
      const addr = (inc.scene_address || '').trim();
      if (addr && _bmGeoCache[addr]) {
        const geo = _bmGeoCache[addr];
        pts.push(geo);
        const ring = L.circleMarker(geo, {
          radius: 18, color: '#ff5555', weight: 3, fillColor: '#ff5555',
          fillOpacity: 0.2, dashArray: '6 4', className: 'map-focus-ring'
        }).addTo(_bmMap);
        _bmMarkers.push(ring);
        setTimeout(() => {
          try { _bmMap.removeLayer(ring); } catch(e) {}
          const idx = _bmMarkers.indexOf(ring);
          if (idx !== -1) _bmMarkers.splice(idx, 1);
        }, 5000);
      }
    });
    if (pts.length > 1) {
      _bmMap.fitBounds(pts, { padding: [30, 30], animate: true });
    } else if (pts.length === 1) {
      _bmMap.setView(pts[0], 14, { animate: true });
    }
    showToast('INCIDENTS: ' + pts.length + '/' + active.length + ' GEOCODED');
  });
}

function mapReset() {
  _clearSearchPin();
  _ensureMapOpen(() => {
    if (!_bmMap) return;
    _bmMap.fitBounds(BM_TRICOUNTY, { padding: [20, 20], animate: true });
    renderBoardMap();
    showToast('MAP RESET TO DEFAULT VIEW');
  });
}

// MAP <address> — geocode an arbitrary address and focus map on it
// Search pin persists until next MAP <addr>, MAP CLR, or MAP RESET
let _bmSearchPin = null;
function _clearSearchPin() {
  if (_bmSearchPin && _bmMap) {
    try { _bmMap.removeLayer(_bmSearchPin); } catch(e) {}
    const idx = _bmMarkers.indexOf(_bmSearchPin);
    if (idx !== -1) _bmMarkers.splice(idx, 1);
    _bmSearchPin = null;
  }
}

function mapGeoFocus(addr) {
  if (!addr) { showToast('MAP: ENTER AN ADDRESS.'); return; }

  // 1. Detect lat/lon coordinates — skip geocoding entirely
  const coordMatch = addr.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]), lon = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      _ensureMapOpen(() => {
        if (!_bmMap || !window.L) return;
        _clearSearchPin();
        _bmMap.setView([lat, lon], 15, { animate: true });
        _bmSearchPin = L.circleMarker([lat, lon], {
          radius: 12, color: '#FFD700', weight: 3, fillColor: '#FFD700',
          fillOpacity: 0.3, dashArray: '6 4'
        }).addTo(_bmMap);
        _bmSearchPin.bindTooltip('<b>' + lat.toFixed(5) + ', ' + lon.toFixed(5) + '</b>', { permanent: true, direction: 'top' }).openTooltip();
        _bmMarkers.push(_bmSearchPin);
        showToast('MAP: ' + lat.toFixed(5) + ', ' + lon.toFixed(5));
      });
      return;
    }
  }

  // 2. Check AddressLookup shortcodes
  const resolved = AddressLookup.resolve(addr);
  let searchAddr = resolved !== addr ? resolved : addr;

  // 3. Handle intersections — / separator (e.g. HWY 97/61ST, SE 3 / MAIN)
  let isIntersection = false;
  if (searchAddr.includes('/')) {
    isIntersection = true;
    const parts = searchAddr.split('/');
    searchAddr = parts[0].trim();
  }

  // 4. Build query — use viewbox to bias to tri-county area instead of assuming a city
  const hasCity = /,|\b(BEND|REDMOND|SISTERS|PRINEVILLE|MADRAS|LA PINE|SUNRIVER|TERREBONNE|POWELL BUTTE|TUMALO|CROOKED RIVER|WARM SPRINGS)\b/i.test(searchAddr);
  let query = hasCity ? searchAddr : searchAddr + ', OR';
  const vbox = '&viewbox=' + BM_MAP_VIEWBOX + '&bounded=0';

  showToast('GEOCODING: ' + (isIntersection ? addr + ' (PRIMARY STREET)' : query));

  _ensureMapOpen(async () => {
    if (!_bmMap || !window.L) return;
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us' + vbox + '&q=' + encodeURIComponent(query);
      const resp = await fetch(url);
      const results = await resp.json();
      if (!results || !results.length) {
        showToast('NO RESULTS FOR: ' + query);
        return;
      }
      const r = results[0];
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);

      // Clear previous search pin
      _clearSearchPin();

      _bmMap.setView([lat, lon], 15, { animate: true });
      // Yellow search pin — persists until next search or MAP RESET/CLR
      _bmSearchPin = L.circleMarker([lat, lon], {
        radius: 12, color: '#FFD700', weight: 3, fillColor: '#FFD700',
        fillOpacity: 0.3, dashArray: '6 4'
      }).addTo(_bmMap);
      const displayName = (r.display_name || addr).substring(0, 100);
      _bmSearchPin.bindTooltip('<b>' + displayName + '</b>', { permanent: true, direction: 'top' }).openTooltip();
      _bmMarkers.push(_bmSearchPin);

      const msg = isIntersection
        ? 'INTERSECTION — SHOWING ' + searchAddr.toUpperCase() + '. VERIFY PIN LOCATION.'
        : displayName;
      showToast(msg);
    } catch(e) {
      showToast('GEOCODING FAILED — NETWORK ERROR.');
    }
  });
}

function _startBmGeoQueue() {
  if (_bmGeoTimer) return;
  _bmGeoTimer = setInterval(_processBmGeoQueue, 1500);
}

function _stopBmGeoQueue() {
  if (_bmGeoTimer) { clearInterval(_bmGeoTimer); _bmGeoTimer = null; }
}

// Approximate squared distance between two lat/lng points (no sqrt needed for comparison)
function _geoDistSq(lat1, lng1, lat2, lng2) {
  const dlat = lat2 - lat1;
  const dlng = (lng2 - lng1) * Math.cos(lat1 * Math.PI / 180);
  return dlat * dlat + dlng * dlng;
}

async function _processBmGeoQueue() {
  if (!_bmGeoQueue.length) return;
  const item = _bmGeoQueue.shift();
  const addr = item.addr;
  const near = item.near;       // [lat, lng] or null
  const bounded = item.bounded; // 1 = strict Central OR viewbox (unit LOCs), 0 = loose (incident scenes)
  if (_bmGeoCache.hasOwnProperty(addr)) return;
  try {
    // Strip leading non-numeric facility name prefix before geocoding
    // e.g. "SAINT CHARLES BEND 2500 NE NEFF RD" → "2500 NE NEFF RD"
    const hasStreetNum = /\d/.test(addr);
    const geocodeAddr = hasStreetNum ? addr.replace(/^[A-Za-z\s,.'"-]+?(?=\d)/, '').trim() : addr;
    const query = /oregon|,\s*or\b/i.test(geocodeAddr) ? geocodeAddr : geocodeAddr + ', Oregon';
    // Fetch multiple results when we have a home coord to pick closest from
    const limit = near ? 5 : 1;
    const url = 'https://nominatim.openstreetmap.org/search?format=json&q=' +
      encodeURIComponent(query) + '&limit=' + limit + '&viewbox=' + BM_MAP_VIEWBOX +
      '&bounded=' + (bounded || 0) + '&countrycodes=us';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.length) {
      let best = data[0];
      if (near && data.length > 1) {
        let bestDist = Infinity;
        for (const r of data) {
          const d = _geoDistSq(near[0], near[1], parseFloat(r.lat), parseFloat(r.lon));
          if (d < bestDist) { bestDist = d; best = r; }
        }
      }
      _bmGeoCache[addr] = [parseFloat(best.lat), parseFloat(best.lon)];
      renderBoardMap();
    } else {
      _bmGeoCache[addr] = null;
    }
  } catch (e) {}
}

function openPopoutMap() {
  if (_popoutMapWindow && !_popoutMapWindow.closed) {
    _popoutMapWindow.focus();
    showToast('MAP ALREADY OPEN IN POPOUT.');
    return;
  }
  // Collapse inline map if open
  if (document.body.classList.contains('board-map-open')) {
    document.body.classList.remove('board-map-open');
    const btn = document.getElementById('tbBtnMAP');
    if (btn) btn.classList.remove('active');
    _stopBmGeoQueue();
  }
  _popoutMapWindow = window.open('/hoscad/popout-map/', 'hoscad-map', 'width=1000,height=750,left=0,top=0');
  if (!_popoutMapWindow) {
    showToast('POPUP BLOCKED — ALLOW POPUPS FOR THIS SITE.', 'warn');
    return;
  }
  function _relayToMap() {
    if (_popoutMapWindow && !_popoutMapWindow.closed && TOKEN) {
      _popoutMapWindow.postMessage({ type: 'HOSCAD_RELAY_TOKEN', token: TOKEN }, window.location.origin);
    }
  }
  _popoutMapWindow.addEventListener('load', _relayToMap);
  window.addEventListener('message', function _relayMapHandler(e) {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'HOSCAD_REQUEST_RELAY_TOKEN') {
      window.removeEventListener('message', _relayMapHandler);
      _relayToMap();
    }
  });
  const check = setInterval(() => {
    if (_popoutMapWindow && _popoutMapWindow.closed) {
      clearInterval(check);
      _popoutMapWindow = null;
    }
  }, 3000);
  showToast('MAP OPENED IN POPOUT.');
}

// ============================================================
// Initialization
// ============================================================
function updateClock() {
  const el = document.getElementById('clockPill');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  updatePopoutClock();
  updatePpSyncBadge();
}

// ─── Resizable Columns ───────────────────────────────────────────────────────
const _COL_NAMES = ['unit', 'status', 'elapsed', 'dest', 'note', 'inc', 'updated'];

function _saveColWidths() {
  const ths = document.querySelectorAll('#boardTable thead th');
  const w = {};
  ths.forEach((th, i) => {
    if (_COL_NAMES[i] !== 'note') w[_COL_NAMES[i]] = th.offsetWidth;
  });
  try { localStorage.setItem('hoscad_col_widths', JSON.stringify(w)); } catch(e) {}
}

function _loadColWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem('hoscad_col_widths') || 'null');
    if (!saved) return;
    const ths = document.querySelectorAll('#boardTable thead th');
    ths.forEach((th, i) => {
      const name = _COL_NAMES[i];
      if (name !== 'note' && saved[name]) th.style.width = saved[name] + 'px';
    });
  } catch(e) {}
}

function initColumnResize() {
  _loadColWidths();
  const ths = document.querySelectorAll('#boardTable thead th');
  ths.forEach((th, i) => {
    const handle = th.querySelector('.col-resize-handle');
    if (!handle) return; // col-note has no handle
    let startX, startW;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation(); // don't trigger sort
      startX = e.clientX;
      startW = th.offsetWidth;
      handle.classList.add('is-resizing');
      document.body.style.cursor = 'col-resize';
      function onMove(ev) {
        th.style.width = Math.max(36, startW + (ev.clientX - startX)) + 'px';
      }
      function onUp() {
        handle.classList.remove('is-resizing');
        document.body.style.cursor = '';
        _saveColWidths();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Global Hover Tooltip System ────────────────────────────────────────────
let _tipTimer = null;

function _hideTip() {
  clearTimeout(_tipTimer);
  const tip = document.getElementById('globalTip');
  if (tip) tip.style.display = 'none';
}

function _showTip(anchorEl, html, delay) {
  clearTimeout(_tipTimer);
  _tipTimer = setTimeout(() => {
    const tip = document.getElementById('globalTip');
    if (!tip) return;
    tip.innerHTML = html;
    tip.style.display = 'block';
    const rect = anchorEl.getBoundingClientRect();
    const tipW = 270;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + tipW > window.innerWidth - 8) left = Math.max(4, window.innerWidth - tipW - 8);
    if (top + 220 > window.innerHeight) top = rect.top - tip.offsetHeight - 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }, delay !== undefined ? delay : 350);
}

function _buildUnitTip(unitId) {
  if (!STATE) return null;
  const u = (STATE.units || []).find(x => x.unit_id === unitId);
  if (!u) return null;
  const agencyStr = u.agency_id || '—';
  const typeStr = [u.type ? u.type.toUpperCase() : null, u.level].filter(Boolean).join(' / ') || '—';
  const stationStr = u.station || '—';
  const assistOnly = u.include_in_recommendations === false;
  const mi = minutesSince(u.updated_at);
  const elStr = mi != null ? formatElapsed(mi) + ' ago' : '—';
  const updStr = fmtTime24(u.updated_at) + (u.updated_by ? ' by ' + u.updated_by.toUpperCase() : '');
  const crewParts = u.unit_info ? String(u.unit_info).split('|').filter(p => /^CM\d:/i.test(p)) : [];
  const etaTipMatch = (u.note || '').match(/\[ETA:(\d+)\]/);
  const rows = [];
  if (crewParts.length) rows.push(['Crew', crewParts.map(p => p.replace(/^CM\d:/i, '').trim()).join(', ')]);
  if (etaTipMatch) rows.push(['ETA', etaTipMatch[1] + ' min']);
  rows.push(
    ['Agency', agencyStr],
    ['Type', typeStr],
    ['Station', stationStr],
    ['Recommend', assistOnly ? 'Assist only' : 'Yes'],
    ['Updated', updStr],
    ['Elapsed', elStr]
  );
  const titleLine = esc(u.unit_id.toUpperCase()) +
    (u.display_name && u.display_name.toUpperCase() !== u.unit_id.toUpperCase() ? ' — ' + esc(u.display_name.toUpperCase()) : '');
  return '<div class="tip-title">' + titleLine + '</div>' +
    rows.map(([k, v]) => '<div class="tip-row"><span class="tip-key">' + k + '</span><span class="tip-val">' + esc(String(v)) + '</span></div>').join('');
}

function _buildIncTip(incId) {
  if (!STATE) return null;
  const inc = (STATE.incidents || []).find(x => x.incident_id === incId);
  if (!inc) return null;
  const unitCount = (STATE.units || []).filter(u => u.active && u.incident === incId).length;
  const mi = minutesSince(inc.dispatch_time || inc.created_at);
  const ageStr = mi != null ? formatElapsed(mi) + ' ago' : '—';
  const note = (inc.incident_note || '')
    .replace(/^\[URGENT\]\s*/i, '').replace(/\[MA\]\s*/gi, '').replace(/\[CB:[^\]]+\]\s*/gi, '').trim();
  const rows = [
    ['Type', inc.incident_type || '—'],
    ['Priority', inc.priority || '—'],
    ['Source', inc.pp_incident_id ? 'PulsePoint' : 'Manual'],
    ['Units', unitCount + ' assigned'],
    ['Scene', inc.scene_address || '—'],
    ['Dispatched', ageStr]
  ];
  if (note) rows.push(['Note', note.length > 90 ? note.substring(0, 90) + '…' : note]);
  return '<div class="tip-title">INC' + esc(inc.incident_id.replace(/^\d{2}-/, '')) + '</div>' +
    rows.map(([k, v]) => '<div class="tip-row"><span class="tip-key">' + k + '</span><span class="tip-val">' + esc(String(v)) + '</span></div>').join('');
}

function _initTooltipSystem() {
  document.addEventListener('mouseover', e => {
    if (e.target.closest('#globalTip')) return;
    // INC# span — incident details on the board
    const incSpan = e.target.closest('.clickableIncidentNum');
    if (incSpan && incSpan.dataset.inc) {
      const html = _buildIncTip(incSpan.dataset.inc);
      if (html) { _showTip(incSpan, html); return; }
    }
    // Active Calls Bar card
    const acbCard = e.target.closest('.acb-card[data-inc-id]');
    if (acbCard) {
      const html = _buildIncTip(acbCard.dataset.incId);
      if (html) { _showTip(acbCard, html); return; }
    }
    // Incident queue row
    const incTr = e.target.closest('tr[data-inc-id]');
    if (incTr) {
      const html = _buildIncTip(incTr.dataset.incId);
      if (html) { _showTip(incTr, html); return; }
    }
    // Unit board row
    const unitTr = e.target.closest('tr[data-unit-id]');
    if (unitTr) {
      const html = _buildUnitTip(unitTr.dataset.unitId);
      if (html) { _showTip(unitTr, html); return; }
    }
    _hideTip();
  });
  document.addEventListener('scroll', _hideTip, true);
  document.addEventListener('click', _hideTip, true);
}
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  await API.init();
  loadViewState();
  refresh();
  AddressLookup.load(); // async, non-blocking — autocomplete works once data arrives
  if (POLL) clearInterval(POLL);
  POLL = setInterval(refresh, 10000);
  if (localStorage.getItem('hoscad_pp_enabled') !== 'false') startPpPolling();
  updateClock();
  var _clockInterval = setInterval(updateClock, 1000);
  let _searchDebounce;
  document.getElementById('search').addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(renderBoardDiff, 180);
  });
  document.getElementById('showInactive').addEventListener('change', renderBoardDiff);
  setupColumnSort();
  applyViewState();
  loadBoardZoom();
  loadScratch();

  // Persistent token relay — serves viewer, board popout, and inc queue popout
  window.addEventListener('message', function _globalRelay(e) {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'HOSCAD_REQUEST_RELAY_TOKEN' && TOKEN && e.source) {
      try { e.source.postMessage({ type: 'HOSCAD_RELAY_TOKEN', token: TOKEN }, window.location.origin); } catch(err){}
    }
    if (e.data && e.data.type === 'HOSCAD_REVIEW_INCIDENT' && e.data.incidentId) {
      openIncident(e.data.incidentId);
    }
  });

  // Throttle polling when tab is hidden (60s) vs visible (10s)
  // Also pause/resume clock and flush pending renders
  document.addEventListener('visibilitychange', function() {
    if (POLL) clearInterval(POLL);
    if (document.hidden) {
      POLL = setInterval(refresh, 60000);
      clearInterval(_clockInterval);
    } else {
      POLL = setInterval(refresh, 10000);
      _clockInterval = setInterval(updateClock, 1000);
      updateClock();
      // Flush any pending render from background updates
      if (_pendingRender) {
        _pendingRender = false;
        renderAll();
      }
    }
  });
}

// DOM Ready
window.addEventListener('load', () => {
  // Attach address autocomplete to destination inputs
  AddrAutocomplete.attach(document.getElementById('mDestination'));
  AddrAutocomplete.attach(document.getElementById('newIncDest'));
  AddrAutocomplete.attach(document.getElementById('incDestEdit'));

  // Attach address autocomplete to scene fields — onSelect fills street address
  AddrAutocomplete.attach(document.getElementById('newIncScene'), {
    onSelect: function(addr) {
      var el = document.getElementById('newIncScene');
      if (el && addr.address) {
        el.value = (addr.address + ', ' + addr.city + ', ' + addr.state + ' ' + addr.zip).toUpperCase();
      }
    }
  });
  AddrAutocomplete.attach(document.getElementById('incSceneAddress'), {
    onSelect: function(addr) {
      var el = document.getElementById('incSceneAddress');
      if (el && addr.address) {
        el.value = (addr.address + ', ' + addr.city + ', ' + addr.state + ' ' + addr.zip).toUpperCase();
      }
    }
  });

  // Incident modal: Ctrl+Enter saves note
  document.getElementById('incNote').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      saveIncidentNote();
    }
  });

  // Setup login form
  document.getElementById('loginRole').value = '';
  document.getElementById('loginCadId').value = '';
  document.getElementById('loginPassword').value = '';

  document.getElementById('loginRole').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginCadId').focus();
  });

  document.getElementById('loginCadId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginPassword').focus();
  });

  document.getElementById('loginPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });

  // Setup command input
  const cI = document.getElementById('cmd');
  cI.addEventListener('input', () => {
    showCmdHints(cI.value.trim());
  });
  cI.addEventListener('keydown', (e) => {
    // Cmd hints navigation
    const hintsOpen = document.getElementById('cmdHints') && document.getElementById('cmdHints').classList.contains('open');
    if (e.key === 'Escape' && hintsOpen) { hideCmdHints(); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      if (hintsOpen && CMD_HINT_INDEX >= 0) { selectCmdHint(CMD_HINT_INDEX); e.preventDefault(); return; }
      hideCmdHints();
      e.preventDefault();
      e.stopPropagation();
      runCommand();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hintsOpen) { navigateCmdHints(-1); return; }
      if (CMD_INDEX > 0) {
        CMD_INDEX--;
        cI.value = CMD_HISTORY[CMD_INDEX] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hintsOpen) { navigateCmdHints(1); return; }
      if (CMD_INDEX < CMD_HISTORY.length - 1) {
        CMD_INDEX++;
        cI.value = CMD_HISTORY[CMD_INDEX] || '';
      } else {
        CMD_INDEX = CMD_HISTORY.length;
        cI.value = '';
      }
    }
  });
  cI.addEventListener('blur', () => {
    setTimeout(hideCmdHints, 150);
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const nib = document.getElementById('newIncBack');
      const uhb = document.getElementById('uhBack');
      const ib = document.getElementById('incBack');
      const mb = document.getElementById('modalBack');
      const msgb = document.getElementById('msgBack');
      const cd = document.getElementById('confirmDialog');
      const ad = document.getElementById('alertDialog');

      if (nib && nib.style.display === 'flex') { closeNewIncident(); return; }
      if (uhb && uhb.style.display === 'flex') { uhb.style.display = 'none'; autoFocusCmd(); return; }
      if (ib && ib.style.display === 'flex') { ib.style.display = 'none'; autoFocusCmd(); return; }
      if (msgb && msgb.style.display === 'flex') { closeMessages(); return; }
      if (mb && mb.style.display === 'flex') { closeModal(); return; }
      if (cd && cd.classList.contains('active')) { hideConfirm(); return; }
      if (ad && ad.classList.contains('active')) { hideAlert(); return; }

      // Escape also deselects
      if (SELECTED_UNIT_ID) {
        SELECTED_UNIT_ID = null;
        document.querySelectorAll('#boardBody tr.selected').forEach(tr => tr.classList.remove('selected'));
      }
    }

    if (e.ctrlKey && e.key === 'k') { e.preventDefault(); cI.focus(); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); openLogon(); }
    if (e.ctrlKey && e.key === 'd') { e.preventDefault(); cycleDensity(); }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); boardZoomIn(); }
    if (e.ctrlKey && e.key === '-') { e.preventDefault(); boardZoomOut(); }
    if (e.ctrlKey && e.key === '0') { e.preventDefault(); boardZoomReset(); }
    if (e.key === 'F1') { e.preventDefault(); cI.focus(); }
    if (e.key === 'F2') { e.preventDefault(); openNewIncident(); }
    if (e.key === 'F3') { e.preventDefault(); cI.focus(); }
    if (e.key === 'F4') { e.preventDefault(); openMessages(); }
  });

  // Confirm dialog handlers
  document.getElementById('confirmOk').addEventListener('click', () => {
    const cb = CONFIRM_CALLBACK;
    hideConfirm();
    if (cb) cb(true);
  });

  document.getElementById('confirmClose').addEventListener('click', () => {
    const cb = CONFIRM_CANCEL_CALLBACK;
    hideConfirm();
    if (cb) cb();
  });

  document.getElementById('alertClose').addEventListener('click', () => {
    hideAlert();
  });

  // Enter key closes dialogs and modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Don't intercept Enter in textareas or inputs - let their handlers deal with it
      const tag = e.target.tagName;
      const isTextarea = tag === 'TEXTAREA';
      const isInput = tag === 'INPUT' && e.target.type !== 'button';
      if (isTextarea || isInput) return;

      // Alert/Confirm dialogs - close on Enter (only when not in an input)
      const alertDialog = document.getElementById('alertDialog');
      const confirmDialog = document.getElementById('confirmDialog');
      if (alertDialog.classList.contains('active')) {
        e.preventDefault();
        hideAlert();
        return;
      }
      if (confirmDialog.classList.contains('active')) {
        e.preventDefault();
        const cb = CONFIRM_CALLBACK;
        hideConfirm();
        if (cb) cb(true);
        return;
      }

      // Close other modals on Enter (when not in an input field)
      const uhBack = document.getElementById('uhBack');
      const msgBack = document.getElementById('msgBack');
      if (uhBack && uhBack.style.display === 'flex') {
        closeUH();
        return;
      }
      if (msgBack && msgBack.style.display === 'flex') {
        closeMessages();
        return;
      }
    }
  });

  // Performance: Event delegation for board table (instead of per-row handlers)
  const boardBody = document.getElementById('boardBody');
  if (boardBody) {
    // Single click = select row
    boardBody.addEventListener('click', (e) => {
      // Check if clicked on stack badge
      const stackEl = e.target.closest('[data-stack-unit]');
      if (stackEl) {
        e.stopPropagation();
        const uid = stackEl.getAttribute('data-stack-unit');
        if (_expandedStacks.has(uid)) _expandedStacks.delete(uid);
        else _expandedStacks.add(uid);
        renderBoardDiff();
        return;
      }

      // Check if clicked on incident number
      const incEl = e.target.closest('.clickableIncidentNum');
      if (incEl) {
        e.stopPropagation();
        const incId = incEl.dataset.inc;
        if (incId) openIncident(incId);
        return;
      }

      // Otherwise select the row
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.unitId) {
        e.stopPropagation();
        selectUnit(tr.dataset.unitId);
      }
    });

    // Double click = open edit modal
    boardBody.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.unitId) {
        e.preventDefault();
        e.stopPropagation();
        const u = (STATE.units || []).find(u => u.unit_id === tr.dataset.unitId);
        if (u) {
          if (u.source && u.source.startsWith('PP:')) { openPpUnitActions(u); return; }
          openModal(u);
        }
      }
    });
  }

  // Session cleanup on tab close — immediately end session so position becomes available
  window.addEventListener('beforeunload', () => {
    if (TOKEN) {
      try {
        fetch(API.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'apikey': API._apiKey,
            'Authorization': 'Bearer ' + API._apiKey
          },
          body: new URLSearchParams({ action: 'logout', params: JSON.stringify([TOKEN]) }).toString(),
          keepalive: true
        });
      } catch(e) {}
    }
  });

  // Show login screen
  document.getElementById('loginBack').style.display = 'flex';
  document.getElementById('userLabel').textContent = '—';

  _initTooltipSystem();
  initColumnResize();
});
