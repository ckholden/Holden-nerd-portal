/**
 * HOSCAD/EMS Tracking System - API Wrapper
 *
 * This module wraps all Google Apps Script API calls with fetch-based requests
 * for use from an external frontend hosted on holdenportal.com/hoscad
 */

const API = {
  // IMPORTANT: Update this URL after deploying the Apps Script as a web app
  // Format: https://script.google.com/macros/s/DEPLOYMENT_ID/exec
  baseUrl: 'https://script.google.com/macros/s/AKfycbwGI9o9U32EAIjaCC28Y7wdGruach4L2wAXBDNv3mUdbGkKM2OeGgGw5G0llK_GYTft/exec',

  /**
   * Make an API call to the Google Apps Script backend
   * @param {string} action - The API function name (e.g., 'login', 'getState')
   * @param {...any} params - Parameters to pass to the API function
   * @returns {Promise<Object>} - The API response
   */
  async call(action, ...params) {
    const url = new URL(this.baseUrl);
    url.searchParams.set('action', action);
    url.searchParams.set('params', JSON.stringify(params));

    try {
      // Google Apps Script redirects 302 to script.googleusercontent.com
      // Plain fetch() with no options handles this best
      const response = await fetch(url.toString());
      const text = await response.text();

      try {
        return JSON.parse(text);
      } catch (parseErr) {
        console.error('API response not JSON:', text.substring(0, 200));
        return { ok: false, error: 'INVALID RESPONSE FROM SERVER. IS THE BACKEND DEPLOYED?' };
      }
    } catch (error) {
      console.error(`API call failed: ${action}`, error);
      return { ok: false, error: 'NETWORK ERROR: ' + (error.message || 'FAILED TO FETCH. CHECK BROWSER CONSOLE.') };
    }
  },

  // ============================================================
  // Authentication
  // ============================================================

  init() {
    return this.call('init');
  },

  login(role, username, password) {
    return this.call('login', role, username, password);
  },

  logout(token) {
    return this.call('logout', token);
  },

  // ============================================================
  // State & Data
  // ============================================================

  getState(token) {
    return this.call('getState', token);
  },

  getMetrics(token, hours) {
    return this.call('getMetrics', token, hours);
  },

  getSystemStatus(token) {
    return this.call('getSystemStatus', token);
  },

  // ============================================================
  // Unit Operations
  // ============================================================

  upsertUnit(token, unitId, patch, expectedUpdatedAt) {
    return this.call('upsertUnit', token, unitId, patch, expectedUpdatedAt);
  },

  logoffUnit(token, unitId, expectedUpdatedAt) {
    return this.call('logoffUnit', token, unitId, expectedUpdatedAt);
  },

  ridoffUnit(token, unitId, expectedUpdatedAt) {
    return this.call('ridoffUnit', token, unitId, expectedUpdatedAt);
  },

  touchUnit(token, unitId, expectedUpdatedAt) {
    return this.call('touchUnit', token, unitId, expectedUpdatedAt);
  },

  touchAllOS(token) {
    return this.call('touchAllOS', token);
  },

  undoUnit(token, unitId) {
    return this.call('undoUnit', token, unitId);
  },

  getUnitInfo(token, unitId) {
    return this.call('getUnitInfo', token, unitId);
  },

  getUnitHistory(token, unitId, hours) {
    return this.call('getUnitHistory', token, unitId, hours);
  },

  massDispatch(token, destination) {
    return this.call('massDispatch', token, destination);
  },

  // ============================================================
  // Incident Operations
  // ============================================================

  createQueuedIncident(token, destination, note, urgent, assignUnitId, incidentType) {
    return this.call('createQueuedIncident', token, destination, note, urgent, assignUnitId, incidentType);
  },

  getIncident(token, incidentId) {
    return this.call('getIncident', token, incidentId);
  },

  updateIncident(token, incidentId, message, incidentType, destination) {
    return this.call('updateIncident', token, incidentId, message, incidentType, destination);
  },

  appendIncidentNote(token, incidentId, message) {
    return this.call('appendIncidentNote', token, incidentId, message);
  },

  touchIncident(token, incidentId) {
    return this.call('touchIncident', token, incidentId);
  },

  linkUnits(token, unit1Id, unit2Id, incidentId) {
    return this.call('linkUnits', token, unit1Id, unit2Id, incidentId);
  },

  transferIncident(token, fromUnitId, toUnitId, incidentId) {
    return this.call('transferIncident', token, fromUnitId, toUnitId, incidentId);
  },

  closeIncident(token, incidentId) {
    return this.call('closeIncident', token, incidentId);
  },

  reopenIncident(token, incidentId) {
    return this.call('reopenIncident', token, incidentId);
  },

  // ============================================================
  // Messaging
  // ============================================================

  sendMessage(token, toRole, message, urgent) {
    return this.call('sendMessage', token, toRole, message, urgent);
  },

  sendBroadcast(token, message, urgent) {
    return this.call('sendBroadcast', token, message, urgent);
  },

  getMessages(token) {
    return this.call('getMessages', token);
  },

  readMessage(token, messageId) {
    return this.call('readMessage', token, messageId);
  },

  deleteMessage(token, messageId) {
    return this.call('deleteMessage', token, messageId);
  },

  deleteAllMessages(token) {
    return this.call('deleteAllMessages', token);
  },

  // ============================================================
  // Banners
  // ============================================================

  setBanner(token, kind, message) {
    return this.call('setBanner', token, kind, message);
  },

  // ============================================================
  // User Management
  // ============================================================

  newUser(token, lastName, firstName) {
    return this.call('newUser', token, lastName, firstName);
  },

  delUser(token, username) {
    return this.call('delUser', token, username);
  },

  listUsers(token) {
    return this.call('listUsers', token);
  },

  listUsersAdmin(token) {
    return this.call('listUsersAdmin', token);
  },

  changePassword(token, oldPassword, newPassword) {
    return this.call('changePassword', token, oldPassword, newPassword);
  },

  // ============================================================
  // Session Management
  // ============================================================

  who(token) {
    return this.call('who', token);
  },

  clearSessions(token) {
    return this.call('clearSessions', token);
  },

  // ============================================================
  // Reports & Export
  // ============================================================

  reportOOS(token, hours) {
    return this.call('reportOOS', token, hours);
  },

  exportAuditCsv(token, hours) {
    return this.call('exportAuditCsv', token, hours);
  },

  // ============================================================
  // Search & Data Management
  // ============================================================

  search(token, query) {
    return this.call('search', token, query);
  },

  clearData(token, what) {
    return this.call('clearData', token, what);
  },

  // ============================================================
  // Addresses
  // ============================================================

  getAddresses(token) {
    return this.call('getAddresses', token);
  },

  // ============================================================
  // Maintenance
  // ============================================================

  runPurge(token) {
    return this.call('runPurge', token);
  }
};

// Export for module systems (if used)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
