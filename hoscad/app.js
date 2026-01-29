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

// VIEW state for layout/display controls
let VIEW = {
  sidebar: false,
  incidents: true,
  messages: true,
  metrics: true,
  density: 'normal',
  sort: 'status',
  sortDir: 'asc',
  filterStatus: null,
  filterType: null,
  preset: 'dispatch',
  elapsedFormat: 'short',
  nightMode: false
};

// Admin role check - SUPV1, SUPV2, MGR1, MGR2, IT have admin access
function isAdminRole() {
  return ACTOR.startsWith('SUPV1/') || ACTOR.startsWith('SUPV2/') ||
         ACTOR.startsWith('MGR1/') || ACTOR.startsWith('MGR2/') ||
         ACTOR.startsWith('IT/');
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

const STATUS_RANK = { D: 1, DE: 2, OS: 3, T: 4, AV: 5, OOS: 6 };
const VALID_STATUSES = new Set(['D', 'DE', 'OS', 'F', 'FD', 'T', 'AV', 'UV', 'BRK', 'OOS']);

// Command hints for autocomplete
const CMD_HINTS = [
  { cmd: 'D <UNIT>; <NOTE>', desc: 'Dispatch unit' },
  { cmd: 'DE <UNIT>; <NOTE>', desc: 'Set enroute' },
  { cmd: 'OS <UNIT>; <NOTE>', desc: 'Set on scene' },
  { cmd: 'T <UNIT>; <NOTE>', desc: 'Set transporting' },
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
  { cmd: 'NC <LOCATION>; <NOTE>; <TYPE>', desc: 'New incident' },
  { cmd: 'R <INC>', desc: 'Review incident' },
  { cmd: 'UH <UNIT> [HOURS]', desc: 'Unit history' },
  { cmd: 'MSG <ROLE/UNIT>; <TEXT>', desc: 'Send message' },
  { cmd: 'DEST <UNIT>; <LOCATION>', desc: 'Set unit destination' },
  { cmd: 'LOGON <UNIT>; <NOTE>', desc: 'Activate unit' },
  { cmd: 'LOGOFF <UNIT>', desc: 'Deactivate unit' },
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
  { cmd: 'HELP', desc: 'Show command reference' },
];
let CMD_HINT_INDEX = -1;

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

  formatBoard(destValue) {
    if (!destValue) return '<span class="muted">\u2014</span>';
    const v = String(destValue).trim().toUpperCase();
    const addr = this.getById(v);
    if (addr) {
      const tip = esc(addr.address + ', ' + addr.city + ', ' + addr.state + ' ' + addr.zip);
      return '<span class="dest-recognized destBig" title="' + tip + '">' + esc(addr.name) + '</span>';
    }
    return '<span class="destBig">' + esc(v || '\u2014') + '</span>';
  }
};

// ============================================================
// Address Autocomplete Component
// ============================================================
const AddrAutocomplete = {
  attach(inputEl) {
    if (!inputEl || inputEl.dataset.acAttached) return;
    inputEl.dataset.acAttached = '1';

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

  // Incident queue
  const iq = document.getElementById('incidentQueueCard');
  if (iq) {
    if (VIEW.incidents) iq.classList.remove('collapsed');
    else iq.classList.add('collapsed');
    iq.style.display = VIEW.incidents ? '' : '';
  }

  // Messages section in sidebar
  const ms = document.getElementById('sideMsgSection');
  if (ms) ms.style.display = VIEW.messages ? '' : 'none';

  // Metrics section in sidebar
  const me = document.getElementById('sideMetSection');
  if (me) me.style.display = VIEW.metrics ? '' : 'none';

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
}

function updateToolbarButtons() {
  const btns = {
    'tbBtnINC': VIEW.incidents,
    'tbBtnSIDE': VIEW.sidebar,
    'tbBtnMSG': VIEW.messages,
    'tbBtnMET': VIEW.metrics
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
  } else if (panel === 'metrics' || panel === 'met') {
    VIEW.metrics = !VIEW.metrics;
  } else if (panel === 'all') {
    VIEW.sidebar = true;
    VIEW.incidents = true;
    VIEW.messages = true;
    VIEW.metrics = true;
  } else if (panel === 'none') {
    VIEW.sidebar = false;
    VIEW.incidents = false;
    VIEW.messages = false;
    VIEW.metrics = false;
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
  const modes = ['compact', 'normal', 'expanded'];
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
    VIEW.metrics = false;
    VIEW.density = 'normal';
    VIEW.sort = 'status';
    VIEW.sortDir = 'asc';
    VIEW.filterStatus = null;
  } else if (name === 'supervisor') {
    VIEW.sidebar = true;
    VIEW.incidents = true;
    VIEW.messages = true;
    VIEW.metrics = true;
    VIEW.density = 'normal';
    VIEW.sort = 'status';
    VIEW.sortDir = 'asc';
    VIEW.filterStatus = null;
  } else if (name === 'field') {
    VIEW.sidebar = false;
    VIEW.incidents = false;
    VIEW.messages = false;
    VIEW.metrics = false;
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
// Audio Feedback
// ============================================================
let _audioUnlocked = false;

function _playTone(src) {
  try {
    const a = new Audio(src);
    a.play().catch(() => {});
  } catch (e) { }
}

// Soft tone for regular messages (523Hz C5, warm)
function _toneSoft() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 523; // C5
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) { }
}

// Unlock audio on first user gesture (mobile requires user interaction)
function _unlockAudio() {
  if (_audioUnlocked) return;
  try {
    const a = new Audio();
    a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
    a.volume = 0;
    a.play().then(() => { a.pause(); }).catch(() => {});
    _audioUnlocked = true;
  } catch (e) { }
}
['touchstart', 'mousedown', 'keydown'].forEach(evt => {
  document.addEventListener(evt, _unlockAudio, { once: false, passive: true });
});

function beepChange()     { /* silent – no tone on status board updates */ }
function beepNote()       { /* silent – no tone on note banners */ }
function beepMessage()    { _toneSoft(); }                    // Soft tone for regular messages
function beepAlert()      { _playTone('tone-urgent.wav'); }   // Urgent tone for alerts
function beepHotMessage() { _playTone('tone-urgent.wav'); }   // Emergent tone for hot messages

// ============================================================
// Utility Functions
// ============================================================
function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", "&#039;");
}

