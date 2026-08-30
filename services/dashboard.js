'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function GetOnlineClient(...args) { return require('../identity/identityManager').GetOnlineClient(...args); }
function GetOnlineServer(...args) { return require('../identity/identityManager').GetOnlineServer(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }

function HealthSnapshot() {
    let onlineServers=0,onlineClients=0;
    for(const id of serverIdentities.values())if(GetOnlineServer(id))onlineServers++;
    for(const saved of clientIdentities.values())if(GetOnlineClient(saved.id))onlineClients++;
    return {
        ok: state.serviceEnabled,
        serviceEnabled: state.serviceEnabled,
        maintenanceMode: state.maintenanceMode,
        startedAt: runtimeStats.startedAt,
        uptimeMs: Now()-runtimeStats.startedAt,
        servers: { total: serverIdentities.size, online: onlineServers, disabled: disabledServers.size, draining: drainingServers.size },
        clients: { total: clientIdentities.size, online: onlineClients, disabled: disabledClients.size },
        licenses: licenses.size,
        pendingAcks: pendingRequests.size,
        ack: { ok: runtimeStats.ackOk, error: runtimeStats.ackError, timeout: runtimeStats.ackTimeout, retries: runtimeStats.ackRetries },
        recovery: { queued: state.offlineQueue.size, deadLetters: Array.from(state.deadLetters.values()).filter(x => x.status === 'ACTIVE').length },
        versionPolicy: { minProtocolVersion: state.minProtocolVersion, minServerVersion: state.minServerVersion, minClientVersion: state.minClientVersion },
        dataDir: DATA_DIR
    };
}

module.exports = {
    HealthSnapshot
};
