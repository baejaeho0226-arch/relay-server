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
function GetSavedClientByID(...args) { return require('../identity/identityManager').GetSavedClientByID(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }

function NotifyServerAuthorized(clientId, serverId, expiresAt) {
    const server = GetOnlineServer(serverId);
    if (!server) return;
    const client = GetOnlineClient(clientId);
    const state = `AUTHORIZED|${expiresAt}`;
    if (client && client.lastServerAuthState === state) return;
    if (client) client.lastServerAuthState = state;
    SendLine(server.socket, `CLIENT_AUTHORIZED|${clientId}|${expiresAt}`);
}

function NotifyServerUnauthorized(clientId, reason) {
    const saved = GetSavedClientByID(clientId);
    if (!saved) return;
    const server = GetOnlineServer(saved.serverId);
    if (!server) return;
    const client = GetOnlineClient(clientId);
    const state = `UNAUTHORIZED|${reason}`;
    if (client && client.lastServerAuthState === state) return;
    if (client) client.lastServerAuthState = state;
    SendLine(server.socket, `CLIENT_UNAUTHORIZED|${clientId}|${reason}`);
}

function NoticeAll(text) {
    const clean = SafeField(text);
    let count = 0;
    for (const client of clients.values()) if (SendLine(client.socket, `NOTICE|${clean}`)) count++;
    runtimeStats.notices += count;
    LogEvent('NOTICE_ALL', `${count} / ${clean}`);
    return count;
}

function NoticeClient(clientId, text) {
    clientId = NormalizeID(clientId);
    const client = GetOnlineClient(clientId);
    if (!client) return false;
    const clean = SafeField(text);
    const ok = SendLine(client.socket, `NOTICE|${clean}`);
    if (ok) { runtimeStats.notices++; LogEvent('NOTICE_CLIENT', `${clientId} / ${clean}`); }
    return ok;
}

module.exports = {
    NotifyServerAuthorized,
    NotifyServerUnauthorized,
    NoticeAll,
    NoticeClient
};
