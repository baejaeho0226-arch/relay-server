'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-roadmap14-'));
const TCP_PORT = 41000 + Math.floor(Math.random() * 1000);
const WEB_PORT = TCP_PORT + 1000;
const SECRET = 'roadmap14-test-secret';
let relay = null;
let relayOutput = '';
const deviceSecrets = new Map();

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class LineSocket {
    constructor(socket) {
        this.socket = socket;
        this.buffer = '';
        this.lines = [];
        this.waiters = [];
        socket.on('data', data => {
            this.buffer += data.toString('utf8');
            while (true) {
                const pos = this.buffer.indexOf('\n');
                if (pos < 0) break;
                const line = this.buffer.substring(0, pos).replace(/\r$/, '');
                this.buffer = this.buffer.substring(pos + 1);
                if (line === 'PING') { this.send('PONG'); continue; }
                if (line.startsWith('PING|')) { this.send(`PONG|${line.split('|')[1] || ''}`); continue; }
                this.lines.push(line);
                this.flush();
            }
        });
    }

    send(line) { this.socket.write(`${line}\n`); }
    close() { try { this.socket.destroy(); } catch (_) {} }

    flush() {
        for (const waiter of Array.from(this.waiters)) {
            const index = this.lines.findIndex(waiter.predicate);
            if (index < 0) continue;
            const line = this.lines.splice(index, 1)[0];
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(line);
        }
    }

    waitFor(predicate, timeoutMs = 8000) {
        const index = this.lines.findIndex(predicate);
        if (index >= 0) return Promise.resolve(this.lines.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) this.waiters.splice(i, 1);
                reject(new Error(`LINE_TIMEOUT lines=${JSON.stringify(this.lines)}`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }
}

async function connectLineSocket() {
    const socket = net.createConnection({ host: '127.0.0.1', port: TCP_PORT });
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    return new LineSocket(socket);
}

function startRelay() {
    relayOutput = '';
    relay = childProcess.spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(TCP_PORT),
            WEB_ADMIN_PORT: String(WEB_PORT),
            HEALTH_PORT: '0',
            DATA_DIR: TEST_ROOT,
            ADMIN_SECRET: SECRET
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    relay.stdout.on('data', data => { relayOutput += data.toString('utf8'); });
    relay.stderr.on('data', data => { relayOutput += data.toString('utf8'); });
}

async function stopRelay() {
    if (!relay || relay.exitCode !== null) return;
    relay.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => relay.once('exit', resolve)),
        delay(4000).then(() => { if (relay.exitCode === null) relay.kill('SIGKILL'); })
    ]);
}

async function waitHealth() {
    for (let i = 0; i < 100; i++) {
        try {
            const response = await fetch(`http://127.0.0.1:${WEB_PORT}/health`);
            if (response.ok) return;
        } catch (_) {}
        if (relay && relay.exitCode !== null) throw new Error(`RELAY_EXITED\n${relayOutput}`);
        await delay(100);
    }
    throw new Error(`HEALTH_TIMEOUT\n${relayOutput}`);
}

