'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function BuildDatabaseObject(...args) { return require('./database').BuildDatabaseObject(...args); }
function EnsureDirs(...args) { return require('../core/utils').EnsureDirs(...args); }
function ForceReconnectAll(...args) { return require('../core/lifecycle').ForceReconnectAll(...args); }
function ImportDatabaseObject(...args) { return require('./database').ImportDatabaseObject(...args); }
function LogEvent(...args) { return require('./audit').LogEvent(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }
function SaveDatabase(...args) { return require('./database').SaveDatabase(...args); }
function TryLoadJson(...args) { return require('./database').TryLoadJson(...args); }

function CleanupBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(x => x.endsWith('.json'))
            .map(file => ({ file, time: fs.statSync(path.join(BACKUP_DIR, file)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        for (let i = MAX_BACKUPS; i < files.length; i++) {
            try { fs.unlinkSync(path.join(BACKUP_DIR, files[i].file)); } catch (_) {}
        }
    } catch (_) {}
}

function CreateBackup(reason) {
    EnsureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `relay-${stamp}-${SafeField(reason || 'backup').replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
    try {
        fs.writeFileSync(path.join(BACKUP_DIR, file), JSON.stringify(BuildDatabaseObject(), null, 2), 'utf8');
        CleanupBackups();
        state.runtimeStats.lastBackupAt = Date.now();
        state.runtimeStats.lastBackupFile = file;
        LogEvent('BACKUP_CREATE', file);
        return file;
    } catch (error) {
        console.error('BACKUP ERROR:', error.message);
        return '';
    }
}

function RestoreBackup(fileName) {
    const safe = path.basename(String(fileName || ''));
    const file = path.join(BACKUP_DIR, safe);
    if (!fs.existsSync(file)) return { ok: false, reason: 'NOT_FOUND' };
    const data = TryLoadJson(file);
    if (!data) return { ok: false, reason: 'INVALID_DATA' };
    const pre = CreateBackup('pre_restore');
    if (!ImportDatabaseObject(data)) return { ok: false, reason: 'INVALID_DATA' };
    requestHistory.clear();
    pendingRequests.clear();
    state.requestTraces.clear();
    rateLimits.clear();
    kickedServers.clear();
    kickedClients.clear();
    require('../services/requestRecovery').RebuildQueueRuntime();
    SaveDatabase();
    LogEvent('BACKUP_RESTORE', safe);
    setTimeout(() => ForceReconnectAll('DATABASE_RESTORED'), 250);
    return { ok: true, fileName: safe, preRestore: pre };
}

module.exports = {
    CleanupBackups,
    CreateBackup,
    RestoreBackup
};
