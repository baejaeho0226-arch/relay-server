'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-installation-test-'));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_ENGINE = 'json';
process.env.ADMIN_SECRET = 'installation-test-admin-only';

function connection() {
    const writes = [];
    const socket = { destroyed: false, remoteAddress: '127.0.0.1',
        write(value) { writes.push(String(value).trim()); return true; },
        destroy() { this.destroyed = true; } };
    const client = { type: 'client', connected: false, socket, writes };
    socket.__relayConnection = client;
    return client;
}

try {
    const state = require('../core/state');
    const handler = require('../relay/clientHandler');
    const policy = require('../services/clientInstallation');
    const auth = require('../services/deviceAuth');
    const biometric = require('../services/clientBiometric');
    const database = require('../storage/database');
    const licenses = require('../license/licenseManager');
    require('../core/utils').EnsureDirs();

    const base = '1122334455667788';
    const key = `ANDROID2-${base}-${'A'.repeat(16)}`;
    const otherInstall = `ANDROID2-${base}-${'B'.repeat(16)}`;
    const token = 'C'.repeat(32);
    const connect = deviceKey => {
        const c = connection();
        handler.HandleClientConnect(c, deviceKey, 2, '2.9.5');
        return c;
    };
    const authenticate = c => {
        handler.HandleClientLine(c, `CLIENT_INSTALLATION|${token}`);
        handler.HandleClientLine(c, 'CAPABILITIES|DEVICE_HMAC,QR_DEVICE_APPROVAL,BIOMETRIC_AUTH');
        if (c.writes.some(line => line.startsWith('DEVICE_SECRET|')))
            handler.HandleClientLine(c, 'DEVICE_SECRET_ACK');
        const parts = c.writes.filter(line => line.startsWith('AUTH_CHALLENGE|')).pop().split('|');
        const secret = state.deviceSecrets.get(`CLIENT:${c.clientId}`);
        const hmac = crypto.createHmac('sha256', secret)
            .update(`CLIENT|${c.clientId}|${parts[1]}|${parts[2]}|${parts[3]}`).digest('hex').toUpperCase();
        handler.HandleClientLine(c, `DEVICE_AUTH|${parts[1]}|${hmac}`);
        assert.strictEqual(c.deviceAuthVerified, true);
        return secret;
    };

    // A first install can enroll, complete HMAC and biometric, and only then
    // commit its installation binding. Socket messages exercise the real route.
    const first = connect(key);
    assert.strictEqual(first.connected, true);
    const saved = state.clientIdentities.get(key);
    const clientId = first.clientId;
    const secret = authenticate(first);
    assert.ok(!saved.installationToken);
    const license = licenses.CreateLicense(30, 'installation test', [], 'QR');
    state.licenses.get(license.key).boundClient = clientId;
    assert.strictEqual(licenses.AuthorizeClientByQr(first, license.key, 'TEST'), true);
    const challenge = state.clientBiometricChallenges.get(clientId);
    const proof = biometric.Proof(secret, challenge.mode, clientId,
        challenge.nonce, challenge.accessType);
    assert.strictEqual(biometric.HandleProof(first,
        ['BIOMETRIC_PROOF', challenge.mode, challenge.nonce, proof]), true);
    assert.strictEqual(saved.installationToken, token);
    assert.ok(saved.installationAuthorizedAt > 0);
    const persisted = JSON.parse(fs.readFileSync(require('../config/config').DB_FILE, 'utf8'));
    assert.strictEqual(persisted.clients[key].installationToken, token);

    // Reinstall must not create an identity/enrollment or displace the still
    // valid original socket, even when new-device admin enrollment is enabled.
    state.enrollmentPolicy.enabled = true;
    const enrollmentCount = state.deviceEnrollments.size;
    const denied = connect(otherInstall);
    assert.strictEqual(denied.reinstallBlocked, true);
    assert.ok(denied.writes.includes('ERROR|REINSTALL_NOT_ALLOWED'));
    assert.strictEqual(state.clientIdentities.has(otherInstall), false);
    assert.strictEqual(state.deviceEnrollments.size, enrollmentCount);
    assert.strictEqual(state.clients.get(clientId), first);
    assert.strictEqual(first.socket.destroyed, false);
    handler.HandleClientLine(denied, `CONNECT|2|2.9.5|${key}`);
    assert.strictEqual(denied.connected, false);
    state.enrollmentPolicy.enabled = false;

    // Ordinary restart/in-place update retains client ID and secret.
    const update = connect(key);
    assert.strictEqual(update.clientId, clientId);
    assert.strictEqual(authenticate(update), secret);
    assert.ok(!update.writes.some(line => line.startsWith('DEVICE_SECRET|')));

    // Backup may restore the old device key/secret; a different no-backup
    // token still blocks authentication and never overwrites the binding.
    const restored = connect(key);
    handler.HandleClientLine(restored, `CLIENT_INSTALLATION|${'D'.repeat(32)}`);
    assert.strictEqual(restored.reinstallBlocked, true);
    handler.HandleClientLine(restored, 'CAPABILITIES|DEVICE_HMAC');
    assert.strictEqual(restored.deviceAuthVerified, false);
    assert.strictEqual(saved.installationToken, token);
    assert.strictEqual(state.deviceSecrets.get(`CLIENT:${clientId}`), secret);

    // A client with lost credentials must not silently recover an already
    // authorized identity by asking the server for a replacement secret.
    const lostSecret = connect(key);
    handler.HandleClientLine(lostSecret, `CLIENT_INSTALLATION|${token}`);
    handler.HandleClientLine(lostSecret, 'CAPABILITIES|DEVICE_HMAC');
    const authLine = lostSecret.writes.filter(line => line.startsWith('AUTH_CHALLENGE|')).pop().split('|');
    const result = auth.HandleDeviceAuthError('CLIENT', clientId,
        ['DEVICE_AUTH_ERROR', authLine[1], 'NO_SECRET']);
    assert.strictEqual(result.reason, 'REINSTALL_NOT_ALLOWED');
    assert.strictEqual(state.deviceSecrets.get(`CLIENT:${clientId}`), secret);
    assert.ok(!lostSecret.writes.some(line => line.startsWith('DEVICE_SECRET|')));

    // Another physical device remains independent. Unapproved reinstallations
    // are also unaffected by the completed-authentication policy.
    assert.strictEqual(connect(`ANDROID2-${'E'.repeat(16)}-${'F'.repeat(16)}`).connected, true);
    assert.strictEqual(connect(`ANDROID2-${'1'.repeat(16)}-${'2'.repeat(16)}`).connected, true);
    assert.strictEqual(connect(`ANDROID2-${'1'.repeat(16)}-${'3'.repeat(16)}`).connected, true);

    // Legacy FIX5 records are backfilled and survive server reload and a
    // biometric-profile reset. Normal history cleanup cannot erase this flag.
    const legacyKey = `ANDROID2-${'4'.repeat(16)}-${'5'.repeat(16)}`;
    state.clientIdentities.set(legacyKey, { id: '1234123412341234', serverId: '' });
    state.clientBiometricProfiles.set('1234123412341234', { verifiedAt: 12345 });
    policy.Backfill();
    const snapshot = JSON.parse(JSON.stringify(database.BuildDatabaseObject()));
    database.ImportDatabaseObject(snapshot);
    const imported = state.clientIdentities.get(key);
    assert.strictEqual(imported.installationToken, token);
    assert.strictEqual(imported.installationAuthorizedAt, saved.installationAuthorizedAt);
    state.clientBiometricProfiles.clear();
    state.qrAuthRequests.clear();
    assert.strictEqual(policy.CheckDeviceKey(connection(), otherInstall), false);
    assert.strictEqual(policy.CheckDeviceKey(connection(),
        `ANDROID2-${'4'.repeat(16)}-${'6'.repeat(16)}`), false);

    console.log('CLIENT INSTALLATION POLICY PASS');
    console.log('- First authentication and in-place update: PASS');
    console.log('- Reinstall/backup restore/lost-secret rejection: PASS');
    console.log('- Existing socket, IDs and secrets retained: PASS');
    console.log('- Independent devices and unapproved installs: PASS');
    console.log('- Persistence, legacy backfill and profile/history reset: PASS');
} catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
} finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
}
