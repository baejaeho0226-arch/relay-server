'use strict';

const state = require('../core/state');
const { NormalizeID, Now, SafeField, SendLine } = require('../core/utils');

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const MAX_BLOCKED = 100;
const TYPE_ROUTES = Object.freeze({
    TYPE1: 'TYPE1/DEFAULT',
    TYPE2: 'TYPE2/DEFAULT',
    TYPE3: 'TYPE3/DEFAULT'
});

function NormalizeInt64(value, optional = true) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!text && optional) return '';
    if (!/^-?\d+$/.test(text)) throw new Error('INVALID_INT64');
    const parsed = BigInt(text);
    if (parsed < INT64_MIN || parsed > INT64_MAX) throw new Error('INT64_OUT_OF_RANGE');
    return parsed.toString();
}

function NormalizePolicy(input = {}, previous = state.numberProcessingPolicy) {
    const processor = SafeField(input.processor || previous.processor || 'DEFAULT').toUpperCase();
    if (processor !== 'DEFAULT') throw new Error('PROCESSOR_NOT_AVAILABLE');
    const minValue = NormalizeInt64(input.minValue, true);
    const maxValue = NormalizeInt64(input.maxValue, true);
    if (minValue && maxValue && BigInt(minValue) > BigInt(maxValue)) throw new Error('MIN_GREATER_THAN_MAX');
    const source = Array.isArray(input.blockedValues)
        ? input.blockedValues
        : String(input.blockedValues || '').split(/[\s,]+/);
    const blockedValues = [...new Set(source.map(x => String(x).trim()).filter(Boolean).map(x => NormalizeInt64(x, false)))].slice(0, MAX_BLOCKED);
    return {
        revision: Math.max(1, Number(previous.revision) || 1),
        enabled: input.enabled !== false,
        processor,
        minValue,
        maxValue,
        blockedValues,
        updatedAt: Number(previous.updatedAt) || 0
    };
}

function ImportPersisted(data) {
    try {
        state.numberProcessingPolicy = NormalizePolicy(data && data.numberProcessingPolicy || {}, data && data.numberProcessingPolicy || state.numberProcessingPolicy);
    } catch (_) {
        state.numberProcessingPolicy = NormalizePolicy({}, state.numberProcessingPolicy);
    }
    state.processorStats.clear();
    const source = data && data.processorStats;
    if (source && typeof source === 'object') {
        for (const [rawName, raw] of Object.entries(source)) {
            const name = SafeField(rawName).toUpperCase();
            if (!name || !raw || typeof raw !== 'object') continue;
            state.processorStats.set(name, {
                processor: name,
                requests: Math.max(0, Number(raw.requests) || 0),
                success: Math.max(0, Number(raw.success) || 0),
                error: Math.max(0, Number(raw.error) || 0),
                totalProcessingMs: Math.max(0, Number(raw.totalProcessingMs) || 0),
                maxMs: Math.max(0, Number(raw.maxMs) || 0),
                lastAt: Math.max(0, Number(raw.lastAt) || 0),
                lastError: SafeField(raw.lastError || '')
            });
        }
    }
}

function BuildConfigLine(policy = state.numberProcessingPolicy) {
    return ['PROCESSOR_CONFIG', policy.revision, policy.enabled ? '1' : '0', policy.processor,
        policy.minValue || '~', policy.maxValue || '~', policy.blockedValues.join(',') || '~'].join('|');
}

function PushToServer(serverId) {
    const id = NormalizeID(serverId);
    const connection = state.servers.get(id);
    if (!connection || !connection.socket || connection.socket.destroyed) return { ok: false, reason: 'SERVER_OFFLINE' };
    const capabilities = state.deviceCapabilities.get(`SERVER:${id}`);
    if (!capabilities || !capabilities.has('PROCESSOR_POLICY')) return { ok: false, reason: 'PROCESSOR_POLICY_UNSUPPORTED' };
    if (!SendLine(connection.socket, BuildConfigLine())) return { ok: false, reason: 'SEND_FAILED' };
    connection.processorConfigSentAt = Now();
    return { ok: true, serverId: id, revision: state.numberProcessingPolicy.revision };
}

function PushAll() {
    return Array.from(state.servers.keys()).map(PushToServer);
}

function SetPolicy(input = {}) {
    const previous = state.numberProcessingPolicy;
    const next = NormalizePolicy(input, previous);
    next.revision = Math.max(1, Number(previous.revision) || 1) + 1;
    next.updatedAt = Now();
    state.numberProcessingPolicy = next;
    require('../storage/database').SaveDatabase();
    const pushes = PushAll();
    require('../storage/audit').LogEvent('PROCESSOR_POLICY_UPDATE', `revision=${next.revision} processor=${next.processor} enabled=${next.enabled}`);
    return { policy: { ...next, blockedValues: [...next.blockedValues] }, pushes };
}

function HandleAck(serverId, parts) {
    const connection = state.servers.get(NormalizeID(serverId));
    if (!connection) return;
    connection.processorConfigAck = {
        revision: Math.max(0, Number(parts[1]) || 0),
        status: SafeField(parts[2] || 'ERROR').toUpperCase(),
        detail: SafeField(parts.slice(3).join(' ')),
        at: Now()
    };
}

function Record(processor, result, processingMs, reason = '') {
    const name = SafeField(processor || state.numberProcessingPolicy.processor || 'DEFAULT').toUpperCase() || 'DEFAULT';
    const item = state.processorStats.get(name) || { processor: name, requests: 0, success: 0, error: 0, totalProcessingMs: 0, maxMs: 0, lastAt: 0, lastError: '' };
    const ms = Math.max(0, Math.min(86400000, Number(processingMs) || 0));
    item.requests++;
    if (String(result).toUpperCase() === 'OK') item.success++; else item.error++;
    item.totalProcessingMs += ms;
    item.maxMs = Math.max(item.maxMs, ms);
    item.lastAt = Now();
    if (reason) item.lastError = SafeField(reason);
    state.processorStats.set(name, item);
}

function Stats() {
    const names = new Set([...Object.values(TYPE_ROUTES), ...state.processorStats.keys()]);
    return Array.from(names).filter(Boolean).sort().map(name => {
        const x = state.processorStats.get(name) || { processor: name, requests: 0, success: 0, error: 0, totalProcessingMs: 0, maxMs: 0, lastAt: 0, lastError: '' };
        return { ...x, avgMs: x.requests ? Number((x.totalProcessingMs / x.requests).toFixed(2)) : 0, successRate: x.requests ? Number((x.success / x.requests * 100).toFixed(2)) : 100 };
    });
}

function ServerStatus() {
    return Array.from(state.serverIdentities.values()).sort().map(serverId => {
        const live = state.servers.get(serverId);
        return { serverId, online: Boolean(live), ack: live && live.processorConfigAck || null, sentAt: live && live.processorConfigSentAt || 0 };
    });
}

function ResetStats() {
    state.processorStats.clear();
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('PROCESSOR_STATS_RESET', 'all');
}

function Overview() {
    return {
        policy: { ...state.numberProcessingPolicy, blockedValues: [...state.numberProcessingPolicy.blockedValues] },
        routes: Object.entries(TYPE_ROUTES).map(([accessType, processor]) => ({ accessType, processor })),
        stats: Stats(),
        servers: ServerStatus()
    };
}

module.exports = { TYPE_ROUTES, NormalizeInt64, NormalizePolicy, ImportPersisted, BuildConfigLine, PushToServer, PushAll, SetPolicy, HandleAck, Record, Stats, ServerStatus, ResetStats, Overview };
