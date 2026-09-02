'use strict';

const state = require('../core/state');

function Save() { return require('../storage/database').SaveDatabase(); }

function Clean(scope, actor = 'admin') {
    scope = String(scope || '').trim().toUpperCase();
    const result = {};
    if (scope === 'ALL' || scope === 'REQUEST_TRACES') result.requestTraces = require('./requestTrace').ClearHistory();
    if (scope === 'ALL' || scope === 'BUILD_SESSIONS') result.buildSessions = require('./buildGate').ClearHistory();
    if (scope === 'ALL' || scope === 'QR_AUTH') result.qrAuth = require('./qrApproval').ClearHistory();
    if (scope === 'ALL' || scope === 'CONFIG') result.config = require('./configHistory').ClearHistory(actor);
    if (scope === 'ALL' || scope === 'DAILY_REPORTS') result.dailyReports = require('./dailyHealth').ClearHistory();
    if (scope === 'ALL' || scope === 'DLQ') result.dlq = require('./requestRecovery').ClearResolvedHistory();
    if (scope === 'ALL' || scope === 'NOTIFICATIONS') {
        const removed = state.notifications.length;
        require('./notificationCenter').ClearNotifications();
        result.notifications = { removed };
    }
    const valid = ['ALL', 'REQUEST_TRACES', 'BUILD_SESSIONS', 'QR_AUTH', 'CONFIG', 'DAILY_REPORTS', 'DLQ', 'NOTIFICATIONS', 'AUDIT'];
    if (!valid.includes(scope)) return { ok: false, reason: 'INVALID_HISTORY_SCOPE' };
    Save();
    if (scope === 'ALL' || scope === 'AUDIT') result.audit = require('../storage/audit').ClearAudit();
    console.log('[ADMIN]', `HISTORY_CLEAN ${scope} BY ${actor}`);
    return { ok: true, scope, result };
}

module.exports = { Clean };
