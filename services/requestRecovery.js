'use strict';

const crypto = require('crypto');
const config = require('../config/config');
const state = require('../core/state');
const { Now, NormalizeID, SafeField, SendLine } = require('../core/utils');

function SaveDatabase() { return require('../storage/database').SaveDatabase(); }
function LogEvent(type, detail) { return require('../storage/audit').LogEvent(type, detail); }
function GetOnlineServer(id) { return require('../identity/identityManager').GetOnlineServer(id); }
function GetOnlineClient(id) { return require('../identity/identityManager').GetOnlineClient(id); }
function GetSavedClientByID(id) { return require('../identity/identityManager').GetSavedClientByID(id); }
function MakeRequestKey(clientId, requestId) { return require('../relay/ackManager').MakeRequestKey(clientId, requestId); }

function DefaultPolicy() {
    return {
        enabled: false,
        maxItemsPerClient: 100,
        ttlSeconds: 3600,
        maxDeliveryAttempts: 5,
        updatedAt: 0
    };
}

function NormalizePolicy(raw) {
    const base = DefaultPolicy();
    raw = raw && typeof raw === 'object' ? raw : {};
    const maxItems = Number(raw.maxItemsPerClient);
    const ttl = Number(raw.ttlSeconds);
    const attempts = Number(raw.maxDeliveryAttempts);
    return {
        enabled: Boolean(raw.enabled),
        maxItemsPerClient: Math.max(1, Math.min(1000, Number.isFinite(maxItems) ? maxItems : base.maxItemsPerClient)),
        ttlSeconds: Math.max(30, Math.min(7 * 86400, Number.isFinite(ttl) ? ttl : base.ttlSeconds)),
        maxDeliveryAttempts: Math.max(1, Math.min(50, Number.isFinite(attempts) ? attempts : base.maxDeliveryAttempts)),
        updatedAt: Math.max(0, Number(raw.updatedAt) || 0)
    };
}

function EnsureState() {
    state.offlineQueuePolicy = NormalizePolicy(state.offlineQueuePolicy);
    if (!(state.clientOfflineQueueEnabled instanceof Set)) state.clientOfflineQueueEnabled = new Set();
    if (!(state.offlineQueue instanceof Map)) state.offlineQueue = new Map();
    if (!(state.deadLetters instanceof Map)) state.deadLetters = new Map();
    if (!(state.clientServerBindings instanceof Map)) state.clientServerBindings = new Map();
}

function NewId(prefix) {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function NewRequestId(prefix = 'REPLAY') {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 64);
}

function NumberFrom(input) {
    if (input.number !== undefined && /^-?\d+$/.test(String(input.number))) return String(input.number);
    const parts = String(input.payload || '').split('|');
    const candidate = parts.length ? parts[parts.length - 1] : '';
    return /^-?\d+$/.test(candidate) ? candidate : '';
}

function BuildSessionReady(clientId, serverId) {
    const session = require('./buildGate').ActiveSessionForClient(clientId);
    if (!session) return { ok: false, reason: 'BUILD_REQUIRED' };
    if (NormalizeID(session.serverId) !== NormalizeID(serverId)) return { ok: false, reason: 'SERVER_BINDING_MISMATCH' };
    return { ok: true, session };
}

function QueueCount(clientId) {
    clientId = NormalizeID(clientId);
    let count = 0;
    for (const item of state.offlineQueue.values()) if (item.clientId === clientId) count++;
    return count;
}

function CanQueue(clientId) {
    EnsureState();
    clientId = NormalizeID(clientId);
    return Boolean(state.offlineQueuePolicy.enabled && clientId && state.clientOfflineQueueEnabled.has(clientId));
}

function SetPolicy(raw) {
    EnsureState();
    state.offlineQueuePolicy = NormalizePolicy({ ...state.offlineQueuePolicy, ...raw, updatedAt: Now() });
    SaveDatabase();
    LogEvent('OFFLINE_QUEUE_POLICY', JSON.stringify(state.offlineQueuePolicy));
    return { ...state.offlineQueuePolicy };
}

