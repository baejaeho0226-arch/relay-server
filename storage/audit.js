'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function Now(...args) { return require('../core/utils').Now(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }

function AuditFileForTime(ms) {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return path.join(AUDIT_DIR, `audit-${yyyy}-${mm}-${dd}.jsonl`);
}

function LogEvent(type, detail) {
    const event = { time: Now(), type: SafeField(type), detail: SafeField(detail) };
    events.push(event);
    while (events.length > MAX_EVENT_MEMORY) events.shift();
    console.log('[EVENT]', event.type, event.detail);
    try {
        fs.appendFileSync(AuditFileForTime(event.time), JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
        console.error('AUDIT WRITE ERROR:', error.message);
    }
}

function LoadRecentAudit() {
    try {
        const files = fs.readdirSync(AUDIT_DIR)
            .filter(x => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x))
            .sort()
            .slice(-5);
        const loaded = [];
        for (const file of files) {
            const lines = fs.readFileSync(path.join(AUDIT_DIR, file), 'utf8').split(/\r?\n/);
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const item = JSON.parse(line);
                    loaded.push({ time: Number(item.time) || 0, type: SafeField(item.type), detail: SafeField(item.detail) });
                } catch (_) {}
            }
        }
        loaded.sort((a, b) => a.time - b.time);
        for (const item of loaded.slice(-MAX_EVENT_MEMORY)) events.push(item);
    } catch (_) {}
}

function AuditSearch(query, type, sinceMs) {
    query = String(query || '').trim().toUpperCase();
    type = String(type || '').trim().toUpperCase();
    sinceMs = Number(sinceMs) || 0;
    return events.filter(e => {
        if (sinceMs && e.time < sinceMs) return false;
        if (type && type !== 'ALL' && e.type.toUpperCase() !== type) return false;
        if (query && !`${e.type}|${e.detail}`.toUpperCase().includes(query)) return false;
        return true;
    }).slice(-MAX_SEARCH_RESULTS);
}

module.exports = {
    AuditFileForTime,
    LogEvent,
    LoadRecentAudit,
    AuditSearch
};
