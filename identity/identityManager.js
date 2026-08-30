'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function RandomID(...args) { return require('../core/utils').RandomID(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }

function GetUsedIDs() {
    const set = new Set();
    for (const id of serverIdentities.values()) if (id) set.add(id);
    for (const saved of clientIdentities.values()) if (saved && saved.id) set.add(saved.id);
    return set;
}

function MakeUniqueID() {
    const used = GetUsedIDs();
    let id;
    do { id = RandomID(); } while (used.has(id));
    return id;
}

function GetOnlineServer(serverId) {
    const c = servers.get(serverId);
    return c && c.registered && c.socket && !c.socket.destroyed ? c : null;
}

function GetOnlineClient(clientId) {
    const c = clients.get(clientId);
    return c && c.connected && c.socket && !c.socket.destroyed ? c : null;
}

function GetSavedClientByID(clientId) {
    clientId = NormalizeID(clientId);
    for (const saved of clientIdentities.values()) if (saved.id === clientId) return saved;
    return null;
}

function FindClientDeviceKey(clientId) {
    clientId = NormalizeID(clientId);
    for (const [deviceKey, saved] of clientIdentities) if (saved.id === clientId) return deviceKey;
    return '';
}

function FindServerDeviceKey(serverId) {
    serverId = NormalizeID(serverId);
    for (const [deviceKey, id] of serverIdentities) if (id === serverId) return deviceKey;
    return '';
}

function ServerExists(serverId) {
    serverId = NormalizeID(serverId);
    return !!serverId && Array.from(serverIdentities.values()).includes(serverId);
}

function ClientExists(clientId) {
    return !!GetSavedClientByID(clientId);
}

function GetKickUntil(map, id) {
    const until = Number(map.get(id) || 0);
    if (until && Now() >= until) { map.delete(id); return 0; }
    return until;
}

function ServerHealth(connection) {
    if (!connection) return 'OFFLINE';
    const age = Now() - connection.lastSeen;
    if (age > 25000) return 'UNSTABLE';
    if (connection.rttMs < 0) return 'CONNECTING';
    if (connection.rttMs <= 300) return 'GOOD';
    if (connection.rttMs <= 1000) return 'SLOW';
    return 'UNSTABLE';
}

function ClientHealth(connection) {
    return ServerHealth(connection);
}

function TrackIP(kind, id, ip) {
    if (!id || !ip) return;
    const key = `${kind}:${id}`;
    const prev = ipHistory.get(key);
    if (prev && prev.ip && prev.ip !== ip) {
        LogEvent('IP_CHANGED', `${key} ${prev.ip} -> ${ip}`);
    }
    ipHistory.set(key, { ip, changedAt: Now() });
    try { require('../services/networkSecurity').Track(kind, id, ip); } catch (_) {}
}

function GetServerClientCount(serverId) {
    let count = 0;
    for (const saved of clientIdentities.values()) if (saved.serverId === serverId) count++;
    return count;
}

function FindAvailableServer() {
    const list = [];
    for (const server of servers.values()) {
        if (!server.registered || !server.socket || server.socket.destroyed) continue;
        if (disabledServers.has(server.serverId) || drainingServers.has(server.serverId)) continue;
        if (GetKickUntil(kickedServers, server.serverId) > Now()) continue;
        try { const da=require('../services/deviceAuth'); if(da.Enforced('SERVER',server.serverId)&&!da.Verified('SERVER',server.serverId)) continue; } catch (_) {}
        if (server.clients.size >= MAX_CLIENTS_PER_SERVER) continue;
        list.push(server);
    }
    list.sort((a, b) => a.clients.size - b.clients.size);
    return list[0] || null;
}

function CreateClientIdentity(deviceKey, serverId) {
    const old = clientIdentities.get(deviceKey);
    if (old) return old;
    const saved = {
        id: MakeUniqueID(), serverId, createdAt: Now(), lastSeenAt: 0, lastAuthAt: 0,
        lastIP: '', authCount: 0, sendCount: 0, reconnectCount: 0
    };
    clientIdentities.set(deviceKey, saved);
    SaveDatabase();
    LogEvent('CLIENT_CREATE', `${saved.id} -> ${deviceKey}`);
    return saved;
}

function ClientMove(clientId, newServerId) {
    clientId = NormalizeID(clientId);
    newServerId = NormalizeID(newServerId);
    const saved = GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!ServerExists(newServerId)) return { ok: false, reason: 'SERVER_NOT_FOUND' };
    if (saved.serverId === newServerId) return { ok: false, reason: 'SAME_SERVER' };
    if (disabledServers.has(newServerId)) return { ok: false, reason: 'SERVER_DISABLED' };
    if (drainingServers.has(newServerId)) return { ok: false, reason: 'SERVER_DRAINING' };
    if (GetKickUntil(kickedServers, newServerId) > Now()) return { ok: false, reason: 'SERVER_KICKED' };
    const target = GetOnlineServer(newServerId);
    if (!target) return { ok: false, reason: 'SERVER_OFFLINE' };
    if (target.clients.size >= MAX_CLIENTS_PER_SERVER || GetServerClientCount(newServerId) >= MAX_CLIENTS_PER_SERVER) return { ok: false, reason: 'SERVER_FULL' };

    const oldServer = saved.serverId;
    saved.serverId = newServerId;
    try { require('../services/emergencyFailover').HandleManualMove(clientId, newServerId); } catch (_) {}
    SaveDatabase();

    const live = GetOnlineClient(clientId);
    if (live) {
        SendLine(live.socket, `ERROR|CLIENT_MOVED|${newServerId}`);
        live.socket.destroy();
    }

    LogEvent('CLIENT_MOVE', `${clientId} ${oldServer} -> ${newServerId}`);
    return { ok: true, oldServerId: oldServer, newServerId };
}

module.exports = {
    GetUsedIDs,
    MakeUniqueID,
    GetOnlineServer,
    GetOnlineClient,
    GetSavedClientByID,
    FindClientDeviceKey,
    FindServerDeviceKey,
    ServerExists,
    ClientExists,
    GetKickUntil,
    ServerHealth,
    ClientHealth,
    TrackIP,
    GetServerClientCount,
    FindAvailableServer,
    CreateClientIdentity,
    ClientMove
};
