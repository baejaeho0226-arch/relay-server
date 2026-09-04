'use strict';

const crypto = require('crypto');
const config = require('../config/config');
const state = require('../core/state');
const { NormalizeID, Now, SafeField, SendLine } = require('../core/utils');

function RequestKey(clientId, requestId) {
    return `${NormalizeID(clientId)}|${String(requestId || '').trim()}`;
}

function NormalizeAccessType(value) {
    return require('./accessType').NormalizeAccessType(value);
}

function OnlineClient(clientId) {
    return require('../identity/identityManager').GetOnlineClient(clientId);
}

function OnlineServer(serverId) {
    return require('../identity/identityManager').GetOnlineServer(serverId);
}

function SavedClient(clientId) {
    return require('../identity/identityManager').GetSavedClientByID(clientId);
}

function Save() {
    return require('../storage/database').SaveDatabase();
}

function Log(type, text) {
    require('../storage/audit').LogEvent(type, text);
}

function SessionId() {
    return `BLS-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
}

function SessionTtlMs() {
    return Math.max(1, Math.min(1440, Number(state.buildSessionPolicy.ttlMinutes) || config.DEFAULT_BUILD_SESSION_TTL_MINUTES)) * 60000;
}

function HmacHex(secret, data) {
    return crypto.createHmac('sha256', String(secret || '')).update(String(data || ''), 'utf8').digest('hex').toUpperCase();
}

function GrantProof(serverId, grant) {
    const secret = state.deviceSecrets.get(`SERVER:${NormalizeID(serverId)}`) || '';
    if (!secret) return '';
    return HmacHex(secret, `BUILD|${NormalizeID(serverId)}|${grant.requestId}|${grant.clientId}|${grant.sessionId}|${grant.sessionExpiresAt}|${grant.accessType}`);
}

function RevokeProof(serverId, clientId, sessionId, reason) {
    const secret = state.deviceSecrets.get(`SERVER:${NormalizeID(serverId)}`) || '';
    if (!secret) return '';
    return HmacHex(secret, `REVOKE|${NormalizeID(serverId)}|${NormalizeID(clientId)}|${sessionId}|${reason}`);
}

function PublicSession(session) {
    if (!session) return null;
    return {
        sessionId: String(session.sessionId || ''),
        requestId: String(session.requestId || ''),
        clientId: NormalizeID(session.clientId),
        serverId: NormalizeID(session.serverId),
        accessType: NormalizeAccessType(session.accessType),
        status: String(session.status || 'FAILED').toUpperCase(),
        createdAt: Number(session.createdAt) || 0,
        dispatchedAt: Number(session.dispatchedAt) || 0,
        authorizedAt: Number(session.authorizedAt) || 0,
        expiresAt: Number(session.expiresAt) || 0,
        endedAt: Number(session.endedAt) || 0,
        reason: SafeField(session.reason || ''),
        actor: SafeField(session.actor || ''),
        dispatchCount: Math.max(0, Number(session.dispatchCount) || 0)
    };
}

function ActiveSessionForClient(clientId) {
    clientId = NormalizeID(clientId);
    const now = Now();
    return Array.from(state.buildSessions.values()).find(session =>
        session.clientId === clientId && session.status === 'AUTHORIZED' && Number(session.expiresAt) > now
    ) || null;
}

function BindingForClient(clientId) {
    clientId = NormalizeID(clientId);
    const binding = state.clientBuildBindings.get(clientId);
    if (!binding) return null;
    return {
        clientId,
        serverId: NormalizeID(binding.serverId),
        boundAt: Number(binding.boundAt) || 0,
        updatedAt: Number(binding.updatedAt) || 0,
        updatedBy: SafeField(binding.updatedBy || ''),
        source: SafeField(binding.source || 'FIRST_BUILD')
    };
}

function BindingForServer(serverId) {
    serverId = NormalizeID(serverId);
    if (!serverId) return null;
    for (const [clientId, binding] of state.clientBuildBindings) {
        if (NormalizeID(binding && binding.serverId) === serverId)
            return BindingForClient(clientId);
    }
    return null;
}

function Queue(connection, requestId) {
    const clientId = NormalizeID(connection && connection.clientId);
    requestId = String(requestId || '').trim();
    if (!clientId || !requestId) return { ok: false, reason: 'INVALID_BUILD' };
    if (state.pendingBuildGrants.has(clientId)) return { ok: false, reason: 'DUPLICATE_REQUEST' };
    if (ActiveSessionForClient(clientId)) return { ok: false, reason: 'BUILD_SESSION_ACTIVE' };

    const saved = SavedClient(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    const serverId = NormalizeID(saved.serverId);
    const binding = BindingForClient(clientId);
    if (binding && binding.serverId !== serverId) return { ok: false, reason: 'SERVER_BINDING_MISMATCH' };
    const serverOwner = BindingForServer(serverId);
    if (serverOwner && serverOwner.clientId !== clientId)
        return { ok: false, reason: 'SERVER_ALREADY_PAIRED' };

    const now = Now();
    const sessionId = SessionId();
    const accessType = NormalizeAccessType(connection.accessType);
    const grant = {
        requestId,
        sessionId,
        clientId,
        serverId,
        accessType,
        createdAt: now,
        expiresAt: now + config.BUILD_WAIT_TTL_MS,
        sessionExpiresAt: 0,
        status: 'PENDING',
        dispatchCount: 0,
        lastDispatchAt: 0,
        lastReason: 'WAITING_FOR_SERVER'
    };
    state.pendingBuildGrants.set(clientId, grant);
    state.buildSessions.set(sessionId, {
        sessionId, requestId, clientId, serverId, accessType,
        status: 'PENDING', createdAt: now, dispatchedAt: 0,
        authorizedAt: 0, expiresAt: 0, endedAt: 0,
        reason: 'WAITING_FOR_SERVER', actor: 'APK', dispatchCount: 0
    });
    connection.buildCompleted = false;
    connection.buildSessionId = '';
    Save();
    SendLine(connection.socket, `BUILD_WAITING|${requestId}|${grant.expiresAt}|${sessionId}`);
    Log('BUILD_WAITING', `${requestId} / ${clientId} / ${serverId || 'UNASSIGNED'} / ${sessionId}`);
    // A server may have completed its own authentication just before the APK
    // submitted Build. Let verified, empty servers atomically claim this new
    // pending grant without waiting for another reconnect event.
    for (const server of Array.from(state.servers.values())) {
        if (!server || !server.serverId || server.deviceAuthVerified !== true) continue;
        TryDispatchServer(server.serverId);
        if (NormalizeID(saved.serverId)) break;
    }
    return { ok: true, grant };
}

function HasGrantForServer(serverId) {
    serverId = NormalizeID(serverId);
    const now = Now();
    for (const grant of state.pendingBuildGrants.values()) {
        if (!grant || Number(grant.expiresAt) <= now) continue;
        const saved = SavedClient(grant.clientId);
        const currentServerId = saved ? NormalizeID(saved.serverId) : NormalizeID(grant.serverId);
        if (currentServerId === serverId) return true;
    }
    return false;
}

function MarkFailed(clientId, grant, reason, status = 'FAILED') {
    state.pendingBuildGrants.delete(clientId);
    state.pendingRequests.delete(RequestKey(clientId, grant.requestId));
    const session = state.buildSessions.get(grant.sessionId);
    if (session) {
        session.status = status;
        session.reason = SafeField(reason || status);
        session.endedAt = Now();
    }
}

function TryDispatchClient(clientId) {
    clientId = NormalizeID(clientId);
    const grant = state.pendingBuildGrants.get(clientId);
    if (!grant) return { delivered: false, waiting: false, reason: 'NO_GRANT' };
    if (Number(grant.expiresAt) <= Now()) {
        ExpirePending(clientId, grant);
        return { delivered: false, waiting: false, reason: 'EXPIRED' };
    }
    if (state.pendingRequests.has(RequestKey(clientId, grant.requestId))) return { delivered: false, waiting: true, reason: 'ALREADY_DISPATCHED' };

    const client = OnlineClient(clientId);
    if (!client || !client.connected) return { delivered: false, waiting: true, reason: 'CLIENT_OFFLINE' };
    if (!require('./deviceAuth').Verified('CLIENT', clientId)) return { delivered: false, waiting: true, reason: 'CLIENT_AUTH_REQUIRED' };
    if (!client.biometricVerified) return { delivered: false, waiting: true, reason: 'BIOMETRIC_AUTH_REQUIRED' };
    const active = require('../license/licenseManager').GetUsableLicenseForConnection(client);
    if (!active) return { delivered: false, waiting: true, reason: 'LICENSE_REQUIRED' };

    const saved = SavedClient(clientId);
    const serverId = saved ? NormalizeID(saved.serverId) : '';
    grant.serverId = serverId;
    const binding = BindingForClient(clientId);
    if (binding && binding.serverId !== serverId) {
        MarkFailed(clientId, grant, 'SERVER_BINDING_MISMATCH');
        SendLine(client.socket, `BUILD_FAILED|${grant.requestId}|SERVER_BINDING_MISMATCH`);
        Save();
        return { delivered: false, waiting: false, reason: 'SERVER_BINDING_MISMATCH' };
    }
    const serverOwner = BindingForServer(serverId);
    if (serverOwner && serverOwner.clientId !== clientId) {
        MarkFailed(clientId, grant, 'SERVER_ALREADY_PAIRED');
        SendLine(client.socket, `BUILD_FAILED|${grant.requestId}|SERVER_ALREADY_PAIRED`);
        Save();
        return { delivered: false, waiting: false, reason: 'SERVER_ALREADY_PAIRED' };
    }
    if (!serverId) return { delivered: false, waiting: true, reason: 'SERVER_UNASSIGNED' };
    const server = OnlineServer(serverId);
    if (!server) return { delivered: false, waiting: true, reason: 'SERVER_OFFLINE' };
    if (!require('./deviceControl').Capabilities('SERVER', serverId).includes('BUILD_SESSION_LEASE')) return { delivered: false, waiting: true, reason: 'SERVER_BUILD_UNSUPPORTED' };
    if (!require('./deviceAuth').Verified('SERVER', serverId)) return { delivered: false, waiting: true, reason: 'SERVER_AUTH_REQUIRED' };

    client.lastServerAuthState = '';
    require('../relay/notifications').NotifyServerAuthorized(clientId, serverId, active.license.expiresAt, 'QR_PASSWORD');

    const now = Now();
    if (!grant.sessionExpiresAt || grant.sessionExpiresAt <= now + 5000) grant.sessionExpiresAt = now + SessionTtlMs();
    grant.accessType = NormalizeAccessType(client.accessType);
    const proof = GrantProof(serverId, grant);
    if (!proof) return { delivered: false, waiting: true, reason: 'SERVER_SECRET_REQUIRED' };
    const payload = `BUILD|${grant.requestId}|${clientId}|${grant.sessionId}|${grant.sessionExpiresAt}|${grant.accessType}|${proof}`;
    if (!SendLine(server.socket, payload)) return { delivered: false, waiting: true, reason: 'SERVER_SEND_FAILED' };

    const key = RequestKey(clientId, grant.requestId);
    state.requestHistory.set(key, now);
    require('./requestTrace').StartTrace(clientId, grant.requestId, serverId, 'BUILD', now, { source: 'CLIENT_BUILD', notifyClient: true });
    state.pendingRequests.set(key, {
        kind: 'BUILD', clientId, serverId, requestId: grant.requestId,
        sessionId: grant.sessionId, sessionExpiresAt: grant.sessionExpiresAt,
        accessType: grant.accessType, number: 'BUILD', payload,
        createdAt: now, originCreatedAt: grant.createdAt,
        lastSendAt: now, retries: 0, source: 'CLIENT_BUILD', replayOf: '', notifyClient: true
    });
    grant.status = 'DISPATCHED';
    grant.dispatchCount = Math.max(0, Number(grant.dispatchCount) || 0) + 1;
    grant.lastDispatchAt = now;
    grant.lastReason = '';
    const session = state.buildSessions.get(grant.sessionId);
    if (session) {
        session.serverId = serverId;
        session.accessType = grant.accessType;
        session.status = 'PENDING';
        session.dispatchedAt = now;
        session.expiresAt = grant.sessionExpiresAt;
        session.reason = '';
        session.dispatchCount = grant.dispatchCount;
    }
    Save();
    SendLine(client.socket, `BUILD_ACCEPTED|${grant.requestId}|${grant.sessionId}`);
    Log('BUILD_REQUEST', `${grant.requestId} / ${clientId} / ${serverId} / ${grant.sessionId} / ${grant.accessType}`);
    return { delivered: true, waiting: true, reason: '' };
}

function TryDispatchServer(serverId) {
    serverId = NormalizeID(serverId);
    const server = OnlineServer(serverId);
    if (!server || !require('./deviceAuth').Verified('SERVER', serverId)) return { delivered: 0, waiting: false };
    const dispatchedBeforeClaim = new Set(Array.from(state.pendingBuildGrants.values())
        .filter(grant => grant && grant.status === 'DISPATCHED')
        .map(grant => grant.sessionId));
    // New APKs complete QR + biometric first and intentionally have no PC yet.
    // Claiming occurs only after this server has passed HMAC authentication.
    require('../relay/serverHandler').BindUnassignedClients(serverId);
    let delivered = 0;
    for (const grant of Array.from(state.pendingBuildGrants.values())) {
        const saved = SavedClient(grant.clientId);
        if (!saved || NormalizeID(saved.serverId) !== serverId) continue;
        if (grant.status === 'DISPATCHED' && !dispatchedBeforeClaim.has(grant.sessionId)) {
            delivered++;
            continue;
        }
        if (TryDispatchClient(grant.clientId).delivered) delivered++;
    }
    return { delivered, waiting: HasGrantForServer(serverId) };
}

function Complete(clientId, requestId) {
    clientId = NormalizeID(clientId);
    const grant = state.pendingBuildGrants.get(clientId);
    if (!grant || grant.requestId !== String(requestId || '').trim()) return { ok: false, reason: 'BUILD_GRANT_NOT_FOUND' };
    const serverOwner = BindingForServer(grant.serverId);
    if (serverOwner && serverOwner.clientId !== clientId) {
        MarkFailed(clientId, grant, 'SERVER_ALREADY_PAIRED');
        Save();
        return { ok: false, reason: 'SERVER_ALREADY_PAIRED' };
    }
    state.pendingBuildGrants.delete(clientId);
    const now = Now();
    const session = state.buildSessions.get(grant.sessionId);
    if (!session) return { ok: false, reason: 'BUILD_SESSION_NOT_FOUND' };
    session.status = 'AUTHORIZED';
    session.authorizedAt = now;
    session.expiresAt = grant.sessionExpiresAt;
    session.reason = '';
    session.endedAt = 0;
    const existing = BindingForClient(clientId);
    if (!existing) {
        state.clientBuildBindings.set(clientId, {
            serverId: grant.serverId,
            boundAt: now,
            updatedAt: now,
            updatedBy: 'SYSTEM',
            source: 'FIRST_BUILD'
        });
        Log('BUILD_BINDING_CREATED', `${clientId} -> ${grant.serverId}`);
    }
    Save();
    return { ok: true, session: PublicSession(session), binding: BindingForClient(clientId) };
}

function Fail(clientId, requestId, reason) {
    clientId = NormalizeID(clientId);
    const grant = state.pendingBuildGrants.get(clientId);
    if (!grant || grant.requestId !== String(requestId || '').trim()) return false;
    MarkFailed(clientId, grant, reason || 'BUILD_FAILED');
    const client = OnlineClient(clientId);
    if (client) SendLine(client.socket, `BUILD_FAILED|${requestId}|${SafeField(reason || 'BUILD_FAILED')}`);
    Save();
    return true;
}

function Requeue(pending, reason) {
    if (!pending || pending.kind !== 'BUILD') return false;
    const clientId = NormalizeID(pending.clientId);
    const grant = state.pendingBuildGrants.get(clientId);
    if (!grant || grant.requestId !== pending.requestId) return false;
    state.pendingRequests.delete(RequestKey(clientId, pending.requestId));
    grant.status = 'PENDING';
    grant.lastReason = String(reason || 'SERVER_OFFLINE');
    grant.sessionExpiresAt = 0;
    const session = state.buildSessions.get(grant.sessionId);
    if (session) {
        session.status = 'PENDING';
        session.expiresAt = 0;
        session.reason = grant.lastReason;
    }
    const client = OnlineClient(clientId);
    if (client) SendLine(client.socket, `BUILD_WAITING|${grant.requestId}|${grant.expiresAt}|${grant.sessionId}`);
    Save();
    Log('BUILD_REQUEUED', `${grant.requestId} / ${clientId} / ${grant.lastReason}`);
    return true;
}

function ExpirePending(clientId, grant) {
    MarkFailed(clientId, grant, 'WAIT_TIMEOUT', 'EXPIRED');
    const client = OnlineClient(clientId);
    if (client) SendLine(client.socket, `BUILD_EXPIRED|${grant.requestId}|${grant.sessionId}`);
    Log('BUILD_EXPIRED', `${grant.requestId} / ${clientId} / WAIT_TIMEOUT`);
    Save();
}

function EndSession(session, status, reason, actor = 'SYSTEM') {
    if (!session || session.status !== 'AUTHORIZED') return false;
    status = status === 'EXPIRED' ? 'EXPIRED' : 'REVOKED';
    reason = SafeField(reason || status).toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 64) || status;
    session.status = status;
    session.reason = reason;
    session.actor = SafeField(actor || 'SYSTEM').slice(0, 64);
    session.endedAt = Now();

    const client = OnlineClient(session.clientId);
    if (client) {
        client.buildCompleted = false;
        client.buildSessionId = '';
        SendLine(client.socket, `${status === 'EXPIRED' ? 'BUILD_SESSION_EXPIRED' : 'BUILD_REVOKED'}|${session.sessionId}|${reason}`);
    }
    const server = OnlineServer(session.serverId);
    if (server) {
        if (server.buildClients instanceof Set) server.buildClients.delete(session.clientId);
        if (server.buildSessions instanceof Map) server.buildSessions.delete(session.clientId);
        server.buildUnlocked = server.buildClients instanceof Set && server.buildClients.size > 0;
        const proof = RevokeProof(session.serverId, session.clientId, session.sessionId, reason);
        if (proof) SendLine(server.socket, `BUILD_REVOKE|${session.clientId}|${session.sessionId}|${reason}|${proof}`);
    }
    Log(status === 'EXPIRED' ? 'BUILD_SESSION_EXPIRED' : 'BUILD_SESSION_REVOKED', `${session.sessionId} / ${session.clientId} / ${session.serverId} / ${reason} / ${session.actor}`);
    return true;
}

function Revoke(sessionId, reason = 'ADMIN_REVOKE', actor = 'WEB_ADMIN') {
    sessionId = String(sessionId || '').trim().toUpperCase();
    const session = state.buildSessions.get(sessionId);
    if (!session) return { ok: false, reason: 'BUILD_SESSION_NOT_FOUND' };
    if (!EndSession(session, 'REVOKED', reason, actor)) return { ok: false, reason: `BUILD_SESSION_${session.status}` };
    Save();
    return { ok: true, session: PublicSession(session) };
}

function RevokeForClient(clientId, reason = 'CLIENT_AUTH_LOST') {
    clientId = NormalizeID(clientId);
    let count = 0;
    for (const session of state.buildSessions.values()) if (session.clientId === clientId && EndSession(session, 'REVOKED', reason, 'SYSTEM')) count++;
    const grant = state.pendingBuildGrants.get(clientId);
    if (grant) {
        MarkFailed(clientId, grant, reason);
        count++;
    }
    if (count) Save();
    return count;
}

function RevokeForServer(serverId, reason = 'SERVER_AUTH_LOST') {
    serverId = NormalizeID(serverId);
    let count = 0;
    for (const session of state.buildSessions.values()) if (session.serverId === serverId && EndSession(session, 'REVOKED', reason, 'SYSTEM')) count++;
    if (count) Save();
    return count;
}

function SetPolicy(input = {}, actor = 'WEB_ADMIN') {
    const ttlMinutes = Number(input.ttlMinutes);
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) return { ok: false, reason: 'INVALID_BUILD_SESSION_TTL' };
    state.buildSessionPolicy = { ttlMinutes, updatedAt: Now(), updatedBy: SafeField(actor).slice(0, 64) || 'WEB_ADMIN' };
    Save();
    Log('BUILD_SESSION_POLICY', `ttlMinutes=${ttlMinutes} / ${state.buildSessionPolicy.updatedBy}`);
    return { ok: true, policy: { ...state.buildSessionPolicy } };
}

function Rebind(clientId, serverId, actor = 'WEB_ADMIN') {
    clientId = NormalizeID(clientId);
    serverId = NormalizeID(serverId);
    const ids = require('../identity/identityManager');
    if (!ids.ClientExists(clientId)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!ids.ServerExists(serverId)) return { ok: false, reason: 'SERVER_NOT_FOUND' };
    const serverOwner = BindingForServer(serverId);
    if (serverOwner && serverOwner.clientId !== clientId)
        return { ok: false, reason: 'SERVER_ALREADY_PAIRED' };
    const saved = SavedClient(clientId);
    if (NormalizeID(saved.serverId) !== serverId) {
        const moved = ids.ClientMove(clientId, serverId);
        if (!moved.ok) return { ok: false, reason: `CLIENT_MOVE_${moved.reason}` };
    }
    RevokeForClient(clientId, 'ADMIN_REBIND');
    const now = Now();
    const previous = BindingForClient(clientId);
    state.clientBuildBindings.set(clientId, {
        serverId,
        boundAt: previous ? previous.boundAt : now,
        updatedAt: now,
        updatedBy: SafeField(actor).slice(0, 64) || 'WEB_ADMIN',
        source: 'ADMIN_REBIND'
    });
    Save();
    Log('BUILD_BINDING_REBIND', `${clientId} ${previous ? previous.serverId : 'NONE'} -> ${serverId} / ${actor}`);
    return { ok: true, binding: BindingForClient(clientId) };
}

function List() {
    return Array.from(state.buildSessions.values())
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
        .slice(0, config.MAX_BUILD_SESSION_HISTORY)
        .map(PublicSession);
}

function Bindings() {
    const rows = [];
    for (const saved of state.clientIdentities.values()) {
        const binding = BindingForClient(saved.id);
        rows.push({
            clientId: saved.id,
            assignedServerId: NormalizeID(saved.serverId),
            binding,
            matched: !binding || binding.serverId === NormalizeID(saved.serverId),
            activeSession: PublicSession(ActiveSessionForClient(saved.id))
        });
    }
    return rows.sort((a, b) => a.clientId.localeCompare(b.clientId));
}

function Summary() {
    const counts = { pending: 0, authorized: 0, expired: 0, revoked: 0, failed: 0 };
    for (const session of state.buildSessions.values()) {
        const key = String(session.status || '').toLowerCase();
        if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key]++;
    }
    return { ...counts, policy: { ...state.buildSessionPolicy }, active: counts.authorized, bindings: state.clientBuildBindings.size };
}

function TrimHistory() {
    const rows = Array.from(state.buildSessions.values()).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    for (const session of rows.slice(config.MAX_BUILD_SESSION_HISTORY)) {
        if (session.status !== 'PENDING' && session.status !== 'AUTHORIZED') state.buildSessions.delete(session.sessionId);
    }
}

function ClearHistory() {
    let removed = 0;
    for (const [sessionId, session] of Array.from(state.buildSessions.entries())) {
        if (session && (session.status === 'PENDING' || session.status === 'AUTHORIZED')) continue;
        state.buildSessions.delete(sessionId);
        removed++;
    }
    if (removed) Save();
    return { removed, retainedActive: state.buildSessions.size };
}

function PurgeClient(clientId) {
    clientId = NormalizeID(clientId);
    RevokeForClient(clientId, 'CLIENT_DELETED');
    state.pendingBuildGrants.delete(clientId);
    state.clientBuildBindings.delete(clientId);
    let removedSessions = 0;
    for (const [sessionId, session] of Array.from(state.buildSessions.entries())) {
        if (session && session.clientId === clientId) {
            state.buildSessions.delete(sessionId);
            removedSessions++;
        }
    }
    return removedSessions;
}

function PurgeServer(serverId) {
    serverId = NormalizeID(serverId);
    RevokeForServer(serverId, 'SERVER_DELETED');
    const clients = [];
    for (const [clientId, binding] of Array.from(state.clientBuildBindings.entries())) {
        if (NormalizeID(binding && binding.serverId) === serverId) {
            state.clientBuildBindings.delete(clientId);
            clients.push(clientId);
        }
    }
    for (const grant of state.pendingBuildGrants.values()) {
        if (NormalizeID(grant && grant.serverId) === serverId) grant.serverId = '';
    }
    return clients;
}

function Cleanup() {
    const now = Now();
    let changed = false;
    for (const [clientId, grant] of Array.from(state.pendingBuildGrants.entries())) {
        if (!grant || Number(grant.expiresAt) <= now) { ExpirePending(clientId, grant || { requestId: '', sessionId: '' }); changed = true; }
        else if (grant.status === 'PENDING') TryDispatchClient(clientId);
    }
    for (const session of state.buildSessions.values()) {
        if (session.status === 'AUTHORIZED' && Number(session.expiresAt) > 0 && Number(session.expiresAt) <= now) {
            if (EndSession(session, 'EXPIRED', 'LEASE_EXPIRED', 'SYSTEM')) changed = true;
        }
    }
    TrimHistory();
    if (changed) Save();
}

function ImportPersisted(data) {
    state.pendingBuildGrants.clear();
    state.buildSessions.clear();
    state.clientBuildBindings.clear();
    const policy = data && data.buildSessionPolicy;
    const ttlMinutes = Math.max(1, Math.min(1440, Number(policy && policy.ttlMinutes) || config.DEFAULT_BUILD_SESSION_TTL_MINUTES));
    state.buildSessionPolicy = {
        ttlMinutes,
        updatedAt: Number(policy && policy.updatedAt) || 0,
        updatedBy: SafeField(policy && policy.updatedBy || 'DEFAULT').slice(0, 64)
    };

    if (data && data.clientBuildBindings && typeof data.clientBuildBindings === 'object') {
        const importedBindings = Object.entries(data.clientBuildBindings)
            .sort((a, b) => (Number(a[1] && a[1].boundAt) || 0) -
                (Number(b[1] && b[1].boundAt) || 0) || String(a[0]).localeCompare(String(b[0])));
        const occupiedServers = new Set();
        for (const [rawClientId, raw] of importedBindings) {
            const clientId = NormalizeID(rawClientId);
            const serverId = NormalizeID(raw && raw.serverId);
            if (!clientId || !serverId || occupiedServers.has(serverId)) continue;
            occupiedServers.add(serverId);
            state.clientBuildBindings.set(clientId, {
                serverId,
                boundAt: Number(raw.boundAt) || 0,
                updatedAt: Number(raw.updatedAt) || 0,
                updatedBy: SafeField(raw.updatedBy || '').slice(0, 64),
                source: SafeField(raw.source || 'FIRST_BUILD').slice(0, 32)
            });
        }
    }

    if (data && data.buildSessions && typeof data.buildSessions === 'object') {
        for (const [rawId, raw] of Object.entries(data.buildSessions)) {
            const sessionId = String(rawId || '').toUpperCase();
            const clientId = NormalizeID(raw && raw.clientId);
            const serverId = NormalizeID(raw && raw.serverId);
            if (!/^BLS-[0-9A-F]{32}$/.test(sessionId) || !clientId || !raw) continue;
            let status = String(raw.status || 'FAILED').toUpperCase();
            if (!['PENDING', 'AUTHORIZED', 'EXPIRED', 'REVOKED', 'FAILED'].includes(status)) status = 'FAILED';
            if (!serverId && status !== 'PENDING') continue;
            if (status === 'AUTHORIZED') status = 'REVOKED';
            state.buildSessions.set(sessionId, {
                sessionId,
                requestId: String(raw.requestId || '').slice(0, 64),
                clientId,
                serverId,
                accessType: NormalizeAccessType(raw.accessType),
                status,
                createdAt: Number(raw.createdAt) || Now(),
                dispatchedAt: Number(raw.dispatchedAt) || 0,
                authorizedAt: Number(raw.authorizedAt) || 0,
                expiresAt: Number(raw.expiresAt) || 0,
                endedAt: status === 'REVOKED' && raw.status === 'AUTHORIZED' ? Now() : Number(raw.endedAt) || 0,
                reason: status === 'REVOKED' && raw.status === 'AUTHORIZED' ? 'RELAY_RESTART' : SafeField(raw.reason || ''),
                actor: SafeField(raw.actor || ''),
                dispatchCount: Math.max(0, Number(raw.dispatchCount) || 0)
            });
        }
    }

    if (data && data.pendingBuildGrants && typeof data.pendingBuildGrants === 'object') {
        const now = Now();
        for (const [rawClientId, raw] of Object.entries(data.pendingBuildGrants)) {
            const clientId = NormalizeID(rawClientId);
            const requestId = String(raw && raw.requestId || '').trim();
            const sessionId = String(raw && raw.sessionId || '').toUpperCase();
            const expiresAt = Number(raw && raw.expiresAt) || 0;
            if (!clientId || !requestId || requestId.length > 64 || !/^BLS-[0-9A-F]{32}$/.test(sessionId) || expiresAt <= now) continue;
            const grant = {
                requestId, sessionId, clientId, serverId: NormalizeID(raw.serverId),
                accessType: NormalizeAccessType(raw.accessType),
                createdAt: Number(raw.createdAt) || now, expiresAt,
                sessionExpiresAt: 0, status: 'PENDING',
                dispatchCount: Math.max(0, Number(raw.dispatchCount) || 0),
                lastDispatchAt: Number(raw.lastDispatchAt) || 0,
                lastReason: 'RELAY_RESTART'
            };
            state.pendingBuildGrants.set(clientId, grant);
            let session = state.buildSessions.get(sessionId);
            if (!session) {
                session = {
                    sessionId, requestId, clientId, serverId: grant.serverId,
                    accessType: grant.accessType, status: 'PENDING',
                    createdAt: grant.createdAt, dispatchedAt: 0,
                    authorizedAt: 0, expiresAt: 0, endedAt: 0,
                    reason: 'RELAY_RESTART', actor: 'APK',
                    dispatchCount: grant.dispatchCount
                };
                state.buildSessions.set(sessionId, session);
            }
            if (session) {
                session.status = 'PENDING';
                session.expiresAt = 0;
                session.reason = 'RELAY_RESTART';
            }
        }
    }
    TrimHistory();
}

module.exports = {
    RequestKey,
    GrantProof,
    PublicSession,
    ActiveSessionForClient,
    BindingForClient,
    BindingForServer,
    Queue,
    TryDispatchClient,
    TryDispatchServer,
    Complete,
    Fail,
    Requeue,
    Revoke,
    RevokeForClient,
    RevokeForServer,
    SetPolicy,
    Rebind,
    List,
    Bindings,
    Summary,
    ClearHistory,
    PurgeClient,
    PurgeServer,
    Cleanup,
    ImportPersisted
};
