'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config/config');
const state = require('../core/state');
const {
    Now, NormalizeID, NormalizeLicenseKey, NormalizeVersion, SafeField, SendLine
} = require('../core/utils');
const {
    GetOnlineServer, GetOnlineClient, GetSavedClientByID,
    FindClientDeviceKey, FindServerDeviceKey, ServerExists, ClientExists,
    GetKickUntil, ServerHealth, ClientHealth, GetServerClientCount, ClientMove
} = require('../identity/identityManager');
const {
    FindLicense, GetBoundLicenseEntry, GetLicenseStatus,
    CreateLicense, ExtendLicense, UnbindLicense, SuspendLicense, ResumeLicense,
    DeleteLicense, ReissueLicense, TransferLicense, SearchLicenses, SetLicenseTags, NormalizeTags
} = require('../license/licenseManager');
const { NoticeAll, NoticeClient, NotifyServerUnauthorized } = require('../relay/notifications');
const { SaveDatabase } = require('../storage/database');
const { CreateBackup, RestoreBackup } = require('../storage/backup');
const { AuditSearch, LogEvent } = require('../storage/audit');
const { EnforceVersionPolicy } = require('../services/versionPolicy');
const { HealthSnapshot } = require('../services/dashboard');
const { BuildSystemHealth } = require('../services/systemHealth');
const { CheckCurrentDatabase, VerifyBackup } = require('../services/integrityCheck');
const { BuildStatistics } = require('../services/statistics');
const { StartDrain, StopDrain, ClearDrainMeta, GetDrainStatus } = require('../services/drainMonitor');
const { ListAdminActivity } = require('../services/adminActivity');
const { GetReconnectStatus } = require('../services/reconnectMonitor');
const { GetExpirySummary, MatchesExpiryFilter } = require('../services/licenseMonitor');
const { ListNotifications, NotificationSummary, MarkRead, MarkAllRead, ClearNotifications } = require('../services/notificationCenter');
const { Can, IsAdmin, ClientIP, ListSessions, RevokeSession, RevokeOtherSessions, RevokeAllSessions } = require('./webAuth');
const deviceControl = require('../services/deviceControl');
const featureFlags = require('../services/featureFlags');
const protocolReadiness = require('../services/protocolReadiness');
const deviceAuth = require('../services/deviceAuth');
const qrApproval = require('../services/qrApproval');
const buildGate = require('../services/buildGate');
const buildQrRoutes = require('./routes/buildQrRoutes');
const productionRoutes = require('./routes/productionRoutes');
const loadSimulator = require('../services/loadSimulator');
const storageMigration = require('../services/storageMigration');
const releaseManager = require('../services/releaseManager');
const configHistory = require('../services/configHistory');
const deviceEnrollment = require('../services/deviceEnrollment');
const secretRotation = require('../services/deviceSecretRotation');
const securityDashboard = require('../services/securityDashboard');
const maintenanceService = require('../services/maintenance');
const networkSecurity = require('../services/networkSecurity');
const emergencyFailover = require('../services/emergencyFailover');
const requestRecovery = require('../services/requestRecovery');
const processorCenter = require('../services/processorCenter');
const pushManager = require('../services/pushManager');
const dailyHealth = require('../services/dailyHealth');
const clientBiometric = require('../services/clientBiometric');
const deviceRegistry = require('../services/deviceRegistry');
const historyCleanup = require('../services/historyCleanup');

const {
    BACKUP_DIR, DATA_DIR, CURRENT_PROTOCOL_VERSION,
    SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS,
    MAX_CLIENTS_PER_SERVER, RATE_LIMIT_MAX, MAX_BULK_KEYS,
    ENABLE_LEGACY_TCP_ADMIN, WEB_ADMIN_VERSION
} = config;

function Json(res, status, data) {
    let text;
    try {
        text = JSON.stringify(data);
    } catch (error) {
        console.error('[WEB JSON ERROR]', error && error.stack ? error.stack : error);
        status = 500;
        text = JSON.stringify({
            ok: false,
            error: 'RESPONSE_SERIALIZATION_FAILED',
            detail: 'JSON_SERIALIZATION'
        });
    }
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store'
    });
    res.end(text);
}

