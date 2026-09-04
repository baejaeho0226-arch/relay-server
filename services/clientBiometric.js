'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { NormalizeID, Now, SendLine } = require('../core/utils');
const { NormalizeAccessType } = require('./accessType');

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

function HmacHex(key, data) {
    return crypto.createHmac('sha256', String(key || ''))
        .update(String(data || ''), 'utf8').digest('hex').toUpperCase();
}

function EqualHex(a, b) {
    try {
        const aa = Buffer.from(String(a || ''), 'hex');
        const bb = Buffer.from(String(b || ''), 'hex');
        return aa.length === 32 && aa.length === bb.length &&
            crypto.timingSafeEqual(aa, bb);
    } catch (_) { return false; }
}

function Proof(secret, mode, clientId, nonce, accessType) {
    return HmacHex(secret, `BIOMETRIC|${String(mode || '').toUpperCase()}|${NormalizeID(clientId)}|${String(nonce || '').toUpperCase()}|${NormalizeAccessType(accessType)}`);
}

function SendChallenge(connection, challenge) {
    SendLine(connection.socket, `BIOMETRIC_CHALLENGE|${challenge.mode}|${challenge.nonce}|${challenge.accessType}|${challenge.expiresAt}`);
}

function Begin(connection, requestedType = '') {
    if (!connection || !connection.connected || !connection.clientId ||
        !connection.licenseAuthorized) return { ok: false, reason: 'LICENSE_REQUIRED' };
    const clientId = NormalizeID(connection.clientId);
    if (!clientId) return { ok: false, reason: 'CLIENT_NOT_CONNECTED' };
    if (!require('./deviceAuth').Verified('CLIENT', clientId)) {
        require('./deviceAuth').IssueChallenge('CLIENT', clientId);
        return { ok: false, reason: 'DEVICE_AUTH_REQUIRED' };
    }
    const capabilities = require('./deviceControl').Capabilities('CLIENT', clientId);
    if (!capabilities.includes('BIOMETRIC_AUTH')) {
        SendLine(connection.socket, 'BIOMETRIC_ERROR|CAPABILITY_REQUIRED');
        return { ok: false, reason: 'BIOMETRIC_CAPABILITY_REQUIRED' };
    }
    const profile = state.clientBiometricProfiles.get(clientId) || null;
    const accessType = NormalizeAccessType(requestedType ||
        (profile && profile.accessType) || connection.accessType);
    const now = Now();
    const challenge = {
        clientId,
        mode: profile ? 'VERIFY' : 'ENROLL',
        nonce: crypto.randomBytes(24).toString('hex').toUpperCase(),
        accessType,
        issuedAt: now,
        expiresAt: now + CHALLENGE_TTL_MS
    };
    connection.biometricVerified = false;
    connection.accessType = accessType;
    state.clientBiometricChallenges.set(clientId, challenge);
    SendChallenge(connection, challenge);
    return { ok: true, mode: challenge.mode, accessType };
}

function NotifyAuthorized(connection, accessType) {
    const active = require('../license/licenseManager')
        .GetUsableLicenseForConnection(connection);
    if (!active) {
        connection.biometricVerified = false;
        SendLine(connection.socket, 'BIOMETRIC_ERROR|LICENSE_REQUIRED');
        return false;
    }
    connection.biometricVerified = true;
    connection.accessType = NormalizeAccessType(accessType);
    state.clientBiometricChallenges.delete(connection.clientId);
    const groupGuid = require('./userDashboard').GroupGuid(connection.accessType);
    SendLine(connection.socket, `BIOMETRIC_OK|${connection.accessType}|${groupGuid}`);
    require('../relay/notifications').NotifyServerAuthorized(connection.clientId,
        connection.serverId, active.license.expiresAt, 'QR_BIOMETRIC');
    require('./buildGate').TryDispatchClient(connection.clientId);
    return true;
}

