'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function GetKickUntil(...args) { return require('../identity/identityManager').GetKickUntil(...args); }
function GetOnlineServer(...args) { return require('../identity/identityManager').GetOnlineServer(...args); }
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

function RegisterServer(connection, deviceKey, protocolVersion, appVersion) {
    deviceKey = String(deviceKey || '').trim();
    if (!deviceKey) { SendLine(connection.socket, 'ERROR|DEVICE_KEY_REQUIRED'); return false; }
    if (!ValidateProtocolAndVersion(connection, 'server', protocolVersion, appVersion)) return false;

    let serverId = serverIdentities.get(deviceKey);
    if (!serverId) {
        serverId = MakeUniqueID();
        serverIdentities.set(deviceKey, serverId);
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
    connection.reconnectCount = (runtimeStats.serverReconnects.get(serverId) || 0) + 1;
    runtimeStats.serverReconnects.set(serverId, connection.reconnectCount);
    servers.set(serverId, connection);
    TrackIP('SERVER', serverId, connection.lastIP);

    SendLine(connection.socket, `REGISTERED|${serverId}|${protocolVersion}|${appVersion}`);
    LogEvent('SERVER_ONLINE', `${serverId} v${appVersion}`);

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
    if (line.startsWith('ACK|')) { HandleServerAck(connection, line); return; }
    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

module.exports = {
    RegisterServer,
    HandleServerLine
};
