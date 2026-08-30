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
    connection.deviceAuthVerified = false;
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
        const enrollment = require('../services/deviceEnrollment').Request('CLIENT', deviceKey, { ip: SafeIP(connection.socket), appVersion, protocolVersion });
        if (!enrollment.allowed) {
            SaveDatabase();
            const requestId = enrollment.record && enrollment.record.requestId ? enrollment.record.requestId : '';
            SendLine(connection.socket, enrollment.rejected ? 'ERROR|ENROLLMENT_REJECTED' : `ERROR|ENROLLMENT_PENDING|${requestId}`);
            LogEvent(enrollment.rejected ? 'CLIENT_ENROLLMENT_REJECTED' : 'CLIENT_ENROLLMENT_PENDING', `${deviceKey} ${requestId}`);
            return;
        }
        const server = FindAvailableServer();
        if (!server) { SendLine(connection.socket, 'ERROR|NO_SERVER'); return; }
        saved = CreateClientIdentity(deviceKey, server.serverId);
        require('../services/deviceEnrollment').MarkBound('CLIENT', deviceKey, saved.id);
        SaveDatabase();
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
    const deviceAuth = require('../services/deviceAuth');
    if (deviceAuth.Enforced('CLIENT',connection.clientId) && !deviceAuth.Verified('CLIENT',connection.clientId)) { SendLine(connection.socket,'ERROR|DEVICE_AUTH_REQUIRED'); deviceAuth.IssueChallenge('CLIENT',connection.clientId); return; }
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
    if (deviceAuth.Enforced('SERVER',saved.serverId) && !deviceAuth.Verified('SERVER',saved.serverId)) { SendLine(connection.socket,'ERROR|SERVER_AUTH_REQUIRED'); deviceAuth.IssueChallenge('SERVER',saved.serverId); return; }

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

    if (connection.clientId) {
        if (line.startsWith('CAPABILITIES|')) { const dc=require('../services/deviceControl'); dc.RecordCapabilities('CLIENT', connection.clientId, line.substring('CAPABILITIES|'.length)); dc.PushDesiredConfig('CLIENT', connection.clientId); require('../services/releaseManager').NotifyDevice('CLIENT', connection.clientId); require('../services/deviceAuth').SendEnrollmentSecret('CLIENT', connection.clientId, false); return; }
        if (line.startsWith('DEVICE_INFO|')) { require('../services/deviceControl').RecordDeviceInfo('CLIENT', connection.clientId, line.split('|').slice(1)); return; }
        if (line.startsWith('PROTOCOL_PROFILE|')) { const p=line.split('|'); require('../services/protocolReadiness').RecordProfile('CLIENT', connection.clientId, p[1], p[2], p.slice(3).join('|')); return; }
        if (line === 'DEVICE_SECRET_ACK' || line.startsWith('DEVICE_SECRET_ACK|')) { require('../services/deviceAuth').HandleSecretAck('CLIENT', connection.clientId); return; }
        if (line.startsWith('DEVICE_AUTH|')) { const p=line.split('|'); require('../services/deviceAuth').HandleAuth('CLIENT', connection.clientId, p[1], p[2]); return; }
        if (line.startsWith('COMMAND_ACK|')) { require('../services/deviceControl').RecordCommandAck('CLIENT', connection.clientId, line.split('|')); return; }
        if (line.startsWith('DIAGNOSTICS|')) { require('../services/deviceControl').RecordDiagnostics('CLIENT', connection.clientId, line.split('|').slice(2).join('|')); return; }
        if (line.startsWith('UPDATE_ACK|')) { require('../services/releaseManager').RecordUpdateAck('CLIENT', connection.clientId, line.split('|')); return; }
        if (line.startsWith('DEVICE_SECRET_ROTATE_ACK|')) { const r=require('../services/deviceSecretRotation').HandleAck('CLIENT',connection.clientId,line.split('|')); if(!r.ok) SendLine(connection.socket,`DEVICE_SECRET_ROTATE_ERROR|${line.split('|')[1]||''}|${r.reason}`); return; }
        if (line.startsWith('CONFIG_ACK|')) {  connection.configAck = line; return; }
        if (line.startsWith('UI_STATE|')) { const p=line.split('|'); require('../services/deviceControl').RecordUiState(connection.clientId,p[1],p.slice(2).join('|')); return; }
    }

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
        const da=require('../services/deviceAuth');
        if (da.Enforced('CLIENT',connection.clientId) && !da.Verified('CLIENT',connection.clientId)) { SendLine(connection.socket,'ERROR|DEVICE_AUTH_REQUIRED'); da.IssueChallenge('CLIENT',connection.clientId); return; }
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
