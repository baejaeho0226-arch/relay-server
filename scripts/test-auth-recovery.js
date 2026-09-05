'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-auth-recovery-'));
process.env.DATA_DIR = dir;
process.env.STORAGE_ENGINE = process.env.STORAGE_ENGINE || 'json';
process.env.ADMIN_SECRET = 'auth-recovery-test-admin';
const state = require('../core/state');
const handler = require('../relay/clientHandler');
const auth = require('../services/deviceAuth');
const recovery = require('../services/clientAuthRecovery');
const installation = require('../services/clientInstallation');
const biometric = require('../services/clientBiometric');
const rotation = require('../services/deviceSecretRotation');
const database = require('../storage/database');
const key = 'ANDROID2-1122334455667788-AAAAAAAAAAAAAAAA';
const token = 'C'.repeat(32);
const caps = 'DEVICE_HMAC,QR_DEVICE_APPROVAL,BIOMETRIC_AUTH,SECRET_ROTATION,INSTALLATION_RECOVERY';
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex').toUpperCase();
function connect(installationToken = token, capabilities = caps) {
    const writes = [];
    const socket = { destroyed: false, remoteAddress: '100.64.0.18', write(text) { writes.push(String(text).trim()); return true; }, destroy() { this.destroyed = true; } };
    const c = { type: 'client', socket, writes };
    socket.__relayConnection = c;
    handler.HandleClientConnect(c, key, 2, '2.9.7');
    handler.HandleClientLine(c, `CLIENT_INSTALLATION|${installationToken}`);
    handler.HandleClientLine(c, `CAPABILITIES|${capabilities}`);
    return c;
}
function latest(c, prefix) {
    const line = c.writes.filter(line => line.startsWith(prefix + '|')).at(-1);
    assert.ok(line, `Expected ${prefix}: ${c.writes.join('\n')}`);
    return line.split('|');
}
function prove(c, secret) {
    const p = latest(c, 'AUTH_CHALLENGE');
    handler.HandleClientLine(c, `DEVICE_AUTH|${p[1]}|${hmac(secret, `CLIENT|${c.clientId}|${p[1]}|${p[2]}|${p[3]}`)}`);
}
function finishRecovery(c) {
    const p = latest(c, 'DEVICE_RECOVERY_CHALLENGE');
    const line = `DEVICE_RECOVERY_PROOF|${p[1]}|${hmac(token, `RECOVER|CLIENT|${c.clientId}|${p[1]}|${p[2]}|${p[3]}`)}`;
    const n = c.writes.filter(x => x.startsWith('DEVICE_SECRET|')).length;
    handler.HandleClientLine(c, line);
    assert.equal(c.writes.filter(x => x.startsWith('DEVICE_SECRET|')).length, n + 1);
    assert.equal(c.deviceAuthVerified, false);
    const secret = latest(c, 'DEVICE_SECRET')[1];
    handler.HandleClientLine(c, line);
    assert.equal(c.writes.filter(x => x.startsWith('DEVICE_SECRET|')).length, n + 1, 'Recovery proof is single-use');
    handler.HandleClientLine(c, 'DEVICE_SECRET_ACK');
    prove(c, secret);
    assert.equal(c.deviceAuthVerified, true);
    return secret;
}
try {
    require('../core/utils').EnsureDirs();
    const first = connect();
    const secret = latest(first, 'DEVICE_SECRET')[1];
    handler.HandleClientLine(first, 'DEVICE_SECRET_ACK');
    prove(first, secret);
    assert.equal(first.deviceAuthVerified, true);
    const licenses = require('../license/licenseManager');
    const license = licenses.CreateLicense(30, 'retained approval', [], 'QR');
    state.licenses.get(license.key).boundClient = first.clientId;
    assert.equal(licenses.AuthorizeClientByQr(first, license.key, 'TEST'), true);
    const ch = state.clientBiometricChallenges.get(first.clientId);
    assert.equal(biometric.HandleProof(first, ['BIOMETRIC_PROOF', ch.mode, ch.nonce, biometric.Proof(secret, ch.mode, first.clientId, ch.nonce, ch.accessType)]), true);
    const id = first.clientId;
    const profileBefore = JSON.stringify(state.clientBiometricProfiles.get(id));
    const saved = state.clientIdentities.get(key);
    assert.equal(saved.installationToken, token);
    const pcId = '1234567890ABCDEF';
    state.serverIdentities.set('TEST-BOUND-PC', pcId);
    saved.serverId = pcId;
    const fixedBinding = {clientId:id,serverId:pcId,boundAt:Date.now()};
    state.clientBuildBindings.set(id,fixedBinding);
    const snapshot = JSON.parse(JSON.stringify(database.BuildDatabaseObject()));

    const c = connect();
    assert.equal(c.clientId, id);
    const initialChallenge = latest(c, 'AUTH_CHALLENGE')[1];
    // Startup can ask through capabilities, QR-resume and configuration at once.
    handler.HandleClientLine(c, `CAPABILITIES|${caps}`);
    handler.HandleClientLine(c, `QR_AUTH_RESUME|${id}`);
    assert.equal(c.writes.filter(x => x.startsWith('AUTH_CHALLENGE|')).length, 1);
    assert.equal(latest(c, 'AUTH_CHALLENGE')[1], initialChallenge);
    prove(c, 'wrong-but-present-local-key');
    assert.equal(c.deviceAuthVerified, false);
    assert.ok(c.authRecovery);
    assert.equal(c.reinstallBlocked, undefined);
    assert.equal(finishRecovery(c), secret);
    assert.equal(state.clientIdentities.get(key), saved);
    assert.equal(saved.serverId,pcId);
    assert.deepEqual(state.clientBuildBindings.get(id),fixedBinding);
    assert.equal(JSON.stringify(state.clientBiometricProfiles.get(id)), profileBefore);
    assert.equal(state.licenses.get(license.key).boundClient, id);
    const qrCount = state.qrAuthRequests.size;
    handler.HandleClientLine(c, `QR_AUTH_RESUME|${id}`);
    assert.equal(state.qrAuthRequests.size, qrCount, 'Existing QR approval must resume');
    assert.ok(c.writes.some(x => x.startsWith('QR_AUTH_OK|')));
    assert.ok(c.writes.some(x => x.startsWith('BIOMETRIC_CHALLENGE|')));
    assert.ok(!c.writes.some(x => x.startsWith('QR_AUTH_CHALLENGE|')));

    // Secret loss in the same installation also requires proof, not a reset.
    const missing = connect();
    const m = latest(missing, 'AUTH_CHALLENGE');
    handler.HandleClientLine(missing, `DEVICE_AUTH_ERROR|${m[1]}|NO_SECRET`);
    assert.ok(missing.authRecovery);
    assert.equal(finishRecovery(missing), secret);

    // Failed/expired proofs cannot disclose a credential or mark the client verified.
    for (const expired of [false, true]) {
        const forged = connect();
        prove(forged, 'wrong-key');
        const r = { ...forged.authRecovery };
        if (expired) forged.authRecovery.expiresAt = 0;
        const proof = expired ? recovery.Proof(token, id, r) : '0'.repeat(64);
        handler.HandleClientLine(forged, `DEVICE_RECOVERY_PROOF|${r.id}|${proof}`);
        assert.ok(!forged.writes.some(x => x.startsWith('DEVICE_SECRET|')));
        assert.equal(forged.deviceAuthVerified, false);
    }

    // A legacy install without a previously trusted token needs administrator
    // recovery, which keeps the same identity, license, profile and PC binding.
    const legacy = connect(token, 'DEVICE_HMAC,QR_DEVICE_APPROVAL,BIOMETRIC_AUTH');
    const legacyChallenge = latest(legacy, 'AUTH_CHALLENGE');
    handler.HandleClientLine(legacy, `DEVICE_AUTH_ERROR|${legacyChallenge[1]}|NO_SECRET`);
    assert.equal(legacy.reinstallBlocked, undefined);
    assert.ok(legacy.writes.some(x => x.endsWith('|RECOVERY_ADMIN_REQUIRED')));
    assert.equal(auth.Reset('CLIENT', id).ok, true);
    const resetSecret = latest(legacy, 'DEVICE_SECRET')[1];
    handler.HandleClientLine(legacy, 'DEVICE_SECRET_ACK');
    prove(legacy, resetSecret);
    assert.equal(legacy.deviceAuthVerified, true);
    assert.equal(state.clientIdentities.get(key), saved);
    assert.equal(saved.serverId,pcId);
    assert.deepEqual(state.clientBuildBindings.get(id),fixedBinding);
    assert.equal(JSON.stringify(state.clientBiometricProfiles.get(id)), profileBefore);
    assert.equal(state.licenses.get(license.key).boundClient, id);

    // A lost rotation commit ACK is settled by a fresh HMAC under the new key.
    const rotating = connect();
    prove(rotating, resetSecret);
    assert.equal(rotation.Start('CLIENT', id).ok, true);
    const r = rotation.Current('CLIENT', id);
    const next = rotation.Derive(resetSecret, 'CLIENT', id, r.rotationId, r.nonce, r.expiresAt);
    assert.equal(rotation.Start('CLIENT', id).reason, 'ROTATION_PENDING');
    assert.equal(rotation.HandleAck('CLIENT', id, ['ACK', r.rotationId, 'READY', rotation.Proof(next, 'CLIENT', id, r.rotationId, 'READY')]).ok, true);
    const afterRotation = connect();
    prove(afterRotation, next);
    assert.equal(afterRotation.deviceAuthVerified, true);
    assert.equal(state.deviceSecrets.get(`CLIENT:${id}`), next);
    assert.equal(rotation.Current('CLIENT', id).status, 'COMPLETED');
    assert.equal(rotation.HandleAck('CLIENT', id, ['ACK', r.rotationId, 'COMMITTED', rotation.Proof(next, 'CLIENT', id, r.rotationId, 'COMMITTED')]).ok, true);
    assert.equal(state.deviceSecrets.get(`CLIENT:${id}`), next, 'Duplicate rotation ACK must not derive a second key');

    // Late frames from a replaced connection cannot mutate the current one.
    const before = afterRotation.writes.length;
    handler.HandleClientLine(rotating, 'DEVICE_SECRET_ACK');
    assert.equal(afterRotation.writes.length, before);
    assert.equal(afterRotation.deviceAuthVerified, true);

    // Loss of the server key must not silently enroll an approved client.
    state.deviceSecrets.delete(`CLIENT:${id}`);
    const serverKeyLost = connect();
    assert.ok(serverKeyLost.authRecovery);
    assert.ok(!serverKeyLost.writes.some(x => x.startsWith('DEVICE_SECRET|')));
    const recoveredServerSecret = finishRecovery(serverKeyLost);
    assert.ok(recoveredServerSecret);
    assert.equal(state.clientIdentities.get(key), saved);
    assert.equal(saved.serverId, pcId);
    assert.equal(state.licenses.get(license.key).boundClient, id);
    // Return the fixture to a known live connection for the save-failure case.
    state.deviceSecrets.set(`CLIENT:${id}`, next);
    state.clients.set(id, afterRotation);
    afterRotation.superseded = false;
    afterRotation.socket.destroyed = false;

    // A failed durable save must not send a new secret or replace the old one.
    const save = database.SaveDatabase;
    database.SaveDatabase = () => false;
    try {
        const count = afterRotation.writes.filter(x => x.startsWith('DEVICE_SECRET|')).length;
        assert.equal(auth.Reset('CLIENT', id).reason, 'STORAGE_SAVE_FAILED');
        assert.equal(afterRotation.writes.filter(x => x.startsWith('DEVICE_SECRET|')).length, count);
        assert.equal(state.deviceSecrets.get(`CLIENT:${id}`), next);
    } finally { database.SaveDatabase = save; }

    state.clients.clear();
    database.ImportDatabaseObject(snapshot);
    const reinstall = connect('D'.repeat(32));
    assert.equal(reinstall.reinstallBlocked, true);
    assert.ok(!reinstall.writes.some(x => x.startsWith('DEVICE_SECRET|') || x.startsWith('DEVICE_RECOVERY_CHALLENGE|')));
    assert.equal(state.deviceSecrets.get(`CLIENT:${id}`), secret);
    assert.equal(installation.List().length, 1);
    assert.equal(auth.Reset('CLIENT', id).ok, false, 'Manual key repair cannot release a reinstall block');
    console.log('AUTH RECOVERY PASS: same-install proof, retained QR/identity/profile/PC binding, no-secret recovery, forged/replayed/expired denial, legacy admin recovery, coalesced challenges, rotation ACK loss, stale socket, durable save failure, reinstall block');
} finally {
    if (process.env.STORAGE_ENGINE === 'sqlite') require('../storage/sqliteDatabase').Close();
    fs.rmSync(dir, { recursive: true, force: true });
}
