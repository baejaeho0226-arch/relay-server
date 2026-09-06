'use strict';
const crypto = require('crypto');
const state = require('../core/state');
const { SendLine, Now } = require('../core/utils');
const identity = require('../identity/identityManager');
const REQUIRED_MASK = 7; // notifications, phone, declared network/biometric permissions
function Ready(c) {
    return !!c && c.connected && c.deviceAuthVerified === true &&
        identity.GetOnlineClient(c.clientId) === c && c.permissionsGranted === true;
}
function NeedsApproval(c) {
    const saved = c && identity.GetSavedClientByID(c.clientId);
    return !!saved && saved.permissionsReapprovalRequired === true;
}
function Reset(c) {
    c.permissionsGranted = false;
    c.permissionSequence = 0;
    c.permissionMask = -1;
}
function Revoke(c) {
    c.permissionsGranted = false;
    c.licenseAuthorized = false;
    c.licenseKey = '';
    c.licenseExpiresAt = 0;
    c.biometricVerified = false;
    const saved = identity.GetSavedClientByID(c.clientId);
    if (saved) saved.permissionsReapprovalRequired = true;
    state.clientBiometricChallenges.delete(c.clientId);
    state.clientBiometricProfiles.delete(c.clientId);
    for (const q of state.qrAuthRequests.values()) {
        if (q.clientId === c.clientId && ['PENDING', 'APPROVED'].includes(q.status)) {
            q.status = 'SUPERSEDED'; q.reason = 'PERMISSIONS_REQUIRED'; q.rejectedAt = Now();
        }
    }
    require('./buildGate').RevokeForClient(c.clientId, 'PERMISSIONS_REQUIRED');
    for (const [key, item] of state.pendingRequests) {
        if (item.clientId === c.clientId) state.pendingRequests.delete(key);
    }
    for (const [key, item] of state.offlineQueue) {
        if (item.clientId === c.clientId) state.offlineQueue.delete(key);
    }
    require('../relay/notifications').NotifyServerUnauthorized(c.clientId, 'PERMISSIONS_REQUIRED');
    // Installation proof, fixed pairing and conversation history survive revocation.
    return require('../storage/database').SaveDatabase();
}
function Handle(c, parts) {
    if (!c || !c.deviceAuthVerified || identity.GetOnlineClient(c.clientId) !== c ||
        !require('./clientInstallation').Ready(c)) return false;
    if (parts.length !== 4 || !/^[1-9][0-9]{0,8}$/.test(parts[1]) || !/^[0-7]$/.test(parts[2]) ||
        !/^[0-9a-f]{64}$/i.test(parts[3]) || !c.deviceAuthChallengeId) return false;
    const sequence = Number(parts[1]), mask = Number(parts[2]);
    const secret = state.deviceSecrets.get(`CLIENT:${c.clientId}`);
    if (!secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(
        `PERMISSIONS|${c.clientId}|${c.deviceAuthChallengeId}|${sequence}|${mask}`).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(parts[3], 'hex'))) return false;
    if (sequence < (c.permissionSequence || 0) ||
        (sequence === c.permissionSequence && mask !== c.permissionMask)) return false;
    if (sequence > (c.permissionSequence || 0)) {
        if (mask !== REQUIRED_MASK && !Revoke(c)) {
            SendLine(c.socket, 'ERROR|STORAGE_SAVE_FAILED'); return false;
        }
        c.permissionSequence = sequence;
        c.permissionMask = mask;
        c.permissionsGranted = mask === REQUIRED_MASK;
    }
    SendLine(c.socket, `CLIENT_PERMISSIONS_OK|${sequence}|${mask}`);
    return true;
}
module.exports = { REQUIRED_MASK, Ready, NeedsApproval, Reset, Revoke, Handle };
