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
        check.saved.serverId = serverId;
        check.saved.pairingApprovedAt = now;
        check.saved.pairingApprovedBy = claim.actor;

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
            delete check.saved.pairingApprovedAt;
            delete check.saved.pairingApprovedBy;
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

function CleanupClaims() {
    const now = Now();
    for (const [key, value] of state.production.pairingClaims)
        if (!value || Number(value.expiresAt) <= now) state.production.pairingClaims.delete(key);
}

module.exports = { EligibleServers, Validate, BindForApproval, CleanupClaims };
