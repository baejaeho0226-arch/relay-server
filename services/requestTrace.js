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

function StartTrace(clientId, requestId, serverId, number, createdAt) {
    const now = Number(createdAt) || Now();
    const key = TraceKey(clientId, requestId);
    const trace = {
        key,
        requestId: String(requestId || '').trim(),
        clientId: NormalizeID(clientId),
        serverId: NormalizeID(serverId),
        number: String(number || '').slice(0, 128),
        createdAt: now,
        forwardedAt: now,
        ackAt: 0,
        completedAt: 0,
        durationMs: 0,
        status: 'PENDING',
        reason: '',
        retries: 0
    };
    state.requestTraces.set(key, trace);
    TrimTraces();
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
            const text = `${trace.requestId}|${trace.clientId}|${trace.serverId}|${trace.status}|${trace.number}`.toUpperCase();
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
    RetryTrace,
    CompleteTrace,
    SearchTraces
};