function HandleProof(connection, parts) {
    if (!Array.isArray(parts) || parts.length !== 4) {
        if (connection && connection.socket)
            SendLine(connection.socket, 'BIOMETRIC_ERROR|FORMAT_INVALID');
        return false;
    }
    if (!connection || !connection.connected || !connection.clientId ||
        !connection.licenseAuthorized) return false;
    const clientId = NormalizeID(connection.clientId);
    if (!require('./deviceAuth').Verified('CLIENT', clientId)) {
        SendLine(connection.socket, 'BIOMETRIC_ERROR|DEVICE_AUTH_REQUIRED');
        return false;
    }
    const mode = String(parts[1] || '').toUpperCase();
    const nonce = String(parts[2] || '').toUpperCase();
    const supplied = String(parts[3] || '').toUpperCase();
    const challenge = state.clientBiometricChallenges.get(clientId);
    if (!challenge || challenge.mode !== mode || challenge.nonce !== nonce) {
        SendLine(connection.socket, 'BIOMETRIC_ERROR|CHALLENGE_INVALID');
        Begin(connection, connection.accessType);
        return false;
    }
    if (challenge.expiresAt <= Now()) {
        state.clientBiometricChallenges.delete(clientId);
        SendLine(connection.socket, 'BIOMETRIC_ERROR|CHALLENGE_EXPIRED');
        Begin(connection, challenge.accessType);
        return false;
    }
    const secret = state.deviceSecrets.get(`CLIENT:${clientId}`) || '';
    const expected = Proof(secret, mode, clientId, nonce, challenge.accessType);
    if (!secret || !/^[0-9A-F]{64}$/.test(supplied) ||
        !EqualHex(expected, supplied)) {
        SendLine(connection.socket, 'BIOMETRIC_ERROR|PROOF_INVALID');
        require('../storage/audit').LogEvent('CLIENT_BIOMETRIC_REJECTED', clientId);
        Begin(connection, challenge.accessType);
        return false;
    }
    const now = Now();
    const existing = state.clientBiometricProfiles.get(clientId);
    state.clientBiometricProfiles.set(clientId, {
        accessType: challenge.accessType,
        enrolledAt: existing ? Number(existing.enrolledAt) || now : now,
        verifiedAt: now,
        verificationCount: Math.max(0, Number(existing && existing.verificationCount) || 0) + 1,
        resetAt: Math.max(0, Number(existing && existing.resetAt) || 0),
        resetBy: String(existing && existing.resetBy || '')
    });
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent(existing ?
        'CLIENT_BIOMETRIC_VERIFIED' : 'CLIENT_BIOMETRIC_ENROLLED',
        `${clientId} / ${challenge.accessType}`);
    return NotifyAuthorized(connection, challenge.accessType);
}

function SetAccessType(clientId, accessType) {
    clientId = NormalizeID(clientId);
    const normalized = NormalizeAccessType(accessType);
    const profile = state.clientBiometricProfiles.get(clientId);
    if (profile) profile.accessType = normalized;
    const connection = state.clients.get(clientId);
    if (connection) connection.accessType = normalized;
    return normalized;
}

function PublicStatus(clientId) {
    clientId = NormalizeID(clientId);
    const profile = clientId ? state.clientBiometricProfiles.get(clientId) : null;
    const live = clientId ? state.clients.get(clientId) : null;
    return {
        enrolled: !!profile,
        verified: !!(live && live.biometricVerified),
        accessType: NormalizeAccessType(profile && profile.accessType),
        enrolledAt: Number(profile && profile.enrolledAt) || 0,
        verifiedAt: Number(profile && profile.verifiedAt) || 0,
        verificationCount: Math.max(0, Number(profile && profile.verificationCount) || 0),
        resetAt: Math.max(0, Number(profile && profile.resetAt) || 0),
        resetBy: String(profile && profile.resetBy || '')
    };
}

function Reset(clientId, actor = 'WEB_ADMIN') {
    clientId = NormalizeID(clientId);
    if (!clientId) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    state.clientBiometricProfiles.delete(clientId);
    state.clientBiometricChallenges.delete(clientId);
    const connection = state.clients.get(clientId);
    if (connection && connection.connected && connection.socket &&
        !connection.socket.destroyed) {
        connection.biometricVerified = false;
        SendLine(connection.socket, 'BIOMETRIC_RESET|ADMIN');
        require('../relay/notifications').NotifyServerUnauthorized(clientId,
            'BIOMETRIC_RESET');
        Begin(connection, connection.accessType);
    }
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('CLIENT_BIOMETRIC_RESET',
        `${clientId} / ${String(actor || 'WEB_ADMIN').slice(0, 64)}`);
    return { ok: true, status: PublicStatus(clientId) };
}

module.exports = {
    CHALLENGE_TTL_MS,
    Proof,
    Begin,
    HandleProof,
    SetAccessType,
    PublicStatus,
    Reset
};
