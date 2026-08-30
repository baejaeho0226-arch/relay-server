'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function AuthorizeClient(...args) { return require('../license/licenseManager').AuthorizeClient(...args); }
function CreateClientIdentity(...args) { return require('../identity/identityManager').CreateClientIdentity(...args); }
function FindAvailableServer(...args) { return require('../identity/identityManager').FindAvailableServer(...args); }
function GetKickUntil(...args) { return require('../identity/identityManager').GetKickUntil(...args); }
function GetOnlineClient(...args) { return require('../identity/identityManager').GetOnlineClient(...args); }
function GetOnlineServer(...args) { return require('../identity/identityManager').GetOnlineServer(...args); }
function GetSavedClientByID(...args) { return require('../identity/identityManager').GetSavedClientByID(...args); }
function GetUsableLicenseForConnection(...args) { return require('../license/licenseManager').GetUsableLicenseForConnection(...args); }
function HandlePong(...args) { return require('./heartbeat').HandlePong(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function MakeRequestKey(...args) { return require('./ackManager').MakeRequestKey(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function NotifyServerUnauthorized(...args) { return require('./notifications').NotifyServerUnauthorized(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function SafeIP(...args) { return require('../core/utils').SafeIP(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }
function TrackIP(...args) { return require('../identity/identityManager').TrackIP(...args); }
function ValidateProtocolAndVersion(...args) { return require('../services/versionPolicy').ValidateProtocolAndVersion(...args); }

function AttachClient(connection, saved) {
    const old = GetOnlineClient(saved.id);
    if (old && old !== connection) {
        const oldServer = GetOnlineServer(old.serverId);
        if (oldServer) oldServer.clients.delete(saved.id);
        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.clientId = saved.id;
    connection.serverId = saved.serverId;
    connection.connected = true;
    connection.licenseAuthorized = false;
    connection.licenseKey = '';
    connection.licenseExpiresAt = 0;
    connection.lastServerAuthState = '';
    connection.lastSeen = Now();
    connection.lastIP = SafeIP(connection.socket);
    clients.set(saved.id, connection);

    saved.lastSeenAt = Now();
    saved.lastIP = connection.lastIP;
    saved.reconnectCount = Number(saved.reconnectCount || 0) + 1;
    runtimeStats.clientReconnects.set(saved.id, saved.reconnectCount);
    require('../services/reconnectMonitor').RecordReconnect('CLIENT', saved.id);
    TrackIP('CLIENT', saved.id, saved.lastIP);

    const server = GetOnlineServer(saved.serverId);
    if (server) server.clients.add(saved.id);
    SaveDatabase();

    SendLine(connection.socket, `CONNECTED|${saved.id}|${saved.serverId}|${connection.protocolVersion}|${connection.appVersion}`);
    NotifyServerUnauthorized(saved.id, 'LICENSE_REQUIRED');
    LogEvent('CLIENT_ONLINE', `${saved.id} v${connection.appVersion}`);
}

function HandleClientConnect(connection, deviceKey, protocolVersion, appVersion) {
    if (!ValidateProtocolAndVersion(connection, 'client', protocolVersion, appVersion)) {
        setTimeout(() => { try { connection.socket.destroy(); } catch (_) {} }, 150);
        return;
    }
    if (!state.serviceEnabled) { SendLine(connection.socket, 'SERVICE_STATE|DISABLED'); return; }
    if (state.maintenanceMode) { SendLine(connection.socket, 'SERVICE_STATE|MAINTENANCE'); return; }

    deviceKey = String(deviceKey || '').trim();
    if (!deviceKey) { SendLine(connection.socket, 'ERROR|DEVICE_KEY_REQUIRED'); return; }

    let saved = clientIdentities.get(deviceKey);
    if (saved) {
        if (disabledClients.has(saved.id)) { SendLine(connection.socket, 'ERROR|CLIENT_DISABLED'); return; }
        const kickedUntil = GetKickUntil(kickedClients, saved.id);
        if (kickedUntil > Now()) { SendLine(connection.socket, `ERROR|CLIENT_KICKED|${kickedUntil}`); return; }
        if (disabledServers.has(saved.serverId)) { SendLine(connection.socket, 'ERROR|SERVER_DISABLED'); return; }
        if (GetKickUntil(kickedServers, saved.serverId) > Now() || !GetOnlineServer(saved.serverId)) {
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE'); return;
        }
    } else {
        const server = FindAvailableServer();
        if (!server) { SendLine(connection.socket, 'ERROR|NO_SERVER'); return; }
        saved = CreateClientIdentity(deviceKey, server.serverId);
    }
    AttachClient(connection, saved);
}

function IsRateLimited(connection) {
    const key = connection.clientId || `IP:${SafeIP(connection.socket)}`;
    const now = Now();
    let state = rateLimits.get(key);
    if (!state || now - state.startedAt >= RATE_LIMIT_WINDOW_MS) {
        state = { startedAt: now, count: 0 };
        rateLimits.set(key, state);
    }
    state.count++;
    return state.count > RATE_LIMIT_MAX;
}

function HandleClientSend(connection, line) {
    if (!state.serviceEnabled) { SendLine(connection.socket, 'SERVICE_STATE|DISABLED'); return; }
    // Maintenance intentionally allows already-authorized live sessions to continue.
    if (state.maintenanceMode && !connection.licenseAuthorized) { SendLine(connection.socket, 'SERVICE_STATE|MAINTENANCE'); return; }
    if (IsRateLimited(connection)) { SendLine(connection.socket, 'ERROR|RATE_LIMIT'); return; }

    const parts = line.split('|');
    if (parts.length !== 4) { SendLine(connection.socket, 'ERROR|INVALID_SEND'); return; }
    const requestId = String(parts[1] || '').trim();
    const clientId = NormalizeID(parts[2] || '');
    const number = String(parts[3] || '').trim();
    if (!requestId || requestId.length > 64) { SendLine(connection.socket, 'ERROR|REQUEST_ID_INVALID'); return; }
    if (!clientId || connection.clientId !== clientId) { SendLine(connection.socket, 'ERROR|CLIENT_NOT_OWNER'); return; }
    if (!/^-?\d+$/.test(number)) { SendLine(connection.socket, 'ERROR|NUMBER_ONLY'); return; }

    const requestKey = MakeRequestKey(clientId, requestId);
    if (requestHistory.has(requestKey)) { SendLine(connection.socket, 'ERROR|DUPLICATE_REQUEST'); return; }

    const active = GetUsableLicenseForConnection(connection);
    if (!active) {
        connection.licenseAuthorized = false;
        connection.licenseExpiresAt = 0;
        SendLine(connection.socket, 'ERROR|LICENSE_REQUIRED');
        NotifyServerUnauthorized(clientId, 'LICENSE_REQUIRED');
        return;
    }

    const saved = GetSavedClientByID(clientId);
    const server = saved ? GetOnlineServer(saved.serverId) : null;
    if (!saved) { SendLine(connection.socket, 'ERROR|CLIENT_NOT_FOUND'); return; }
    if (!server) { SendLine(connection.socket, 'ERROR|SERVER_OFFLINE'); return; }

    const payload = `NUMBER|${requestId}|${clientId}|${number}`;
    if (!SendLine(server.socket, payload)) { SendLine(connection.socket, 'ERROR|SERVER_SEND_FAILED'); return; }

    const forwardedAt = Now();
    requestHistory.set(requestKey, forwardedAt);
    require('../services/requestTrace').StartTrace(clientId, requestId, saved.serverId, number, forwardedAt);
    pendingRequests.set(requestKey, {
        clientId, serverId: saved.serverId, requestId, payload,
        createdAt: forwardedAt, lastSendAt: forwardedAt, retries: 0
    });

    active.license.lastSeenAt = Now();
    active.license.lastIP = SafeIP(connection.socket);
    active.license.sendCount = Number(active.license.sendCount || 0) + 1;
    saved.lastSeenAt = Now();
    saved.lastIP = active.license.lastIP;
    saved.sendCount = Number(saved.sendCount || 0) + 1;
    SaveDatabase();

    SendLine(connection.socket, `SENT|OK|${requestId}`);
    LogEvent('NUMBER_SEND', `${requestId} / ${clientId} / ${number}`);
}

function HandleClientLine(connection, line) {
    line = line.trim();
    if (!line) return;

    if (line === 'CONNECT' || line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        let protocolVersion = 1, appVersion = '1.0.0', deviceKey = '';
        if (parts.length >= 4) {
            protocolVersion = Number(parts[1]);
            appVersion = String(parts[2] || '').trim();
            deviceKey = parts.slice(3).join('|').trim();
        } else if (parts.length >= 2) {
            deviceKey = parts[1].trim();
        }
        HandleClientConnect(connection, deviceKey, protocolVersion, appVersion);
        return;
    }

    if (line.startsWith('LICENSE_AUTH|')) {
        const parts = line.split('|');
        const requestedClient = parts.length >= 3 ? NormalizeID(parts[2]) : '';
        if (requestedClient && requestedClient !== connection.clientId) { SendLine(connection.socket, 'LICENSE_ERROR|CLIENT_NOT_OWNER'); return; }
        AuthorizeClient(connection, parts[1] || '');
        return;
    }

    if (line === 'PONG' || line.startsWith('PONG|')) { HandlePong(connection, line.split('|')); return; }
    if (line.startsWith('SEND|')) { HandleClientSend(connection, line); return; }
    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

module.exports = {
    AttachClient,
    HandleClientConnect,
    IsRateLimited,
    HandleClientSend,
    HandleClientLine
};
