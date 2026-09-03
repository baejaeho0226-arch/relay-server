'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-multi-pair-test-'));
process.env.DATA_DIR = temporaryData;
process.env.STORAGE_ENGINE = 'json';
process.env.ADMIN_SECRET = 'multi-pair-test-secret';

function Socket(ip = '100.64.0.5') {
    return {
        destroyed: false,
        remoteAddress: ip,
        writes: [],
        write(value) { this.writes.push(String(value)); return true; },
        destroy() { this.destroyed = true; }
    };
}

function LiveServer(id, ip) {
    const socket = Socket(ip);
    const value = { serverId: id, registered: true, socket, clients: new Set(), lastIP: ip, lastSeen: Date.now(), rttMs: 1, protocolVersion: 2, appVersion: '2.6.1' };
    socket.__relayConnection = value;
    return value;
}

function LiveClient(id, ip) {
    const socket = Socket(ip);
    const value = { clientId: id, connected: true, socket, serverId: '', lastIP: ip, lastSeen: Date.now(), rttMs: 1, protocolVersion: 2, appVersion: '2.9.1' };
    socket.__relayConnection = value;
    return value;
}

async function run() {
    const state = require('../core/state');
    const pairing = require('../services/pairingApproval');
    const identity = require('../identity/identityManager');
    const network = require('../services/networkSecurity');
    require('../core/utils').EnsureDirs();

    const serverIds = ['1000000000000001', '1000000000000002', '1000000000000003', '1000000000000004'];
    const clientIds = ['2000000000000001', '2000000000000002', '2000000000000003', '2000000000000004'];
    for (let i = 0; i < 4; i++) {
        state.serverIdentities.set(`WIN2-${String(i + 1).repeat(32).slice(0, 32)}-${String(i + 5).repeat(16).slice(0, 16)}`, serverIds[i]);
        state.servers.set(serverIds[i], LiveServer(serverIds[i], `100.64.0.${5 + i}`));
        state.clientIdentities.set(`ANDROID2-${String.fromCharCode(65 + i).repeat(16)}-${String.fromCharCode(69 + i).repeat(16)}`, {
            id: clientIds[i], serverId: '', createdAt: i + 1, lastSeenAt: 0, lastAuthAt: 0,
            lastIP: '', authCount: 0, sendCount: 0, reconnectCount: 0
        });
        state.clients.set(clientIds[i], LiveClient(clientIds[i], `100.64.0.${25 + i}`));
    }

    for (let i = 0; i < 4; i++) {
        const before = pairing.EligibleServers(clientIds[i]);
        assert.ok(before.some(row => row.id === serverIds[i] && row.eligible));
        const result = pairing.BindForApproval(clientIds[i], serverIds[i], 'MULTI_TEST');
        assert.strictEqual(result.ok, true, result.reason);
    }
    assert.strictEqual(new Set(Array.from(state.clientIdentities.values()).map(x => x.serverId)).size, 4);
    assert.strictEqual(pairing.EligibleServers(clientIds[2]).find(x => x.id === serverIds[2]).current, true);
    assert.strictEqual(pairing.EligibleServers(clientIds[2]).find(x => x.id === serverIds[2]).eligible, true);
    assert.strictEqual(pairing.Validate(clientIds[0], serverIds[1]).reason, 'SERVER_ALREADY_PAIRED');

    // Changing Railway/CGNAT hop addresses is not a device IP incident.
    identity.TrackIP('CLIENT', clientIds[0], '100.64.0.5');
    identity.TrackIP('CLIENT', clientIds[0], '100.64.88.17');
    const privateProfile = network.Get('CLIENT', clientIds[0]);
    assert.strictEqual(privateProfile.status, 'RELAY_PRIVATE');
    assert.strictEqual(privateProfile.changed, false);
    assert.strictEqual(privateProfile.changeCount, 0);
    assert.strictEqual(network.DisplayIP('CLIENT', clientIds[0], '100.64.88.17'), 'RELAY_PRIVATE');
    assert.strictEqual(state.notifications.filter(x => x.type === 'DEVICE_NETWORK_CHANGE').length, 0);

    // A routable address change needs two consecutive observations. A single
    // reconnect cannot create a warning by itself.
    identity.TrackIP('CLIENT', clientIds[1], '8.8.8.8');
    identity.TrackIP('CLIENT', clientIds[1], '1.1.1.1');
    assert.strictEqual(network.Get('CLIENT', clientIds[1]).status, 'PENDING_CONFIRMATION');
    assert.strictEqual(state.notifications.filter(x => x.type === 'DEVICE_NETWORK_CHANGE').length, 0);
    identity.TrackIP('CLIENT', clientIds[1], '1.1.1.1');
    assert.strictEqual(network.Get('CLIENT', clientIds[1]).changed, true);
    assert.strictEqual(state.notifications.filter(x => x.type === 'DEVICE_NETWORK_CHANGE').length, 1);

    const routeSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'routes', 'buildQrRoutes.js'), 'utf8');
    const pageSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-pages-access.js'), 'utf8');
    assert.ok(routeSource.includes('EligibleServers(result.request.clientId)'));
    assert.ok(pageSource.includes('?clientId=${encodeURIComponent(scannedClientId)}'));

    console.log('MULTI PAIR / DELETE / IP PASS');
    console.log('- Four independent APK to PC pairs: PASS');
    console.log('- Scanned CLIENT receives its own current/eligible target list: PASS');
    console.log('- Relay-private IP churn does not notify: PASS');
    console.log('- Public IP change requires consecutive confirmation: PASS');
}

run().finally(() => {
    fs.rmSync(temporaryData, { recursive: true, force: true });
}).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