function SetClientEnabled(clientId, enabled) {
    EnsureState();
    clientId = NormalizeID(clientId);
    if (!GetSavedClientByID(clientId)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (enabled) state.clientOfflineQueueEnabled.add(clientId);
    else state.clientOfflineQueueEnabled.delete(clientId);
    SaveDatabase();
    LogEvent(enabled ? 'OFFLINE_QUEUE_CLIENT_ENABLED' : 'OFFLINE_QUEUE_CLIENT_DISABLED', clientId);
    return { ok: true, clientId, enabled: Boolean(enabled) };
}

function FindQueued(clientId, requestId) {
    for (const item of state.offlineQueue.values()) {
        if (item.clientId === clientId && item.requestId === requestId) return item;
    }
    return null;
}

function IsQueued(clientId, requestId) {
    return Boolean(FindQueued(NormalizeID(clientId), String(requestId || '').trim()));
}

function EnqueueRequest(input, reason = 'SERVER_OFFLINE') {
    EnsureState();
    const clientId = NormalizeID(input.clientId);
    const requestId = String(input.requestId || '').trim().slice(0, 64);
    const number = NumberFrom(input);
    if (!clientId || !GetSavedClientByID(clientId)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!requestId || !number) return { ok: false, reason: 'INVALID_REQUEST' };
    if (!CanQueue(clientId)) return { ok: false, reason: 'OFFLINE_QUEUE_DISABLED' };
    const existing = FindQueued(clientId, requestId);
    if (existing) return { ok: true, queued: true, duplicate: true, item: { ...existing }, position: QueuePosition(existing.queueId) };
    if (state.offlineQueue.size >= config.MAX_OFFLINE_QUEUE_ITEMS) return { ok: false, reason: 'OFFLINE_QUEUE_GLOBAL_FULL' };
    if (QueueCount(clientId) >= state.offlineQueuePolicy.maxItemsPerClient) return { ok: false, reason: 'OFFLINE_QUEUE_CLIENT_FULL' };

    const now = Now();
    const queueId = NewId('QUEUE');
    const item = {
        queueId,
        clientId,
        requestId,
        number,
        payload: `NUMBER|${requestId}|${clientId}|${require('./accessType').NormalizeAccessType(input.accessType)}|${number}`,
        serverId: NormalizeID(input.serverId || ''),
        createdAt: Number(input.originCreatedAt || input.createdAt) || now,
        queuedAt: now,
        expiresAt: now + state.offlineQueuePolicy.ttlSeconds * 1000,
        attempts: Math.max(0, Number(input.attempts) || 0),
        lastAttemptAt: 0,
        reason: SafeField(reason || 'SERVER_OFFLINE'),
        source: SafeField(input.source || 'CLIENT'),
        replayOf: SafeField(input.replayOf || ''),
        notifyClient: input.notifyClient !== false
    };
    state.offlineQueue.set(queueId, item);
    state.requestHistory.set(MakeRequestKey(clientId, requestId), now);
    const trace = require('./requestTrace');
    if (!state.requestTraces.has(trace.TraceKey(clientId, requestId))) {
        trace.StartTrace(clientId, requestId, item.serverId, number, now, {
            queued: true, source: item.source, replayOf: item.replayOf, notifyClient: item.notifyClient
        });
    } else {
        trace.MarkQueued(clientId, requestId, item.reason, now);
    }
    state.runtimeStats.queuedRequests++;
    SaveDatabase();
    LogEvent('REQUEST_QUEUED', `${requestId} / ${clientId} / ${item.reason}`);
    return { ok: true, queued: true, item: { ...item }, position: QueuePosition(queueId) };
}

function QueuePosition(queueId) {
    const items = Array.from(state.offlineQueue.values()).sort((a, b) => a.createdAt - b.createdAt || a.queueId.localeCompare(b.queueId));
    const target = state.offlineQueue.get(queueId);
    if (!target) return 0;
    return items.filter(x => x.clientId === target.clientId).findIndex(x => x.queueId === queueId) + 1;
}

function AddDeadLetter(input, reason, options = {}) {
    EnsureState();
    const clientId = NormalizeID(input.clientId);
    const requestId = String(input.requestId || '').trim().slice(0, 64);
    const number = NumberFrom(input);
    if (!clientId || !requestId || !number) return null;
    const now = Now();
    const deadLetterId = NewId('DLQ');
    const item = {
        deadLetterId,
        clientId,
        serverId: NormalizeID(input.serverId || ''),
        originalRequestId: requestId,
        number,
        reason: SafeField(reason || 'UNKNOWN_FAILURE'),
        source: SafeField(input.source || 'CLIENT'),
        replayOf: SafeField(input.replayOf || ''),
        createdAt: Number(input.originCreatedAt || input.createdAt) || now,
        failedAt: now,
        attempts: Math.max(0, Number(input.attempts ?? input.retries) || 0),
        retryCount: Math.max(0, Number(input.retryCount) || 0),
        status: 'ACTIVE',
        lastReplayRequestId: '',
        resolvedAt: 0,
        notifyClient: input.notifyClient !== false,
        detail: SafeField(options.detail || '')
    };
    state.deadLetters.set(deadLetterId, item);
    while (state.deadLetters.size > config.MAX_DEAD_LETTERS) {
        const first = state.deadLetters.keys().next();
        if (first.done) break;
        state.deadLetters.delete(first.value);
    }
    require('./requestTrace').LinkDeadLetter(clientId, requestId, deadLetterId);
    state.runtimeStats.deadLetteredRequests++;
    SaveDatabase();
    LogEvent('REQUEST_DLQ', `${deadLetterId} / ${requestId} / ${clientId} / ${item.reason}`);
    return { ...item };
}

function RequeuePending(pending, reason) {
    if (!pending || !CanQueue(pending.clientId)) return { ok: false, reason: 'OFFLINE_QUEUE_DISABLED' };
    const result = EnqueueRequest({ ...pending, originCreatedAt: pending.originCreatedAt || pending.createdAt }, reason);
    if (result.ok && pending.notifyClient !== false) {
        const client = GetOnlineClient(pending.clientId);
        if (client) SendLine(client.socket, `QUEUED|OK|${pending.requestId}|${result.position}`);
    }
    return result;
}

function ServerReady(serverId) {
    const server = GetOnlineServer(serverId);
    if (!server) return { ok: false, reason: 'SERVER_OFFLINE' };
    try {
        const auth = require('./deviceAuth');
        if (auth.Enforced('SERVER', serverId) && !auth.Verified('SERVER', serverId)) return { ok: false, reason: 'SERVER_AUTH_REQUIRED' };
    } catch (_) {}
    return { ok: true, server };
}

function LicenseReady(clientId) {
    const manager = require('../license/licenseManager');
    const entry = manager.GetBoundLicenseEntry(clientId);
    return Boolean(entry && manager.GetLicenseStatus(entry.license) === 'BOUND');
}

function DispatchRequest(input, options = {}) {
    EnsureState();
    const clientId = NormalizeID(input.clientId);
    const requestId = String(input.requestId || NewRequestId(options.prefix || 'REPLAY')).trim().slice(0, 64);
    const number = NumberFrom(input);
    const saved = GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!requestId || !number) return { ok: false, reason: 'INVALID_REQUEST' };
    const requestKey = MakeRequestKey(clientId, requestId);
    if (state.requestHistory.has(requestKey) || state.pendingRequests.has(requestKey) || FindQueued(clientId, requestId)) {
        return { ok: false, reason: 'DUPLICATE_REQUEST' };
    }
    if (!LicenseReady(clientId)) return { ok: false, reason: 'LICENSE_REQUIRED' };
    const serverId = NormalizeID(saved.serverId);
    const ready = ServerReady(serverId);
    const build = ready.ok ? BuildSessionReady(clientId, serverId) : { ok: false, reason: ready.reason };
    const common = {
        clientId, requestId, serverId, number,
        accessType: build.ok ? build.session.accessType : require('./accessType').NormalizeAccessType(input.accessType),
        payload: build.ok ? `NUMBER|${requestId}|${clientId}|${build.session.accessType}|${number}` : '',
        source: SafeField(input.source || options.source || 'ADMIN_REPLAY'),
        replayOf: SafeField(input.replayOf || ''),
        notifyClient: input.notifyClient === true,
        originCreatedAt: Number(input.originCreatedAt) || Now()
    };
    if (!ready.ok) {
        if (options.allowQueue && CanQueue(clientId)) return EnqueueRequest(common, ready.reason);
        return { ok: false, reason: ready.reason };
    }
    if (!build.ok) {
        if (options.allowQueue && CanQueue(clientId)) return EnqueueRequest(common, build.reason);
        return { ok: false, reason: build.reason };
    }
    if (!SendLine(ready.server.socket, common.payload)) {
        if (options.allowQueue && CanQueue(clientId)) return EnqueueRequest(common, 'SERVER_SEND_FAILED');
        return { ok: false, reason: 'SERVER_SEND_FAILED' };
    }
    const now = Now();
    state.requestHistory.set(requestKey, now);
    require('./requestTrace').StartTrace(clientId, requestId, serverId, number, now, common);
    state.pendingRequests.set(requestKey, {
        ...common, createdAt: now, lastSendAt: now, retries: 0
    });
    LogEvent('REQUEST_REPLAY_DISPATCHED', `${requestId} / ${clientId} / ${common.replayOf || '-'}`);
    return { ok: true, queued: false, requestId, clientId, serverId };
}

