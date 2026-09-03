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

function EventHash(previousHash, sequence, time, type, detail) {
    return crypto.createHash('sha256')
        .update(`${previousHash}|${sequence}|${time}|${type}|${detail}`, 'utf8')
        .digest('hex').toUpperCase();
}

function LogEvent(type, detail) {
    const chain = state.production.auditChain;
    const event = {
        time: Now(), type: SafeField(type), detail: SafeField(detail),
        sequence: Math.max(0, Number(chain.count) || 0) + 1,
        previousHash: String(chain.head || '').toUpperCase()
    };
    event.hash = EventHash(event.previousHash, event.sequence, event.time, event.type, event.detail);
    chain.head = event.hash;
    chain.count = event.sequence;
    chain.lastError = '';
    events.push(event);
    while (events.length > MAX_EVENT_MEMORY) events.shift();
    console.log('[EVENT]', event.type, event.detail);
    try { require('../web/webEvents').BroadcastEvent(event); } catch (_) {}
    try { require('../services/notificationCenter').CaptureEvent(event); } catch (_) {}
    try { require('../services/incidentCenter').CaptureEvent(event); } catch (_) {}
    try {
        fs.appendFileSync(AuditFileForTime(event.time), JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
        console.error('AUDIT WRITE ERROR:', error.message);
    }
}

function LoadRecentAudit() {
    try {
        events.length = 0;
        const files = fs.readdirSync(AUDIT_DIR)
            .filter(x => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x))
            .sort();
        const loaded = [];
        const chainAnchor = String(state.production.auditChain.anchor || '').toUpperCase();
        let expectedPrevious = chainAnchor;
        let verifiedCount = 0;
        let lastError = '';
        for (const file of files) {
            const lines = fs.readFileSync(path.join(AUDIT_DIR, file), 'utf8').split(/\r?\n/);
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const item = JSON.parse(line);
                    const normalized = {
                        time: Number(item.time) || 0, type: SafeField(item.type), detail: SafeField(item.detail),
                        sequence: Number(item.sequence) || 0,
                        previousHash: String(item.previousHash || '').toUpperCase(),
                        hash: String(item.hash || '').toUpperCase()
                    };
                    // Legacy audit rows remain readable, but a signed chain
                    // starts only at the first row carrying chain metadata.
                    if (normalized.sequence && normalized.hash) {
                        const computed = EventHash(normalized.previousHash, normalized.sequence, normalized.time, normalized.type, normalized.detail);
                        if (normalized.previousHash !== expectedPrevious || computed !== normalized.hash) {
                            if (!lastError) lastError = `${file}:${normalized.sequence}`;
                        } else {
                            expectedPrevious = normalized.hash;
                            verifiedCount = normalized.sequence;
                        }
                    }
                    loaded.push(normalized);
                } catch (_) {}
            }
        }
        loaded.sort((a, b) => a.time - b.time);
        for (const item of loaded.slice(-MAX_EVENT_MEMORY)) events.push(item);
        state.production.auditChain.head = expectedPrevious;
        state.production.auditChain.anchor = chainAnchor;
        state.production.auditChain.count = verifiedCount;
        state.production.auditChain.verifiedAt = Now();
        state.production.auditChain.lastError = lastError;
    } catch (_) {}
}

function VerifyAuditChain() {
    const previousEvents = events.slice();
    events.length = 0;
    LoadRecentAudit();
    const result = {
        ok: !state.production.auditChain.lastError,
        checkedAt: state.production.auditChain.verifiedAt,
        count: state.production.auditChain.count,
        head: state.production.auditChain.head,
        error: state.production.auditChain.lastError
    };
    // LoadRecentAudit already restored the most recent authoritative view.
    if (!events.length && previousEvents.length) events.push(...previousEvents.slice(-MAX_EVENT_MEMORY));
    return result;
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

function ClearAudit() {
    const removedMemory = events.length;
    events.length = 0;
    let removedFiles = 0;
    try {
        for (const file of fs.readdirSync(AUDIT_DIR)) {
            if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
            try { fs.unlinkSync(path.join(AUDIT_DIR, file)); removedFiles++; } catch (_) {}
        }
    } catch (_) {}
    state.production.auditChain = { anchor: '', head: '', count: 0, verifiedAt: Now(), lastError: '' };
    return { removedMemory, removedFiles };
}

module.exports = {
    AuditFileForTime,
    LogEvent,
    LoadRecentAudit,
    AuditSearch,
    ClearAudit,
    VerifyAuditChain
};
