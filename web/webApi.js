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

const {
    BACKUP_DIR, DATA_DIR, CURRENT_PROTOCOL_VERSION,
    SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS,
    MAX_CLIENTS_PER_SERVER, RATE_LIMIT_MAX, MAX_BULK_KEYS,
    ENABLE_LEGACY_TCP_ADMIN, WEB_ADMIN_VERSION
} = config;

function Json(res, status, data) {
    const text = JSON.stringify(data);
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

function RequireConfirm(res, body, expected) {
    if (String(body && body.confirmText || '').trim().toUpperCase() === expected) return true;
    ApiError(res, 409, 'CONFIRM_REQUIRED', expected);
    return false;
}

async function ReadJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 128 * 1024) {
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
        ack: {
            pending: state.pendingRequests.size,
            ok: state.runtimeStats.ackOk,
            error: state.runtimeStats.ackError,
            timeout: state.runtimeStats.ackTimeout,
            retries: state.runtimeStats.ackRetries,
            successRate: Number(ackSuccessRate.toFixed(2))
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
        out.push({
            id: saved.id,
            alias: state.clientAliases.get(saved.id) || '',
            note: state.clientNotes.get(saved.id) || '',
            ack: { ...ack, successRate: ackTotal ? Number(((ack.ok / ackTotal) * 100).toFixed(2)) : 100 },
            deviceKey,
            serverId: saved.serverId,
            serverAlias: state.serverAliases.get(saved.serverId) || '',
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
            kickedUntil
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
        minProtocolVersion: state.minProtocolVersion,
        minServerVersion: state.minServerVersion,
        minClientVersion: state.minClientVersion,
        currentProtocolVersion: CURRENT_PROTOCOL_VERSION,
        maxClientsPerServer: MAX_CLIENTS_PER_SERVER,
        rateLimit: RATE_LIMIT_MAX,
        dataDir: DATA_DIR,
        webAdminVersion: WEB_ADMIN_VERSION,
        legacyTcpAdminEnabled: ENABLE_LEGACY_TCP_ADMIN,
        health: HealthSnapshot()
    };
}

async function HandleApiRequest(req, res, session) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = String(req.method || 'GET').toUpperCase();
    let body = {};

    if (!['GET', 'HEAD'].includes(method)) {
        try { body = await ReadJsonBody(req); }
        catch (error) { ApiError(res, error.message === 'BODY_TOO_LARGE' ? 413 : 400, error.message); return; }
    }

    if (method === 'GET' && pathname === '/api/dashboard') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        Json(res, 200, { ok: true, dashboard: BuildDashboard() });
        return;
    }

    if (method === 'GET' && pathname === '/api/servers') {
        if (!RequireOperation(res, session, 'SERVER_LIST')) return;
        Json(res, 200, { ok: true, servers: BuildServers() });
        return;
    }

    let match = pathname.match(/^\/api\/servers\/([^/]+)$/);
    if (method === 'GET' && match) {
        if (!RequireOperation(res, session, 'SERVER_TREE')) return;
        const item = BuildServerDetail(DecodePart(match[1]));
        if (!item) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return; }
        Json(res, 200, { ok: true, server: item });
        return;
    }

    match = pathname.match(/^\/api\/servers\/([^/]+)\/alias$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ServerExists(id)) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return; }
        const alias = NormalizeAlias(body.alias);
        if (alias) state.serverAliases.set(id, alias); else state.serverAliases.delete(id);
        SaveDatabase();
        LogEvent('SERVER_ALIAS', `${id} -> ${alias || '(cleared)'}`);
        Json(res, 200, { ok: true, id, alias });
        return;
    }

    match = pathname.match(/^\/api\/servers\/([^/]+)\/note$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'NOTE')) return;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ServerExists(id)) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return; }
        const note = NormalizeNote(body.note);
        if (note) state.serverNotes.set(id, note); else state.serverNotes.delete(id);
        SaveDatabase();
        LogEvent('SERVER_NOTE', `${id} ${note ? 'updated' : 'cleared'}`);
        Json(res, 200, { ok: true, id, note });
        return;
    }

    match = pathname.match(/^\/api\/servers\/([^/]+)\/(kick|disable|enable|drain-on|drain-off)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return;
        const id = NormalizeID(DecodePart(match[1]));
        const action = match[2];
        if (!ServerExists(id)) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return; }

        if (action === 'kick') {
            const until = Now() + SERVER_KICK_BLOCK_MS;
            state.kickedServers.set(id, until);
            const live = GetOnlineServer(id);
            if (live) { SendLine(live.socket, `ERROR|ADMIN_KICK|${until}`); live.socket.destroy(); }
            LogEvent('SERVER_KICK', `${id} until ${until}`);
            Json(res, 200, { ok: true, id, kickedUntil: until });
            return;
        }
        if (action === 'disable') {
            state.disabledServers.add(id);
            ClearDrainMeta(id);
            state.kickedServers.delete(id);
            SaveDatabase();
            const live = GetOnlineServer(id);
            if (live) { SendLine(live.socket, 'ERROR|SERVER_DISABLED'); live.socket.destroy(); }
            LogEvent('SERVER_DISABLE', id);
        } else if (action === 'enable') {
            state.disabledServers.delete(id);
            state.kickedServers.delete(id);
            SaveDatabase();
            LogEvent('SERVER_ENABLE', id);
        } else if (action === 'drain-on') {
            const result = StartDrain(id);
            if (!result.ok) { ApiError(res, 409, result.reason); return; }
            LogEvent('SERVER_DRAIN_ON', `${id} initialClients=${result.status.initialClients}`);
        } else if (action === 'drain-off') {
            StopDrain(id);
            LogEvent('SERVER_DRAIN_OFF', id);
        }
        Json(res, 200, { ok: true, id, action, drain: GetDrainStatus(id) });
        return;
    }

    if (method === 'GET' && pathname === '/api/clients') {
        if (!RequireOperation(res, session, 'CLIENT_LIST')) return;
        Json(res, 200, { ok: true, clients: BuildClients() });
        return;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (method === 'GET' && match) {
        if (!RequireOperation(res, session, 'CLIENT_DETAIL')) return;
        const item = BuildClientDetail(DecodePart(match[1]));
        if (!item) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return; }
        Json(res, 200, { ok: true, client: item });
        return;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/alias$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ClientExists(id)) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return; }
        const alias = NormalizeAlias(body.alias);
        if (alias) state.clientAliases.set(id, alias); else state.clientAliases.delete(id);
        SaveDatabase();
        LogEvent('CLIENT_ALIAS', `${id} -> ${alias || '(cleared)'}`);
        Json(res, 200, { ok: true, id, alias });
        return;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/note$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'NOTE')) return;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ClientExists(id)) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return; }
        const note = NormalizeNote(body.note);
        if (note) state.clientNotes.set(id, note); else state.clientNotes.delete(id);
        SaveDatabase();
        LogEvent('CLIENT_NOTE', `${id} ${note ? 'updated' : 'cleared'}`);
        Json(res, 200, { ok: true, id, note });
        return;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/(kick|disable|enable)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return;
        const id = NormalizeID(DecodePart(match[1]));
        const action = match[2];
        if (!ClientExists(id)) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return; }

        if (action === 'kick') {
            const until = Now() + CLIENT_KICK_BLOCK_MS;
            state.kickedClients.set(id, until);
            NotifyServerUnauthorized(id, 'ADMIN_KICK');
            const live = GetOnlineClient(id);
            if (live) { SendLine(live.socket, `ERROR|CLIENT_KICKED|${until}`); live.socket.destroy(); }
            LogEvent('CLIENT_KICK', `${id} until ${until}`);
            Json(res, 200, { ok: true, id, kickedUntil: until });
            return;
        }
        if (action === 'disable') {
            state.disabledClients.add(id);
            state.kickedClients.delete(id);
            SaveDatabase();
            NotifyServerUnauthorized(id, 'CLIENT_DISABLED');
            const live = GetOnlineClient(id);
            if (live) { SendLine(live.socket, 'ERROR|CLIENT_DISABLED'); live.socket.destroy(); }
            LogEvent('CLIENT_DISABLE', id);
        } else {
            state.disabledClients.delete(id);
            state.kickedClients.delete(id);
            SaveDatabase();
            LogEvent('CLIENT_ENABLE', id);
        }
        Json(res, 200, { ok: true, id, action });
        return;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/move$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return;
        const id = NormalizeID(DecodePart(match[1]));
        const newServerId = NormalizeID(body.serverId || '');
        const result = ClientMove(id, newServerId);
        if (!result.ok) { ApiError(res, 409, result.reason); return; }
        Json(res, 200, { ok: true, id, serverId: newServerId, oldServerId: result.oldServerId });
        return;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/notice$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'NOTICE')) return;
        const id = NormalizeID(DecodePart(match[1]));
        const message = SafeField(body.message || '');
        if (!message) { ApiError(res, 400, 'MESSAGE_REQUIRED'); return; }
        if (!NoticeClient(id, message)) { ApiError(res, 409, 'CLIENT_OFFLINE'); return; }
        Json(res, 200, { ok: true, id });
        return;
    }

    if (method === 'GET' && pathname === '/api/licenses') {
        if (!RequireOperation(res, session, 'LIST')) return;
        Json(res, 200, {
            ok: true,
            licenses: BuildLicenses(url.searchParams.get('query') || '', url.searchParams.get('status') || 'ALL', url.searchParams.get('expiry') || 'ALL')
        });
        return;
    }

    if (method === 'POST' && pathname === '/api/licenses') {
        if (!RequireAdmin(res, session)) return;
        const days = Number(body.days);
        if (!Number.isInteger(days) || days <= 0 || days > 36500) { ApiError(res, 400, 'INVALID_DAYS'); return; }
        const created = CreateLicense(days, body.memo || '', body.tags || []);
        Json(res, 201, { ok: true, ...created });
        return;
    }

    match = pathname.match(/^\/api\/licenses\/([^/]+)\/tags$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'EXTEND')) return;
        const key = NormalizeLicenseKey(DecodePart(match[1]));
        if (!FindLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return; }
        const tags = SetLicenseTags(key, body.tags || []);
        Json(res, 200, { ok: true, key, tags });
        return;
    }

    if (method === 'POST' && pathname === '/api/licenses/bulk') {
        const action = String(body.action || '').toLowerCase();
        const keys = Array.isArray(body.keys) ? body.keys.map(NormalizeLicenseKey).filter(Boolean).slice(0, MAX_BULK_KEYS) : [];
        if (!keys.length) { ApiError(res, 400, 'NO_KEYS'); return; }
        if (action === 'delete') {
            if (!RequireAdmin(res, session)) return;
        } else {
            const permission = { extend: 'EXTEND', unbind: 'UNBIND', suspend: 'SUSPEND', resume: 'RESUME' }[action];
            if (!permission || !RequireOperation(res, session, permission)) return;
        }
        const days = Number(body.days || 0);
        if (action === 'extend' && (!Number.isInteger(days) || days <= 0 || days > 36500)) { ApiError(res, 400, 'INVALID_DAYS'); return; }
        let success = 0;
        for (const key of keys) {
            if (action === 'extend' && ExtendLicense(key, days)) success++;
            else if (action === 'unbind' && UnbindLicense(key)) success++;
            else if (action === 'suspend' && SuspendLicense(key)) success++;
            else if (action === 'resume' && ResumeLicense(key)) success++;
            else if (action === 'delete' && DeleteLicense(key)) success++;
        }
        SaveDatabase();
        LogEvent('WEB_LICENSE_BULK', `${action} ${success}/${keys.length}`);
        Json(res, 200, { ok: true, success, total: keys.length });
        return;
    }

    match = pathname.match(/^\/api\/licenses\/([^/]+)\/(extend|unbind|suspend|resume|reissue|transfer|delete)$/);
    if (method === 'POST' && match) {
        const key = NormalizeLicenseKey(DecodePart(match[1]));
        const action = match[2];
        if (!FindLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return; }

        if (action === 'reissue' || action === 'delete') {
            if (!RequireAdmin(res, session)) return;
        } else {
            const permission = { extend: 'EXTEND', unbind: 'UNBIND', suspend: 'SUSPEND', resume: 'RESUME', transfer: 'TRANSFER' }[action];
            if (!RequireOperation(res, session, permission)) return;
        }

        if (action === 'extend') {
            const days = Number(body.days);
            if (!Number.isInteger(days) || days <= 0 || days > 36500) { ApiError(res, 400, 'INVALID_DAYS'); return; }
            if (!ExtendLicense(key, days)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return; }
            SaveDatabase(); LogEvent('LICENSE_EXTEND', `${key} +${days}`);
            Json(res, 200, { ok: true, key, expiresAt: FindLicense(key).expiresAt });
            return;
        }
        if (action === 'unbind') {
            if (!UnbindLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return; }
            SaveDatabase(); LogEvent('LICENSE_UNBIND', key); Json(res, 200, { ok: true, key }); return;
        }
        if (action === 'suspend') {
            if (!SuspendLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return; }
            SaveDatabase(); LogEvent('LICENSE_SUSPEND', key); Json(res, 200, { ok: true, key }); return;
        }
        if (action === 'resume') {
            if (!ResumeLicense(key)) { ApiError(res, 400, 'NOT_FOUND_OR_EXPIRED'); return; }
            SaveDatabase(); LogEvent('LICENSE_RESUME', key); Json(res, 200, { ok: true, key }); return;
        }
        if (action === 'reissue') {
            const result = ReissueLicense(key);
            if (!result) { ApiError(res, 400, 'REISSUE_FAILED'); return; }
            Json(res, 200, { ok: true, ...result }); return;
        }
        if (action === 'transfer') {
            const result = TransferLicense(key, body.clientId || '');
            if (!result.ok) { ApiError(res, 400, result.reason); return; }
            Json(res, 200, { ok: true, key, clientId: NormalizeID(body.clientId || '') }); return;
        }
        if (action === 'delete') {
            if (!DeleteLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return; }
            SaveDatabase(); LogEvent('LICENSE_DELETE', key); Json(res, 200, { ok: true, key }); return;
        }
    }

    if (method === 'GET' && pathname === '/api/notifications') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        Json(res, 200, {
            ok: true,
            summary: NotificationSummary(),
            notifications: ListNotifications({
                unreadOnly: url.searchParams.get('unread') === '1',
                severity: url.searchParams.get('severity') || 'ALL',
                limit: Number(url.searchParams.get('limit') || 200)
            })
        });
        return;
    }

    match = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        if (!MarkRead(DecodePart(match[1]), body.read !== false)) { ApiError(res, 404, 'NOTIFICATION_NOT_FOUND'); return; }
        Json(res, 200, { ok: true, summary: NotificationSummary() });
        return;
    }

    if (method === 'POST' && pathname === '/api/notifications/read-all') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        MarkAllRead();
        Json(res, 200, { ok: true, summary: NotificationSummary() });
        return;
    }

    if (method === 'POST' && pathname === '/api/notifications/clear') {
        if (!RequireAdmin(res, session)) return;
        ClearNotifications();
        Json(res, 200, { ok: true, summary: NotificationSummary() });
        return;
    }

    if (method === 'GET' && pathname === '/api/request-traces') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        const traces = require('../services/requestTrace').SearchTraces(url.searchParams.get('query') || '');
        Json(res, 200, { ok: true, traces });
        return;
    }

    if (method === 'GET' && pathname === '/api/audit') {
        if (!RequireOperation(res, session, 'AUDIT')) return;
        const query = url.searchParams.get('query') || '';
        const type = url.searchParams.get('type') || 'ALL';
        const since = Number(url.searchParams.get('since') || 0);
        Json(res, 200, { ok: true, events: AuditSearch(query, type, since).slice().reverse() });
        return;
    }

    if (method === 'GET' && pathname === '/api/backups') {
        if (!RequireOperation(res, session, 'VIEW')) return;
        Json(res, 200, { ok: true, backups: BuildBackups() });
        return;
    }

    if (method === 'POST' && pathname === '/api/backups/create') {
        if (!RequireAdmin(res, session)) return;
        const file = CreateBackup('web_manual');
        if (!file) { ApiError(res, 500, 'BACKUP_FAILED'); return; }
        Json(res, 201, { ok: true, file });
        return;
    }

    match = pathname.match(/^\/api\/backups\/([^/]+)\/verify$/);
    if (method === 'GET' && match) {
        if (!RequireOperation(res, session, 'VIEW')) return;
        const result = VerifyBackup(DecodePart(match[1]));
        Json(res, result.errors && result.errors.some(x => x.code === 'NOT_FOUND') ? 404 : 200, { ok: true, verification: result });
        return;
    }

    match = pathname.match(/^\/api\/backups\/([^/]+)\/(restore|delete)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return;
        const file = path.basename(DecodePart(match[1]));
        const action = match[2];
        if (!RequireConfirm(res, body, action === 'restore' ? 'RESTORE' : 'DELETE')) return;
        if (action === 'restore') {
            const result = RestoreBackup(file);
            if (!result.ok) { ApiError(res, 400, result.reason); return; }
            Json(res, 200, { ok: true, ...result });
            return;
        }
        const full = path.join(BACKUP_DIR, file);
        if (!fs.existsSync(full)) { ApiError(res, 404, 'NOT_FOUND'); return; }
        try {
            fs.unlinkSync(full);
            LogEvent('BACKUP_DELETE', file);
            Json(res, 200, { ok: true, file });
        } catch (_) {
            ApiError(res, 500, 'DELETE_FAILED');
        }
        return;
    }

    if (method === 'GET' && pathname === '/api/admin-activity') {
        if (!RequireAdmin(res, session)) return;
        const query = url.searchParams.get('query') || '';
        const limit = Number(url.searchParams.get('limit') || 300);
        Json(res, 200, { ok: true, activities: ListAdminActivity(query, limit) });
        return;
    }

    if (method === 'GET' && pathname === '/api/sessions') {
        if (!RequireAdmin(res, session)) return;
        Json(res, 200, { ok: true, sessions: ListSessions(session) });
        return;
    }

    match = pathname.match(/^\/api\/sessions\/([^/]+)\/revoke$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return;
        const sessionId = DecodePart(match[1]);
        const target = ListSessions(session).find(x => x.id === sessionId);
        if (!target) { ApiError(res, 404, 'SESSION_NOT_FOUND'); return; }
        const current = target.current;
        RevokeSession(sessionId);
        Json(res, 200, { ok: true, id: sessionId, current });
        return;
    }

    if (method === 'POST' && pathname === '/api/sessions/revoke-others') {
        if (!RequireAdmin(res, session)) return;
        const count = RevokeOtherSessions(session);
        Json(res, 200, { ok: true, count });
        return;
    }

    if (method === 'POST' && pathname === '/api/sessions/revoke-all') {
        if (!RequireAdmin(res, session)) return;
        const count = RevokeAllSessions();
        Json(res, 200, { ok: true, count, currentRevoked: true });
        return;
    }

    if (method === 'GET' && pathname === '/api/system/integrity') {
        if (!RequireOperation(res, session, 'VIEW')) return;
        Json(res, 200, { ok: true, integrity: CheckCurrentDatabase() });
        return;
    }

    if (method === 'GET' && pathname === '/api/statistics') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        Json(res, 200, { ok: true, statistics: BuildStatistics(url.searchParams.get('range') || '1H') });
        return;
    }

    if (method === 'GET' && pathname === '/api/search') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        Json(res, 200, { ok: true, results: GlobalSearch(url.searchParams.get('q') || '') });
        return;
    }

    if (method === 'GET' && pathname === '/api/system/health') {
        if (!RequireOperation(res, session, 'VIEW')) return;
        Json(res, 200, { ok: true, health: BuildSystemHealth() });
        return;
    }

    if (method === 'GET' && pathname === '/api/system') {
        if (!RequireOperation(res, session, 'VERSION_STATUS')) return;
        Json(res, 200, { ok: true, system: BuildSystem() });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/service/start') {
        if (!RequireAdmin(res, session)) return;
        state.serviceEnabled = true;
        state.maintenanceMode = false;
        SaveDatabase();
        for (const c of state.clients.values()) SendLine(c.socket, 'SERVICE_STATE|ONLINE');
        LogEvent('SERVICE_START', `WEB ${ClientIP(req)}`);
        Json(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/service/stop') {
        if (!RequireAdmin(res, session) || !RequireConfirm(res, body, 'STOP')) return;
        state.serviceEnabled = false;
        state.maintenanceMode = false;
        SaveDatabase();
        for (const c of state.clients.values()) {
            c.licenseAuthorized = false;
            c.licenseExpiresAt = 0;
            c.lastServerAuthState = '';
            SendLine(c.socket, 'SERVICE_STATE|DISABLED');
            NotifyServerUnauthorized(c.clientId, 'SERVICE_DISABLED');
        }
        LogEvent('SERVICE_STOP', `WEB ${ClientIP(req)}`);
        Json(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/on') {
        if (!RequireAdmin(res, session)) return;
        if (!state.serviceEnabled) { ApiError(res, 409, 'SERVICE_DISABLED'); return; }
        state.maintenanceMode = true;
        SaveDatabase();
        for (const c of state.clients.values()) if (!c.licenseAuthorized) SendLine(c.socket, 'SERVICE_STATE|MAINTENANCE');
        LogEvent('MAINTENANCE_ON', `WEB ${ClientIP(req)}`);
        Json(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/off') {
        if (!RequireAdmin(res, session)) return;
        state.maintenanceMode = false;
        SaveDatabase();
        for (const c of state.clients.values()) SendLine(c.socket, 'SERVICE_STATE|ONLINE');
        LogEvent('MAINTENANCE_OFF', `WEB ${ClientIP(req)}`);
        Json(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/schedule') {
        if (!RequireAdmin(res, session)) return;
        const startAt = Number(body.startAt);
        const endAt = Number(body.endAt);
        const message = SafeField(body.message || 'Scheduled maintenance');
        if (!(startAt > Now() && endAt > startAt)) { ApiError(res, 400, 'INVALID_TIME'); return; }
        state.maintenanceSchedule = { startAt, endAt, message };
        SaveDatabase();
        LogEvent('MAINT_SCHEDULE', `${startAt}-${endAt} ${message}`);
        Json(res, 200, { ok: true, schedule: state.maintenanceSchedule });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/clear') {
        if (!RequireAdmin(res, session)) return;
        state.maintenanceSchedule = null;
        SaveDatabase();
        LogEvent('MAINT_SCHEDULE_CLEAR', 'WEB');
        Json(res, 200, { ok: true });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/version') {
        if (!RequireAdmin(res, session) || !RequireConfirm(res, body, 'VERSION')) return;
        const protocol = Number(body.protocol);
        const serverVersion = NormalizeVersion(body.serverVersion);
        const clientVersion = NormalizeVersion(body.clientVersion);
        if (!Number.isInteger(protocol) || protocol < 1 || protocol > CURRENT_PROTOCOL_VERSION || !serverVersion || !clientVersion) {
            ApiError(res, 400, 'INVALID_VERSION');
            return;
        }
        state.minProtocolVersion = protocol;
        state.minServerVersion = serverVersion;
        state.minClientVersion = clientVersion;
        SaveDatabase();
        LogEvent('VERSION_POLICY_CHANGED', `P=${protocol} S=${serverVersion} C=${clientVersion}`);
        setTimeout(EnforceVersionPolicy, 250);
        Json(res, 200, { ok: true, protocol, serverVersion, clientVersion });
        return;
    }

    if (method === 'POST' && pathname === '/api/system/notice') {
        if (!RequireOperation(res, session, 'NOTICE')) return;
        const message = SafeField(body.message || '');
        if (!message) { ApiError(res, 400, 'MESSAGE_REQUIRED'); return; }
        const count = NoticeAll(message);
        Json(res, 200, { ok: true, count });
        return;
    }

    ApiError(res, 404, 'NOT_FOUND');
}

module.exports = {
    Json,
    ApiError,
    ReadJsonBody,
    HandleApiRequest
};
