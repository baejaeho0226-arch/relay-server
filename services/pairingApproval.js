'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const config = require('../config/config');
const { NormalizeID, Now, SendLine, SafeField } = require('../core/utils');

function Identity() { return require('../identity/identityManager'); }
function BuildGate() { return require('./buildGate'); }

function Occupant(serverId, exceptClientId = '') {
    serverId = NormalizeID(serverId);
    exceptClientId = NormalizeID(exceptClientId);
    for (const saved of state.clientIdentities.values()) {
        if (saved && NormalizeID(saved.serverId) === serverId && NormalizeID(saved.id) !== exceptClientId)
            return NormalizeID(saved.id);
    }
    const fixed = BuildGate().BindingForServer(serverId);
    if (fixed && fixed.clientId !== exceptClientId) return fixed.clientId;
    return '';
}

function EligibleServers(clientId = '') {
    clientId = NormalizeID(clientId);
    const current = Identity().GetSavedClientByID(clientId);
    const rows = [];
    for (const [deviceKey, serverIdRaw] of state.serverIdentities) {
        const serverId = NormalizeID(serverIdRaw);
        const live = Identity().GetOnlineServer(serverId);
        const occupiedBy = Occupant(serverId, clientId);
        const kicked = Identity().GetKickUntil(state.kickedServers, serverId) > Now();
        let reason = '';
        if (!live) reason = 'OFFLINE';
        else if (state.disabledServers.has(serverId)) reason = 'DISABLED';
        else if (state.drainingServers.has(serverId)) reason = 'DRAINING';
        else if (kicked) reason = 'KICKED';
        else if (occupiedBy) reason = 'ALREADY_PAIRED';
        rows.push({
            id: serverId,
            alias: state.serverAliases.get(serverId) || '',
            online: !!live,
            eligible: !reason,
            reason,
            occupiedBy,
            current: !!current && NormalizeID(current.serverId) === serverId,
            deviceRef: deviceKey ? crypto.createHash('sha256').update(deviceKey).digest('hex').slice(0, 12).toUpperCase() : ''
        });
    }
    return rows.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.eligible) - Number(a.eligible) || a.id.localeCompare(b.id));
}

function Validate(clientId, serverId) {
    clientId = NormalizeID(clientId);
    serverId = NormalizeID(serverId);
    if (!clientId) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!serverId) return { ok: false, reason: 'PAIR_TARGET_REQUIRED' };
    const saved = Identity().GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!Identity().ServerExists(serverId)) return { ok: false, reason: 'SERVER_NOT_FOUND' };
    const row = EligibleServers(clientId).find(item => item.id === serverId);
    if (!row || (!row.eligible && !row.current)) return { ok: false, reason: `SERVER_${row ? row.reason : 'NOT_FOUND'}` };
    const fixed = BuildGate().BindingForClient(clientId);
    if (fixed && fixed.serverId !== serverId) return { ok: false, reason: 'FIXED_BINDING_MISMATCH' };
    return { ok: true, saved, row };
}

// Node executes this function synchronously.  The short-lived claim is still
// recorded so a second approval request cannot reuse a target while the first
// approval is being persisted/delivered.
function BindForApproval(clientId, serverId, actor = 'admin') {
    const check = Validate(clientId, serverId);
    if (!check.ok) return check;
    clientId = NormalizeID(clientId);
    serverId = NormalizeID(serverId);
    const now = Now();
    const existingClaim = state.production.pairingClaims.get(serverId);
    if (existingClaim && existingClaim.expiresAt > now && existingClaim.clientId !== clientId)
        return { ok: false, reason: 'PAIR_TARGET_BUSY' };

    const claim = {
        claimId: crypto.randomBytes(12).toString('hex').toUpperCase(), clientId, serverId,
        actor: SafeField(actor).slice(0, 64), claimedAt: now, expiresAt: now + 60000
    };
    state.production.pairingClaims.set(serverId, claim);
    try {
        const occupiedBy = Occupant(serverId, clientId);
        if (occupiedBy) return { ok: false, reason: 'SERVER_ALREADY_PAIRED' };
        const oldServerId = NormalizeID(check.saved.serverId);
        const oldRequiresPairingApproval = Boolean(check.saved.requiresPairingApproval);
        const oldPairingApprovedAt = Number(check.saved.pairingApprovedAt) || 0;
        const oldPairingApprovedBy = String(check.saved.pairingApprovedBy || '');
        const oldPairingDeferredAt = Number(check.saved.pairingDeferredAt) || 0;
        const oldPairingBoundAt = Number(check.saved.pairingBoundAt) || 0;
        check.saved.serverId = serverId;
        check.saved.requiresPairingApproval = false;
        check.saved.pairingApprovedAt = now;
        check.saved.pairingApprovedBy = claim.actor;
        check.saved.pairingBoundAt = now;
        delete check.saved.pairingDeferredAt;

        const live = Identity().GetOnlineClient(clientId);
        const oldLiveServer = Identity().GetOnlineServer(oldServerId);
        const target = Identity().GetOnlineServer(serverId);
        if (live) {
            if (oldLiveServer && oldLiveServer.clients instanceof Set) oldLiveServer.clients.delete(clientId);
            live.serverId = serverId;
            if (target && target.clients instanceof Set) target.clients.add(clientId);
        }
        if (!require('../storage/database').SaveDatabase()) {
            check.saved.serverId = oldServerId;
            check.saved.requiresPairingApproval = oldRequiresPairingApproval;
            check.saved.pairingApprovedAt = oldPairingApprovedAt;
            check.saved.pairingApprovedBy = oldPairingApprovedBy;
            check.saved.pairingBoundAt = oldPairingBoundAt;
            if (oldPairingDeferredAt) check.saved.pairingDeferredAt = oldPairingDeferredAt;
            if (live) {
                live.serverId = oldServerId;
                if (target && target.clients instanceof Set) target.clients.delete(clientId);
                if (oldLiveServer && oldLiveServer.clients instanceof Set) oldLiveServer.clients.add(clientId);
            }
            return { ok: false, reason: 'PAIR_PERSIST_FAILED' };
        }
        if (live) SendLine(live.socket, `SERVER_ASSIGNED|${serverId}`);
        require('../storage/audit').LogEvent('PAIRING_APPROVED', `${clientId} -> ${serverId} / ${claim.actor}`);
        return { ok: true, pairing: { clientId, serverId, oldServerId, approvedAt: now, approvedBy: claim.actor } };
    } finally {
        const current = state.production.pairingClaims.get(serverId);
        if (current && current.claimId === claim.claimId) state.production.pairingClaims.delete(serverId);
    }
}

