'use strict';

const config = require('../config/config');
const state = require('../core/state');
const { Now, NormalizeID, SafeField } = require('../core/utils');

function TraceKey(clientId, requestId) {
    return `${NormalizeID(clientId)}|${String(requestId || '').trim()}`;
}

function TrimTraces() {
    const cutoff = Now() - config.REQUEST_HISTORY_TIMEOUT_MS;
    for (const [key, trace] of state.requestTraces) {
        if (!trace || Number(trace.createdAt || 0) < cutoff) state.requestTraces.delete(key);
    }
    while (state.requestTraces.size > config.MAX_REQUEST_TRACES) {
        const first = state.requestTraces.keys().next();
        if (first.done) break;
        state.requestTraces.delete(first.value);
    }
}

function StartTrace(clientId, requestId, serverId, number, createdAt, meta = {}) {
    const now = Number(createdAt) || Now();
    const key = TraceKey(clientId, requestId);
    const trace = {
        key,
        requestId: String(requestId || '').trim(),
        clientId: NormalizeID(clientId),
        serverId: NormalizeID(serverId),
        number: String(number || '').slice(0, 128),
        createdAt: now,
        forwardedAt: meta.queued ? 0 : now,
        queuedAt: meta.queued ? now : 0,
        ackAt: 0,
        completedAt: 0,
        durationMs: 0,
        status: meta.queued ? 'QUEUED' : 'PENDING',
        reason: '',
        retries: 0,
        source: SafeField(meta.source || 'CLIENT'),
        replayOf: SafeField(meta.replayOf || ''),
        notifyClient: meta.notifyClient !== false,
        deadLetterId: ''
    };
    state.requestTraces.set(key, trace);
    TrimTraces();
    return trace;
}

function MarkQueued(clientId, requestId, reason, at) {
    const trace = state.requestTraces.get(TraceKey(clientId, requestId));
    if (!trace) return null;
    trace.status = 'QUEUED';
    trace.reason = SafeField(reason || 'SERVER_OFFLINE');
    trace.queuedAt = Number(at) || Now();
    trace.completedAt = 0;
    trace.ackAt = 0;
    return trace;
}

function MarkForwarded(clientId, requestId, serverId, at) {
    const trace = state.requestTraces.get(TraceKey(clientId, requestId));
    if (!trace) return null;
    const now = Number(at) || Now();
    trace.serverId = NormalizeID(serverId);
    trace.forwardedAt = now;
    trace.status = 'PENDING';
    trace.reason = '';
    return trace;
}

function LinkDeadLetter(clientId, requestId, deadLetterId) {
    const trace = state.requestTraces.get(TraceKey(clientId, requestId));
    if (!trace) return null;
    trace.deadLetterId = SafeField(deadLetterId || '');
    return trace;
}

function RetryTrace(clientId, requestId, retries, at) {
    const trace = state.requestTraces.get(TraceKey(clientId, requestId));
    if (!trace) return null;
    trace.retries = Number(retries) || 0;
    trace.lastRetryAt = Number(at) || Now();
    return trace;
}

function CompleteTrace(clientId, requestId, status, reason, at) {
    const trace = state.requestTraces.get(TraceKey(clientId, requestId));
    if (!trace) return null;
    const now = Number(at) || Now();
    trace.status = String(status || 'UNKNOWN').toUpperCase();
    trace.reason = SafeField(reason || '');
    trace.ackAt = now;
    trace.completedAt = now;
    trace.durationMs = Math.max(0, now - Number(trace.forwardedAt || trace.createdAt || now));
    return trace;
}

function SearchTraces(query) {
    TrimTraces();
    query = String(query || '').trim().toUpperCase();
    const out = [];
    for (const trace of state.requestTraces.values()) {
        if (query) {
            const text = `${trace.requestId}|${trace.clientId}|${trace.serverId}|${trace.status}|${trace.number}|${trace.source}|${trace.replayOf}|${trace.deadLetterId}`.toUpperCase();
            if (!text.includes(query)) continue;
        }
        out.push({ ...trace });
    }
    return out.sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 200);
}

module.exports = {
    TraceKey,
    TrimTraces,
    StartTrace,
    MarkQueued,
    MarkForwarded,
    LinkDeadLetter,
    RetryTrace,
    CompleteTrace,
    SearchTraces
};