function fmtTime24(i) {
  if (!i) return '—';
  const d = new Date(i);
  if (!isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function minutesSince(i) {
  if (!i) return null;
  const t = new Date(i).getTime();
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

function getRoleColor(a) {
  const m = String(a || '').match(/@([A-Z0-9]+)$/);
  if (!m) return '';
  return 'roleColor-' + m[1];
}

function setLive(ok, txt) {
  const e = document.getElementById('livePill');
  e.className = 'pill ' + (ok ? 'live' : 'offline');
  e.textContent = txt;
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
function showConfirm(title, message, callback) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  CONFIRM_CALLBACK = callback;
  document.getElementById('confirmDialog').classList.add('active');
}

function hideConfirm() {
  document.getElementById('confirmDialog').classList.remove('active');
  CONFIRM_CALLBACK = null;
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
  const u = (document.getElementById('loginUsername').value || '').trim();
  const p = (document.getElementById('loginPassword').value || '').trim();
  const e = document.getElementById('loginErr');
  e.textContent = '';

  if (!r) { e.textContent = 'SELECT ROLE.'; return; }

  if (r === 'UNIT') {
    if (!u || u.length < 2) { e.textContent = 'ENTER UNIT ID (E.G. EMS2121, CC1, WC1)'; return; }
  } else {
    if (!u || u.length < 2) { e.textContent = 'ENTER USERNAME'; return; }
    if (!p) { e.textContent = 'ENTER PASSWORD'; return; }
  }

  const res = await API.login(r, u, p);
  if (!res || !res.ok) {
    e.textContent = (res && res.error) ? res.error : 'LOGIN FAILED.';
    return;
  }

  TOKEN = res.token;
  ACTOR = res.actor;
  localStorage.setItem('ems_token', TOKEN);
  document.getElementById('loginBack').style.display = 'none';
  document.getElementById('userLabel').textContent = ACTOR;
  start();
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

async function refresh() {
  if (!TOKEN || _refreshing) return;
  _refreshing = true;

  try {
    const r = await API.getState(TOKEN);
    if (!r || !r.ok) {
      setLive(false, 'OFFLINE');
      return;
    }

    STATE = r;
    setLive(true, 'LIVE • ' + fmtTime24(STATE.serverTime));
    ACTOR = STATE.actor || ACTOR;
    document.getElementById('userLabel').textContent = ACTOR;
    tryBeepOnStateChange();

    // Granular change detection — only re-render what actually changed
    const unitsHash = _computeUnitsHash(r.units);
    const incidentsHash = _computeIncidentsHash(r.incidents);
    const bannersHash = _computeBannersHash(r.banners);
    const messagesHash = _computeMessagesHash(r.messages);

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
  if (_changedSections.units) {
    renderStatusSummary();
    renderBoardDiff(); // Use diffing instead of full rebuild
  }
  if (_changedSections.incidents) renderIncidentQueue();
  if (_changedSections.messages) {
    renderMessagesPanel();
    renderMessages();
    renderInboxPanel();
  }

  // Metrics depend on units
  if (_changedSections.units) renderMetrics();

  applyViewState();
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
        const alertText = (STATE.banners && STATE.banners.alert && STATE.banners.alert.text) || 'ALERT';
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
  renderIncidentQueue();
  renderMessagesPanel();
  renderMessages();
  renderInboxPanel();
  renderMetrics();
  renderBoardDiff(); // Use optimized DOM diffing
  applyViewState();
}

function renderBanners() {
  const a = document.getElementById('alertBanner');
  const n = document.getElementById('noteBanner');
  const b = (STATE && STATE.banners) ? STATE.banners : { alert: null, note: null };

  if (b.alert && b.alert.message) {
    a.style.display = 'block';
    a.textContent = 'ALERT: ' + b.alert.message + ' — ' + (b.alert.actor || '');
  } else {
    a.style.display = 'none';
  }

  if (b.note && b.note.message) {
    n.style.display = 'block';
    n.textContent = 'NOTE: ' + b.note.message + ' — ' + (b.note.actor || '');
  } else {
    n.style.display = 'none';
  }
}

function renderStatusSummary() {
  const el = document.getElementById('statusSummary');
  if (!el) return;

  const units = (STATE.units || []).filter(u => u.active);
  const counts = { AV: 0, D: 0, DE: 0, OS: 0, T: 0, F: 0, BRK: 0, OOS: 0 };

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
  if (t.includes('MED') || t.includes('MEDICAL') || t.includes('EMS')) return 'inc-type-med';
  if (t.includes('TRAUMA') || t.includes('MVA') || t.includes('MVC') || t.includes('ACCIDENT')) return 'inc-type-trauma';
  if (t.includes('FIRE') || t.includes('STRUCTURE') || t.includes('WILDLAND')) return 'inc-type-fire';
  if (t.includes('HAZ') || t.includes('HAZMAT')) return 'inc-type-hazmat';
  if (t.includes('RESCUE') || t.includes('WATER') || t.includes('SWIFT')) return 'inc-type-rescue';
  if (t) return 'inc-type-other';
  return '';
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

  incidents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  let html = '<table class="inc-queue-table"><thead><tr>';
  html += '<th>INC#</th><th>LOCATION</th><th>TYPE</th><th>NOTE</th><th>HOLD</th><th>ACTIONS</th>';
  html += '</tr></thead><tbody>';

  incidents.forEach(inc => {
    const urgent = inc.incident_note && inc.incident_note.includes('[URGENT]');
    const rowCl = urgent ? ' class="inc-urgent"' : '';
    const mins = minutesSince(inc.created_at);
    const age = mins != null ? Math.floor(mins) + 'M' : '--';
    const shortId = inc.incident_id.replace(/^\d{2}-/, '');
    let note = (inc.incident_note || '').replace(/^\[URGENT\]\s*/i, '').trim();
    const incType = inc.incident_type || '';
    const typeCl = getIncidentTypeClass(incType);

    html += `<tr${rowCl} onclick="openIncident('${esc(inc.incident_id)}')">`;
    html += `<td class="inc-id">${urgent ? 'HOT ' : ''}INC${esc(shortId)}</td>`;
    const incDestResolved = AddressLookup.resolve(inc.destination);
    const incDestDisplay = incDestResolved.recognized ? incDestResolved.addr.name : (inc.destination || 'NO DEST');
    html += `<td class="inc-dest${incDestResolved.recognized ? ' dest-recognized' : ''}">${esc(incDestDisplay)}</td>`;
    html += `<td>${incType ? '<span class="inc-type ' + typeCl + '">' + esc(incType) + '</span>' : '<span class="muted">--</span>'}</td>`;
    html += `<td class="inc-note" title="${esc(note)}">${esc(note || '--')}</td>`;
    html += `<td class="inc-age">${age}</td>`;
    html += `<td style="white-space:nowrap;">`;
    html += `<button class="toolbar-btn toolbar-btn-accent" onclick="event.stopPropagation(); assignIncidentToUnit('${esc(inc.incident_id)}')">ASSIGN</button> `;
    html += `<button class="toolbar-btn" onclick="event.stopPropagation(); openIncident('${esc(inc.incident_id)}')">REVIEW</button> `;
    html += `<button class="btn-danger mini" style="padding:3px 6px;font-size:10px;" onclick="event.stopPropagation(); closeIncidentFromQueue('${esc(inc.incident_id)}')">CLOSE</button>`;
    html += `</td>`;
    html += '</tr>';
  });

  html += '</tbody></table>';
  panel.innerHTML = html;
}

function renderMessagesPanel() {
  const panel = document.getElementById('messagesPanel');
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
    const replyCmd = 'MSG ' + msg.from_role + '; ';
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
    const replyCmd = 'MSG ' + msg.from_role + '; ';
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
  const pad = document.getElementById('scratchPad');
  if (!pad) return;
  pad.value = localStorage.getItem(getScratchKey()) || '';
  pad.addEventListener('input', saveScratch);
}

function saveScratch() {
  const pad = document.getElementById('scratchPad');
  if (!pad) return;
  localStorage.setItem(getScratchKey(), pad.value);
}

function renderMetrics() {
  const el = document.getElementById('metrics');
  const m = STATE.metrics || {};
  const av = m.averagesMinutes || {};

  const ls = [];
  ls.push('<div>D→DE AVG: <b>' + (av['D→DE'] ?? '—') + '</b> MIN</div>');
  ls.push('<div>DE→OS AVG: <b>' + (av['DE→OS'] ?? '—') + '</b> MIN</div>');
  ls.push('<div>OS→T  AVG: <b>' + (av['OS→T'] ?? '—') + '</b> MIN</div>');
  ls.push('<div>T→AV  AVG: <b>' + (av['T→AV'] ?? '—') + '</b> MIN</div>');

  if (m.longestCurrentlyOnScene) {
    ls.push('<div style="margin-top:8px;">LONGEST ON SCENE: <b>' + m.longestCurrentlyOnScene.unit + '</b> (' + m.longestCurrentlyOnScene.minutes + 'M)</div>');
  }

  el.innerHTML = ls.join('');
}

function renderBoard() {
  const tb = document.getElementById('boardBody');
  const q = document.getElementById('search').value.trim().toUpperCase();
  const sI = document.getElementById('showInactive').checked;
  const boardCountEl = document.getElementById('boardCount');

  let us = (STATE.units || []).filter(u => {
    if (!sI && !u.active) return false;
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
        const tA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        cmp = tB - tA;
        break;
      }
      case 'status':
      default: {
        const ra = statusRank(a.status);
        const rb = statusRank(b.status);
        cmp = ra - rb;
        if (cmp === 0 && String(a.status || '').toUpperCase() === 'D') {
          const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
          const tbb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
          cmp = tbb - ta;
        }
        if (cmp === 0) cmp = String(a.unit_id || '').localeCompare(String(b.unit_id || ''));
        break;
      }
    }
    return VIEW.sortDir === 'desc' ? -cmp : cmp;
  });

  // Stale detection — expanded to D, DE, OS, T
  const STALE_STATUSES = new Set(['D', 'DE', 'OS', 'T']);
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
    const unitHtml = '<span class="unit">' + esc(uId) + '</span>' +
      (u.active ? '' : ' <span class="muted">(I)</span>') +
      (sD ? ' <span class="muted" style="font-size:10px;">' + esc(di) + '</span>' : '');

    // STATUS column — badge pill + label
    const sL = (STATE.statuses || []).find(s => s.code === u.status)?.label || u.status;
    const stCode = (u.status || '').toUpperCase();
    const statusHtml = '<span class="status-badge status-badge-' + esc(stCode) + '">' + esc(stCode) + '</span> <span class="status-text-' + esc(stCode) + '">' + esc(sL) + '</span>';

    // ELAPSED column — coloring for D, DE, OS, T
    const elapsedVal = formatElapsed(mi);
    let elapsedClass = 'elapsed-cell';
    if (mi != null && STALE_STATUSES.has(stCode)) {
      if (STATE.staleThresholds && mi >= STATE.staleThresholds.CRITICAL) elapsedClass += ' elapsed-critical';
      else if (STATE.staleThresholds && mi >= STATE.staleThresholds.WARN) elapsedClass += ' elapsed-warn';
    }

    // LOCATION column
    const destHtml = AddressLookup.formatBoard(u.destination);

    // NOTES column — incident notes if on incident, status notes otherwise
    let noteText = '';
    if (u.incident) {
      const incObj = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (incObj && incObj.incident_note) noteText = incObj.incident_note.replace(/^\[URGENT\]\s*/i, '').trim();
    }
    if (!noteText) noteText = (u.note || '');
    noteText = noteText.toUpperCase();
    const noteHtml = noteText ? '<span class="noteBig">' + esc(noteText) + '</span>' : '<span class="muted">—</span>';

    // INC# column — with type dot
    let incHtml = '<span class="muted">—</span>';
    if (u.incident) {
      const shortInc = String(u.incident).replace(/^\d{2}-/, '');
      let dotHtml = '';
      const incObj = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (incObj && incObj.incident_type) {
        const dotCl = getIncidentTypeClass(incObj.incident_type).replace('inc-type-', 'inc-type-dot-');
        if (dotCl) dotHtml = '<span class="inc-type-dot ' + dotCl + '"></span>';
      }
      incHtml = dotHtml + '<span class="clickableIncidentNum" onclick="event.stopPropagation(); openIncident(\'' + esc(u.incident) + '\')">' + esc('INC' + shortInc) + '</span>';
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
      openModal(u);
    };

    tr.style.cursor = 'pointer';
    tb.appendChild(tr);
  });
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
    tsCache.set(u.unit_id, u.updated_at ? new Date(u.updated_at).getTime() : 0);
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
  const STALE_STATUSES = new Set(['D', 'DE', 'OS', 'T']);
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

  // Track which rows we've processed
  const processedIds = new Set();

  // Build/update rows using DocumentFragment for batch insert
  const fragment = document.createDocumentFragment();

  us.forEach((u, idx) => {
    const unitId = u.unit_id;
    processedIds.add(unitId);

    // Generate row hash to check if update needed
    const rowHash = unitId + '|' + (u.status || '') + '|' + (u.updated_at || '') + '|' + (u.destination || '') + '|' + (u.note || '') + '|' + (u.incident || '') + '|' + (u.active ? '1' : '0');
    const cached = _rowCache.get(unitId);

    let tr = existingMap.get(unitId);

    // If row exists and hash matches, just reposition if needed
    if (tr && cached && cached.hash === rowHash) {
      // Update stale/selected classes only
      updateRowClasses(tr, u, STALE_STATUSES);
      fragment.appendChild(tr);
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
    const unitHtml = '<span class="unit">' + esc(uId) + '</span>' +
      (u.active ? '' : ' <span class="muted">(I)</span>') +
      (sD ? ' <span class="muted" style="font-size:10px;">' + esc(di) + '</span>' : '');

    // STATUS column
    const sL = (STATE.statuses || []).find(s => s.code === u.status)?.label || u.status;
    const statusHtml = '<span class="status-badge status-badge-' + esc(stCode) + '">' + esc(stCode) + '</span> <span class="status-text-' + esc(stCode) + '">' + esc(sL) + '</span>';

    // ELAPSED column
    const elapsedVal = formatElapsed(mi);
    let elapsedClass = 'elapsed-cell';
    if (mi != null && STALE_STATUSES.has(stCode)) {
      if (STATE.staleThresholds && mi >= STATE.staleThresholds.CRITICAL) elapsedClass += ' elapsed-critical';
      else if (STATE.staleThresholds && mi >= STATE.staleThresholds.WARN) elapsedClass += ' elapsed-warn';
    }

    // LOCATION column
    const destHtml = AddressLookup.formatBoard(u.destination);

    // NOTES column
    let noteText = '';
    if (u.incident) {
      const incObj = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (incObj && incObj.incident_note) noteText = incObj.incident_note.replace(/^\[URGENT\]\s*/i, '').trim();
    }
    if (!noteText) noteText = (u.note || '');
    noteText = noteText.toUpperCase();
    const noteHtml = noteText ? '<span class="noteBig">' + esc(noteText) + '</span>' : '<span class="muted">—</span>';

    // INC# column
    let incHtml = '<span class="muted">—</span>';
    if (u.incident) {
      const shortInc = String(u.incident).replace(/^\d{2}-/, '');
      let dotHtml = '';
      const incObj = (STATE.incidents || []).find(i => i.incident_id === u.incident);
      if (incObj && incObj.incident_type) {
        const dotCl = getIncidentTypeClass(incObj.incident_type).replace('inc-type-', 'inc-type-dot-');
        if (dotCl) dotHtml = '<span class="inc-type-dot ' + dotCl + '"></span>';
      }
      incHtml = dotHtml + '<span class="clickableIncidentNum" data-inc="' + esc(u.incident) + '">' + esc('INC' + shortInc) + '</span>';
    }

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
    } else {
      // Create new row
      tr = document.createElement('tr');
      tr.dataset.unitId = unitId;
      tr.className = rowClasses;
      tr.innerHTML = rowHtml;
      tr.style.cursor = 'pointer';
    }

    // Cache the row
    _rowCache.set(unitId, { hash: rowHash });

    fragment.appendChild(tr);
  });

  // Clear and append all at once
  tb.innerHTML = '';
  tb.appendChild(fragment);

  // Clean up cache for removed units
  for (const key of _rowCache.keys()) {
    if (!processedIds.has(key)) _rowCache.delete(key);
  }
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
  if (SELECTED_UNIT_ID === id) {
    SELECTED_UNIT_ID = null;
  } else {
    SELECTED_UNIT_ID = id;
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
function openModal(u, f = false) {
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
  document.getElementById('mNote').value = u ? (u.note || '') : '';
  document.getElementById('mUnitInfo').value = u ? (u.unit_info || '') : '';
  document.getElementById('modalTitle').textContent = u ? 'EDIT ' + u.unit_id : 'LOGON UNIT';
  document.getElementById('modalFoot').textContent = u ? 'UPDATED: ' + (u.updated_at || '—') + ' BY ' + (u.updated_by || '—') : 'TIP: SET STATUS TO D WITH INCIDENT BLANK TO AUTO-GENERATE.';
  b.dataset.expectedUpdatedAt = u ? (u.updated_at || '') : '';
  if (f) {
    setTimeout(() => document.getElementById('mUnitInfo').focus(), 50);
  }
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

  let dN = (document.getElementById('mDisplayName').value || '').trim().toUpperCase();
  if (!dN) dN = displayNameForUnit(uId);

  const destEl = document.getElementById('mDestination');
  const destVal = destEl.dataset.addrId || (destEl.value || '').trim().toUpperCase();

  const p = {
    displayName: dN,
    type: (document.getElementById('mType').value || '').trim().toUpperCase(),
    status: document.getElementById('mStatus').value,
    destination: destVal,
    incident: (document.getElementById('mIncident').value || '').trim().toUpperCase(),
    note: (document.getElementById('mNote').value || '').toUpperCase(),
    unitInfo: (document.getElementById('mUnitInfo').value || '').toUpperCase(),
    active: true
  };

  const eUA = document.getElementById('modalBack').dataset.expectedUpdatedAt || '';
  setLive(true, 'LIVE • SAVING');
  const r = await API.upsertUnit(TOKEN, uId, p, eUA);
  if (!r.ok) return showErr(r);
  beepChange();
  closeModal();
  refresh();
}

function confirmLogoff() {
  const uId = canonicalUnit(document.getElementById('mUnitId').value);
  if (!uId) return;
  const eUA = document.getElementById('modalBack').dataset.expectedUpdatedAt || '';
  const currentStatus = document.getElementById('mStatus').value;
  const needsConfirm = ['OS', 'T', 'D', 'DE'].includes(currentStatus);

  if (needsConfirm) {
    showConfirm('CONFIRM LOGOFF', 'LOGOFF ' + uId + ' (CURRENTLY ' + currentStatus + ')?', async () => {
      setLive(true, 'LIVE • LOGOFF');
      const r = await API.logoffUnit(TOKEN, uId, eUA);
      if (!r.ok) return showErr(r);
      beepChange();
      closeModal();
      refresh();
    });
  } else {
    (async () => {
      setLive(true, 'LIVE • LOGOFF');
      const r = await API.logoffUnit(TOKEN, uId, eUA);
      if (!r.ok) return showErr(r);
      beepChange();
      closeModal();
      refresh();
    })();
  }
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

  const units = (STATE.units || []).filter(u => u.active && u.status === 'AV');
  units.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.unit_id;
    opt.textContent = u.unit_id + (u.display_name && u.display_name !== u.unit_id ? ' - ' + u.display_name : '');
    unitSelect.appendChild(opt);
  });

  const newIncDestEl = document.getElementById('newIncDest');
  newIncDestEl.value = '';
  delete newIncDestEl.dataset.addrId;
  document.getElementById('newIncType').value = '';
  document.getElementById('newIncNote').value = '';
  document.getElementById('newIncUrgent').checked = false;
  document.getElementById('newIncBack').style.display = 'flex';
  setTimeout(() => newIncDestEl.focus(), 50);
}

function closeNewIncident() {
  document.getElementById('newIncBack').style.display = 'none';
  autoFocusCmd();
}

async function createNewIncident() {
  const destEl = document.getElementById('newIncDest');
  const dest = destEl.dataset.addrId || destEl.value.trim().toUpperCase();
  const note = document.getElementById('newIncNote').value.trim().toUpperCase();
  const urgent = document.getElementById('newIncUrgent').checked;
  const unitId = document.getElementById('newIncUnit').value;
  const incType = (document.getElementById('newIncType').value || '').trim().toUpperCase();

  if (!dest) {
    showAlert('ERROR', 'DESTINATION REQUIRED.');
    return;
  }

  const finalNote = (urgent && note ? '[URGENT] ' + note : (urgent ? '[URGENT]' : note));

  setLive(true, 'LIVE • CREATE INCIDENT');
  const r = await API.createQueuedIncident(TOKEN, dest, finalNote, urgent, unitId, incType);
  if (!r.ok) return showErr(r);
  beepChange();
  if (r.urgent) beepAlert();
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
    const cmd = `DE ${unitId} ${incidentId}`;
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
  document.getElementById('incTypeEdit').value = (inc.incident_type || '').toUpperCase();
  document.getElementById('incUpdated').textContent = inc.last_update ? fmtTime24(inc.last_update) : '—';

  const bC = getRoleColor(inc.updated_by);
  const bE = document.getElementById('incBy');
  bE.textContent = (inc.updated_by || '—').toUpperCase();
  bE.className = bC;

  document.getElementById('incNote').value = (inc.incident_note || '').toUpperCase();
  renderIncidentAudit(r.audit || []);
  document.getElementById('incBack').style.display = 'flex';
  setTimeout(() => document.getElementById('incNote').focus(), 50);
}

function openIncident(iId) {
  openIncidentFromServer(iId);
}

function closeIncidentPanel() {
  document.getElementById('incBack').style.display = 'none';
  CURRENT_INCIDENT_ID = '';
}

// Keep old name as alias for ESC key handler etc.
function closeIncident() { closeIncidentPanel(); }

async function closeIncidentAction() {
  const incId = CURRENT_INCIDENT_ID;
  if (!incId) { showAlert('ERROR', 'NO INCIDENT OPEN'); return; }
  closeIncidentPanel();
  setLive(true, 'LIVE • CLOSE INCIDENT');
  try {
    const r = await API.closeIncident(TOKEN, incId);
    if (!r.ok) { showAlert('ERROR', r.error || 'FAILED TO CLOSE INCIDENT'); return; }
    refresh();
  } catch (e) {
    showAlert('ERROR', 'FAILED TO CLOSE INCIDENT: ' + e.message);
  }
}

async function reopenIncidentAction() {
  const incId = CURRENT_INCIDENT_ID;
  if (!incId) { showAlert('ERROR', 'NO INCIDENT OPEN'); return; }
  closeIncidentPanel();
  setLive(true, 'LIVE • REOPEN INCIDENT');
  try {
    const r = await API.reopenIncident(TOKEN, incId);
    if (!r.ok) { showAlert('ERROR', r.error || 'FAILED TO REOPEN INCIDENT'); return; }
    beepChange();
    showAlert('INCIDENT REOPENED', 'INCIDENT ' + incId + ' REOPENED.');
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
  if (!CURRENT_INCIDENT_ID) return;

  // Get current incident to compare destination
  const curInc = (STATE.incidents || []).find(i => i.incident_id === CURRENT_INCIDENT_ID);
  const curDest = curInc ? (curInc.destination || '') : '';
  const destChanged = newDest !== curDest.toUpperCase();

  // If anything changed, use updateIncident
  if (newType || m || destChanged) {
    setLive(true, 'LIVE • UPDATE INCIDENT');
    const r = await API.updateIncident(TOKEN, CURRENT_INCIDENT_ID, m, newType, destChanged ? newDest : undefined);
    if (!r.ok) return showErr(r);
    beepChange();
    closeIncidentPanel();
    refresh();
    return;
  }

  showConfirm('ERROR', 'ENTER INCIDENT NOTE, CHANGE TYPE, OR UPDATE DESTINATION.', () => { });
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

async function loadMetrics(h) {
  document.getElementById('metricWindow').textContent = String(h);
  const r = await API.getMetrics(TOKEN, h);
  if (!r.ok) return showErr(r);
  STATE.metrics = r.metrics;
  renderMetrics();
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

  let ma = tx;
  let no = '';
  const se = tx.indexOf(';');
  if (se >= 0) {
    ma = tx.slice(0, se).trim();
    no = tx.slice(se + 1).trim();
  }

  const mU = ma.toUpperCase();
  const nU = expandShortcutsInText(no || '');

  if (mU === 'HELP' || mU === 'H') return showHelp();
  if (mU === 'ADMIN') return showAdmin();
  if (mU === 'REFRESH') { refresh(); return; }

  // ── VIEW / DISPLAY COMMANDS ──

  // V SIDE/MSG/MET/INC/ALL/NONE
  if (/^V\s+/i.test(mU)) {
    const panel = mU.substring(2).trim();
    if (panel === 'SIDE') toggleView('sidebar');
    else if (panel === 'MSG') toggleView('messages');
    else if (panel === 'MET') toggleView('metrics');
    else if (panel === 'INC') toggleView('incidents');
    else if (panel === 'ALL') toggleView('all');
    else if (panel === 'NONE') toggleView('none');
    else { showAlert('ERROR', 'USAGE: V SIDE/MSG/MET/INC/ALL/NONE'); }
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
      showAlert('ERROR', 'USAGE: F <STATUS> OR F ALL\nVALID: D, DE, OS, F, FD, T, AV, UV, BRK, OOS');
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
    const p = document.getElementById('scratchPanel');
    if (p && p.classList.contains('collapsed')) p.classList.remove('collapsed');
    const pad = document.getElementById('scratchPad');
    if (pad) pad.focus();
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

  // LUI - Logon Unit Interface
  if (mU === 'LUI') return openModal(null);
  if (mU.startsWith('LUI ')) {
    const uR = ma.substring(4).trim();
    const uId = canonicalUnit(uR);
    const dN = displayNameForUnit(uId);
    const u = { unit_id: uId, display_name: dN, type: '', active: true, status: 'AV', note: '', unit_info: '', incident: '', destination: '', updated_at: '', updated_by: '' };
    return openModal(u);
  }

  // User management
  if (mU.startsWith('NEWUSER ')) {
    const parts = ma.substring(8).trim().split(',');
    if (parts.length !== 2) { showAlert('ERROR', 'USAGE: NEWUSER lastname,firstname'); return; }
    const r = await API.newUser(TOKEN, parts[0].trim(), parts[1].trim());
    if (!r.ok) return showErr(r);
    const collisionMsg = r.collision ? '\n\nUSERNAME COLLISION - NUMBER ADDED' : '';
    showAlert('USER CREATED', `NEW USER CREATED:${collisionMsg}\n\nNAME: ${r.firstName} ${r.lastName}\nUSERNAME: ${r.username}\nPASSWORD: ${r.password}\n\nUser can now log in with this username and password.`);
    return;
  }

  if (mU.startsWith('DELUSER ')) {
    const u = ma.substring(8).trim();
    if (!u) { showAlert('ERROR', 'USAGE: DELUSER username'); return; }
    showConfirm('CONFIRM DELETE USER', 'DELETE USER: ' + u + '?', async () => {
      const r = await API.delUser(TOKEN, u);
      if (!r.ok) return showErr(r);
      showAlert('USER DELETED', 'USER DELETED: ' + r.username);
    });
    return;
  }

  // REPORTOOS - Out of Service report
  if (mU.startsWith('REPORTOOS')) {
    const ts = mU.substring(9).trim().toUpperCase();
    let hrs = 24;
    if (ts) {
      const m = ts.match(/^(\d+)(H|D)?$/);
      if (m) {
        const n = parseInt(m[1]);
        const ut = m[2] || 'H';
        hrs = ut === 'D' ? n * 24 : n;
      } else {
        showAlert('ERROR', 'USAGE: REPORTOOS [24H|7D|30D]\nH=HOURS, D=DAYS\nExample: REPORTOOS24H or REPORTOOS7D');
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

  if (mU === 'LISTUSERS') {
    const r = await API.listUsers(TOKEN);
    if (!r.ok) return showErr(r);
    const users = r.users || [];
    if (!users.length) { showAlert('USERS', 'NO USERS IN SYSTEM'); return; }
    const userList = users.map(u => `${u.username} - ${u.firstName} ${u.lastName}`).join('\n');
    showAlert('SYSTEM USERS (' + users.length + ')', userList);
    return;
  }

  if (mU.startsWith('PASSWD ')) {
    const parts = ma.substring(7).trim().split(/\s+/);
    if (parts.length !== 2) { showAlert('ERROR', 'USAGE: PASSWD oldpassword newpassword'); return; }
    const r = await API.changePassword(TOKEN, parts[0], parts[1]);
    if (!r.ok) return showErr(r);
    showAlert('PASSWORD CHANGED', 'YOUR PASSWORD HAS BEEN CHANGED SUCCESSFULLY.');
    return;
  }

  // Search
  if (mU.startsWith('! ')) {
    const query = ma.substring(2).trim().toUpperCase();
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
  if (mU.startsWith('CLEARDATA ')) {
    if (!isAdminRole()) {
      showAlert('ACCESS DENIED', 'CLEARDATA COMMANDS REQUIRE ADMIN LOGIN (SUPV/MGR/IT).');
      return;
    }
    const what = ma.substring(10).trim().toUpperCase();
    if (!['UNITS', 'INACTIVE', 'AUDIT', 'INCIDENTS', 'MESSAGES', 'SESSIONS', 'ALL'].includes(what)) {
      showAlert('ERROR', 'USAGE: CLEARDATA [UNITS|INACTIVE|AUDIT|INCIDENTS|MESSAGES|SESSIONS|ALL]');
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

  // WHO - logged in users
  if (mU === 'WHO') {
    const r = await API.who(TOKEN);
    if (!r.ok) return showErr(r);
    const users = r.users || [];
    if (!users.length) { showAlert('WHO', 'NO DISPATCHERS ONLINE', 'yellow'); return; }
    const userList = users.map(u => `${u.actor} (${u.minutesAgo}M AGO)`).join('\n');
    showAlert('DISPATCHERS ONLINE (' + users.length + ')', userList, 'yellow');
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

  // LO / LOGOUT
  if (mU === 'LO' || mU === 'LOGOUT' || mU.startsWith('LO ')) {
    const targetRole = mU.startsWith('LO ') ? mU.substring(3).trim().toUpperCase() : '';
    if (targetRole && targetRole !== ACTOR.split('@')[1]) {
      showAlert('ERROR', 'YOU CAN ONLY LOG OUT YOURSELF. YOU ARE ' + ACTOR);
      return;
    }
    if (!confirm('LOG OUT OF HOSCAD?')) return;
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
    if (!iR) { showConfirm('ERROR', 'USAGE: U INC0001; MESSAGE', () => { }); return; }
    if (!nU) { showConfirm('ERROR', 'USAGE: U INC0001; MESSAGE (MESSAGE REQUIRED)', () => { }); return; }
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
    if (!ncRaw) { showAlert('ERROR', 'USAGE: NC <LOCATION>; <NOTE>; <TYPE>\nNOTE AND TYPE ARE OPTIONAL'); return; }
    const ncParts = ncRaw.split(';').map(p => p.trim().toUpperCase());
    const dest = ncParts[0] || '';
    const note = ncParts[1] || '';
    const incType = ncParts[2] || '';
    if (!dest) { showAlert('ERROR', 'USAGE: NC <LOCATION>; <NOTE>; <TYPE>'); return; }
    setLive(true, 'LIVE • CREATE INCIDENT');
    const r = await API.createQueuedIncident(TOKEN, dest, note, false, '', incType);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    autoFocusCmd();
    return;
  }

  // LINK - Link two units to incident
  if (mU.startsWith('LINK ')) {
    const ps = ma.substring(5).trim().split(/\s+/);
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
    const ps = ma.substring(9).trim().split(/\s+/);
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
    const delCanMatch = mU.match(/^(?:DEL|CAN)\s+(?:INC\s*)?(\d{3,4})$/) ||
                        mU.match(/^(\d{3,4})\s+(?:DEL|CAN)$/) ||
                        mU.match(/^(?:DEL|CAN)(\d{3,4})$/) ||
                        mU.match(/^(\d{3,4})(?:DEL|CAN)$/);
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

  // RQ - Reopen incident
  if (mU.startsWith('RQ ')) {
    const inc = ma.substring(3).trim().toUpperCase();
    if (!inc) { showConfirm('ERROR', 'USAGE: RQ INC0001', () => { }); return; }
    const r = await API.reopenIncident(TOKEN, inc);
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // MASS D - Mass dispatch
  if (mU.startsWith('MASS D ')) {
    const de = ma.substring(7).trim().toUpperCase();
    if (!de) { showConfirm('ERROR', 'USAGE: MASS D <DESTINATION>', () => { }); return; }
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
    const ps = ma.trim().split(/\s+/);
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
    const ps = ma.trim().split(/\s+/).filter(Boolean);
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

  // LOGON
  if (mU.startsWith('LOGON ')) {
    const u = canonicalUnit(ma.substring(6).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: LOGON <UNIT>; <NOTE>', () => { }); return; }
    const dN = displayNameForUnit(u);
    setLive(true, 'LIVE • LOGON');
    const r = await API.upsertUnit(TOKEN, u, { active: true, status: 'AV', note: nU, displayName: dN }, '');
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // LOGOFF
  if (mU.startsWith('LOGOFF ')) {
    const u = canonicalUnit(ma.substring(7).trim());
    if (!u) { showConfirm('ERROR', 'USAGE: LOGOFF <UNIT>', () => { }); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === u) : null;
    const currentStatus = uO ? uO.status : '';
    const needsConfirm = ['OS', 'T', 'D', 'DE'].includes(currentStatus);
    if (needsConfirm) {
      showConfirm('CONFIRM LOGOFF', 'LOGOFF ' + u + ' (CURRENTLY ' + currentStatus + ')?', async () => {
        setLive(true, 'LIVE • LOGOFF');
        const r = await API.logoffUnit(TOKEN, u, '');
        if (!r.ok) return showErr(r);
        beepChange();
        refresh();
      });
    } else {
      setLive(true, 'LIVE • LOGOFF');
      const r = await API.logoffUnit(TOKEN, u, '');
      if (!r.ok) return showErr(r);
      beepChange();
      refresh();
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
    if (!u) { showAlert('ERROR', 'USAGE: DEST <UNIT>; <LOCATION>\nDEST <UNIT> (CLEAR DESTINATION)'); return; }
    const uO = (STATE && STATE.units) ? STATE.units.find(x => String(x.unit_id || '').toUpperCase() === u) : null;
    if (!uO) { showAlert('ERROR', 'UNIT NOT FOUND: ' + u); return; }
    let destVal = (nU || '').trim().toUpperCase();
    if (destVal) {
      // Try to resolve to a known address ID
      const byId = AddressLookup.getById(destVal);
      if (byId) {
        destVal = byId.id;
      } else {
        const results = AddressLookup.search(destVal, 3);
        if (results.length === 1) destVal = results[0].id;
      }
    }
    setLive(true, 'LIVE • SET DEST');
    const r = await API.upsertUnit(TOKEN, u, { destination: destVal, displayName: uO.display_name }, uO.updated_at || '');
    if (!r.ok) return showErr(r);
    beepChange();
    refresh();
    return;
  }

  // Messaging
  if (mU === 'MSGALL') {
    if (!nU) { showAlert('ERROR', 'USAGE: MSGALL; MESSAGE TEXT'); return; }
    const r = await API.sendBroadcast(TOKEN, nU, false);
    if (!r.ok) return showErr(r);
    showAlert('MESSAGE SENT', `BROADCAST MESSAGE SENT TO ${r.recipients} RECIPIENTS`);
    beepChange();
    refresh();
    return;
  }

  if (mU === 'HTALL') {
    if (!nU) { showAlert('ERROR', 'USAGE: HTALL; URGENT MESSAGE TEXT'); return; }
    const r = await API.sendBroadcast(TOKEN, nU, true);
    if (!r.ok) return showErr(r);
    showAlert('URGENT MESSAGE SENT', `URGENT BROADCAST SENT TO ${r.recipients} RECIPIENTS`);
    refresh();
    return;
  }

  if (mU.startsWith('MSG ')) {
    const tR = ma.substring(4).trim().toUpperCase();
    if (!tR || !nU) { showAlert('ERROR', 'USAGE: MSG STA2; MESSAGE TEXT  (OR MSG EMS12; TEXT)'); return; }
    const r = await API.sendMessage(TOKEN, tR, nU, false);
    if (!r.ok) return showErr(r);
    refresh();
    return;
  }

  if (mU.startsWith('HTMSG ')) {
    const tR = ma.substring(6).trim().toUpperCase();
    if (!tR || !nU) { showConfirm('ERROR', 'USAGE: HTMSG STA2; URGENT MESSAGE', () => { }); return; }
    const r = await API.sendMessage(TOKEN, tR, nU, true);
    if (!r.ok) return showErr(r);
    refresh();
    return;
  }

  if (/^MSG\d+$/i.test(mU)) {
    return viewMessage(mU);
  }

  if (mU.startsWith('DEL ALL MSG')) {
    return deleteAllMessages();
  }

  if (mU.startsWith('DEL MSG')) {
    const re = mU.substring(7).trim();
    if (!re) { showConfirm('ERROR', 'USAGE: DEL MSG1 OR DEL ALL MSG', () => { }); return; }
    const msgId = re.toUpperCase();
    if (/^MSG\d+$/i.test(msgId) || /^\d+$/.test(re)) {
      const finalId = /^\d+$/.test(re) ? 'MSG' + re : msgId;
      return deleteMessage(finalId);
    }
    showConfirm('ERROR', 'USAGE: DEL MSG1 OR DEL ALL MSG', () => { });
    return;
  }

  // Parse status + unit commands (D JC; MADRAS ED, JC OS, etc.)
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

  // Check for incident ID at end of unit
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

  const u = canonicalUnit(rawUnit);
  const dN = displayNameForUnit(u);
  const p = { status: stCmd, displayName: dN };
  if (nU) p.note = nU;
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
  const matches = CMD_HINTS.filter(h => h.cmd.toUpperCase().startsWith(q)).slice(0, 5);

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

function showHelp() {
  showAlert('HELP - COMMAND REFERENCE', `SCMC HOSCAD/EMS TRACKING - COMMAND REFERENCE

═══════════════════════════════════════════════════
VIEW / DISPLAY COMMANDS
═══════════════════════════════════════════════════
V SIDE                  Toggle sidebar panel
V MSG                   Toggle messages in sidebar
V MET                   Toggle metrics in sidebar
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
WHO                     Show all logged-in users
US                      Unit status report (all units)
LO                      Logout and return to login
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

DEST <UNIT>; <LOCATION> Set unit destination
  DEST EMS1; SCB         → resolves to ST. CHARLES BEND
  DEST EMS1; BEND ED     → freeform text
  DEST EMS1              → clears destination
  NOTE: Assigning an incident (DE UNIT INC#)
  auto-copies incident destination to unit.

LOGON <UNIT>; <NOTE>    Activate unit
LOGOFF <UNIT>           Deactivate unit
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
NC <LOCATION>; <NOTE>; <TYPE>  Create new incident
  Example: NC BEND ED; CHEST PAIN; MED
  Note and type are optional: NC BEND ED

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
// Initialization
// ============================================================
function updateClock() {
  const el = document.getElementById('clockPill');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function start() {
  await API.init();
  loadViewState();
  refresh();
  AddressLookup.load(); // async, non-blocking — autocomplete works once data arrives
  if (POLL) clearInterval(POLL);
  POLL = setInterval(refresh, 10000);
  updateClock();
  var _clockInterval = setInterval(updateClock, 1000);
  document.getElementById('search').addEventListener('input', renderBoard);
  document.getElementById('showInactive').addEventListener('change', renderBoard);
  setupColumnSort();
  applyViewState();
  loadScratch();

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

  // Incident modal: Ctrl+Enter saves note
  document.getElementById('incNote').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      saveIncidentNote();
    }
  });

  // Setup login form
  document.getElementById('loginRole').value = '';
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';

  document.getElementById('loginRole').addEventListener('change', (e) => {
    const isUnit = e.target.value === 'UNIT';
    document.getElementById('loginPasswordRow').style.display = isUnit ? 'none' : 'flex';
    if (isUnit) document.getElementById('loginPassword').value = '';
  });

  document.getElementById('loginRole').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginUsername').focus();
  });

  document.getElementById('loginUsername').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (document.getElementById('loginRole').value === 'UNIT') {
        login();
      } else {
        document.getElementById('loginPassword').focus();
      }
    }
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
    if (e.key === 'F1') { e.preventDefault(); cI.focus(); }
    if (e.key === 'F2') { e.preventDefault(); openNewIncident(); }
    if (e.key === 'F3') { e.preventDefault(); cI.focus(); }
    if (e.key === 'F4') { e.preventDefault(); openMessages(); }
  });

  // Confirm dialog handlers
  document.getElementById('confirmOk').addEventListener('click', () => {
    const cb = CONFIRM_CALLBACK;
    hideConfirm();
    if (cb) cb();
  });

  document.getElementById('confirmClose').addEventListener('click', () => {
    hideConfirm();
  });

  document.getElementById('alertClose').addEventListener('click', () => {
    hideAlert();
  });

  // Enter key closes dialogs and modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Don't intercept Enter in textareas or inputs (unless it's a button)
      const tag = e.target.tagName;
      const isTextarea = tag === 'TEXTAREA';
      const isInput = tag === 'INPUT' && e.target.type !== 'button';

      // Alert/Confirm dialogs have priority
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
        if (cb) cb();
        return;
      }

      // Skip if in textarea or input (let them handle Enter normally, except for specific cases)
      if (isTextarea || isInput) return;

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
        if (u) openModal(u);
      }
    });
  }

  // Show login screen
  document.getElementById('loginBack').style.display = 'flex';
  document.getElementById('userLabel').textContent = '—';

});
