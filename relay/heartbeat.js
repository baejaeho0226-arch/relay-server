'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function Now(...args) { return require('../core/utils').Now(...args); }
function RandomHex(...args) { return require('../core/utils').RandomHex(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }

function SendPing(connection) {
    if (!connection || !connection.socket || connection.socket.destroyed) return;
    connection.heartbeatStats = connection.heartbeatStats || {sent:0,received:0,missed:0,consecutiveMisses:0,rttMin:-1,rttMax:-1,rttSum:0,rttSamples:0,lastRtt:-1,jitterSum:0,jitterSamples:0};
    if (connection.pendingPingToken && connection.pendingPingAt > 0) { connection.heartbeatStats.missed++; connection.heartbeatStats.consecutiveMisses++; }
    const token = RandomHex(6); connection.pendingPingToken = token; connection.pendingPingAt = Now(); connection.heartbeatStats.sent++;
    SendLine(connection.socket, `PING|${token}|${connection.pendingPingAt}`);
}

function HandlePong(connection, parts) {
    connection.lastSeen = Now();
    const token = parts[1] || '';
    if (token && token === connection.pendingPingToken && connection.pendingPingAt > 0) {
        connection.rttMs = Math.max(0, Now() - connection.pendingPingAt);
        const h=connection.heartbeatStats||(connection.heartbeatStats={sent:0,received:0,missed:0,consecutiveMisses:0,rttMin:-1,rttMax:-1,rttSum:0,rttSamples:0,lastRtt:-1,jitterSum:0,jitterSamples:0});
        h.received++; h.consecutiveMisses=0; h.rttMin=h.rttMin<0?connection.rttMs:Math.min(h.rttMin,connection.rttMs); h.rttMax=Math.max(h.rttMax,connection.rttMs); h.rttSum+=connection.rttMs; h.rttSamples++;
        if(h.lastRtt>=0){h.jitterSum+=Math.abs(connection.rttMs-h.lastRtt);h.jitterSamples++;}h.lastRtt=connection.rttMs;h.lastPongAt=Now();
        connection.pendingPingToken = ''; connection.pendingPingAt = 0;
    }
}

module.exports = {
    SendPing,
    HandlePong
};