function ApiError(res, status, code, detail = '') {
    Json(res, status, { ok: false, error: code, detail });
}

function DecodePart(value) {
    try { return decodeURIComponent(value); } catch (_) { return ''; }
}

function NormalizeAlias(value) {
    return SafeField(value || '').trim().slice(0, 64);
}

function NormalizeNote(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
}

function RequireAdmin(res, session) {
    if (IsAdmin(session)) return true;
    ApiError(res, 403, 'FORBIDDEN');
    return false;
}

function RequireOperation(res, session, operation) {
    if (Can(session, operation)) return true;
    ApiError(res, 403, 'FORBIDDEN');
    return false;
}


async function ReadJsonBody(req, maxBytes = 128 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('BODY_TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) { resolve({}); return; }
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve(text ? JSON.parse(text) : {});
            } catch (_) {
                reject(new Error('INVALID_JSON'));
            }
        });
        req.on('error', reject);
    });
}

function BuildDashboard() {
    let available = 0;
    let bound = 0;
    let expired = 0;
    let suspended = 0;
    let onlineServers = 0;
    let onlineClients = 0;

    for (const id of state.serverIdentities.values()) if (GetOnlineServer(id)) onlineServers++;
    for (const saved of state.clientIdentities.values()) if (GetOnlineClient(saved.id)) onlineClients++;
    for (const license of state.licenses.values()) {
        const status = GetLicenseStatus(license);
        if (status === 'AVAILABLE') available++;
        else if (status === 'BOUND') bound++;
        else if (status === 'EXPIRED') expired++;
        else if (status === 'SUSPENDED') suspended++;
    }

    const ackTotal = state.runtimeStats.ackOk + state.runtimeStats.ackError + state.runtimeStats.ackTimeout;
    const ackSuccessRate = ackTotal > 0 ? (state.runtimeStats.ackOk / ackTotal) * 100 : 100;

    return {
        serviceEnabled: state.serviceEnabled,
        maintenanceMode: state.maintenanceMode,
        uptimeMs: Now() - state.runtimeStats.startedAt,
        servers: {
            total: state.serverIdentities.size,
            online: onlineServers,
            disabled: state.disabledServers.size,
            draining: state.drainingServers.size
        },
        clients: {
            total: state.clientIdentities.size,
            online: onlineClients,
            disabled: state.disabledClients.size
        },
        licenses: {
            total: state.licenses.size,
            available,
            bound,
            expired,
            suspended
        },
        qrAuth: qrApproval.Summary(),
        buildSessions: buildGate.Summary(),
        ack: {
            pending: state.pendingRequests.size,
            ok: state.runtimeStats.ackOk,
            error: state.runtimeStats.ackError,
            timeout: state.runtimeStats.ackTimeout,
            retries: state.runtimeStats.ackRetries,
            successRate: Number(ackSuccessRate.toFixed(2))
        },
        recovery: {
            queued: state.offlineQueue.size,
            deadLetters: Array.from(state.deadLetters.values()).filter(x => x.status === 'ACTIVE').length,
            replayed: state.runtimeStats.replayedRequests,
            dequeued: state.runtimeStats.dequeuedRequests
        },
        versions: {
            protocol: state.minProtocolVersion,
            server: state.minServerVersion,
            client: state.minClientVersion
        },
        totalConnections: state.runtimeStats.totalConnections,
        notices: state.runtimeStats.notices,
        licenseExpiry: GetExpirySummary(),
        notifications: NotificationSummary(),
        ha: require('../services/haCoordinator').Status(),
        recentEvents: state.events.slice(-30).reverse()
    };
}

