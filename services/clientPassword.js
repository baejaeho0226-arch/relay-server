'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { NormalizeID, Now, SendLine } = require('../core/utils');

const PASSWORD_ITERATIONS = 4096;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

function NormalizeAccessType(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return ['TYPE1', 'TYPE2', 'TYPE3'].includes(normalized) ? normalized : 'TYPE1';
}

function HmacHex(key, data) {
    return crypto.createHmac('sha256', String(key || '')).update(String(data || ''), 'utf8').digest('hex').toUpperCase();
}

function EqualHex(a, b) {
    try {
        const aa = Buffer.from(String(a || ''), 'hex');
        const bb = Buffer.from(String(b || ''), 'hex');
        return aa.length === 32 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
    } catch (_) { return false; }
}

function Proof(verifier, mode, clientId, nonce, accessType) {
    return HmacHex(verifier, `${mode}|${clientId}|${nonce}|${NormalizeAccessType(accessType)}`);
}

function DeriveVerifier(password, salt, iterations = PASSWORD_ITERATIONS) {
    const rounds = Math.max(1, Math.min(20000, Number(iterations) || PASSWORD_ITERATIONS));
    let value = HmacHex(salt, password);
    for (let i = 1; i < rounds; i++) value = HmacHex(salt, value);
    return value;
}

function SendChallenge(connection, challenge) {
    SendLine(connection.socket, `PASSWORD_CHALLENGE|${challenge.mode}|${challenge.nonce}|${challenge.salt}|${challenge.iterations}|${challenge.accessType}`);
}

function Begin(connection, requestedType = '') {
    if (!connection || !connection.connected || !connection.clientId || !connection.licenseAuthorized) return { ok: false, reason: 'LICENSE_REQUIRED' };
    const clientId = NormalizeID(connection.clientId);
    if (!clientId) return { ok: false, reason: 'CLIENT_NOT_CONNECTED' };
    const profile = state.clientPasswordProfiles.get(clientId) || null;
    const now = Now();
    if (profile && Number(profile.lockUntil || 0) > now) {
        SendLine(connection.socket, `PASSWORD_LOCKED|${profile.lockUntil}`);
        return { ok: false, reason: 'PASSWORD_LOCKED', lockUntil: profile.lockUntil };
    }
    const accessType = NormalizeAccessType(requestedType || (profile && profile.accessType) || connection.accessType);
    const challenge = {
        clientId,
        mode: profile ? 'LOGIN' : 'SETUP',
        nonce: crypto.randomBytes(24).toString('hex').toUpperCase(),
        salt: profile ? profile.salt : crypto.randomBytes(16).toString('hex').toUpperCase(),
        iterations: profile ? profile.iterations : PASSWORD_ITERATIONS,
        accessType,
        issuedAt: now,
        expiresAt: now + CHALLENGE_TTL_MS
    };
    connection.passwordVerified = false;
    connection.accessType = accessType;
    state.clientPasswordChallenges.set(clientId, challenge);
    SendChallenge(connection, challenge);
    return { ok: true, mode: challenge.mode, accessType };
}

function CurrentChallenge(connection, mode, nonce) {
    if (!connection || !connection.connected || !connection.clientId || !connection.licenseAuthorized) return { ok: false, reason: 'LICENSE_REQUIRED' };
    const clientId = NormalizeID(connection.clientId);
    if (!require('./deviceAuth').Verified('CLIENT', clientId)) return { ok: false, reason: 'DEVICE_AUTH_REQUIRED' };
    const challenge = state.clientPasswordChallenges.get(clientId);
    if (!challenge || challenge.mode !== mode || challenge.nonce !== String(nonce || '').toUpperCase()) return { ok: false, reason: 'CHALLENGE_INVALID' };
    if (challenge.expiresAt <= Now()) {
        state.clientPasswordChallenges.delete(clientId);
        return { ok: false, reason: 'CHALLENGE_EXPIRED' };
    }
    return { ok: true, clientId, challenge };
}

