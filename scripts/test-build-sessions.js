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
        serverId, deviceAuthVerified: true, passwordVerified: true,
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
    assert.strictEqual(dispatched.delivered, true);
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
    assert.strictEqual(buildGate.ActiveSessionForClient(clientId).sessionId, parts[3]);
    assert.strictEqual(buildGate.Queue(client, 'BUILD-DUPLICATE-ACTIVE').reason, 'BUILD_SESSION_ACTIVE');

    const saved = state.clientIdentities.get('ANDROID-BUILD-SESSION-TEST');
    const emergency = require('../services/emergencyFailover');
    state.servers.set(secondServerId, {
        socket: { destroyed: false, write() { return true; } },
        type: 'server', connected: true, registered: true, serverId: secondServerId,
        deviceAuthVerified: true, clients: new Set()
    });
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