function BuildServers() {
    const out = [];
    for (const [deviceKey, serverId] of state.serverIdentities) {
        const live = GetOnlineServer(serverId);
        const kickedUntil = GetKickUntil(state.kickedServers, serverId);
        let status = live ? 'ONLINE' : 'OFFLINE';
        if (state.disabledServers.has(serverId)) status = 'DISABLED';
        else if (state.drainingServers.has(serverId)) status = 'DRAINING';
        else if (kickedUntil > Now()) status = 'KICKED';

        const liveClients = live ? live.clients.size : 0;
        const savedClients = GetServerClientCount(serverId);
        const canAcceptClients = !!live && !state.disabledServers.has(serverId) && !state.drainingServers.has(serverId) && kickedUntil <= Now() && liveClients < MAX_CLIENTS_PER_SERVER && savedClients < MAX_CLIENTS_PER_SERVER;
        let acceptState = 'READY';
        if (!live) acceptState = 'OFFLINE';
        else if (state.disabledServers.has(serverId)) acceptState = 'DISABLED';
        else if (state.drainingServers.has(serverId)) acceptState = 'DRAINING';
        else if (kickedUntil > Now()) acceptState = 'KICKED';
        else if (liveClients >= MAX_CLIENTS_PER_SERVER || savedClients >= MAX_CLIENTS_PER_SERVER) acceptState = 'FULL';

        const ack = state.runtimeStats.serverAckStats.get(serverId) || { ok: 0, error: 0, timeout: 0 };
        const ackTotal = ack.ok + ack.error + ack.timeout;
        const reconnectWindow = GetReconnectStatus('SERVER', serverId);
        out.push({
            id: serverId,
            alias: state.serverAliases.get(serverId) || '',
            note: state.serverNotes.get(serverId) || '',
            ack: { ...ack, successRate: ackTotal ? Number(((ack.ok / ackTotal) * 100).toFixed(2)) : 100 },
            deviceKey,
            status,
            online: !!live,
            health: reconnectWindow.flapping ? 'FLAPPING' : (live ? ServerHealth(live) : 'OFFLINE'),
            reconnectWindow,
            clients: liveClients,
            savedClients,
            canAcceptClients,
            acceptState,
            lastIP: live ? live.lastIP : '',
            lastSeen: live ? live.lastSeen : 0,
            kickedUntil,
            protocolVersion: live ? live.protocolVersion : 0,
            appVersion: live ? live.appVersion : '',
            rttMs: live ? live.rttMs : -1,
            reconnectCount: state.runtimeStats.serverReconnects.get(serverId) || 0,
            drain: GetDrainStatus(serverId)
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

function BuildServerDetail(serverId) {
    serverId = NormalizeID(serverId);
    if (!ServerExists(serverId)) return null;
    const server = BuildServers().find(x => x.id === serverId);
    const clients = BuildClients().filter(x => x.serverId === serverId);
    return { ...server, clientsList: clients };
}

function BuildClients() {
    const out = [];
    for (const [deviceKey, saved] of state.clientIdentities) {
        const live = GetOnlineClient(saved.id);
        const bound = GetBoundLicenseEntry(saved.id);
        const kickedUntil = GetKickUntil(state.kickedClients, saved.id);
        let status = live ? 'ONLINE' : 'OFFLINE';
        if (state.disabledClients.has(saved.id)) status = 'DISABLED';
        else if (kickedUntil > Now()) status = 'KICKED';

        const ack = state.runtimeStats.clientAckStats.get(saved.id) || { ok: 0, error: 0, timeout: 0 };
        const ackTotal = ack.ok + ack.error + ack.timeout;
        const reconnectWindow = GetReconnectStatus('CLIENT', saved.id);
        const binding = emergencyFailover.GetBinding(saved.id);
        out.push({
            id: saved.id,
            alias: state.clientAliases.get(saved.id) || '',
            note: state.clientNotes.get(saved.id) || '',
            ack: { ...ack, successRate: ackTotal ? Number(((ack.ok / ackTotal) * 100).toFixed(2)) : 100 },
            deviceKey,
            serverId: saved.serverId,
            serverAlias: state.serverAliases.get(saved.serverId) || '',
            primaryServerId: binding ? binding.primaryServerId : saved.serverId,
            backupServerId: binding ? binding.backupServerId : '',
            bindingConfigured: Boolean(binding && binding.configured),
            offlineQueueEnabled: state.clientOfflineQueueEnabled.has(saved.id),
            queuedRequests: Array.from(state.offlineQueue.values()).filter(x => x.clientId === saved.id).length,
            status,
            online: !!live,
            health: reconnectWindow.flapping ? 'FLAPPING' : (live ? ClientHealth(live) : 'OFFLINE'),
            reconnectWindow,
            licenseStatus: bound ? GetLicenseStatus(bound.license) : 'NONE',
            licenseKey: bound ? bound.key : '',
            licenseExpiresAt: bound ? bound.license.expiresAt : 0,
            lastAuthAt: saved.lastAuthAt,
            lastSeenAt: saved.lastSeenAt,
            lastIP: saved.lastIP,
            authCount: saved.authCount,
            sendCount: saved.sendCount,
            reconnectCount: saved.reconnectCount,
            protocolVersion: live ? live.protocolVersion : 0,
            appVersion: live ? live.appVersion : '',
            rttMs: live ? live.rttMs : -1,
            kickedUntil,
            biometric: clientBiometric.PublicStatus(saved.id),
            buildSession: buildGate.PublicSession(buildGate.ActiveSessionForClient(saved.id)),
            buildBinding: buildGate.BindingForClient(saved.id)
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

function BuildClientDetail(clientId) {
    clientId = NormalizeID(clientId);
    const saved = GetSavedClientByID(clientId);
    if (!saved) return null;
    return BuildClients().find(x => x.id === clientId) || null;
}

function BuildLicenseItem(key, license) {
    return {
        key,
        status: GetLicenseStatus(license),
        expiresAt: license.expiresAt,
        boundClient: license.boundClient || '',
        memo: license.memo || '',
        createdAt: license.createdAt || 0,
        boundAt: license.boundAt || 0,
        lastAuthAt: license.lastAuthAt || 0,
        lastSeenAt: license.lastSeenAt || 0,
        lastIP: license.lastIP || '',
        authCount: license.authCount || 0,
        sendCount: license.sendCount || 0,
        suspended: !!license.suspended,
        accessType: require('../services/accessType').NormalizeAccessType(license.accessType),
        tags: NormalizeTags(license.tags || [])
    };
}

function BuildLicenses(query, status, expiry) {
    return SearchLicenses(query || '', status || 'ALL')
        .filter(item => MatchesExpiryFilter(item.license, expiry || 'ALL'))
        .map(item => BuildLicenseItem(item.key, item.license));
}

function BuildBackups() {
    try {
        return fs.readdirSync(BACKUP_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const stat = fs.statSync(path.join(BACKUP_DIR, file));
                return { file, size: stat.size, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (_) {
        return [];
    }
}


function GlobalSearch(query) {
    query = String(query || '').trim().toUpperCase();
    if (!query) return [];
    const out = [];
    const add = (kind, id, label, detail, status = '') => {
        if (out.length >= 60) return;
        out.push({ kind, id, label, detail, status });
    };

    for (const server of BuildServers()) {
        const text = `${server.id}|${server.alias}|${server.deviceKey}|${server.note}|${server.lastIP}`.toUpperCase();
        if (text.includes(query)) add('SERVER', server.id, server.alias || server.id, `${server.id} // ${server.status} // ${server.health}`, server.status);
    }
    for (const client of BuildClients()) {
        const text = `${client.id}|${client.alias}|${client.deviceKey}|${client.note}|${client.serverId}|${client.serverAlias}|${client.licenseKey}|${client.lastIP}`.toUpperCase();
        if (text.includes(query)) add('CLIENT', client.id, client.alias || client.id, `${client.id} // ${client.status} // ${client.serverAlias || client.serverId}`, client.status);
    }
    for (const item of BuildLicenses('', 'ALL', 'ALL')) {
        const text = `${item.key}|${item.boundClient}|${item.memo}|${(item.tags || []).join('|')}|${item.status}`.toUpperCase();
        if (text.includes(query)) add('LICENSE', item.key, item.key, `${item.status} // ${(item.tags || []).join(', ') || 'NO TAG'} // ${item.boundClient || 'UNBOUND'}`, item.status);
    }
    for (const trace of require('../services/requestTrace').SearchTraces(query).slice(0, 20)) {
        add('REQUEST', trace.key, trace.requestId, `${trace.status} // ${trace.clientId} → ${trace.serverId} // ${trace.durationMs || 0}ms`, trace.status);
    }
    return out.slice(0, 60);
}

function BuildSystem() {
    return {
        serviceEnabled: state.serviceEnabled,
        maintenanceMode: state.maintenanceMode,
        maintenanceSchedule: state.maintenanceSchedule,
        maintenanceAutomation: maintenanceService.GetMaintenanceAutomationStatus(),
        minProtocolVersion: state.minProtocolVersion,
        minServerVersion: state.minServerVersion,
        minClientVersion: state.minClientVersion,
        currentProtocolVersion: CURRENT_PROTOCOL_VERSION,
        maxClientsPerServer: MAX_CLIENTS_PER_SERVER,
        rateLimit: RATE_LIMIT_MAX,
        dataDir: DATA_DIR,
        webAdminVersion: WEB_ADMIN_VERSION,
        webUiRevision: config.WEB_UI_REVISION,
        legacyTcpAdminEnabled: ENABLE_LEGACY_TCP_ADMIN,
        health: HealthSnapshot()
    };
}


module.exports = { fs, path, config, state, Now, NormalizeID, NormalizeLicenseKey, NormalizeVersion, SafeField, SendLine, GetOnlineServer, GetOnlineClient, GetSavedClientByID, FindClientDeviceKey, FindServerDeviceKey, ServerExists, ClientExists, GetKickUntil, ServerHealth, ClientHealth, GetServerClientCount, ClientMove, FindLicense, GetBoundLicenseEntry, GetLicenseStatus, CreateLicense, ExtendLicense, UnbindLicense, SuspendLicense, ResumeLicense, DeleteLicense, ReissueLicense, TransferLicense, SearchLicenses, SetLicenseTags, NormalizeTags, NoticeAll, NoticeClient, NotifyServerUnauthorized, SaveDatabase, CreateBackup, RestoreBackup, AuditSearch, LogEvent, EnforceVersionPolicy, HealthSnapshot, BuildSystemHealth, CheckCurrentDatabase, VerifyBackup, BuildStatistics, StartDrain, StopDrain, ClearDrainMeta, GetDrainStatus, ListAdminActivity, GetReconnectStatus, GetExpirySummary, MatchesExpiryFilter, ListNotifications, NotificationSummary, MarkRead, MarkAllRead, ClearNotifications, Can, IsAdmin, ClientIP, ListSessions, RevokeSession, RevokeOtherSessions, RevokeAllSessions, deviceControl, featureFlags, protocolReadiness, deviceAuth, qrApproval, buildGate, buildQrRoutes, productionRoutes, loadSimulator, storageMigration, releaseManager, configHistory, deviceEnrollment, secretRotation, securityDashboard, maintenanceService, networkSecurity, emergencyFailover, requestRecovery, processorCenter, pushManager, dailyHealth, clientBiometric, deviceRegistry, historyCleanup, BACKUP_DIR, DATA_DIR, CURRENT_PROTOCOL_VERSION, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, MAX_CLIENTS_PER_SERVER, RATE_LIMIT_MAX, MAX_BULK_KEYS, ENABLE_LEGACY_TCP_ADMIN, WEB_ADMIN_VERSION, Json, ApiError, DecodePart, NormalizeAlias, NormalizeNote, RequireAdmin, RequireOperation, ReadJsonBody, BuildDashboard, BuildServers, BuildServerDetail, BuildClients, BuildClientDetail, BuildLicenseItem, BuildLicenses, BuildBackups, GlobalSearch, BuildSystem };