function NotifyAuthorized(connection, accessType) {
    const active = require('../license/licenseManager').GetUsableLicenseForConnection(connection);
    if (!active) {
        connection.passwordVerified = false;
        SendLine(connection.socket, 'PASSWORD_ERROR|LICENSE_REQUIRED');
        return false;
    }
    connection.passwordVerified = true;
    connection.accessType = NormalizeAccessType(accessType);
    state.clientPasswordChallenges.delete(connection.clientId);
    SendLine(connection.socket, `PASSWORD_OK|${connection.accessType}`);
    require('../relay/notifications').NotifyServerAuthorized(connection.clientId, connection.serverId, active.license.expiresAt, 'QR_PASSWORD');
    require('./buildGate').TryDispatchClient(connection.clientId);
    return true;
}

function RegisterFailure(connection, profile, reason = 'INVALID_PASSWORD') {
    profile.failedAttempts = Math.max(0, Number(profile.failedAttempts) || 0) + 1;
    profile.updatedAt = Now();
    if (profile.failedAttempts >= MAX_FAILURES) {
        profile.failedAttempts = 0;
        profile.lockUntil = Now() + LOCK_MS;
        state.clientPasswordChallenges.delete(connection.clientId);
        require('../storage/database').SaveDatabase();
        SendLine(connection.socket, `PASSWORD_LOCKED|${profile.lockUntil}`);
        require('../storage/audit').LogEvent('CLIENT_PASSWORD_LOCKED', connection.clientId);
        return false;
    }
    require('../storage/database').SaveDatabase();
    SendLine(connection.socket, `PASSWORD_ERROR|${reason}|${MAX_FAILURES - profile.failedAttempts}`);
    return false;
}

function HandleSetup(connection, parts) {
    const nonce = String(parts[1] || '').toUpperCase();
    const verifier = String(parts[2] || '').toUpperCase();
    const suppliedProof = String(parts[3] || '').toUpperCase();
    const current = CurrentChallenge(connection, 'SETUP', nonce);
    if (!current.ok) {
        SendLine(connection.socket, `PASSWORD_ERROR|${current.reason}`);
        if (current.reason === 'CHALLENGE_EXPIRED') Begin(connection, connection.accessType);
        return false;
    }
    if (!/^[0-9A-F]{64}$/.test(verifier) || !/^[0-9A-F]{64}$/.test(suppliedProof)) {
        SendLine(connection.socket, 'PASSWORD_ERROR|FORMAT_INVALID');
        return false;
    }
    const expected = Proof(verifier, 'SETUP', current.clientId, current.challenge.nonce, current.challenge.accessType);
    if (!EqualHex(expected, suppliedProof)) {
        SendLine(connection.socket, 'PASSWORD_ERROR|PROOF_INVALID');
        return false;
    }
    const now = Now();
    state.clientPasswordProfiles.set(current.clientId, {
        salt: current.challenge.salt,
        iterations: current.challenge.iterations,
        verifier,
        accessType: current.challenge.accessType,
        createdAt: now,
        updatedAt: now,
        failedAttempts: 0,
        lockUntil: 0
    });
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('CLIENT_PASSWORD_CREATED', `${current.clientId} / ${current.challenge.accessType}`);
    return NotifyAuthorized(connection, current.challenge.accessType);
}

function HandleVerify(connection, parts) {
    const nonce = String(parts[1] || '').toUpperCase();
    const suppliedProof = String(parts[2] || '').toUpperCase();
    const current = CurrentChallenge(connection, 'LOGIN', nonce);
    if (!current.ok) {
        SendLine(connection.socket, `PASSWORD_ERROR|${current.reason}`);
        if (current.reason === 'CHALLENGE_EXPIRED') Begin(connection, connection.accessType);
        return false;
    }
    const profile = state.clientPasswordProfiles.get(current.clientId);
    if (!profile) {
        state.clientPasswordChallenges.delete(current.clientId);
        return Begin(connection, current.challenge.accessType).ok;
    }
    if (Number(profile.lockUntil || 0) > Now()) {
        SendLine(connection.socket, `PASSWORD_LOCKED|${profile.lockUntil}`);
        return false;
    }
    const expected = Proof(profile.verifier, 'LOGIN', current.clientId, current.challenge.nonce, current.challenge.accessType);
    if (!/^[0-9A-F]{64}$/.test(suppliedProof) || !EqualHex(expected, suppliedProof)) return RegisterFailure(connection, profile);
    profile.failedAttempts = 0;
    profile.lockUntil = 0;
    profile.accessType = current.challenge.accessType;
    profile.updatedAt = Now();
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('CLIENT_PASSWORD_VERIFIED', `${current.clientId} / ${current.challenge.accessType}`);
    return NotifyAuthorized(connection, current.challenge.accessType);
}