function ReplayTrace(traceKey, actor = 'admin') {
    const trace = state.requestTraces.get(String(traceKey || ''));
    if (!trace) return { ok: false, reason: 'TRACE_NOT_FOUND' };
    if (!['ERROR', 'TIMEOUT', 'DLQ'].includes(String(trace.status || '').toUpperCase())) return { ok: false, reason: 'TRACE_NOT_REPLAYABLE' };
    const result = DispatchRequest({
        clientId: trace.clientId,
        number: trace.number,
        source: 'ADMIN_REPLAY',
        replayOf: trace.requestId,
        notifyClient: false,
        originCreatedAt: trace.createdAt
    }, { allowQueue: true, source: 'ADMIN_REPLAY', prefix: 'REPLAY' });
    if (result.ok) {
        state.runtimeStats.replayedRequests++;
        LogEvent('REQUEST_REPLAY', `${actor} ${trace.requestId} -> ${result.requestId || result.item?.requestId}`);
    }
    return result;
}

function RetryDeadLetter(deadLetterId, actor = 'admin') {
    EnsureState();
    const item = state.deadLetters.get(String(deadLetterId || ''));
    if (!item) return { ok: false, reason: 'DLQ_NOT_FOUND' };
    if (item.status !== 'ACTIVE') return { ok: false, reason: 'DLQ_NOT_ACTIVE' };
    const result = DispatchRequest({
        clientId: item.clientId,
        number: item.number,
        source: 'DLQ_RETRY',
        replayOf: item.originalRequestId,
        notifyClient: false,
        originCreatedAt: item.createdAt
    }, { allowQueue: true, source: 'DLQ_RETRY', prefix: 'DLQRETRY' });
    if (!result.ok) return result;
    item.status = 'REPLAYED';
    item.retryCount++;
    item.lastReplayRequestId = result.requestId || result.item?.requestId || '';
    item.resolvedAt = Now();
    state.runtimeStats.replayedRequests++;
    SaveDatabase();
    LogEvent('DLQ_RETRY', `${actor} ${deadLetterId} -> ${item.lastReplayRequestId}`);
    return { ok: true, deadLetter: { ...item }, result };
}