async function login() {
    const response = await fetch(`http://127.0.0.1:${WEB_PORT}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: SECRET })
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return { cookie: String(response.headers.get('set-cookie') || '').split(';')[0], csrf: data.csrf };
}

async function api(session, method, url, body) {
    const headers = { Cookie: session.cookie, Accept: 'application/json' };
    if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = session.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${WEB_PORT}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    assert.ok(response.ok && data.ok !== false, `${method} ${url} ${response.status} ${JSON.stringify(data)}`);
    return data;
}

function hmac(key, data) {
    return crypto.createHmac('sha256', String(key)).update(String(data), 'utf8').digest('hex').toUpperCase();
}

async function authenticateDevice(socket, type, id, deviceKey) {
    let line = await socket.waitFor(x => x.startsWith('DEVICE_SECRET|') || x.startsWith('AUTH_CHALLENGE|'));
    if (line.startsWith('DEVICE_SECRET|')) {
        deviceSecrets.set(`${type}:${deviceKey}`, line.split('|')[1]);
        socket.send('DEVICE_SECRET_ACK');
        line = await socket.waitFor(x => x.startsWith('AUTH_CHALLENGE|'));
    }
    const secret = deviceSecrets.get(`${type}:${deviceKey}`);
    assert.ok(secret, `Missing ${type} secret for ${deviceKey}`);
    const challenge = line.split('|');
    socket.send(`DEVICE_AUTH|${challenge[1]}|${hmac(secret, `${type}|${id}|${challenge[1]}|${challenge[2]}|${challenge[3]}`)}`);
    await socket.waitFor(x => x.startsWith(`DEVICE_AUTH_OK|${challenge[1]}`));
}

async function registerServer(deviceKey) {
    const socket = await connectLineSocket();
    socket.send(`REGISTER|2|2.0.0|${deviceKey}`);
    const line = await socket.waitFor(x => x.startsWith('REGISTERED|'));
    const id = line.split('|')[1];
    socket.send('CAPABILITIES|DEVICE_HMAC,BUILD_GATE,BUILD_SESSION_LEASE,FIXED_BUILD_BINDING,TYPE_PROCESSOR_ROUTING');
    await authenticateDevice(socket, 'SERVER', id, deviceKey);
    return { socket, id, deviceKey };
}

async function connectClient(deviceKey, licenseKey) {
    const socket = await connectLineSocket();
    socket.send(`CONNECT|2|2.0.0|${deviceKey}`);
    const connected = await socket.waitFor(x => x.startsWith('CONNECTED|'));
    const parts = connected.split('|');
    socket.send('CAPABILITIES|DEVICE_HMAC,BUILD_GATE,BUILD_SESSION_LEASE');
    await authenticateDevice(socket, 'CLIENT', parts[1], deviceKey);
    socket.send(`LICENSE_AUTH|${licenseKey}|${parts[1]}`);
    await socket.waitFor(x => x.startsWith('LICENSE_OK|'));
    return { socket, id: parts[1], serverId: parts[2], deviceKey };
}

async function authorizeBuild(server, client, requestId) {
    client.socket.send(`BUILD|${requestId}|${client.id}`);
    await client.socket.waitFor(x => x.startsWith(`BUILD_WAITING|${requestId}|`));
    const build = await server.socket.waitFor(x => x.startsWith(`BUILD|${requestId}|${client.id}|BLS-`));
    const parts = build.split('|');
    assert.equal(parts.length, 7);
    server.socket.send(`ACK|${requestId}|${client.id}|OK|0|BUILD_SESSION|SESSION=${parts[3]}`);
    await client.socket.waitFor(x => x.startsWith(`BUILD_OK|${requestId}|${parts[3]}|`));
}

async function run() {
    startRelay();
    await waitHealth();
    let session = await login();

    let serverA = await registerServer('ROADMAP14-SERVER-A');
    let serverB = await registerServer('ROADMAP14-SERVER-B');
    assert.notEqual(serverA.id, serverB.id);
    const license = await api(session, 'POST', '/api/licenses', { days: 30, memo: 'roadmap14-test' });
    let client = await connectClient('ROADMAP14-CLIENT-A', license.key);
    assert.equal(client.serverId, serverA.id);

    await api(session, 'POST', `/api/failover/clients/${client.id}/binding`, {
        primaryServerId: serverA.id,
        backupServerId: serverB.id,
        allowAutomaticFallback: false
    });
    await api(session, 'POST', `/api/failover/clients/${client.id}`, { enabled: true });
    await api(session, 'POST', '/api/failover/policy', {
        enabled: true, autoReturn: true, offlineGraceSeconds: 0, returnGraceSeconds: 0, maxMovesPerCycle: 50
    });
    serverA.socket.close();
    const moved = await client.socket.waitFor(x => x.startsWith(`ERROR|CLIENT_MOVED|${serverB.id}|EMERGENCY_FAILOVER`), 10000);
    assert.ok(moved.includes(serverB.id));
    const failover = await api(session, 'GET', '/api/failover');
    const failoverRow = failover.failover.clients.find(x => x.clientId === client.id);
    assert.equal(failoverRow.primaryServerId, serverA.id);
    assert.equal(failoverRow.backupServerId, serverB.id);
    assert.equal(failoverRow.currentServerId, serverB.id);
    assert.equal(failoverRow.selectedBy, 'EXPLICIT_BACKUP');

    await api(session, 'POST', '/api/failover/policy', {
        enabled: false, autoReturn: true, offlineGraceSeconds: 0, returnGraceSeconds: 0, maxMovesPerCycle: 50
    });
    await api(session, 'POST', `/api/failover/clients/${client.id}/binding`, {
        primaryServerId: serverA.id,
        backupServerId: serverB.id,
        allowAutomaticFallback: false
    });
    serverA = await registerServer('ROADMAP14-SERVER-A');
    client = await connectClient('ROADMAP14-CLIENT-A', license.key);
    assert.equal(client.serverId, serverA.id);
    await authorizeBuild(serverA, client, 'BUILD-ROADMAP14-A1');

    await api(session, 'POST', '/api/request-recovery/policy', {
        enabled: true, maxItemsPerClient: 20, ttlSeconds: 300, maxDeliveryAttempts: 3
    });
    await api(session, 'POST', `/api/request-recovery/clients/${client.id}`, { enabled: true });
    serverA.socket.close();
    await delay(200);
    client.socket.send(`SEND|QUEUE-REQUEST-1|${client.id}|101`);
    const queued = await client.socket.waitFor(x => x.startsWith('QUEUED|OK|QUEUE-REQUEST-1|'));
    assert.ok(queued.endsWith('|1'));
    let recovery = await api(session, 'GET', '/api/request-recovery');
    assert.equal(recovery.recovery.summary.queued, 1);

    await stopRelay();
    startRelay();
    await waitHealth();
    session = await login();
    serverA = await registerServer('ROADMAP14-SERVER-A');
    client = await connectClient('ROADMAP14-CLIENT-A', license.key);
    assert.equal(client.serverId, serverA.id);
    await authorizeBuild(serverA, client, 'BUILD-ROADMAP14-A2');
    const queuedNumber = await serverA.socket.waitFor(x => x === `NUMBER|QUEUE-REQUEST-1|${client.id}|TYPE1|101`, 10000);
    assert.ok(queuedNumber);
    serverA.socket.send(`ACK|QUEUE-REQUEST-1|${client.id}|OK|12|DEFAULT|QUEUED_OK`);
    recovery = await api(session, 'GET', '/api/request-recovery');
    assert.equal(recovery.recovery.summary.queued, 0);

    serverA.socket.close();
    await delay(200);
    client.socket.send(`SEND|QUEUE-REQUEST-2|${client.id}|102`);
    await client.socket.waitFor(x => x.startsWith('QUEUED|OK|QUEUE-REQUEST-2|'));
    serverA = await registerServer('ROADMAP14-SERVER-A');
    await authorizeBuild(serverA, client, 'BUILD-ROADMAP14-A3');
    await serverA.socket.waitFor(x => x === `NUMBER|QUEUE-REQUEST-2|${client.id}|TYPE1|102`, 10000);
    serverA.socket.send(`ACK|QUEUE-REQUEST-2|${client.id}|OK|11|DEFAULT|LIVE_QUEUE_OK`);
    await client.socket.waitFor(x => x === 'DEQUEUED|QUEUE-REQUEST-2|' + serverA.id);
    await client.socket.waitFor(x => x.startsWith('ACK|OK|QUEUE-REQUEST-2'));

    client.socket.send(`SEND|FAILED-REQUEST-1|${client.id}|202`);
    await client.socket.waitFor(x => x === 'SENT|OK|FAILED-REQUEST-1');
    await serverA.socket.waitFor(x => x === `NUMBER|FAILED-REQUEST-1|${client.id}|TYPE1|202`);
    serverA.socket.send(`ACK|FAILED-REQUEST-1|${client.id}|ERROR|PROCESS_ERROR|9|DEFAULT|TEST_FAILURE`);
    await client.socket.waitFor(x => x.startsWith('ACK|ERROR|FAILED-REQUEST-1|PROCESS_ERROR'));
    recovery = await api(session, 'GET', '/api/request-recovery');
    const dlq = recovery.recovery.deadLetters.find(x => x.originalRequestId === 'FAILED-REQUEST-1' && x.status === 'ACTIVE');
    assert.ok(dlq, 'ACTIVE DLQ missing');

    const traces = await api(session, 'GET', '/api/request-traces?query=FAILED-REQUEST-1');
    const failedTrace = traces.traces.find(x => x.requestId === 'FAILED-REQUEST-1');
    assert.ok(failedTrace && failedTrace.status === 'ERROR');
    const replay = await api(session, 'POST', '/api/request-traces/replay', { key: failedTrace.key });
    const replayLine = await serverA.socket.waitFor(x => x.startsWith('NUMBER|REPLAY-') && x.endsWith(`|${client.id}|TYPE1|202`));
    const replayId = replayLine.split('|')[1];
    assert.notEqual(replayId, 'FAILED-REQUEST-1');
    assert.equal(replay.requestId, replayId);
    serverA.socket.send(`ACK|${replayId}|${client.id}|OK|4|DEFAULT|REPLAY_OK`);

    const dlqRetry = await api(session, 'POST', `/api/dead-letters/${dlq.deadLetterId}/retry`, {});
    const retryLine = await serverA.socket.waitFor(x => x.startsWith('NUMBER|DLQRETRY-') && x.endsWith(`|${client.id}|TYPE1|202`));
    const retryId = retryLine.split('|')[1];
    assert.notEqual(retryId, replayId);
    assert.equal(dlqRetry.deadLetter.lastReplayRequestId, retryId);
    serverA.socket.send(`ACK|${retryId}|${client.id}|OK|5|DEFAULT|DLQ_OK`);

    client.socket.send(`SEND|DISCARD-REQUEST-1|${client.id}|303`);
    await client.socket.waitFor(x => x === 'SENT|OK|DISCARD-REQUEST-1');
    await serverA.socket.waitFor(x => x === `NUMBER|DISCARD-REQUEST-1|${client.id}|TYPE1|303`);
    serverA.socket.send(`ACK|DISCARD-REQUEST-1|${client.id}|ERROR|PROCESS_ERROR`);
    await client.socket.waitFor(x => x.startsWith('ACK|ERROR|DISCARD-REQUEST-1|PROCESS_ERROR'));
    recovery = await api(session, 'GET', '/api/request-recovery?query=DISCARD-REQUEST-1');
    const discardDlq = recovery.recovery.deadLetters.find(x => x.originalRequestId === 'DISCARD-REQUEST-1' && x.status === 'ACTIVE');
    assert.ok(discardDlq, 'Discard test DLQ missing');
    await api(session, 'POST', `/api/dead-letters/${discardDlq.deadLetterId}/discard`, {});
    recovery = await api(session, 'GET', '/api/request-recovery?query=DISCARD-REQUEST-1');
    assert.equal(recovery.recovery.deadLetters.find(x => x.deadLetterId === discardDlq.deadLetterId).status, 'DISCARDED');

    await delay(200);
    client.socket.close();
    serverA.socket.close();
    serverB.socket.close();
    await stopRelay();

    startRelay();
    await waitHealth();
    session = await login();
    const persistedFailover = await api(session, 'GET', '/api/failover');
    const persistedBinding = persistedFailover.failover.clients.find(x => x.clientId === client.id);
    assert.ok(persistedBinding && persistedBinding.bindingConfigured);
    assert.equal(persistedBinding.primaryServerId, serverA.id);
    assert.equal(persistedBinding.backupServerId, serverB.id);
    const persistedRecovery = await api(session, 'GET', '/api/request-recovery');
    const persistedDlq = persistedRecovery.recovery.deadLetters.find(x => x.deadLetterId === dlq.deadLetterId);
    assert.ok(persistedDlq && persistedDlq.status === 'REPLAYED');

    console.log('ROADMAP 11-14 E2E PASS');
    console.log('- Primary / Backup binding and explicit backup failover: PASS');
    console.log('- Offline Queue persistence and FIFO delivery after server recovery: PASS');
    console.log('- Request Replay creates a new Request ID: PASS');
    console.log('- DLQ capture / retry / discard / persisted status: PASS');
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    console.error(relayOutput);
    process.exitCode = 1;
}).finally(async () => {
    await stopRelay();
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (_) {}
});
