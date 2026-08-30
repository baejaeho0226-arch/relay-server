'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function EnsureDirs(...args) { return require('../core/utils').EnsureDirs(...args); }
function LogEvent(...args) { return require('./audit').LogEvent(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function NormalizeLicenseKey(...args) { return require('../core/utils').NormalizeLicenseKey(...args); }
function NormalizeVersion(...args) { return require('../core/utils').NormalizeVersion(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }

function BuildDatabaseObject() {
    return {
        version: 100,
        serviceEnabled: state.serviceEnabled,
        maintenanceMode: state.maintenanceMode,
        minProtocolVersion: state.minProtocolVersion,
        minServerVersion: state.minServerVersion,
        minClientVersion: state.minClientVersion,
        maintenanceSchedule: state.maintenanceSchedule,
        disabledServers: Array.from(disabledServers),
        drainingServers: Array.from(drainingServers),
        disabledClients: Array.from(disabledClients),
        serverAliases: Object.fromEntries(state.serverAliases),
        clientAliases: Object.fromEntries(state.clientAliases),
        serverNotes: Object.fromEntries(state.serverNotes),
        clientNotes: Object.fromEntries(state.clientNotes),
        serverDrainMeta: Object.fromEntries(state.serverDrainMeta),
        servers: Object.fromEntries(serverIdentities),
        clients: Object.fromEntries(clientIdentities),
        licenses: Object.fromEntries(licenses)
    };
}

function SaveDatabase() {
    const tmp = DB_FILE + '.tmp';
    try {
        const text = JSON.stringify(BuildDatabaseObject(), null, 2);
        if (fs.existsSync(DB_FILE)) {
            try { fs.copyFileSync(DB_FILE, DB_BAK_FILE); } catch (_) {}
        }
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, DB_FILE);
        state.runtimeStats.lastDatabaseSaveAt = Date.now();
        state.runtimeStats.lastDatabaseSaveOk = true;
        try { state.runtimeStats.lastDatabaseSize = fs.statSync(DB_FILE).size; } catch (_) {}
        return true;
    } catch (error) {
        state.runtimeStats.lastDatabaseSaveAt = Date.now();
        state.runtimeStats.lastDatabaseSaveOk = false;
        console.error('DATABASE SAVE ERROR:', error.message);
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        return false;
    }
}

function ImportDatabaseObject(data) {
    if (!data || typeof data !== 'object') return false;

    const newServers = new Map();
    const newClients = new Map();
    const newLicenses = new Map();
    const used = new Set();

    if (data.servers && typeof data.servers === 'object') {
        for (const [deviceKey, rawId] of Object.entries(data.servers)) {
            const key = String(deviceKey || '').trim();
            const id = NormalizeID(rawId);
            if (!key || !id || used.has(id)) continue;
            newServers.set(key, id);
            used.add(id);
        }
    }

    if (data.clients && typeof data.clients === 'object') {
        for (const [deviceKey, value] of Object.entries(data.clients)) {
            if (!value || typeof value !== 'object') continue;
            const key = String(deviceKey || '').trim();
            const id = NormalizeID(value.id || value.clientId);
            const serverId = NormalizeID(value.serverId);
            if (!key || !id || !serverId || used.has(id)) continue;
            newClients.set(key, {
                id,
                serverId,
                createdAt: Number(value.createdAt) || Now(),
                lastSeenAt: Number(value.lastSeenAt) || 0,
                lastAuthAt: Number(value.lastAuthAt) || 0,
                lastIP: String(value.lastIP || ''),
                authCount: Number(value.authCount) || 0,
                sendCount: Number(value.sendCount) || 0,
                reconnectCount: Number(value.reconnectCount) || 0
            });
            used.add(id);
        }
    }

    if (data.licenses && typeof data.licenses === 'object') {
        for (const [rawKey, value] of Object.entries(data.licenses)) {
            if (!value || typeof value !== 'object') continue;
            const key = NormalizeLicenseKey(rawKey);
            const expiresAt = Number(value.expiresAt);
            if (!key || !Number.isFinite(expiresAt) || expiresAt <= 0) continue;
            newLicenses.set(key, {
                createdAt: Number(value.createdAt) || Now(),
                expiresAt,
                boundClient: NormalizeID(value.boundClient || ''),
                boundAt: Number(value.boundAt) || 0,
                lastAuthAt: Number(value.lastAuthAt) || 0,
                lastSeenAt: Number(value.lastSeenAt) || 0,
                lastIP: String(value.lastIP || ''),
                authCount: Number(value.authCount) || 0,
                sendCount: Number(value.sendCount) || 0,
                suspended: Boolean(value.suspended),
                memo: SafeField(value.memo || ''),
                tags: require('../license/licenseManager').NormalizeTags(value.tags || [])
            });
        }
    }

    serverIdentities.clear();
    clientIdentities.clear();
    licenses.clear();
    disabledServers.clear();
    drainingServers.clear();
    disabledClients.clear();
    state.serverAliases.clear();
    state.clientAliases.clear();
    state.serverNotes.clear();
    state.clientNotes.clear();
    state.serverDrainMeta.clear();

    for (const [k, v] of newServers) serverIdentities.set(k, v);
    for (const [k, v] of newClients) clientIdentities.set(k, v);
    for (const [k, v] of newLicenses) licenses.set(k, v);

    for (const id of Array.isArray(data.disabledServers) ? data.disabledServers : []) {
        const n = NormalizeID(id); if (n) disabledServers.add(n);
    }
    for (const id of Array.isArray(data.drainingServers) ? data.drainingServers : []) {
        const n = NormalizeID(id); if (n) drainingServers.add(n);
    }
    for (const id of Array.isArray(data.disabledClients) ? data.disabledClients : []) {
        const n = NormalizeID(id); if (n) disabledClients.add(n);
    }

    if (data.serverAliases && typeof data.serverAliases === 'object') {
        for (const [rawId, rawAlias] of Object.entries(data.serverAliases)) {
            const id = NormalizeID(rawId);
            const alias = SafeField(rawAlias || '').slice(0, 64);
            if (id && alias && Array.from(serverIdentities.values()).includes(id)) state.serverAliases.set(id, alias);
        }
    }
    if (data.clientAliases && typeof data.clientAliases === 'object') {
        for (const [rawId, rawAlias] of Object.entries(data.clientAliases)) {
            const id = NormalizeID(rawId);
            const alias = SafeField(rawAlias || '').slice(0, 64);
            if (id && alias && Array.from(clientIdentities.values()).some(x => x.id === id)) state.clientAliases.set(id, alias);
        }
    }


    if (data.serverNotes && typeof data.serverNotes === 'object') {
        for (const [rawId, rawNote] of Object.entries(data.serverNotes)) {
            const id = NormalizeID(rawId);
            const note = String(rawNote || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
            if (id && note && Array.from(serverIdentities.values()).includes(id)) state.serverNotes.set(id, note);
        }
    }
    if (data.clientNotes && typeof data.clientNotes === 'object') {
        for (const [rawId, rawNote] of Object.entries(data.clientNotes)) {
            const id = NormalizeID(rawId);
            const note = String(rawNote || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
            if (id && note && Array.from(clientIdentities.values()).some(x => x.id === id)) state.clientNotes.set(id, note);
        }
    }

    if (data.serverDrainMeta && typeof data.serverDrainMeta === 'object') {
        for (const [rawId, rawMeta] of Object.entries(data.serverDrainMeta)) {
            const id = NormalizeID(rawId);
            if (!id || !drainingServers.has(id) || !Array.from(serverIdentities.values()).includes(id) || !rawMeta || typeof rawMeta !== 'object') continue;
            state.serverDrainMeta.set(id, {
                startedAt: Math.max(0, Number(rawMeta.startedAt) || 0),
                initialClients: Math.max(0, Number(rawMeta.initialClients) || 0),
                readyNotified: Boolean(rawMeta.readyNotified)
            });
        }
    }

    if (typeof data.serviceEnabled === 'boolean') state.serviceEnabled = data.serviceEnabled;
    if (typeof data.maintenanceMode === 'boolean') state.maintenanceMode = data.maintenanceMode;

    const p = Number(data.minProtocolVersion);
    if (Number.isInteger(p) && p >= 1 && p <= CURRENT_PROTOCOL_VERSION) state.minProtocolVersion = p;
    const sv = NormalizeVersion(data.minServerVersion);
    const cv = NormalizeVersion(data.minClientVersion);
    if (sv) state.minServerVersion = sv;
    if (cv) state.minClientVersion = cv;

    if (data.maintenanceSchedule && typeof data.maintenanceSchedule === 'object') {
        const startAt = Number(data.maintenanceSchedule.startAt);
        const endAt = Number(data.maintenanceSchedule.endAt);
        if (startAt > 0 && endAt > startAt) {
            state.maintenanceSchedule = {
                startAt,
                endAt,
                message: SafeField(data.maintenanceSchedule.message || 'Scheduled maintenance')
            };
        }
    } else {
        state.maintenanceSchedule = null;
    }
    return true;
}

function LatestBackupFile() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(x => x.endsWith('.json'))
            .map(file => ({ file, time: fs.statSync(path.join(BACKUP_DIR, file)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        return files.length ? path.join(BACKUP_DIR, files[0].file) : '';
    } catch (_) { return ''; }
}

function TryLoadJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function LoadDatabase() {
    EnsureDirs();
    const candidates = [DB_FILE, DB_BAK_FILE, LatestBackupFile()].filter(Boolean);
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const data = TryLoadJson(file);
        if (data && ImportDatabaseObject(data)) {
            if (file !== DB_FILE) LogEvent('DATABASE_AUTO_RECOVER', path.basename(file));
            SaveDatabase();
            return;
        }
    }
    SaveDatabase();
}

module.exports = {
    BuildDatabaseObject,
    SaveDatabase,
    ImportDatabaseObject,
    LatestBackupFile,
    TryLoadJson,
    LoadDatabase
};