function DiscardDeadLetter(deadLetterId, actor = 'admin') {
    EnsureState();
    const item = state.deadLetters.get(String(deadLetterId || ''));
    if (!item) return { ok: false, reason: 'DLQ_NOT_FOUND' };
    if (item.status !== 'ACTIVE') return { ok: false, reason: 'DLQ_NOT_ACTIVE' };
    item.status = 'DISCARDED';
    item.resolvedAt = Now();
    SaveDatabase();
    LogEvent('DLQ_DISCARD', `${actor} ${deadLetterId}`);
    return { ok: true, deadLetter: { ...item } };
}

function FailQueueItem(queueId, reason) {
    const item = state.offlineQueue.get(queueId);
    if (!item) return null;
    state.offlineQueue.delete(queueId);
    require('./requestTrace').CompleteTrace(item.clientId, item.requestId, 'ERROR', reason, Now());
    const deadLetter = AddDeadLetter(item, reason);
    if (item.notifyClient) {
        const client = GetOnlineClient(item.clientId);
        if (client) SendLine(client.socket, `ACK|ERROR|${item.requestId}|${reason}`);
    }
    return deadLetter;
}

function ProcessOfflineQueue() {
    EnsureState();
    if (!state.offlineQueuePolicy.enabled || !state.serviceEnabled || state.maintenanceMode) return { delivered: 0, failed: 0, paused: true };
    const now = Now();
    const items = Array.from(state.offlineQueue.values()).sort((a, b) => a.createdAt - b.createdAt || a.queueId.localeCompare(b.queueId));
    const firstByClient = new Map();
    for (const item of items) if (!firstByClient.has(item.clientId)) firstByClient.set(item.clientId, item);
    let delivered = 0;
    let failed = 0;
    let changed = false;
    for (const item of firstByClient.values()) {
        if (delivered + failed >= config.OFFLINE_QUEUE_PROCESS_LIMIT) break;
        if (now >= item.expiresAt) { FailQueueItem(item.queueId, 'QUEUE_EXPIRED'); failed++; changed = true; continue; }
        if (state.disabledClients.has(item.clientId)) { FailQueueItem(item.queueId, 'CLIENT_DISABLED'); failed++; changed = true; continue; }
        if (!LicenseReady(item.clientId)) { FailQueueItem(item.queueId, 'LICENSE_REQUIRED'); failed++; changed = true; continue; }
        const saved = GetSavedClientByID(item.clientId);
        if (!saved) { FailQueueItem(item.queueId, 'CLIENT_NOT_FOUND'); failed++; changed = true; continue; }
        const ready = ServerReady(saved.serverId);
        if (!ready.ok) continue;
        const build = BuildSessionReady(item.clientId, saved.serverId);
        if (!build.ok) continue;
        if (now - Number(item.lastAttemptAt || 0) < 1000) continue;
        item.lastAttemptAt = now;
        item.attempts++;
        item.serverId = NormalizeID(saved.serverId);
        item.accessType = build.session.accessType;
        item.payload = `NUMBER|${item.requestId}|${item.clientId}|${item.accessType}|${item.number}`;
        if (!SendLine(ready.server.socket, item.payload)) {
            changed = true;
            if (item.attempts >= state.offlineQueuePolicy.maxDeliveryAttempts) {
                FailQueueItem(item.queueId, 'QUEUE_DELIVERY_FAILED');
                failed++;
            }
            continue;
        }
        state.offlineQueue.delete(item.queueId);
        const requestKey = MakeRequestKey(item.clientId, item.requestId);
        state.pendingRequests.set(requestKey, {
            clientId: item.clientId, serverId: item.serverId, requestId: item.requestId,
            number: item.number, payload: item.payload, createdAt: now, lastSendAt: now, retries: 0,
            originCreatedAt: item.createdAt, source: item.source, replayOf: item.replayOf,
            notifyClient: item.notifyClient
        });
        require('./requestTrace').MarkForwarded(item.clientId, item.requestId, item.serverId, now);
        if (item.notifyClient) {
            const client = GetOnlineClient(item.clientId);
            if (client) SendLine(client.socket, `DEQUEUED|${item.requestId}|${item.serverId}`);
        }
        state.runtimeStats.dequeuedRequests++;
        LogEvent('REQUEST_DEQUEUED', `${item.requestId} / ${item.clientId} / ${item.serverId}`);
        delivered++;
        changed = true;
    }
    if (changed) SaveDatabase();
    return { delivered, failed, paused: false };
}

