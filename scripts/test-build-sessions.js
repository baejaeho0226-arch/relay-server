'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-build-session-test-'));
process.env.DATA_DIR = temporaryData;
process.env.STORAGE_ENGINE = 'json';
process.env.ADMIN_SECRET = 'build-session-test-admin-secret';

async function run() {
    const state = require('../core/state');
    const buildGate = require('../services/buildGate');
    const deviceControl = require('../services/deviceControl');
    require('../core/utils').EnsureDirs();

    const clientId = 'AABBCCDDEEFF0011';
    const serverId = '1122334455667788';
    const secondServerId = '8877665544332211';
    const requestId = 'BUILD-LEASE-TEST-0001';
    const licenseKey = 'LICENSE-BUILDSESSION-TEST';
    const serverSecret = 'server-build-session-test-secret';
    const clientWrites = [];
    const serverWrites = [];

    const clientSocket = {
        destroyed: false,
        remoteAddress: '127.0.0.1',
        write(value) { clientWrites.push(String(value)); return true; },
        destroy() { this.destroyed = true; }
    };
    const serverSocket = {
        destroyed: false,
        remoteAddress: '127.0.0.1',
        write(value) { serverWrites.push(String(value)); return true; },
        destroy() { this.destroyed = true; }
    };
    const client = {
        socket: clientSocket, type: 'client', connected: true, clientId,
        serverId, deviceAuthVerified: true, biometricVerified: true,
        accessType: 'TYPE3', licenseAuthorized: true, licenseKey,
        buildCompleted: false, buildSessionId: ''
    };
    const server = {
        socket: serverSocket, type: 'server', connected: true, registered: true,
        serverId, deviceAuthVerified: true, buildGateCapable: true,
        buildUnlocked: false, buildClients: new Set(), buildSessions: new Map(),
        clients: new Set([clientId])
    };
    clientSocket.__relayConnection = client;
    serverSocket.__relayConnection = server;

    state.clientIdentities.set('ANDROID-BUILD-SESSION-TEST', {
        id: clientId, serverId, createdAt: Date.now(), lastSeenAt: 0,
        lastAuthAt: 0, lastIP: '', authCount: 0, sendCount: 0,
        reconnectCount: 0
    });
    state.serverIdentities.set('SERVER-BUILD-SESSION-TEST', serverId);
    state.serverIdentities.set('SERVER-BUILD-SESSION-TEST-2', secondServerId);
    state.clients.set(clientId, client);
    state.servers.set(serverId, server);
    state.licenses.set(licenseKey, {
        boundClient: clientId, expiresAt: Date.now() + 86400000,
        suspended: false, accessType: 'TYPE3', tags: [], memo: ''
    });
    state.deviceSecrets.set(`SERVER:${serverId}`, serverSecret);
    deviceControl.RecordCapabilities('SERVER', serverId,
        'DEVICE_HMAC,BUILD_GATE,BUILD_SESSION_LEASE,FIXED_BUILD_BINDING,TYPE_PROCESSOR_ROUTING');

    assert.strictEqual(buildGate.SetPolicy({ ttlMinutes: 7 }, 'TEST').ok, true);
    assert.strictEqual(buildGate.Summary().policy.ttlMinutes, 7);
    assert.strictEqual(buildGate.SetPolicy({ ttlMinutes: 0 }, 'TEST').ok, false);

    const queued = buildGate.Queue(client, requestId);
    assert.strictEqual(queued.ok, true);
    assert.match(queued.grant.sessionId, /^BLS-[0-9A-F]{32}$/);
    assert.ok(clientWrites.some(line => line.startsWith(`BUILD_WAITING|${requestId}|`)));

    const dispatched = buildGate.TryDispatchClient(clientId);
    assert.strictEqual(dispatched.delivered, false);
    assert.strictEqual(dispatched.reason, 'ALREADY_DISPATCHED');
    const buildLine = serverWrites.find(line => line.startsWith(`BUILD|${requestId}|${clientId}|`));
    assert.ok(buildLine);
    const parts = buildLine.trim().split('|');
    assert.strictEqual(parts.length, 7);
    assert.strictEqual(parts[5], 'TYPE3');
    const expectedProof = crypto.createHmac('sha256', serverSecret)
        .update(`BUILD|${serverId}|${requestId}|${clientId}|${parts[3]}|${parts[4]}|TYPE3`, 'utf8')
        .digest('hex').toUpperCase();
    assert.strictEqual(parts[6], expectedProof);

    state.pendingRequests.delete(buildGate.RequestKey(clientId, requestId));
    const completed = buildGate.Complete(clientId, requestId);
    assert.strictEqual(completed.ok, true);
    assert.strictEqual(completed.session.status, 'AUTHORIZED');
    assert.strictEqual(completed.session.accessType, 'TYPE3');
    assert.strictEqual(buildGate.BindingForClient(clientId).serverId, serverId);
    assert.strictEqual(buildGate.BindingForServer(serverId).clientId, clientId);
    assert.strictEqual(buildGate.ActiveSessionForClient(clientId).sessionId, parts[3]);
    assert.strictEqual(buildGate.Queue(client, 'BUILD-DUPLICATE-ACTIVE').reason, 'BUILD_SESSION_ACTIVE');

    const secondClientId = '0011223344556677';
    const secondSaved = {
        id: secondClientId, serverId, createdAt: Date.now() + 1,
        lastSeenAt: 0, lastAuthAt: 0, lastIP: '', authCount: 0,
        sendCount: 0, reconnectCount: 0
    };
    state.clientIdentities.set('ANDROID-SECOND-PAIR-TEST', secondSaved);
    const secondClient = {
        clientId: secondClientId, serverId, connected: true,
        accessType: 'TYPE1', biometricVerified: true, deviceAuthVerified: true,
        licenseAuthorized: true, licenseKey: 'LICENSE-SECOND-DEFERRED',
        socket: { destroyed: false, write() { return true; } }
    };
    assert.strictEqual(buildGate.Queue(secondClient, 'BUILD-SECOND-PAIR').reason,
        'SERVER_ALREADY_PAIRED');
    assert.strictEqual(buildGate.Rebind(secondClientId, serverId, 'TEST').reason,
        'SERVER_ALREADY_PAIRED');
    assert.strictEqual(require('../identity/identityManager').RepairOneToOneAssignments(), 1);
    assert.strictEqual(secondSaved.serverId, '');

    const saved = state.clientIdentities.get('ANDROID-BUILD-SESSION-TEST');
    const emergency = require('../services/emergencyFailover');
    state.clients.set(secondClientId, secondClient);
    state.licenses.set(secondClient.licenseKey, {
        boundClient: secondClientId, expiresAt: Date.now() + 86400000,
        suspended: false, accessType: 'TYPE1', tags: [], memo: ''
    });
    assert.strictEqual(buildGate.Queue(secondClient, 'BUILD-SECOND-DEFERRED').ok, true);
    state.servers.set(secondServerId, {
        socket: { destroyed: false, write() { return true; } },
        type: 'server', connected: true, registered: true, serverId: secondServerId,
        deviceAuthVerified: true, clients: new Set()
    });
    deviceControl.RecordCapabilities('SERVER', secondServerId,
        'DEVICE_HMAC,BUILD_SESSION_LEASE,FIXED_BUILD_BINDING');
    assert.strictEqual(require('../relay/serverHandler').BindUnassignedClients(secondServerId), 1);
    assert.strictEqual(secondSaved.serverId, secondServerId);
    assert.strictEqual(state.servers.get(secondServerId).clients.has(secondClientId), true);

    // A third PC must claim the third live phone, not a stale offline row that
    // happens to appear first in persisted insertion order.
    const staleClientId = 'DEAD000000000001';
    state.clientIdentities.set('ANDROID-STALE-OFFLINE', {
        id: staleClientId, serverId: '', createdAt: Date.now() - 10000,
        lastSeenAt: Date.now() - 10000, lastAuthAt: 0, lastIP: '',
        authCount: 0, sendCount: 0, reconnectCount: 0
    });
    const thirdClientId = 'CCDDEEFF00112233';
    const thirdServerId = '3344556677889900';
    const thirdSaved = {
        id: thirdClientId, serverId: '', createdAt: Date.now(),
        lastSeenAt: Date.now(), lastAuthAt: 0, lastIP: '', authCount: 0,
        sendCount: 0, reconnectCount: 0
    };
    const thirdClient = {
        clientId: thirdClientId, serverId: '', connected: true,
        accessType: 'TYPE2', biometricVerified: true, deviceAuthVerified: true,
        licenseAuthorized: true, licenseKey: 'LICENSE-THIRD-DEFERRED',
        socket: { destroyed: false, write() { return true; } }
    };
    state.clientIdentities.set('ANDROID-THIRD-LIVE', thirdSaved);
    state.clients.set(thirdClientId, thirdClient);
    state.licenses.set(thirdClient.licenseKey, {
        boundClient: thirdClientId, expiresAt: Date.now() + 86400000,
        suspended: false, accessType: 'TYPE2', tags: [], memo: ''
    });
    assert.strictEqual(buildGate.Queue(thirdClient, 'BUILD-THIRD-DEFERRED').ok, true);
    state.serverIdentities.set('SERVER-THIRD-LIVE', thirdServerId);
    state.servers.set(thirdServerId, {
        socket: { destroyed: false, write() { return true; } },
        type: 'server', connected: true, registered: true,
        serverId: thirdServerId, deviceAuthVerified: false, clients: new Set()
    });
    deviceControl.RecordCapabilities('SERVER', thirdServerId,
        'DEVICE_HMAC,BUILD_SESSION_LEASE,FIXED_BUILD_BINDING');
    assert.strictEqual(require('../relay/serverHandler').BindUnassignedClients(thirdServerId), 0);
    state.servers.get(thirdServerId).deviceAuthVerified = true;
    assert.strictEqual(require('../relay/serverHandler').BindUnassignedClients(thirdServerId), 1);
    assert.strictEqual(thirdSaved.serverId, thirdServerId);
    assert.strictEqual(state.clientIdentities.get('ANDROID-STALE-OFFLINE').serverId, '');

    // Two fully authenticated phones may wait together while no empty PC is
    // available. Later HMAC-verified PCs must claim exactly one phone each in
    // Build FIFO order; the first PC may never consume both pending grants.
    const waitingPairs = [
        { clientId: '4400000000000001', deviceKey: 'ANDROID-WAITING-PAIR-1', licenseKey: 'LICENSE-WAITING-PAIR-1', requestId: 'BUILD-WAITING-PAIR-1' },
        { clientId: '5500000000000002', deviceKey: 'ANDROID-WAITING-PAIR-2', licenseKey: 'LICENSE-WAITING-PAIR-2', requestId: 'BUILD-WAITING-PAIR-2' }
    ];
    for (const item of waitingPairs) {
        const waitingClient = {
            clientId: item.clientId, serverId: '', connected: true,
            accessType: 'TYPE1', biometricVerified: true, deviceAuthVerified: true,
            licenseAuthorized: true, licenseKey: item.licenseKey,
            socket: { destroyed: false, write() { return true; } }
        };
        state.clientIdentities.set(item.deviceKey, {
            id: item.clientId, serverId: '', createdAt: Date.now(),
            lastSeenAt: Date.now(), lastAuthAt: Date.now(), lastIP: '',
            authCount: 1, sendCount: 0, reconnectCount: 0
        });
        state.clients.set(item.clientId, waitingClient);
        state.licenses.set(item.licenseKey, {
            boundClient: item.clientId, expiresAt: Date.now() + 86400000,
            suspended: false, accessType: 'TYPE1', tags: [], memo: ''
        });
        assert.strictEqual(buildGate.Queue(waitingClient, item.requestId).ok, true);
    }
    const lateServers = ['6600000000000001', '7700000000000002'];
    for (let index = 0; index < lateServers.length; index++) {
        const lateServerId = lateServers[index];
        state.servers.set(lateServerId, {
            socket: { destroyed: false, write() { return true; } },
            type: 'server', connected: true, registered: true,
            serverId: lateServerId, deviceAuthVerified: true, clients: new Set()
        });
        state.deviceSecrets.set(`SERVER:${lateServerId}`, `late-server-secret-${lateServerId}`);
        deviceControl.RecordCapabilities('SERVER', lateServerId,
            'DEVICE_HMAC,BUILD_SESSION_LEASE,FIXED_BUILD_BINDING');
        const dispatchResult = buildGate.TryDispatchServer(lateServerId);
        assert.strictEqual(dispatchResult.delivered, 1);
        assert.strictEqual(state.clientIdentities.get(waitingPairs[index].deviceKey).serverId, lateServerId);
        assert.strictEqual(state.servers.get(lateServerId).clients.size, 1);
        if (index === 0)
            assert.strictEqual(state.clientIdentities.get(waitingPairs[1].deviceKey).serverId, '');
    }

    // First WIN2 registration migrates the old server identity. A second PC
    // with the same synced legacy base no longer collides with it.
    const legacyBase = 'A'.repeat(32);
    const legacyServerId = 'ABCDEFABCDEFABCD';
    state.serverIdentities.set(`WIN-${legacyBase}`, legacyServerId);
    const migrated = require('../relay/serverHandler').MigrateLegacyServerIdentity(
        `WIN2-${legacyBase}-${'1'.repeat(16)}`);
    assert.strictEqual(migrated, legacyServerId);
    assert.strictEqual(require('../relay/serverHandler').MigrateLegacyServerIdentity(
        `WIN2-${legacyBase}-${'2'.repeat(16)}`), '');

    const legacyAndroidId = 'B'.repeat(16);
    const legacyClientId = '1234123412341234';
    state.clientIdentities.set(`ANDROID-${legacyAndroidId}`, {
        id: legacyClientId, serverId: '', createdAt: Date.now(),
        lastSeenAt: 0, lastAuthAt: 0, lastIP: '', authCount: 0,
        sendCount: 0, reconnectCount: 0
    });
    const migratedClient = require('../relay/clientHandler').MigrateLegacyClientIdentity(
        `ANDROID2-${legacyAndroidId}-${'3'.repeat(16)}`);
    assert.strictEqual(migratedClient.id, legacyClientId);
    assert.strictEqual(require('../relay/clientHandler').MigrateLegacyClientIdentity(
        `ANDROID2-${legacyAndroidId}-${'4'.repeat(16)}`), null);

    state.serviceEnabled = true;
    state.maintenanceMode = false;
    emergency.SetPolicy({ enabled: true, offlineGraceSeconds: 0, returnGraceSeconds: 0 });
    assert.strictEqual(emergency.SetClientEnabled(clientId, true).ok, true);
    state.disabledServers.add(serverId);
    const failoverResult = emergency.Evaluate();
    state.disabledServers.delete(serverId);
    assert.strictEqual(failoverResult.moves, 0);
    assert.strictEqual(saved.serverId, serverId);
    const failoverStatus = emergency.BuildStatus().clients.find(item => item.clientId === clientId);
    assert.strictEqual(failoverStatus.buildBindingFixed, true);
    assert.strictEqual(failoverStatus.buildBindingServerId, serverId);

    const recovery = require('../services/requestRecovery');
    recovery.SetPolicy({ enabled: true, maxItemsPerClient: 10, ttlSeconds: 300, maxDeliveryAttempts: 3 });
    recovery.SetClientEnabled(clientId, true);
    assert.strictEqual(recovery.EnqueueRequest({ clientId, serverId, requestId: 'QUEUE-WITH-BUILD', number: '77', accessType: 'TYPE1' }, 'TEST').ok, true);
    assert.strictEqual(recovery.ProcessOfflineQueue().delivered, 1);
    assert.ok(serverWrites.some(line => line.trim() === `NUMBER|QUEUE-WITH-BUILD|${clientId}|TYPE3|77`));
    state.pendingRequests.delete(buildGate.RequestKey(clientId, 'QUEUE-WITH-BUILD'));

    const revoke = buildGate.Revoke(parts[3], 'ADMIN_TEST_REVOKE', 'TEST_ADMIN');
    assert.strictEqual(revoke.ok, true);
    assert.strictEqual(revoke.session.status, 'REVOKED');
    assert.ok(clientWrites.some(line => line.startsWith(`BUILD_REVOKED|${parts[3]}|ADMIN_TEST_REVOKE`)));
    const revokeLine = serverWrites.find(line => line.startsWith(`BUILD_REVOKE|${clientId}|${parts[3]}|ADMIN_TEST_REVOKE|`));
    assert.ok(revokeLine);
    const revokeParts = revokeLine.trim().split('|');
    const expectedRevokeProof = crypto.createHmac('sha256', serverSecret)
        .update(`REVOKE|${serverId}|${clientId}|${parts[3]}|ADMIN_TEST_REVOKE`, 'utf8')
        .digest('hex').toUpperCase();
    assert.strictEqual(revokeParts[4], expectedRevokeProof);
    assert.strictEqual(recovery.EnqueueRequest({ clientId, serverId, requestId: 'QUEUE-WITHOUT-BUILD', number: '88', accessType: 'TYPE2' }, 'TEST').ok, true);
    assert.strictEqual(recovery.ProcessOfflineQueue().delivered, 0);
    assert.strictEqual(recovery.BuildStatus().queue.some(item => item.requestId === 'QUEUE-WITHOUT-BUILD'), true);

    saved.serverId = secondServerId;
    assert.strictEqual(buildGate.Queue(client, 'BUILD-BINDING-MISMATCH').reason,
        'SERVER_BINDING_MISMATCH');
    saved.serverId = serverId;

    const persisted = JSON.parse(fs.readFileSync(require('../config/config').DB_FILE, 'utf8'));
    assert.strictEqual(persisted.buildSessionPolicy.ttlMinutes, 7);
    assert.strictEqual(persisted.clientBuildBindings[clientId].serverId, serverId);
    assert.strictEqual(persisted.buildSessions[parts[3]].status, 'REVOKED');

    const serverlessSessionId = 'BLS-00112233445566778899AABBCCDDEEFF';
    buildGate.ImportPersisted({
        buildSessionPolicy: { ttlMinutes: 9, updatedAt: Date.now(), updatedBy: 'TEST' },
        buildSessions: {
            [serverlessSessionId]: {
                sessionId: serverlessSessionId, requestId: 'BUILD-SERVERLESS',
                clientId, serverId: '', accessType: 'TYPE1', status: 'PENDING',
                createdAt: Date.now(), dispatchCount: 0
            }
        },
        pendingBuildGrants: {
            [clientId]: {
                requestId: 'BUILD-SERVERLESS', sessionId: serverlessSessionId,
                clientId, serverId: '', accessType: 'TYPE1',
                createdAt: Date.now(), expiresAt: Date.now() + 60000
            }
        }
    });
    assert.ok(state.pendingBuildGrants.has(clientId));
    assert.strictEqual(state.buildSessions.get(serverlessSessionId).status, 'PENDING');
    assert.strictEqual(state.buildSessions.get(serverlessSessionId).serverId, '');

    const adminSource = fs.readdirSync(path.join(__dirname, '..', 'public'))
        .filter(name => /^admin(?:-[a-z-]+)?\.js$/i.test(name))
        .sort()
        .map(name => fs.readFileSync(path.join(path.join(__dirname, '..', 'public'), name), 'utf8'))
        .join('\n');
    const apiSource = fs.readdirSync(path.join(__dirname, '..', 'web'), { recursive: true })
        .filter(name => String(name).endsWith('.js'))
        .map(name => fs.readFileSync(path.join(__dirname, '..', 'web', name), 'utf8'))
        .join('\n');
    const processorSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'processorCenter.js'), 'utf8');
    assert.ok(adminSource.includes('async function renderBuildSessions()'));
    assert.ok(adminSource.includes('REVOKE NOW'));
    assert.ok(apiSource.includes("pathname === '/api/build-sessions'"));
    assert.ok(apiSource.includes('/api\\/build-bindings'));
    assert.ok(processorSource.includes("TYPE1: 'TYPE1/DEFAULT'"));
    assert.ok(processorSource.includes("TYPE2: 'TYPE2/DEFAULT'"));
    assert.ok(processorSource.includes("TYPE3: 'TYPE3/DEFAULT'"));

    const buildQrRoutes = require('../web/routes/buildQrRoutes');
    let routedResponse = null;
    const routed = await buildQrRoutes.Handle({
        method: 'GET', pathname: '/api/build-sessions', body: {}, res: {},
        session: { role: 'admin' }, BuildServers: () => [],
        RequireAdmin: () => true,
        Json: (_res, status, data) => { routedResponse = { status, data }; },
        ApiError: () => { throw new Error('UNEXPECTED_ROUTE_ERROR'); }
    });
    assert.strictEqual(routed, true);
    assert.strictEqual(routedResponse.status, 200);
    assert.ok(routedResponse.data.summary);
    assert.strictEqual(await buildQrRoutes.Handle({
        method: 'GET', pathname: '/api/not-a-modular-route', body: {}, res: {},
        session: { role: 'admin' }, BuildServers: () => [],
        RequireAdmin: () => true, Json: () => {}, ApiError: () => {}
    }), false);

    console.log('BUILD SESSION 24-27 PASS');
    console.log('- Signed expiring Build lease and TYPE routing: PASS');
    console.log('- Replay/active-session rejection: PASS');
    console.log('- Fixed APK to WinSockServer binding: PASS');
    console.log('- Absolute one APK to one WinSockServer pairing: PASS');
    console.log('- Three live PCs/phones pair independently; stale offline rows skipped: PASS');
    console.log('- Multiple authenticated APKs wait first; later verified PCs claim one each FIFO: PASS');
    console.log('- Synced legacy Windows device ID collision migration: PASS');
    console.log('- Cloned legacy Android ID collision migration: PASS');
    console.log('- Signed immediate revoke and persisted history: PASS');
    console.log('- Offline Queue waits for Build and uses session TYPE: PASS');
    console.log('- Web policy, rebind and revoke controls: PASS');
    console.log('- Modular QR/Build Web route dispatch: PASS');
}

run().finally(() => {
    fs.rmSync(temporaryData, { recursive: true, force: true });
}).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
