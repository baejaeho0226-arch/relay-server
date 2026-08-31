'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function CreateBackup(...args) { return require('../storage/backup').CreateBackup(...args); }
function FailPendingRequestsForServer(...args) { return require('../relay/ackManager').FailPendingRequestsForServer(...args); }
function GetOnlineServer(...args) { return require('../identity/identityManager').GetOnlineServer(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function Now(...args) { return require('./utils').Now(...args); }
function SafeIP(...args) { return require('./utils').SafeIP(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SendLine(...args) { return require('./utils').SendLine(...args); }

function ForceReconnectAll(reason) {
    for (const c of Array.from(clients.values())) { SendLine(c.socket, `ERROR|${reason}`); try { c.socket.destroy(); } catch (_) {} }
    for (const c of Array.from(servers.values())) { SendLine(c.socket, `ERROR|${reason}`); try { c.socket.destroy(); } catch (_) {} }
}

function CleanupTransient() {
    const now=Now();
    for(const [key,state] of rateLimits) if(state.startedAt<now-RATE_LIMIT_WINDOW_MS*5) rateLimits.delete(key);
    for(const [id,until] of kickedServers) if(now>=until){kickedServers.delete(id);LogEvent('SERVER_KICK_EXPIRED',id);}
    for(const [id,until] of kickedClients) if(now>=until){kickedClients.delete(id);LogEvent('CLIENT_KICK_EXPIRED',id);}
    for(const [token,item] of confirmTokens) if(now>=item.expiresAt) confirmTokens.delete(token);
}

function DisconnectConnection(connection) {
    if(connection.disconnected)return;connection.disconnected=true;
    if(connection.type==='server'){
        if(connection.serverId&&servers.get(connection.serverId)===connection)servers.delete(connection.serverId);
        if(connection.serverId){FailPendingRequestsForServer(connection.serverId,'SERVER_OFFLINE');LogEvent('SERVER_OFFLINE',connection.serverId);try{require('../services/emergencyFailover').MarkServerOffline(connection.serverId);}catch(_){}}
    }else if(connection.type==='client'){
        if(connection.clientId) state.clientPasswordChallenges.delete(connection.clientId);
        if(connection.clientId&&clients.get(connection.clientId)===connection)clients.delete(connection.clientId);
        if(connection.clientId&&connection.serverId){const s=GetOnlineServer(connection.serverId);if(s)s.clients.delete(connection.clientId);}
        if(connection.clientId)LogEvent('CLIENT_OFFLINE',connection.clientId);
    }else if(connection.type==='admin'){
        LogEvent('ADMIN_OFFLINE',SafeIP(connection.socket));
    }
}

function Shutdown(){try{CreateBackup('shutdown');SaveDatabase();}finally{process.exit(0);}}

module.exports = {
    ForceReconnectAll,
    CleanupTransient,
    DisconnectConnection,
    Shutdown
};
