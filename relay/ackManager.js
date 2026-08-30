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
function Now(...args) { return require('../core/utils').Now(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }
function CompleteTrace(...args) { return require('../services/requestTrace').CompleteTrace(...args); }
function RetryTrace(...args) { return require('../services/requestTrace').RetryTrace(...args); }
function TrimTraces(...args) { return require('../services/requestTrace').TrimTraces(...args); }

function MakeRequestKey(clientId, requestId) {
    return `${NormalizeID(clientId)}|${String(requestId || '').trim()}`;
}

function RecordAck(serverId, clientId, result) {
    function bump(map, id) {
        if (!id) return;
        const item = map.get(id) || { ok: 0, error: 0, timeout: 0 };
        if (result === 'OK') item.ok++;
        else if (result === 'TIMEOUT') item.timeout++;
        else item.error++;
        map.set(id, item);
    }
    bump(runtimeStats.serverAckStats, serverId);
    bump(runtimeStats.clientAckStats, clientId);
}

function HandleServerAck(connection, line) {
    const parts = line.split('|');
    if (parts.length < 4) { SendLine(connection.socket, 'ERROR|INVALID_ACK'); return; }
    const requestId = String(parts[1] || '').trim();
    const clientId = NormalizeID(parts[2] || '');
    const result = String(parts[3] || '').trim().toUpperCase();
    const saved = GetSavedClientByID(clientId);
    const key = MakeRequestKey(clientId, requestId);
    const pending = pendingRequests.get(key);
    if (!requestId || !clientId || !saved) {
        SendLine(connection.socket, 'ERROR|ACK_NOT_OWNER');
        return;
    }
    if (!pending) { SendLine(connection.socket, `ACK_RESULT|UNKNOWN|${requestId}`); return; }
    if (pending.serverId !== connection.serverId) { SendLine(connection.socket, 'ERROR|ACK_NOT_OWNER'); return; }
    pendingRequests.delete(key);
    const client = GetOnlineClient(clientId);
    if (result === 'OK') {
        runtimeStats.ackOk++;
        RecordAck(connection.serverId, clientId, 'OK');
        const processingMs = parts.length >= 5 && /^\d+$/.test(parts[4]) ? Number(parts[4]) : 0;
        const processor = parts.length >= 6 ? SafeField(parts[5]) : '';
        const detail = parts.length >= 7 ? SafeField(parts.slice(6).join(' ')) : '';
        const trace=CompleteTrace(clientId, requestId, 'OK', '', Now());
        if(trace){trace.processingMs=processingMs;trace.processor=processor;trace.resultDetail=detail;}
        require('../services/processorCenter').Record(processor || 'DEFAULT', 'OK', processingMs);
        require('../services/dailyHealth').Record('ackOk');
        if (client && pending.notifyClient !== false) SendLine(client.socket, processingMs||processor||detail ? `ACK|OK|${requestId}|${processingMs}|${processor}|${detail}` : `ACK|OK|${requestId}`);
        SendLine(connection.socket, `ACK_RESULT|OK|${requestId}`);
        LogEvent('ACK_OK', `${requestId} / ${clientId}`);
    } else {
        runtimeStats.ackError++;
        RecordAck(connection.serverId, clientId, 'ERROR');
        const reason = parts.length >= 5 ? SafeField(parts[4]) : 'PROCESS_FAILED';
        const processingMs = parts.length >= 6 && /^\d+$/.test(parts[5]) ? Number(parts[5]) : 0;
        const processor = parts.length >= 7 ? SafeField(parts[6]) : '';
        const detail = parts.length >= 8 ? SafeField(parts.slice(7).join(' ')) : '';
        const trace=CompleteTrace(clientId, requestId, 'ERROR', reason, Now());
        if(trace){trace.processingMs=processingMs;trace.processor=processor;trace.resultDetail=detail;}
        require('../services/processorCenter').Record(processor || 'DEFAULT', 'ERROR', processingMs, reason);
        require('../services/dailyHealth').Record('ackError');
        require('../services/requestRecovery').AddDeadLetter(pending, reason, { detail });
        if (client && pending.notifyClient !== false) SendLine(client.socket, processingMs||processor||detail ? `ACK|ERROR|${requestId}|${reason}|${processingMs}|${processor}|${detail}` : `ACK|ERROR|${requestId}|${reason}`);
        SendLine(connection.socket, `ACK_RESULT|ERROR|${requestId}`);
        LogEvent('ACK_ERROR', `${requestId} / ${clientId} / ${reason}`);
    }
}

function CleanupRequestHistory() {
    const cutoff=Now()-REQUEST_HISTORY_TIMEOUT_MS;
    for(const [key,ts] of requestHistory) {
        if (pendingRequests.has(key)) continue;
        const split = key.indexOf('|');
        const queued = split > 0 && require('../services/requestRecovery').IsQueued(key.substring(0, split), key.substring(split + 1));
        if (!queued && (!Number.isFinite(ts) || ts < cutoff)) requestHistory.delete(key);
    }
    TrimTraces();
}

function ProcessPendingRequests() {
    const now=Now();
    for(const [key,p] of Array.from(pendingRequests.entries())) {
        if(now-p.createdAt>=ACK_TIMEOUT_MS){
            pendingRequests.delete(key);runtimeStats.ackTimeout++;RecordAck(p.serverId,p.clientId,'TIMEOUT');require('../services/dailyHealth').Record('ackTimeout');CompleteTrace(p.clientId,p.requestId,'TIMEOUT','ACK_TIMEOUT',now);require('../services/requestRecovery').AddDeadLetter(p,'ACK_TIMEOUT');const c=GetOnlineClient(p.clientId);if(c&&p.notifyClient!==false)SendLine(c.socket,`ACK|TIMEOUT|${p.requestId}`);LogEvent('ACK_TIMEOUT',`${p.requestId} / ${p.clientId}`);continue;
        }
        if(now-p.lastSendAt>=ACK_RETRY_MS&&p.retries<ACK_MAX_RETRIES){
            const s=GetOnlineServer(p.serverId);if(!s)continue;
            if(SendLine(s.socket,p.payload)){p.retries++;p.lastSendAt=now;RetryTrace(p.clientId,p.requestId,p.retries,now);runtimeStats.ackRetries++;LogEvent('ACK_RETRY',`${p.requestId} / ${p.clientId} #${p.retries}`);}
        }
    }
}

function FailPendingRequestsForServer(serverId, reason) {
    for(const [key,p] of Array.from(pendingRequests.entries())){
        if(p.serverId!==serverId)continue;pendingRequests.delete(key);
        const queued=require('../services/requestRecovery').RequeuePending(p,reason);
        if(queued.ok){LogEvent('ACK_REQUEUED',`${p.requestId} / ${p.clientId} / ${reason}`);continue;}
        CompleteTrace(p.clientId,p.requestId,'ERROR',reason,Now());require('../services/requestRecovery').AddDeadLetter(p,reason,{detail:queued.reason});const c=GetOnlineClient(p.clientId);if(c&&p.notifyClient!==false)SendLine(c.socket,`ACK|ERROR|${p.requestId}|${reason}`);runtimeStats.ackError++;RecordAck(p.serverId,p.clientId,'ERROR');require('../services/dailyHealth').Record('ackError');LogEvent('ACK_FAILED',`${p.requestId} / ${p.clientId} / ${reason}`);
    }
}

module.exports = {
    MakeRequestKey,
    HandleServerAck,
    CleanupRequestHistory,
    ProcessPendingRequests,
    FailPendingRequestsForServer
};
