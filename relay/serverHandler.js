'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function GetKickUntil(...args) { return require('../identity/identityManager').GetKickUntil(...args); }
function GetOnlineClient(...args) { return require('../identity/identityManager').GetOnlineClient(...args); }
function GetOnlineServer(...args) { return require('../identity/identityManager').GetOnlineServer(...args); }
function GetServerClientCount(...args) { return require('../identity/identityManager').GetServerClientCount(...args); }
function GetUsableLicenseForConnection(...args) { return require('../license/licenseManager').GetUsableLicenseForConnection(...args); }
function HandlePong(...args) { return require('./heartbeat').HandlePong(...args); }
function HandleServerAck(...args) { return require('./ackManager').HandleServerAck(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function MakeUniqueID(...args) { return require('../identity/identityManager').MakeUniqueID(...args); }
function NotifyServerAuthorized(...args) { return require('./notifications').NotifyServerAuthorized(...args); }
function NotifyServerUnauthorized(...args) { return require('./notifications').NotifyServerUnauthorized(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function SafeIP(...args) { return require('../core/utils').SafeIP(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }
function TrackIP(...args) { return require('../identity/identityManager').TrackIP(...args); }
function ValidateProtocolAndVersion(...args) { return require('../services/versionPolicy').ValidateProtocolAndVersion(...args); }

function BindUnassignedClients(serverId) {
    if (!serverId || disabledServers.has(serverId) || drainingServers.has(serverId)) return 0;
    if (GetKickUntil(kickedServers, serverId) > Now()) return 0;

    let assignedCount = GetServerClientCount(serverId);
    let changed = 0;
    for (const [deviceKey, saved] of clientIdentities) {
        if (!saved || saved.serverId || assignedCount >= MAX_CLIENTS_PER_SERVER) continue;
        saved.serverId = serverId;
        assignedCount++;
        changed++;

        const live = GetOnlineClient(saved.id);
        if (live) {
            live.serverId = serverId;
            SendLine(live.socket, `SERVER_ASSIGNED|${serverId}`);
        }
        LogEvent('CLIENT_FIRST_BIND', `${saved.id} -> ${serverId} (${deviceKey})`);
    }
    if (changed) SaveDatabase();
    return changed;
}

function RegisterServer(connection, deviceKey, protocolVersion, appVersion) {
    deviceKey = String(deviceKey || '').trim();
    if (!deviceKey) { SendLine(connection.socket, 'ERROR|DEVICE_KEY_REQUIRED'); return false; }
    if (!ValidateProtocolAndVersion(connection, 'server', protocolVersion, appVersion)) return false;

    let serverId = serverIdentities.get(deviceKey);
    if (!serverId) {
        const enrollment = require('../services/deviceEnrollment').Request('SERVER', deviceKey, { ip: SafeIP(connection.socket), appVersion, protocolVersion });
        if (!enrollment.allowed) {
            SaveDatabase();
            const requestId = enrollment.record && enrollment.record.requestId ? enrollment.record.requestId : '';
            SendLine(connection.socket, enrollment.rejected ? 'ERROR|ENROLLMENT_REJECTED' : `ERROR|ENROLLMENT_PENDING|${requestId}`);
            LogEvent(enrollment.rejected ? 'SERVER_ENROLLMENT_REJECTED' : 'SERVER_ENROLLMENT_PENDING', `${deviceKey} ${requestId}`);
            return false;
        }
        serverId = MakeUniqueID();
        serverIdentities.set(deviceKey, serverId);
        require('../services/deviceEnrollment').MarkBound('SERVER', deviceKey, serverId);
        SaveDatabase();
        LogEvent('SERVER_CREATE', `${serverId} -> ${deviceKey}`);
    }

    if (disabledServers.has(serverId)) { SendLine(connection.socket, 'ERROR|SERVER_DISABLED'); return false; }
    const kickedUntil = GetKickUntil(kickedServers, serverId);
    if (kickedUntil > Now()) { SendLine(connection.socket, `ERROR|SERVER_KICKED|${kickedUntil}`); return false; }

    const old = GetOnlineServer(serverId);
    if (old && old !== connection) {
        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.identityKey = deviceKey;
    connection.serverId = serverId;
    connection.registered = true;
    connection.lastSeen = Now();
    connection.lastIP = SafeIP(connection.socket);
    connection.clients = new Set();
    connection.deviceAuthVerified = false;
    connection.reconnectCount = (runtimeStats.serverReconnects.get(serverId) || 0) + 1;
    runtimeStats.serverReconnects.set(serverId, connection.reconnectCount);
    require('../services/reconnectMonitor').RecordReconnect('SERVER', serverId);
    servers.set(serverId, connection);
    TrackIP('SERVER', serverId, connection.lastIP);
    try { require('../services/emergencyFailover').MarkServerOnline(serverId); } catch (_) {}

    SendLine(connection.socket, `REGISTERED|${serverId}|${protocolVersion}|${appVersion}`);
    LogEvent('SERVER_ONLINE', `${serverId} v${appVersion}`);

    BindUnassignedClients(serverId);

    for (const client of clients.values()) {
        if (client.serverId !== serverId) continue;
        connection.clients.add(client.clientId);
        client.lastServerAuthState = '';
        if (client.licenseAuthorized) {
            const active = GetUsableLicenseForConnection(client);
            if (active) NotifyServerAuthorized(client.clientId, serverId, active.license.expiresAt);
            else NotifyServerUnauthorized(client.clientId, 'LICENSE_REQUIRED');
        } else {
            NotifyServerUnauthorized(client.clientId, 'LICENSE_REQUIRED');
        }
    }
    return true;
}

function HandleServerLine(connection, line) {
    line = line.trim();
    if (!line) return;

    if (connection.serverId) {
        if (line.startsWith('CAPABILITIES|')) { const dc=require('../services/deviceControl'); dc.RecordCapabilities('SERVER', connection.serverId, line.substring('CAPABILITIES|'.length)); dc.PushDesiredConfig('SERVER', connection.serverId); if(dc.Capabilities('SERVER',connection.serverId).includes('PROCESSOR_POLICY'))require('../services/processorCenter').PushToServer(connection.serverId); require('../services/releaseManager').NotifyDevice('SERVER', connection.serverId); require('../services/deviceAuth').SendEnrollmentSecret('SERVER', connection.serverId, false); return; }
        if (line.startsWith('DEVICE_INFO|')) { require('../services/deviceControl').RecordDeviceInfo('SERVER', connection.serverId, line.split('|').slice(1)); return; }
        if (line.startsWith('PROTOCOL_PROFILE|')) { const p=line.split('|'); require('../services/protocolReadiness').RecordProfile('SERVER', connection.serverId, p[1], p[2], p.slice(3).join('|')); return; }
        if (line === 'DEVICE_SECRET_ACK' || line.startsWith('DEVICE_SECRET_ACK|')) { require('../services/deviceAuth').HandleSecretAck('SERVER', connection.serverId); return; }
        if (line.startsWith('DEVICE_AUTH|')) { const p=line.split('|'); require('../services/deviceAuth').HandleAuth('SERVER', connection.serverId, p[1], p[2]); return; }
        if (line.startsWith('COMMAND_ACK|')) { require('../services/deviceControl').RecordCommandAck('SERVER', connection.serverId, line.split('|')); return; }
        if (line.startsWith('DIAGNOSTICS|')) { require('../services/deviceControl').RecordDiagnostics('SERVER', connection.serverId, line.split('|').slice(2).join('|')); return; }
        if (line.startsWith('UPDATE_ACK|')) { require('../services/releaseManager').RecordUpdateAck('SERVER', connection.serverId, line.split('|')); return; }
        if (line.startsWith('DEVICE_SECRET_ROTATE_ACK|')) { const r=require('../services/deviceSecretRotation').HandleAck('SERVER',connection.serverId,line.split('|')); if(!r.ok) SendLine(connection.socket,`DEVICE_SECRET_ROTATE_ERROR|${line.split('|')[1]||''}|${r.reason}`); return; }
        if (line.startsWith('CONFIG_ACK|')) {  connection.configAck = line; return; }
        if (line.startsWith('PROCESSOR_CONFIG_ACK|')) { require('../services/processorCenter').HandleAck(connection.serverId, line.split('|')); return; }
    }

    if (line === 'REGISTER' || line.startsWith('REGISTER|')) {
        if (connection.registered) { SendLine(connection.socket, 'ERROR|ALREADY_REGISTERED'); return; }
        const parts = line.split('|');
        let protocolVersion = 1, appVersion = '1.0.0', deviceKey = '';
        if (parts.length >= 4) {
            protocolVersion = Number(parts[1]);
            appVersion = String(parts[2] || '').trim();
            deviceKey = parts.slice(3).join('|').trim();
        } else if (parts.length >= 2) {
            deviceKey = parts[1].trim();
        }
        const ok = RegisterServer(connection, deviceKey, protocolVersion, appVersion);
        if (!ok) setTimeout(() => { try { connection.socket.destroy(); } catch (_) {} }, 150);
        return;
    }

    if (line === 'PONG' || line.startsWith('PONG|')) { HandlePong(connection, line.split('|')); return; }
    if (line.startsWith('ACK|')) { const da=require('../services/deviceAuth'); if(da.Enforced('SERVER',connection.serverId)&&!da.Verified('SERVER',connection.serverId)){ SendLine(connection.socket,'ERROR|DEVICE_AUTH_REQUIRED'); da.IssueChallenge('SERVER',connection.serverId); return; } HandleServerAck(connection, line); return; }
    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

module.exports = {
    BindUnassignedClients,
    RegisterServer,
    HandleServerLine
};
