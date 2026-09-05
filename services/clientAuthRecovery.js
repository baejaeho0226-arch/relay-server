'use strict';
// Recover a transport credential only after a fresh proof from the retained
// no-backup installation token. A device ID/IP/claimed token is not sufficient.
const crypto = require('crypto');
const state = require('../core/state');
const { Now, SendLine } = require('../core/utils');
const identity = require('../identity/identityManager');
const installation = require('./clientInstallation');
const TTL = 30000;
function Token(c) {
    if (!c || identity.GetOnlineClient(c.clientId) !== c || !installation.Ready(c)) return '';
    const saved = identity.GetSavedClientByID(c.clientId);
    if (!installation.WasAuthorized(saved)) return '';
    const token = String(saved.installationToken || '');
    return /^[0-9A-F]{32}$/.test(token) && token === c.installationToken ? token : '';
}
function Proof(token, id, challenge) {
    return crypto.createHmac('sha256', token).update(`RECOVER|CLIENT|${id}|${challenge.id}|${challenge.nonce}|${challenge.issuedAt}`, 'utf8').digest('hex').toUpperCase();
}
function Begin(c) {
    if (!Token(c) || !require('./deviceControl').Capabilities('CLIENT', c.clientId).includes('INSTALLATION_RECOVERY'))
        return { ok: false, reason: 'RECOVERY_ADMIN_REQUIRED' };
    if (c.authRecovery && c.authRecovery.expiresAt > Now()) return { ok: true, pending: true };
    if (c.authRecoveryAttempted) return { ok: false, reason: 'RECOVERY_ALREADY_ATTEMPTED' };
    c.authRecoveryAttempted = true;
    const issuedAt = Now();
    const challenge = { id: crypto.randomBytes(12).toString('hex').toUpperCase(), nonce: crypto.randomBytes(24).toString('hex').toUpperCase(), issuedAt, expiresAt: issuedAt + TTL };
    c.authRecovery = challenge;
    SendLine(c.socket, `DEVICE_RECOVERY_CHALLENGE|${challenge.id}|${challenge.nonce}|${challenge.issuedAt}`);
    require('../storage/audit').LogEvent('DEVICE_AUTH_RECOVERY_STARTED', `CLIENT ${c.clientId}`);
    return { ok: true, pending: true };
}
function Handle(c, parts) {
    const ch = c.authRecovery;
    c.authRecovery = null; // Single use, including rejected proofs.
    const token = Token(c);
    const hex = String(parts[2] || '');
    const valid = !!ch && ch.id === parts[1] && ch.expiresAt > Now() && !!token && /^[0-9a-f]{64}$/i.test(hex) &&
        crypto.timingSafeEqual(Buffer.from(Proof(token, c.clientId, ch), 'hex'), Buffer.from(hex, 'hex'));
    if (!valid) {
        require('../storage/audit').LogEvent('DEVICE_AUTH_RECOVERY_DENIED', `CLIENT ${c.clientId}`);
        SendLine(c.socket, `DEVICE_AUTH_ERROR|${parts[1] || ''}|RECOVERY_DENIED`);
        return { ok: false, reason: 'RECOVERY_DENIED' };
    }
    const key = `CLIENT:${c.clientId}`;
    const secret = state.deviceSecrets.get(key);
    c.deviceAuthVerified = false;
    // Sending a credential does not authorize QR, biometric or business access.
    // The normal secret ACK + HMAC + QR-resume + biometric flow still follows.
    if (secret) SendLine(c.socket, `DEVICE_SECRET|${secret}`);
    else {
        const result = require('./deviceAuth').SendEnrollmentSecret('CLIENT', c.clientId, true);
        if (!result.ok) return result;
    }
    require('../storage/audit').LogEvent('DEVICE_AUTH_RECOVERED', `CLIENT ${c.clientId} / INSTALLATION_PROOF`);
    return { ok: true };
}
module.exports = { Begin, Handle, Token, Proof };
