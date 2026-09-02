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

function RepairOrphanAssignments() {
    const validServers = new Set(Array.from(serverIdentities.values()).map(NormalizeID).filter(Boolean));
    const validClients = new Set(Array.from(clientIdentities.values()).map(saved => NormalizeID(saved && saved.id)).filter(Boolean));
    let changed = 0;

    for (const saved of clientIdentities.values()) {
        if (!saved || !saved.id) continue;
        const serverId = NormalizeID(saved.serverId);
        if (serverId && !validServers.has(serverId)) {
            saved.serverId = '';
            const live = GetOnlineClient(saved.id);
            if (live) {
                live.serverId = '';
                live.buildCompleted = false;
                live.buildSessionId = '';
                SendLine(live.socket, 'SERVER_UNASSIGNED|ORPHAN_SERVER');
            }
            try { require('../services/buildGate').RevokeForClient(saved.id, 'ORPHAN_SERVER'); } catch (_) {}
            state.clientBuildBindings.delete(saved.id);
            changed++;
            LogEvent('CLIENT_ORPHAN_BINDING_REPAIRED', `${saved.id} released from ${serverId}`);
        }
    }

    for (const [clientId, binding] of Array.from(state.clientBuildBindings.entries())) {
        const serverId = NormalizeID(binding && binding.serverId);
        if (!validClients.has(NormalizeID(clientId)) || !validServers.has(serverId)) {
            state.clientBuildBindings.delete(clientId);
            changed++;
        }
    }

    if (changed) SaveDatabase();
    return changed;
}

function RepairOneToOneAssignments() {
    const groups = new Map();
    for (const saved of clientIdentities.values()) {
        const serverId = NormalizeID(saved && saved.serverId);
        if (!serverId || !saved || !saved.id) continue;
        if (!groups.has(serverId)) groups.set(serverId, []);
        groups.get(serverId).push(saved);
    }

    let changed = 0;
    for (const [serverId, rows] of groups) {
        if (rows.length <= MAX_CLIENTS_PER_SERVER) continue;
        rows.sort((a, b) => {
            // A completed fixed Build binding is authoritative.  For legacy
            // rows without one, keep the oldest deterministic assignment.
            let aFixed = false, bFixed = false;
            try {
                const gate = require('../services/buildGate');
                const ab = gate.BindingForClient(a.id);
                const bb = gate.BindingForClient(b.id);
                aFixed = !!ab && ab.serverId === serverId;
                bFixed = !!bb && bb.serverId === serverId;
            } catch (_) {}
            if (aFixed !== bFixed) return aFixed ? -1 : 1;
            return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) ||
                String(a.id).localeCompare(String(b.id));
        });

        for (const saved of rows.slice(MAX_CLIENTS_PER_SERVER)) {
            saved.serverId = '';
            changed++;
            try { require('../services/buildGate').RevokeForClient(saved.id, 'ONE_TO_ONE_REPAIR'); } catch (_) {}
            const live = GetOnlineClient(saved.id);
            if (live) {
                const previous = GetOnlineServer(live.serverId);
                if (previous && previous.clients instanceof Set) previous.clients.delete(saved.id);
                live.serverId = '';
                live.buildCompleted = false;
                live.buildSessionId = '';
                SendLine(live.socket, 'SERVER_UNASSIGNED|ONE_TO_ONE_REPAIR');
            }
            LogEvent('CLIENT_ONE_TO_ONE_REPAIR', `${saved.id} released from ${serverId}`);
        }
    }
    if (changed) SaveDatabase();
    return changed;
}

function FindAvailableServer() {
    const list = [];
    for (const server of servers.values()) {
        if (!server.registered || !server.socket || server.socket.destroyed) continue;
        if (disabledServers.has(server.serverId) || drainingServers.has(server.serverId)) continue;
        if (GetKickUntil(kickedServers, server.serverId) > Now()) continue;
        // Pairing reserves a slot only; it never grants business access.
        // Do not leave a phone unassigned merely because the server HMAC
        // challenge is still in flight. Build Gate remains authoritative.
        if (server.clients.size >= MAX_CLIENTS_PER_SERVER ||
            GetServerClientCount(server.serverId) >= MAX_CLIENTS_PER_SERVER) continue;
        list.push(server);
    }
    list.sort((a, b) => a.clients.size - b.clients.size);
    return list[0] || null;
}

function FindAssignableServerId() {
    const online = FindAvailableServer();
    // Never reserve an APK against a stale offline server identity.  If no PC
    // is online, the APK stays unassigned and the next live PC claims it.
    return online ? online.serverId : '';
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
    RepairOrphanAssignments,
    RepairOneToOneAssignments,
    FindAvailableServer,
    FindAssignableServerId,
    CreateClientIdentity,
    ClientMove
};