function CompleteDeferredBinding(clientId, serverId, source = 'AUTO') {
    clientId = NormalizeID(clientId);
    serverId = NormalizeID(serverId);
    const saved = Identity().GetSavedClientByID(clientId);
    if (!saved || !serverId) return false;
    const wasDeferred = Number(saved.pairingDeferredAt) > 0;
    if (wasDeferred) {
        saved.pairingBoundAt = Now();
        delete saved.pairingDeferredAt;
        for (const record of state.qrAuthRequests.values()) {
            if (record && record.clientId === clientId && record.status === 'APPROVED' && !NormalizeID(record.serverId)) {
                record.serverId = serverId;
                record.pairingBoundAt = saved.pairingBoundAt;
            }
        }
        require('../storage/audit').LogEvent('PAIRING_DEFERRED_BOUND', `${clientId} -> ${serverId} / ${SafeField(source).slice(0, 64)}`);
    }
    return wasDeferred;
}

function DeferForApproval(clientId, actor = 'admin') {
    clientId = NormalizeID(clientId);
    const saved = Identity().GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    const now = Now();
    const oldRequiresPairingApproval = Boolean(saved.requiresPairingApproval);
    const oldPairingApprovedAt = Number(saved.pairingApprovedAt) || 0;
    const oldPairingApprovedBy = String(saved.pairingApprovedBy || '');
    const oldPairingDeferredAt = Number(saved.pairingDeferredAt) || 0;
    saved.requiresPairingApproval = false;
    saved.pairingApprovedAt = now;
    saved.pairingApprovedBy = SafeField(actor).slice(0, 64);
    saved.pairingDeferredAt = now;
    if (!require('../storage/database').SaveDatabase()) {
        saved.requiresPairingApproval = oldRequiresPairingApproval;
        saved.pairingApprovedAt = oldPairingApprovedAt;
        saved.pairingApprovedBy = oldPairingApprovedBy;
        if (oldPairingDeferredAt) saved.pairingDeferredAt = oldPairingDeferredAt;
        else delete saved.pairingDeferredAt;
        return { ok: false, reason: 'PAIR_PERSIST_FAILED' };
    }
    require('../storage/audit').LogEvent('PAIRING_APPROVED_DEFERRED', `${clientId} -> WAITING_SERVER / ${saved.pairingApprovedBy}`);
    return {
        ok: true,
        pairing: {
            clientId,
            serverId: '',
            oldServerId: '',
            status: 'DEFERRED',
            approvedAt: now,
            approvedBy: saved.pairingApprovedBy
        }
    };
}

function ResolveForApproval(clientId, requestedServerId, actor = 'admin') {
    clientId = NormalizeID(clientId);
    const rawTarget = String(requestedServerId || '').trim();
    const target = NormalizeID(rawTarget);
    if (!clientId) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (rawTarget && !target) return { ok: false, reason: 'PAIR_TARGET_INVALID' };
    if (target) return BindForApproval(clientId, target, actor);

    const saved = Identity().GetSavedClientByID(clientId);
    if (!saved) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    const currentServerId = NormalizeID(saved.serverId);
    if (currentServerId) return BindForApproval(clientId, currentServerId, actor);

    // Compatibility for both the serverless QR flow and an older cached Web
    // Admin bundle that does not send serverId. With one unambiguous target we
    // can commit immediately; otherwise approval succeeds and the Relay binds
    // one empty PC later without exceeding the 1:1 capacity.
    const candidates = EligibleServers(clientId).filter(row => row.eligible);
    if (candidates.length === 1) return BindForApproval(clientId, candidates[0].id, actor);
    return DeferForApproval(clientId, actor);
}

function CleanupClaims() {
    const now = Now();
    for (const [key, value] of state.production.pairingClaims)
        if (!value || Number(value.expiresAt) <= now) state.production.pairingClaims.delete(key);
}

module.exports = { EligibleServers, Validate, BindForApproval, DeferForApproval, ResolveForApproval, CompleteDeferredBinding, CleanupClaims };
