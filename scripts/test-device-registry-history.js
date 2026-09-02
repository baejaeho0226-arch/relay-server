'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-device-registry-test-'));
process.env.DATA_DIR = temporaryData;
process.env.STORAGE_ENGINE = 'json';
process.env.ADMIN_SECRET = 'device-registry-test-admin-secret';

function Socket(name) {
    return {
        name,
        destroyed: false,
        remoteAddress: '127.0.0.1',
        writes: [],
        write(value) { this.writes.push(String(value)); return true; },
        destroy() { this.destroyed = true; }
    };
}

function Connection(type, name) {
    const socket = Socket(name);
    const connection = {
        socket, type, registered: false, connected: false, superseded: false,
        disconnected: false, serverId: '', clientId: '', clients: new Set(),
        lastSeen: Date.now(), lastIP: '127.0.0.1', rttMs: 1
    };
    socket.__relayConnection = connection;
    return connection;
}

async function run() {
    const state = require('../core/state');
    const identity = require('../identity/identityManager');
    const serverHandler = require('../relay/serverHandler');
    const clientHandler = require('../relay/clientHandler');
    const lifecycle = require('../core/lifecycle');
    const registry = require('../services/deviceRegistry');
    const history = require('../services/historyCleanup');
    require('../core/utils').EnsureDirs();

    const serverKeyA = `WIN2-${'A'.repeat(32)}-${'1'.repeat(16)}`;
    const serverKeyB = `WIN2-${'B'.repeat(32)}-${'2'.repeat(16)}`;
    const serverIdA = 'AAAABBBBCCCC0001';
    const serverIdB = 'AAAABBBBCCCC0002';
    state.serverIdentities.set(serverKeyA, serverIdA);
    state.serverIdentities.set(serverKeyB, serverIdB);

    const serverA1 = Connection('server', 'server-a-first');
    const serverB1 = Connection('server', 'server-b-first');
    assert.strictEqual(serverHandler.RegisterServer(serverA1, serverKeyA, 2, '2.6.0'), true);
    assert.strictEqual(serverHandler.RegisterServer(serverB1, serverKeyB, 2, '2.6.0'), true);
    assert.strictEqual(serverA1.serverId, serverIdA);
    assert.strictEqual(serverB1.serverId, serverIdB);

    // The same local device key must replace only its previous transport and
    // keep the persisted SERVER-ID.
    const serverA2 = Connection('server', 'server-a-reconnect');
    assert.strictEqual(serverHandler.RegisterServer(serverA2, serverKeyA, 2, '2.6.0'), true);
    assert.strictEqual(serverA2.serverId, serverIdA);
    assert.strictEqual(serverA1.superseded, true);
    assert.strictEqual(serverA1.socket.destroyed, true);
    lifecycle.DisconnectConnection(serverA1);
    assert.strictEqual(state.servers.get(serverIdA), serverA2);

    // #Accept describes remaining one-to-one capacity, not socket online
    // status. An online server without a binding is READY.
    const { BuildServers } = require('../web/webApi');
    let serverRows = BuildServers();
    assert.strictEqual(serverRows.find(x => x.id === serverIdA).status, 'ONLINE');
    assert.strictEqual(serverRows.find(x => x.id === serverIdA).acceptState, 'READY');
    assert.strictEqual(serverRows.find(x => x.id === serverIdA).canAcceptClients, true);

    const clientKeyA = `ANDROID2-${'C'.repeat(16)}-${'3'.repeat(16)}`;
    const clientKeyB = `ANDROID2-${'D'.repeat(16)}-${'4'.repeat(16)}`;
    const clientIdA = '1111222233330001';
    const clientIdB = '1111222233330002';
    state.clientIdentities.set(clientKeyA, {
        id: clientIdA, serverId: serverIdA, createdAt: 1, lastSeenAt: 0,
        lastAuthAt: 0, lastIP: '', authCount: 0, sendCount: 0, reconnectCount: 0
    });
    state.clientIdentities.set(clientKeyB, {
        id: clientIdB, serverId: serverIdB, createdAt: 2, lastSeenAt: 0,
        lastAuthAt: 0, lastIP: '', authCount: 0, sendCount: 0, reconnectCount: 0
    });

    const clientA1 = Connection('client', 'client-a-first');
    const clientB1 = Connection('client', 'client-b-first');
    clientHandler.HandleClientConnect(clientA1, clientKeyA, 2, '2.9.0');
    clientHandler.HandleClientConnect(clientB1, clientKeyB, 2, '2.9.0');
    assert.strictEqual(clientA1.clientId, clientIdA);
    assert.strictEqual(clientB1.clientId, clientIdB);
    assert.strictEqual(clientA1.serverId, serverIdA);
    assert.strictEqual(clientB1.serverId, serverIdB);
    assert.strictEqual(serverA2.clients.has(clientIdA), true);
    assert.strictEqual(serverB1.clients.has(clientIdB), true);

    // At the configured 1/1 capacity an online server is FULL, never OFFLINE.
    serverRows = BuildServers();
    assert.strictEqual(serverRows.find(x => x.id === serverIdA).status, 'ONLINE');
    assert.strictEqual(serverRows.find(x => x.id === serverIdA).acceptState, 'FULL');
    assert.strictEqual(serverRows.find(x => x.id === serverIdA).canAcceptClients, false);

    const clientA2 = Connection('client', 'client-a-reconnect');
    clientHandler.HandleClientConnect(clientA2, clientKeyA, 2, '2.9.0');
    assert.strictEqual(clientA2.clientId, clientIdA);
    assert.strictEqual(clientA2.serverId, serverIdA);
    assert.strictEqual(clientA1.superseded, true);
    lifecycle.DisconnectConnection(clientA1);
    assert.strictEqual(state.clients.get(clientIdA), clientA2);
    assert.strictEqual(state.clientIdentities.get(clientKeyA).id, clientIdA);

    // A binding to an ID that no longer exists is repairable, while a merely
    // offline but still registered fixed pair is deliberately preserved.
    const orphanKey = `ANDROID2-${'E'.repeat(16)}-${'5'.repeat(16)}`;
    const orphanId = '1111222233330003';
    state.clientIdentities.set(orphanKey, {
        id: orphanId, serverId: 'DEADDEADDEADDEAD', createdAt: 3,
        lastSeenAt: 0, lastAuthAt: 0, lastIP: '', authCount: 0,
        sendCount: 0, reconnectCount: 0
    });
    assert.ok(identity.RepairOrphanAssignments() >= 1);
    assert.strictEqual(state.clientIdentities.get(orphanKey).serverId, '');

    state.licenses.set('DELETE-CLIENT-LICENSE', {
        boundClient: clientIdA, boundAt: Date.now(), expiresAt: Date.now() + 60000,
        suspended: false, accessType: 'TYPE1', tags: [], memo: ''
    });
    const deletedClient = registry.DeleteClient(clientIdA);
    assert.strictEqual(deletedClient.ok, true);
    assert.strictEqual(state.clientIdentities.has(clientKeyA), false);
    assert.strictEqual(state.licenses.get('DELETE-CLIENT-LICENSE').boundClient, '');
    assert.strictEqual(serverA2.clients.has(clientIdA), false);

    // An explicit Delete is the only operation that intentionally creates a
    // new ID on the next appearance of the same physical installation.
    const clientANew = Connection('client', 'client-a-after-delete');
    clientHandler.HandleClientConnect(clientANew, clientKeyA, 2, '2.9.0');
    assert.ok(clientANew.clientId);
    assert.notStrictEqual(clientANew.clientId, clientIdA);
    assert.strictEqual(clientANew.serverId, serverIdA);

    const deletedServer = registry.DeleteServer(serverIdB);
    assert.strictEqual(deletedServer.ok, true);
    assert.strictEqual(state.serverIdentities.has(serverKeyB), false);
    assert.strictEqual(state.clientIdentities.get(clientKeyB).serverId, '');
    assert.strictEqual(serverB1.socket.destroyed, true);

    // Finished history is removable without destroying work that can still
    // affect a live request or authorization.
    state.requestTraces.set('TRACE-DONE', { status: 'ACK', clientId: clientIdB, requestId: 'DONE' });
    state.requestTraces.set('TRACE-LIVE', { status: 'PENDING', clientId: clientIdB, requestId: 'LIVE' });
    state.buildSessions.set('BUILD-DONE', { sessionId: 'BUILD-DONE', status: 'REVOKED' });
    state.buildSessions.set('BUILD-LIVE', { sessionId: 'BUILD-LIVE', status: 'PENDING' });
    state.qrAuthRequests.set('QR-DONE', { requestId: 'QR-DONE', status: 'APPROVED' });
    state.qrAuthRequests.set('QR-LIVE', { requestId: 'QR-LIVE', status: 'PENDING' });
    state.dailyHealthReports.set('2026-09-01', { date: '2026-09-01' });
    state.deadLetters.set('DLQ-DONE', { deadLetterId: 'DLQ-DONE', status: 'DISCARDED' });
    state.deadLetters.set('DLQ-LIVE', { deadLetterId: 'DLQ-LIVE', status: 'ACTIVE' });
    state.notifications.push({ id: '1', type: 'TEST' });
    state.configHistory.push({ id: 'CFG-OLD', at: 1, revision: 1, snapshot: {} });
    require('../storage/audit').LogEvent('REGISTRY_TEST', 'history clean');

    const cleaned = history.Clean('ALL', 'TEST');
    assert.strictEqual(cleaned.ok, true);
    assert.strictEqual(state.requestTraces.has('TRACE-DONE'), false);
    assert.strictEqual(state.requestTraces.has('TRACE-LIVE'), true);
    assert.strictEqual(state.buildSessions.has('BUILD-DONE'), false);
    assert.strictEqual(state.buildSessions.has('BUILD-LIVE'), true);
    assert.strictEqual(state.qrAuthRequests.has('QR-DONE'), false);
    assert.strictEqual(state.qrAuthRequests.has('QR-LIVE'), true);
    assert.strictEqual(state.deadLetters.has('DLQ-DONE'), false);
    assert.strictEqual(state.deadLetters.has('DLQ-LIVE'), true);
    assert.strictEqual(state.dailyHealthReports.size, 0);
    assert.strictEqual(state.notifications.length, 0);
    assert.strictEqual(state.configHistory.length, 1);
    assert.strictEqual(state.configHistory[0].action, 'BASELINE');
    assert.strictEqual(state.events.length, 0);

    const adminSource = fs.readdirSync(path.join(__dirname, '..', 'public'))
        .filter(name => /^admin(?:-[a-z-]+)?\.js$/i.test(name))
        .sort()
        .map(name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'))
        .join('\n');
    const webApi = fs.readFileSync(path.join(__dirname, '..', 'web', 'webApi.js'), 'utf8');
    assert.ok(adminSource.includes('data-server-action="delete"'));
    assert.ok(adminSource.includes('data-client-action="delete"'));
    assert.ok(adminSource.includes('data-history-clean="ALL"'));
    assert.ok(adminSource.includes('1:1 MATCH REPAIR'));
    assert.ok(webApi.includes("method === 'DELETE'"));
    assert.ok(webApi.includes("pathname === '/api/history/clean'"));
    assert.ok(webApi.includes("pathname === '/api/pairing/repair'"));

    console.log('DEVICE REGISTRY / HISTORY PASS');
    console.log('- Two PCs and two APKs keep independent fixed pairs: PASS');
    console.log('- Server #Accept READY/FULL stays separate from ONLINE/OFFLINE: PASS');
    console.log('- Reconnect replaces transport without changing IDs: PASS');
    console.log('- Explicit Delete purges bindings and permits new enrollment: PASS');
    console.log('- Orphan pairing repair preserves registered fixed pairs: PASS');
    console.log('- History CLEAN preserves active work: PASS');
    console.log('- Web Delete / Repair / CLEAN controls: PASS');
}

run().finally(() => {
    fs.rmSync(temporaryData, { recursive: true, force: true });
}).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