function ListDeadLetters(query = '') {
    EnsureState();
    query = String(query || '').trim().toUpperCase();
    return Array.from(state.deadLetters.values())
        .filter(item => !query || `${item.deadLetterId}|${item.clientId}|${item.serverId}|${item.originalRequestId}|${item.reason}|${item.status}|${item.number}`.toUpperCase().includes(query))
        .sort((a, b) => b.failedAt - a.failedAt)
        .slice(0, 1000)
        .map(item => ({ ...item }));
}

function BuildStatus(query = '') {
    EnsureState();
    const queue = Array.from(state.offlineQueue.values()).sort((a, b) => a.createdAt - b.createdAt).map(item => ({ ...item }));
    const deadLetters = ListDeadLetters(query);
    const clients = [];
    for (const saved of state.clientIdentities.values()) {
        const dlqActive = Array.from(state.deadLetters.values()).filter(x => x.clientId === saved.id && x.status === 'ACTIVE').length;
        clients.push({
            clientId: saved.id,
            enabled: state.clientOfflineQueueEnabled.has(saved.id),
            queued: queue.filter(x => x.clientId === saved.id).length,
            deadLetters: dlqActive,
            serverId: saved.serverId
        });
    }
    return {
        policy: { ...state.offlineQueuePolicy },
        summary: {
            queued: queue.length,
            enabledClients: clients.filter(x => x.enabled).length,
            activeDeadLetters: Array.from(state.deadLetters.values()).filter(x => x.status === 'ACTIVE').length,
            replayedDeadLetters: Array.from(state.deadLetters.values()).filter(x => x.status === 'REPLAYED').length,
            discardedDeadLetters: Array.from(state.deadLetters.values()).filter(x => x.status === 'DISCARDED').length
        },
        clients,
        queue,
        deadLetters
    };
}

