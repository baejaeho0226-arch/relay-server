'use strict';

const state = require('../core/state');
const { NormalizeID, Now, SendLine } = require('../core/utils');

const BUILD_WAIT_TTL_MS = Math.max(60000, Number(process.env.BUILD_GATE_WAIT_TTL_MS) || 30 * 60 * 1000);

function RequestKey(clientId, requestId) {
    return `${NormalizeID(clientId)}|${String(requestId || '').trim()}`;
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

function Queue(connection, requestId) {
    const clientId = NormalizeID(connection && connection.clientId);
    requestId = String(requestId || '').trim();
    if (!clientId || !requestId) return { ok: false, reason: 'INVALID_BUILD' };
    if (state.pendingBuildGrants.has(clientId)) return { ok: false, reason: 'DUPLICATE_REQUEST' };

    const now = Now();
    const saved = SavedClient(clientId);
    const grant = {
        requestId,
        clientId,
        serverId: saved ? NormalizeID(saved.serverId) : '',
        createdAt: now,
        expiresAt: now + BUILD_WAIT_TTL_MS,
        status: 'PENDING',
        dispatchCount: 0,
        lastDispatchAt: 0,
        lastReason: 'WAITING_FOR_SERVER'
    };
    state.pendingBuildGrants.set(clientId, grant);
    connection.buildCompleted = false;
    Save();
    SendLine(connection.socket, `BUILD_WAITING|${requestId}|${grant.expiresAt}`);
    Log('BUILD_WAITING', `${requestId} / ${clientId} / ${grant.serverId || 'UNASSIGNED'}`);
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

function TryDispatchClient(clientId) {
    clientId = NormalizeID(clientId);
    const grant = state.pendingBuildGrants.get(clientId);
    if (!grant) return { delivered: false, waiting: false, reason: 'NO_GRANT' };
    if (Number(grant.expiresAt) <= Now()) {
        Expire(clientId, grant);
        return { delivered: false, waiting: false, reason: 'EXPIRED' };
    }
    if (state.pendingRequests.has(RequestKey(clientId, grant.requestId))) return { delivered: false, waiting: true, reason: 'ALREADY_DISPATCHED' };

    const client = OnlineClient(clientId);
    if (!client || !client.connected) return { delivered: false, waiting: true, reason: 'CLIENT_OFFLINE' };
    if (!require('./deviceAuth').Verified('CLIENT', clientId)) return { delivered: false, waiting: true, reason: 'CLIENT_AUTH_REQUIRED' };
    if (!client.passwordVerified) return { delivered: false, waiting: true, reason: 'PASSWORD_AUTH_REQUIRED' };
    const active = require('../license/licenseManager').GetUsableLicenseForConnection(client);
    if (!active) return { delivered: false, waiting: true, reason: 'LICENSE_REQUIRED' };

    const saved = SavedClient(clientId);
    const serverId = saved ? NormalizeID(saved.serverId) : '';
    grant.serverId = serverId;
    if (!serverId) return { delivered: false, waiting: true, reason: 'SERVER_UNASSIGNED' };
    const server = OnlineServer(serverId);
    if (!server) return { delivered: false, waiting: true, reason: 'SERVER_OFFLINE' };
    if (!require('./deviceControl').Capabilities('SERVER', serverId).includes('BUILD_GATE')) return { delivered: false, waiting: true, reason: 'SERVER_BUILD_UNSUPPORTED' };
    if (!require('./deviceAuth').Verified('SERVER', serverId)) return { delivered: false, waiting: true, reason: 'SERVER_AUTH_REQUIRED' };

    // A freshly started WinSockServer must receive client authorization before BUILD.
    client.lastServerAuthState = '';
    require('../relay/notifications').NotifyServerAuthorized(clientId, serverId, active.license.expiresAt, 'QR_PASSWORD');

    const payload = `BUILD|${grant.requestId}|${clientId}`;
    if (!SendLine(server.socket, payload)) return { delivered: false, waiting: true, reason: 'SERVER_SEND_FAILED' };

    const now = Now();
    const key = RequestKey(clientId, grant.requestId);
    state.requestHistory.set(key, now);
    require('./requestTrace').StartTrace(clientId, grant.requestId, serverId, 'BUILD', now, { source: 'CLIENT_BUILD', notifyClient: true });
    state.pendingRequests.set(key, {
        kind: 'BUILD', clientId, serverId, requestId: grant.requestId,
        number: 'BUILD', payload, createdAt: now, originCreatedAt: grant.createdAt,
        lastSendAt: now, retries: 0, source: 'CLIENT_BUILD', replayOf: '', notifyClient: true
    });
    grant.status = 'DISPATCHED';
    grant.dispatchCount = Math.max(0, Number(grant.dispatchCount) || 0) + 1;
    grant.lastDispatchAt = now;
    grant.lastReason = '';
    Save();
    SendLine(client.socket, `BUILD_ACCEPTED|${grant.requestId}`);
    Log('BUILD_REQUEST', `${grant.requestId} / ${clientId} / ${serverId}`);
    return { delivered: true, waiting: true, reason: '' };
}

function TryDispatchServer(serverId) {
    serverId = NormalizeID(serverId);
    const server = OnlineServer(serverId);
    if (!server || !require('./deviceAuth').Verified('SERVER', serverId)) return { delivered: 0, waiting: false };
    let delivered = 0;
    for (const grant of Array.from(state.pendingBuildGrants.values())) {
        const saved = SavedClient(grant.clientId);
        if (saved && NormalizeID(saved.serverId) === serverId && TryDispatchClient(grant.clientId).delivered) delivered++;
    }
    const waiting = HasGrantForServer(serverId);
    if (delivered === 0 && !waiting && server.buildGateCapable) SendLine(server.socket, 'BUILD_GATE_EXIT|NO_PENDING_BUILD');
    return { delivered, waiting };
}

function Complete(clientId, requestId) {
    clientId = NormalizeID(clientId);
    const grant = state.pendingBuildGrants.get(clientId);
    if (!grant || grant.requestId !== String(requestId || '').trim()) return false;
    state.pendingBuildGrants.delete(clientId);
    Save();
    return true;
}

function Fail(clientId, requestId, reason) {
    clientId = NormalizeID(clientId);
    const grant = state.pendingBuildGrants.get(clientId);
    if (!grant || grant.requestId !== String(requestId || '').trim()) return false;
    state.pendingBuildGrants.delete(clientId);
    const client = OnlineClient(clientId);
    if (client) SendLine(client.socket, `ACK|ERROR|${requestId}|${reason || 'BUILD_FAILED'}`);
    const server = OnlineServer(grant.serverId);
    if (server && server.buildGateCapable && !HasGrantForServer(grant.serverId)) SendLine(server.socket, `BUILD_GATE_EXIT|${reason || 'BUILD_FAILED'}`);
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
    const client = OnlineClient(clientId);
    if (client) SendLine(client.socket, `BUILD_WAITING|${grant.requestId}|${grant.expiresAt}`);
    Save();
    Log('BUILD_REQUEUED', `${grant.requestId} / ${clientId} / ${grant.lastReason}`);
    return true;
}

function Expire(clientId, grant) {
    state.pendingBuildGrants.delete(clientId);
    state.pendingRequests.delete(RequestKey(clientId, grant.requestId));
    const client = OnlineClient(clientId);
    if (client) SendLine(client.socket, `BUILD_EXPIRED|${grant.requestId}`);
    const server = OnlineServer(grant.serverId);
    if (server && server.buildGateCapable && !server.buildUnlocked && !HasGrantForServer(grant.serverId)) SendLine(server.socket, 'BUILD_GATE_EXIT|BUILD_EXPIRED');
    Log('BUILD_EXPIRED', `${grant.requestId} / ${clientId}`);
    Save();
}

function Cleanup() {
    const now = Now();
    for (const [clientId, grant] of Array.from(state.pendingBuildGrants.entries())) {
        if (!grant || Number(grant.expiresAt) <= now) Expire(clientId, grant || { requestId: '' });
        else if (grant.status === 'PENDING') TryDispatchClient(clientId);
    }
}

function ImportPersisted(data) {
    state.pendingBuildGrants.clear();
    if (!data || !data.pendingBuildGrants || typeof data.pendingBuildGrants !== 'object') return;
    const now = Now();
    for (const [rawClientId, raw] of Object.entries(data.pendingBuildGrants)) {
        const clientId = NormalizeID(rawClientId);
        const requestId = String(raw && raw.requestId || '').trim();
        const expiresAt = Number(raw && raw.expiresAt) || 0;
        if (!clientId || !requestId || requestId.length > 64 || expiresAt <= now) continue;
        state.pendingBuildGrants.set(clientId, {
            requestId, clientId, serverId: NormalizeID(raw.serverId),
            createdAt: Number(raw.createdAt) || now, expiresAt,
            status: 'PENDING', dispatchCount: Math.max(0, Number(raw.dispatchCount) || 0),
            lastDispatchAt: Number(raw.lastDispatchAt) || 0,
            lastReason: 'RELAY_RESTART'
        });
    }
}

module.exports = {
    BUILD_WAIT_TTL_MS,
    Queue,
    TryDispatchClient,
    TryDispatchServer,
    Complete,
    Fail,
    Requeue,
    Cleanup,
    ImportPersisted
};
