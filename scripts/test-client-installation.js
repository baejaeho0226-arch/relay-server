'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-installation-test-'));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_ENGINE = process.env.STORAGE_ENGINE || 'json';
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

async function run() {
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
        handler.HandleClientConnect(c, deviceKey, 2, '2.9.6');
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

    const authorizedSnapshot = JSON.parse(JSON.stringify(database.BuildDatabaseObject()));
    // Ordinary restart/update still works before a reinstall is detected.
    const update = connect(key);
    assert.strictEqual(update.clientId, clientId);
    assert.strictEqual(authenticate(update), secret);
    assert.ok(!update.writes.some(line => line.startsWith('DEVICE_SECRET|')));

    // Reinstall locks every connection for this device, revokes all work, and
    // must not enroll or replace the identity even with enrollment enabled.
    const serverId = 'BBAABBAABBAABBAA';
    state.serverIdentities.set('TEST-BLOCK-PC', serverId);
    saved.serverId = serverId;
    const pc = connection();
    Object.assign(pc, { registered: true, serverId, clients: new Set([clientId]), buildClients: new Set([clientId]), buildSessions: new Map(), buildUnlocked: true });
    state.servers.set(serverId, pc);
    state.deviceSecrets.set(`SERVER:${serverId}`, 'X'.repeat(43));
    const sessionId = 'BLS-' + 'A'.repeat(32);
    state.buildSessions.set(sessionId, { sessionId, clientId, serverId, status: 'AUTHORIZED', expiresAt: Date.now() + 60000 });
    state.enrollmentPolicy.enabled = true;
    const enrollmentCount = state.deviceEnrollments.size;
    const denied = connect(otherInstall);
    assert.strictEqual(denied.reinstallBlocked, true);
    assert.ok(denied.writes.includes('ERROR|REINSTALL_NOT_ALLOWED'));
    assert.strictEqual(state.clientIdentities.has(otherInstall), false);
    assert.strictEqual(state.deviceEnrollments.size, enrollmentCount);
    assert.strictEqual(state.clients.get(clientId), update);
    assert.strictEqual(state.buildSessions.get(sessionId).status, 'REVOKED');
    assert.strictEqual(pc.buildUnlocked, false);
    assert.ok(pc.writes.some(x => x.startsWith('BUILD_REVOKE|') && x.includes('|REINSTALL_NOT_ALLOWED|')));
    assert.strictEqual(require('../services/buildGate').Rebind(clientId, serverId, 'TEST').ok, true);
    assert.strictEqual(connect(otherInstall).reinstallBlocked, true, 'binding does not release reinstall lock');
    assert.strictEqual(update.connected, false);
    assert.strictEqual(update.deviceAuthVerified, false);
    assert.strictEqual(update.licenseAuthorized, false);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.strictEqual(update.socket.destroyed, true);
    assert.strictEqual(denied.socket.destroyed, true);
    handler.HandleClientLine(denied, `CONNECT|2|2.9.6|${key}`);
    assert.strictEqual(denied.connected, false);
    state.enrollmentPolicy.enabled = false;

    assert.strictEqual(connect(key).reinstallBlocked, true);
    const registryKey = policy.RegistryKey(key);
    assert.strictEqual(policy.List()[0].key, registryKey);
    // CLIENT removal, binding repair, history cleanup and restart cannot erase it.
    require('../services/deviceRegistry').DeleteClient(clientId);
    require('../services/deviceRegistry').RepairPairing();
    require('../services/historyCleanup').Clean('ALL', 'TEST');
    const blockedSnapshot = process.env.STORAGE_ENGINE === 'sqlite'
        ? require('../storage/sqliteDatabase').LoadSnapshot().data
        : JSON.parse(fs.readFileSync(require('../config/config').DB_FILE, 'utf8'));
    assert.ok(blockedSnapshot.clientInstallations[registryKey].blockedAt);
    assert.ok(!blockedSnapshot.clients[key]);
    database.ImportDatabaseObject(blockedSnapshot);
    assert.strictEqual(connect(otherInstall).reinstallBlocked, true);
    assert.strictEqual(connect(key).reinstallBlocked, true);
    assert.strictEqual(policy.Release(registryKey, 'TEST_ADMIN').ok, true);
    assert.strictEqual(policy.Release(registryKey, 'TEST_ADMIN').ok, false);
    const released = connect(otherInstall);
    assert.strictEqual(released.connected, true);
    authenticate(released);
    assert.strictEqual(released.licenseAuthorized, false);
    assert.strictEqual(released.biometricVerified, false);
    assert.strictEqual(released.buildCompleted, false);
    handler.HandleClientLine(released, `QR_AUTH_RESUME|${released.clientId}`);
    assert.ok(released.writes.some(x => x.startsWith('QR_AUTH_CHALLENGE|')));

    // Restore a known authorized fixture for independent backup/lost-secret cases.
    state.clients.clear();
    database.ImportDatabaseObject(authorizedSnapshot);
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
    state.clients.clear();
    database.ImportDatabaseObject(authorizedSnapshot);
    const lostSecret = connect(key);
    handler.HandleClientLine(lostSecret, `CLIENT_INSTALLATION|${token}`);
    handler.HandleClientLine(lostSecret, 'CAPABILITIES|DEVICE_HMAC');
    const authLine = lostSecret.writes.filter(line => line.startsWith('AUTH_CHALLENGE|')).pop().split('|');
    const result = auth.HandleDeviceAuthError('CLIENT', clientId,
        ['DEVICE_AUTH_ERROR', authLine[1], 'NO_SECRET']);
    assert.strictEqual(result.reason, 'RECOVERY_ADMIN_REQUIRED');
    assert.ok(!lostSecret.reinstallBlocked);
    assert.strictEqual(state.deviceSecrets.get(`CLIENT:${clientId}`), secret);
    assert.ok(!lostSecret.writes.some(line => line.startsWith('DEVICE_SECRET|')));

    // A different installation token still creates a real block.
    handler.HandleClientLine(lostSecret, `CLIENT_INSTALLATION|${'D'.repeat(32)}`);
    assert.strictEqual(lostSecret.reinstallBlocked, true);
    assert.strictEqual(policy.Release(registryKey, 'TEST_ADMIN').ok, true);
    assert.strictEqual(state.clientIdentities.has(key), false);
    assert.strictEqual(state.deviceSecrets.has(`CLIENT:${clientId}`), false);
    assert.strictEqual(state.clientBuildBindings.has(clientId), false);
    assert.ok([...state.licenses.values()].every(x => x.boundClient !== clientId));
    const freshAfterReset = connect(otherInstall);
    assert.strictEqual(freshAfterReset.connected, true);
    assert.strictEqual(freshAfterReset.biometricVerified, false);
    state.clients.clear();
    database.ImportDatabaseObject(authorizedSnapshot);

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
    console.log('- Full device disconnect, durable deletion/history lock, explicit release: PASS');
    console.log('- Independent devices and unapproved installs: PASS');
    console.log('- Persistence, legacy backfill and profile/history reset: PASS');
} catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
} finally {
    if (process.env.STORAGE_ENGINE === 'sqlite') require('../storage/sqliteDatabase').Close();
    fs.rmSync(dataDir, { recursive: true, force: true });
}

}
run();