function RebuildQueueRuntime() {
    EnsureState();
    const traces = require('./requestTrace');
    for (const item of state.offlineQueue.values()) {
        state.requestHistory.set(MakeRequestKey(item.clientId, item.requestId), Number(item.createdAt) || Now());
        if (!state.requestTraces.has(traces.TraceKey(item.clientId, item.requestId))) {
            traces.StartTrace(item.clientId, item.requestId, item.serverId, item.number, Number(item.createdAt) || Now(), {
                queued: true, source: item.source, replayOf: item.replayOf, notifyClient: item.notifyClient
            });
        }
        traces.MarkQueued(item.clientId, item.requestId, item.reason, Number(item.queuedAt) || Now());
    }
}

function ImportPersisted(data) {
    EnsureState();
    const serverExists = id => Array.from(state.serverIdentities.values()).includes(id);
    if (data.clientServerBindings && typeof data.clientServerBindings === 'object') {
        for (const [rawClientId, value] of Object.entries(data.clientServerBindings)) {
            const clientId = NormalizeID(rawClientId);
            if (!clientId || !GetSavedClientByID(clientId) || !value || typeof value !== 'object') continue;
            const primaryServerId = NormalizeID(value.primaryServerId);
            const backupServerId = NormalizeID(value.backupServerId || '');
            if (!primaryServerId || !serverExists(primaryServerId) || (backupServerId && (!serverExists(backupServerId) || backupServerId === primaryServerId))) continue;
            state.clientServerBindings.set(clientId, {
                clientId, primaryServerId, backupServerId,
                allowAutomaticFallback: Boolean(value.allowAutomaticFallback),
                updatedAt: Math.max(0, Number(value.updatedAt) || 0)
            });
        }
    }
    state.offlineQueuePolicy = NormalizePolicy(data.offlineQueuePolicy);
    for (const rawId of Array.isArray(data.clientOfflineQueueEnabled) ? data.clientOfflineQueueEnabled : []) {
        const id = NormalizeID(rawId);
        if (id && GetSavedClientByID(id)) state.clientOfflineQueueEnabled.add(id);
    }
    if (data.offlineQueue && typeof data.offlineQueue === 'object') {
        for (const [queueId, value] of Object.entries(data.offlineQueue)) {
            if (!value || typeof value !== 'object') continue;
            const clientId = NormalizeID(value.clientId);
            const requestId = String(value.requestId || '').trim().slice(0, 64);
            const number = NumberFrom(value);
            const accessType = require('./accessType').NormalizeAccessType(value.accessType);
            if (!/^QUEUE-[A-Z0-9-]+$/.test(queueId) || !clientId || !GetSavedClientByID(clientId) || !requestId || !number) continue;
            state.offlineQueue.set(queueId, {
                queueId, clientId, requestId, number, accessType,
                payload: `NUMBER|${requestId}|${clientId}|${accessType}|${number}`,
                serverId: NormalizeID(value.serverId || ''),
                createdAt: Number(value.createdAt) || Now(), queuedAt: Number(value.queuedAt) || Now(),
                expiresAt: Number(value.expiresAt) || (Now() + state.offlineQueuePolicy.ttlSeconds * 1000),
                attempts: Math.max(0, Number(value.attempts) || 0), lastAttemptAt: Math.max(0, Number(value.lastAttemptAt) || 0),
                reason: SafeField(value.reason || 'SERVER_OFFLINE'), source: SafeField(value.source || 'CLIENT'),
                replayOf: SafeField(value.replayOf || ''), notifyClient: value.notifyClient !== false
            });
            state.requestHistory.set(MakeRequestKey(clientId, requestId), Number(value.createdAt) || Now());
            require('./requestTrace').StartTrace(clientId, requestId, NormalizeID(value.serverId || ''), number, Number(value.createdAt) || Now(), {
                queued: true, source: SafeField(value.source || 'CLIENT'), replayOf: SafeField(value.replayOf || ''), notifyClient: value.notifyClient !== false
            });
            require('./requestTrace').MarkQueued(clientId, requestId, SafeField(value.reason || 'SERVER_OFFLINE'), Number(value.queuedAt) || Now());
        }
    }
    if (data.deadLetters && typeof data.deadLetters === 'object') {
        for (const [deadLetterId, value] of Object.entries(data.deadLetters)) {
            if (!value || typeof value !== 'object') continue;
            const clientId = NormalizeID(value.clientId);
            const requestId = String(value.originalRequestId || '').trim().slice(0, 64);
            const number = NumberFrom({ ...value, requestId });
            if (!/^DLQ-[A-Z0-9-]+$/.test(deadLetterId) || !clientId || !GetSavedClientByID(clientId) || !requestId || !number) continue;
            const status = ['ACTIVE', 'REPLAYED', 'DISCARDED'].includes(String(value.status || '').toUpperCase()) ? String(value.status).toUpperCase() : 'ACTIVE';
            state.deadLetters.set(deadLetterId, {
                deadLetterId, clientId, serverId: NormalizeID(value.serverId || ''), originalRequestId: requestId, number,
                reason: SafeField(value.reason || 'UNKNOWN_FAILURE'), source: SafeField(value.source || 'CLIENT'), replayOf: SafeField(value.replayOf || ''),
                createdAt: Number(value.createdAt) || Now(), failedAt: Number(value.failedAt) || Now(), attempts: Math.max(0, Number(value.attempts) || 0),
                retryCount: Math.max(0, Number(value.retryCount) || 0), status,
                lastReplayRequestId: String(value.lastReplayRequestId || '').slice(0, 64), resolvedAt: Math.max(0, Number(value.resolvedAt) || 0),
                notifyClient: value.notifyClient !== false, detail: SafeField(value.detail || '')
            });
        }
    }
    RebuildQueueRuntime();
}

function ClearResolvedHistory() {
    let removed = 0;
    for (const [id, item] of Array.from(state.deadLetters.entries())) {
        if (item && item.status === 'ACTIVE') continue;
        state.deadLetters.delete(id);
        removed++;
    }
    if (removed) require('../storage/database').SaveDatabase();
    return { removed, retainedActive: Array.from(state.deadLetters.values()).filter(x => x.status === 'ACTIVE').length };
}

module.exports = {
    DefaultPolicy,
    NormalizePolicy,
    EnsureState,
    NewRequestId,
    CanQueue,
    IsQueued,
    SetPolicy,
    SetClientEnabled,
    EnqueueRequest,
    RequeuePending,
    AddDeadLetter,
    DispatchRequest,
    ReplayTrace,
    RetryDeadLetter,
    DiscardDeadLetter,
    ProcessOfflineQueue,
    ListDeadLetters,
    BuildStatus,
    RebuildQueueRuntime,
    ClearResolvedHistory,
    ImportPersisted
};