function SetAccessType(clientId, accessType) {
    clientId = NormalizeID(clientId);
    if (!clientId) return false;
    const normalized = NormalizeAccessType(accessType);
    const profile = state.clientPasswordProfiles.get(clientId);
    if (profile) {
        profile.accessType = normalized;
        profile.updatedAt = Now();
    }
    const connection = state.clients.get(clientId);
    if (connection) connection.accessType = normalized;
    return normalized;
}

function PublicStatus(clientId) {
    clientId = NormalizeID(clientId);
    const profile = clientId ? state.clientPasswordProfiles.get(clientId) : null;
    if (!profile) {
        return {
            registered: false,
            masked: '-',
            accessType: 'TYPE1',
            createdAt: 0,
            updatedAt: 0,
            failedAttempts: 0,
            lockUntil: 0,
            locked: false,
            resetAt: 0,
            resetBy: ''
        };
    }
    const lockUntil = Math.max(0, Number(profile.lockUntil) || 0);
    return {
        registered: true,
        masked: '\u2022\u2022\u2022\u2022\u2022\u2022',
        accessType: NormalizeAccessType(profile.accessType),
        createdAt: Number(profile.createdAt) || 0,
        updatedAt: Number(profile.updatedAt) || 0,
        failedAttempts: Math.max(0, Number(profile.failedAttempts) || 0),
        lockUntil,
        locked: lockUntil > Now(),
        resetAt: Number(profile.resetAt) || 0,
        resetBy: String(profile.resetBy || '')
    };
}

function ResetPassword(clientId, password, actor = 'WEB_ADMIN') {
    clientId = NormalizeID(clientId);
    const pin = String(password || '').trim();
    if (!clientId) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    if (!/^\d{4,8}$/.test(pin)) return { ok: false, reason: 'PASSWORD_FORMAT' };

    const previous = state.clientPasswordProfiles.get(clientId) || null;
    const connection = state.clients.get(clientId) || null;
    const bound = require('../license/licenseManager').GetBoundLicenseEntry(clientId);
    const now = Now();
    const salt = crypto.randomBytes(16).toString('hex').toUpperCase();
    const accessType = NormalizeAccessType(
        (previous && previous.accessType) ||
        (connection && connection.accessType) ||
        (bound && bound.license && bound.license.accessType) ||
        'TYPE1'
    );
    state.clientPasswordProfiles.set(clientId, {
        salt,
        iterations: PASSWORD_ITERATIONS,
        verifier: DeriveVerifier(pin, salt, PASSWORD_ITERATIONS),
        accessType,
        createdAt: previous ? (Number(previous.createdAt) || now) : now,
        updatedAt: now,
        failedAttempts: 0,
        lockUntil: 0,
        resetAt: now,
        resetBy: String(actor || 'WEB_ADMIN').replace(/[\r\n|]/g, '').slice(0, 64)
    });
    state.clientPasswordChallenges.delete(clientId);
    require('../storage/database').SaveDatabase();
    require('../storage/audit').LogEvent('CLIENT_PASSWORD_RESET', `${clientId} / ${accessType} / ${String(actor || 'WEB_ADMIN').slice(0, 64)}`);

    if (connection && connection.connected && connection.socket && !connection.socket.destroyed) {
        connection.passwordVerified = false;
        SendLine(connection.socket, 'PASSWORD_RESET|ADMIN');
        require('../relay/notifications').NotifyServerUnauthorized(clientId, 'PASSWORD_RESET');
        Begin(connection, accessType);
    }
    return { ok: true, status: PublicStatus(clientId) };
}

module.exports = {
    PASSWORD_ITERATIONS,
    NormalizeAccessType,
    DeriveVerifier,
    Proof,
    Begin,
    HandleSetup,
    HandleVerify,
    SetAccessType,
    PublicStatus,
    ResetPassword
};
