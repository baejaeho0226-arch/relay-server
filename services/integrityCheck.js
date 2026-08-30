'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');
const { NormalizeID, NormalizeLicenseKey, NormalizeVersion, Now } = require('../core/utils');

function AddIssue(list, code, message, entity = '') {
    list.push({ code, message, entity: String(entity || '') });
}

function ValidateDatabaseObject(data, source = 'DATABASE') {
    const errors = [];
    const warnings = [];
    const stats = { servers: 0, clients: 0, licenses: 0, aliases: 0, notes: 0, bindings: 0, queued: 0, deadLetters: 0 };
    const serverIds = new Set();
    const clientIds = new Set();
    const licenseBoundClients = new Map();

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        AddIssue(errors, 'INVALID_ROOT', 'Database root must be an object.');
        return { ok: false, source, checkedAt: Now(), errors, warnings, stats };
    }

    if (Number(data.version || 0) !== 114) AddIssue(warnings, 'DB_VERSION', `Unexpected database version: ${data.version ?? 'missing'} (current 114)`);

    const servers = data.servers && typeof data.servers === 'object' && !Array.isArray(data.servers) ? data.servers : {};
    for (const [deviceKey, rawId] of Object.entries(servers)) {
        stats.servers++;
        const id = NormalizeID(rawId);
        if (!String(deviceKey || '').trim()) AddIssue(errors, 'SERVER_DEVICE_KEY_EMPTY', 'Server device key is empty.', rawId);
        if (!id) { AddIssue(errors, 'SERVER_ID_INVALID', 'Server ID is invalid.', rawId); continue; }
        if (serverIds.has(id)) AddIssue(errors, 'SERVER_ID_DUPLICATE', 'Duplicate Server ID.', id);
        serverIds.add(id);
    }

    const clients = data.clients && typeof data.clients === 'object' && !Array.isArray(data.clients) ? data.clients : {};
    for (const [deviceKey, value] of Object.entries(clients)) {
        stats.clients++;
        if (!value || typeof value !== 'object' || Array.isArray(value)) { AddIssue(errors, 'CLIENT_RECORD_INVALID', 'Client record must be an object.', deviceKey); continue; }
        const id = NormalizeID(value.id || value.clientId);
        const serverId = NormalizeID(value.serverId);
        if (!String(deviceKey || '').trim()) AddIssue(errors, 'CLIENT_DEVICE_KEY_EMPTY', 'Client device key is empty.', id || deviceKey);
        if (!id) { AddIssue(errors, 'CLIENT_ID_INVALID', 'Client ID is invalid.', value.id || value.clientId); continue; }
        if (clientIds.has(id)) AddIssue(errors, 'CLIENT_ID_DUPLICATE', 'Duplicate Client ID.', id);
        if (serverIds.has(id)) AddIssue(errors, 'ID_COLLISION', 'Client ID collides with Server ID.', id);
        clientIds.add(id);
        if (!serverId) AddIssue(errors, 'CLIENT_SERVER_INVALID', 'Client Server binding is invalid.', id);
        else if (!serverIds.has(serverId)) AddIssue(errors, 'CLIENT_SERVER_MISSING', `Bound Server does not exist: ${serverId}`, id);
    }

    const licenses = data.licenses && typeof data.licenses === 'object' && !Array.isArray(data.licenses) ? data.licenses : {};
    for (const [rawKey, value] of Object.entries(licenses)) {
        stats.licenses++;
        const key = NormalizeLicenseKey(rawKey);
        if (!key) { AddIssue(errors, 'LICENSE_KEY_INVALID', 'License key is invalid.', rawKey); continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { AddIssue(errors, 'LICENSE_RECORD_INVALID', 'License record must be an object.', key); continue; }
        const expiresAt = Number(value.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= 0) AddIssue(errors, 'LICENSE_EXPIRY_INVALID', 'License expiresAt is invalid.', key);
        const boundClient = NormalizeID(value.boundClient || '');
        if (boundClient) {
            if (!clientIds.has(boundClient)) AddIssue(errors, 'LICENSE_CLIENT_MISSING', `Bound Client does not exist: ${boundClient}`, key);
            const previous = licenseBoundClients.get(boundClient);
            if (previous && previous !== key) AddIssue(errors, 'CLIENT_MULTI_LICENSE', `Client is bound to multiple licenses: ${previous}, ${key}`, boundClient);
            else licenseBoundClients.set(boundClient, key);
        }
        if (value.tags !== undefined && !Array.isArray(value.tags)) AddIssue(warnings, 'LICENSE_TAGS_INVALID', 'License tags should be an array.', key);
    }

    for (const field of ['disabledServers', 'drainingServers']) {
        for (const rawId of Array.isArray(data[field]) ? data[field] : []) {
            const id = NormalizeID(rawId);
            if (!id || !serverIds.has(id)) AddIssue(warnings, 'ORPHAN_SERVER_STATE', `${field} references missing Server.`, rawId);
        }
    }
    for (const rawId of Array.isArray(data.disabledClients) ? data.disabledClients : []) {
        const id = NormalizeID(rawId);
        if (!id || !clientIds.has(id)) AddIssue(warnings, 'ORPHAN_CLIENT_STATE', 'disabledClients references missing Client.', rawId);
    }

    const bindings = data.clientServerBindings && typeof data.clientServerBindings === 'object' && !Array.isArray(data.clientServerBindings) ? data.clientServerBindings : {};
    for (const [rawClientId, value] of Object.entries(bindings)) {
        stats.bindings++;
        const clientId = NormalizeID(rawClientId);
        if (!clientId || !clientIds.has(clientId)) { AddIssue(errors, 'BINDING_CLIENT_MISSING', 'Primary/Backup binding references missing Client.', rawClientId); continue; }
        if (!value || typeof value !== 'object') { AddIssue(errors, 'BINDING_INVALID', 'Primary/Backup binding must be an object.', clientId); continue; }
        const primary = NormalizeID(value.primaryServerId);
        const backup = NormalizeID(value.backupServerId || '');
        if (!primary || !serverIds.has(primary)) AddIssue(errors, 'BINDING_PRIMARY_MISSING', 'Primary Server does not exist.', clientId);
        if (backup && !serverIds.has(backup)) AddIssue(errors, 'BINDING_BACKUP_MISSING', 'Backup Server does not exist.', clientId);
        if (primary && backup && primary === backup) AddIssue(errors, 'BINDING_PRIMARY_BACKUP_SAME', 'Primary and Backup must be different.', clientId);
    }

    for (const rawId of Array.isArray(data.clientOfflineQueueEnabled) ? data.clientOfflineQueueEnabled : []) {
        const id = NormalizeID(rawId);
        if (!id || !clientIds.has(id)) AddIssue(warnings, 'ORPHAN_QUEUE_OPT_IN', 'Offline Queue opt-in references missing Client.', rawId);
    }
    const queue = data.offlineQueue && typeof data.offlineQueue === 'object' && !Array.isArray(data.offlineQueue) ? data.offlineQueue : {};
    for (const [queueId, value] of Object.entries(queue)) {
        stats.queued++;
        if (!/^QUEUE-[A-Z0-9-]+$/.test(queueId)) AddIssue(errors, 'QUEUE_ID_INVALID', 'Offline Queue ID is invalid.', queueId);
        if (!value || typeof value !== 'object') { AddIssue(errors, 'QUEUE_RECORD_INVALID', 'Offline Queue record must be an object.', queueId); continue; }
        const clientId = NormalizeID(value.clientId);
        if (!clientId || !clientIds.has(clientId)) AddIssue(errors, 'QUEUE_CLIENT_MISSING', 'Offline Queue references missing Client.', queueId);
        if (!String(value.requestId || '').trim() || !/^-?\d+$/.test(String(value.number || ''))) AddIssue(errors, 'QUEUE_REQUEST_INVALID', 'Offline Queue requestId/number is invalid.', queueId);
        if (!(Number(value.expiresAt) > Number(value.createdAt))) AddIssue(errors, 'QUEUE_EXPIRY_INVALID', 'Offline Queue expiry is invalid.', queueId);
    }
    const deadLetters = data.deadLetters && typeof data.deadLetters === 'object' && !Array.isArray(data.deadLetters) ? data.deadLetters : {};
    for (const [deadLetterId, value] of Object.entries(deadLetters)) {
        stats.deadLetters++;
        if (!/^DLQ-[A-Z0-9-]+$/.test(deadLetterId)) AddIssue(errors, 'DLQ_ID_INVALID', 'Dead Letter ID is invalid.', deadLetterId);
        if (!value || typeof value !== 'object') { AddIssue(errors, 'DLQ_RECORD_INVALID', 'Dead Letter record must be an object.', deadLetterId); continue; }
        const clientId = NormalizeID(value.clientId);
        if (!clientId || !clientIds.has(clientId)) AddIssue(errors, 'DLQ_CLIENT_MISSING', 'Dead Letter references missing Client.', deadLetterId);
        if (!String(value.originalRequestId || '').trim() || !/^-?\d+$/.test(String(value.number || ''))) AddIssue(errors, 'DLQ_REQUEST_INVALID', 'Dead Letter requestId/number is invalid.', deadLetterId);
        if (!['ACTIVE', 'REPLAYED', 'DISCARDED'].includes(String(value.status || '').toUpperCase())) AddIssue(errors, 'DLQ_STATUS_INVALID', 'Dead Letter status is invalid.', deadLetterId);
    }

    for (const [field, ids, kind] of [
        ['serverAliases', serverIds, 'Server alias'], ['serverNotes', serverIds, 'Server note'],
        ['clientAliases', clientIds, 'Client alias'], ['clientNotes', clientIds, 'Client note']
    ]) {
        const obj = data[field] && typeof data[field] === 'object' && !Array.isArray(data[field]) ? data[field] : {};
        for (const rawId of Object.keys(obj)) {
            stats[field.toLowerCase().includes('alias') ? 'aliases' : 'notes']++;
            const id = NormalizeID(rawId);
            if (!id || !ids.has(id)) AddIssue(warnings, 'ORPHAN_METADATA', `${kind} references missing entity.`, rawId);
        }
    }

    const drainMeta = data.serverDrainMeta && typeof data.serverDrainMeta === 'object' && !Array.isArray(data.serverDrainMeta) ? data.serverDrainMeta : {};
    for (const [rawId, meta] of Object.entries(drainMeta)) {
        const id = NormalizeID(rawId);
        if (!id || !serverIds.has(id)) AddIssue(warnings, 'ORPHAN_DRAIN_META', 'Drain metadata references missing Server.', rawId);
        else if (!(Array.isArray(data.drainingServers) ? data.drainingServers.map(NormalizeID) : []).includes(id)) AddIssue(warnings, 'STALE_DRAIN_META', 'Drain metadata exists while Server is not draining.', id);
        if (!meta || typeof meta !== 'object' || Number(meta.initialClients) < 0 || Number(meta.startedAt) < 0) AddIssue(warnings, 'DRAIN_META_INVALID', 'Drain metadata is invalid.', id || rawId);
    }

    const protocol = Number(data.minProtocolVersion);
    if (!Number.isInteger(protocol) || protocol < 1 || protocol > config.CURRENT_PROTOCOL_VERSION) AddIssue(errors, 'PROTOCOL_POLICY_INVALID', 'minProtocolVersion is invalid.', data.minProtocolVersion);
    if (!NormalizeVersion(data.minServerVersion)) AddIssue(errors, 'SERVER_VERSION_POLICY_INVALID', 'minServerVersion is invalid.', data.minServerVersion);
    if (!NormalizeVersion(data.minClientVersion)) AddIssue(errors, 'CLIENT_VERSION_POLICY_INVALID', 'minClientVersion is invalid.', data.minClientVersion);

    if (data.maintenanceSchedule != null) {
        const m = data.maintenanceSchedule;
        if (!m || typeof m !== 'object' || !(Number(m.startAt) > 0) || !(Number(m.endAt) > Number(m.startAt))) AddIssue(errors, 'MAINTENANCE_SCHEDULE_INVALID', 'Maintenance schedule is invalid.');
    }

    return { ok: errors.length === 0, source, checkedAt: Now(), errors, warnings, stats };
}

function CurrentDatabaseObject() {
    return require('../storage/database').BuildDatabaseObject();
}

function CheckCurrentDatabase() {
    return ValidateDatabaseObject(CurrentDatabaseObject(), 'CURRENT_DATABASE');
}

function VerifyBackup(fileName) {
    const safe = path.basename(String(fileName || ''));
    const full = path.join(config.BACKUP_DIR, safe);
    if (!safe || !fs.existsSync(full)) return { ok: false, source: safe, checkedAt: Now(), errors: [{ code: 'NOT_FOUND', message: 'Backup file not found.', entity: safe }], warnings: [], stats: {} };
    let data;
    try { data = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (error) { return { ok: false, source: safe, checkedAt: Now(), errors: [{ code: 'INVALID_JSON', message: error.message, entity: safe }], warnings: [], stats: {} }; }
    const result = ValidateDatabaseObject(data, safe);
    try {
        const st = fs.statSync(full);
        result.file = { name: safe, size: st.size, mtimeMs: st.mtimeMs };
    } catch (_) {}
    return result;
}

module.exports = { ValidateDatabaseObject, CheckCurrentDatabase, VerifyBackup };
