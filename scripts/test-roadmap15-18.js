'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRODUCT_ROOT = path.resolve(ROOT, '..');
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-roadmap18-'));
const TCP_PORT = 43000 + Math.floor(Math.random() * 700);
const WEB_PORT = TCP_PORT + 1000;
const SECRET = 'roadmap18-test-secret';
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
            const waiter = { predicate, resolve, timer: null };
            waiter.timer = setTimeout(() => {
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) this.waiters.splice(i, 1);
                reject(new Error(`LINE_TIMEOUT lines=${JSON.stringify(this.lines)}`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }
}

async function connectSocket() {
    const socket = net.createConnection({ host: '127.0.0.1', port: TCP_PORT });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    return new LineSocket(socket);
}

function startRelay() {
    relayOutput = '';
    relay = childProcess.spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(TCP_PORT), WEB_ADMIN_PORT: String(WEB_PORT), HEALTH_PORT: '0', DATA_DIR: TEST_ROOT, ADMIN_SECRET: SECRET, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    relay.stdout.on('data', data => { relayOutput += data.toString('utf8'); });
    relay.stderr.on('data', data => { relayOutput += data.toString('utf8'); });
}

async function stopRelay() {
    if (!relay || relay.exitCode !== null) return;
    relay.kill('SIGTERM');
    await Promise.race([new Promise(resolve => relay.once('exit', resolve)), delay(4000).then(() => { if (relay.exitCode === null) relay.kill('SIGKILL'); })]);
}

async function waitHealth() {
    for (let i = 0; i < 100; i++) {
        try { const response = await fetch(`http://127.0.0.1:${WEB_PORT}/health`); if (response.ok) return; } catch (_) {}
        if (relay && relay.exitCode !== null) throw new Error(`RELAY_EXITED\n${relayOutput}`);
        await delay(100);
    }
    throw new Error(`HEALTH_TIMEOUT\n${relayOutput}`);
}

async function login() {
    const response = await fetch(`http://127.0.0.1:${WEB_PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin', password: SECRET }) });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return { cookie: String(response.headers.get('set-cookie') || '').split(';')[0], csrf: data.csrf };
}

async function api(session, method, url, body) {
    const headers = { Cookie: session.cookie, Accept: 'application/json' };
    if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = session.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${WEB_PORT}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok && data.ok !== false, `${method} ${url} ${response.status} ${JSON.stringify(data)}`);
    return data;
}

function hmac(key, data) {
    return crypto.createHmac('sha256', String(key)).update(String(data), 'utf8').digest('hex').toUpperCase();
}

async function authenticateDevice(socket, type, id, key) {
    let line = await socket.waitFor(x => x.startsWith('DEVICE_SECRET|') || x.startsWith('AUTH_CHALLENGE|'));
    if (line.startsWith('DEVICE_SECRET|')) {
        deviceSecrets.set(key, line.split('|')[1]);
        socket.send('DEVICE_SECRET_ACK');
        line = await socket.waitFor(x => x.startsWith('AUTH_CHALLENGE|'));
    }
    const secret = deviceSecrets.get(key);
    assert.ok(secret, `Missing ${type} test secret`);
    const challenge = line.split('|');
    socket.send(`DEVICE_AUTH|${challenge[1]}|${hmac(secret, `${type}|${id}|${challenge[1]}|${challenge[2]}|${challenge[3]}`)}`);
    await socket.waitFor(x => x.startsWith(`DEVICE_AUTH_OK|${challenge[1]}`));
}

async function completeBiometric(socket, clientId, key) {
    const line = await socket.waitFor(x => x.startsWith('BIOMETRIC_CHALLENGE|'));
    const parts = line.split('|');
    const secret = deviceSecrets.get(key);
    const proof = hmac(secret,
        `BIOMETRIC|${parts[1]}|${clientId}|${parts[2]}|${parts[3]}`);
    socket.send(`BIOMETRIC_PROOF|${parts[1]}|${parts[2]}|${proof}`);
    await socket.waitFor(x => x.startsWith('BIOMETRIC_OK|'));
}

async function registerServer() {
    const socket = await connectSocket();
    socket.send('REGISTER|2|2.1.0|ROADMAP18-SERVER');
    const registered = await socket.waitFor(x => x.startsWith('REGISTERED|'));
    const id = registered.split('|')[1];
    socket.send('CAPABILITIES|CONFIG,PROCESS_RESULT,PROCESSOR_POLICY,DEVICE_HMAC,BUILD_GATE,BUILD_SESSION_LEASE,FIXED_BUILD_BINDING,TYPE_PROCESSOR_ROUTING');
    await socket.waitFor(x => x.startsWith('PROCESSOR_CONFIG|'));
    await authenticateDevice(socket, 'SERVER', id, 'ROADMAP18-SERVER');
    return { socket, id };
}

async function connectClient(licenseKey) {
    const socket = await connectSocket();
    socket.send('CONNECT|2|2.1.0|ROADMAP18-CLIENT');
    const connected = await socket.waitFor(x => x.startsWith('CONNECTED|'));
    const id = connected.split('|')[1];
    socket.send('CAPABILITIES|DEVICE_HMAC,BIOMETRIC_AUTH,BIOMETRIC_STRONG,BUILD_GATE,BUILD_SESSION_LEASE');
    await authenticateDevice(socket, 'CLIENT', id, 'ROADMAP18-CLIENT');
    socket.send(`LICENSE_AUTH|${licenseKey}|${id}`);
    await socket.waitFor(x => x.startsWith('LICENSE_OK|'));
    await completeBiometric(socket, id, 'ROADMAP18-CLIENT');
    return { socket, id };
}

async function authorizeBuild(server, client, requestId = 'BUILD-ROADMAP18') {
    client.socket.send(`BUILD|${requestId}|${client.id}`);
    await client.socket.waitFor(x => x.startsWith(`BUILD_WAITING|${requestId}|`));
    const build = await server.socket.waitFor(x => x.startsWith(`BUILD|${requestId}|${client.id}|BLS-`));
    const parts = build.split('|');
    assert.equal(parts.length, 7);
    server.socket.send(`ACK|${requestId}|${client.id}|OK|0|BUILD_SESSION|SESSION=${parts[3]}`);
    await client.socket.waitFor(x => x.startsWith(`BUILD_OK|${requestId}|${parts[3]}|`));
}

async function testPushManagerWithMock() {
    const Module = require('module');
    const originalLoad = Module._load;
    let configured = false;
    let deliveries = 0;
    Module._load = function(request, parent, isMain) {
        if (request === 'web-push') return {
            setVapidDetails(subject, publicKey, privateKey) { configured = Boolean(subject && publicKey && privateKey); },
            async sendNotification(subscription, payload) { assert.ok(subscription.endpoint); assert.equal(JSON.parse(payload).type, 'MOCK_WARNING'); deliveries++; }
        };
        return originalLoad.call(this, request, parent, isMain);
    };
    process.env.VAPID_PUBLIC_KEY = 'mock-public-key';
    process.env.VAPID_PRIVATE_KEY = 'mock-private-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    try {
        const pushManager = require('../services/pushManager');
        const state = require('../core/state');
        state.pushSubscriptions.set('mock', { id: 'mock', subscription: { endpoint: 'https://push.example.test/subscription', keys: { p256dh: 'key', auth: 'auth' } }, failureCount: 0 });
        assert.equal(pushManager.Status().available, true);
        const result = await pushManager.Send({ title: 'Mock', body: 'Delivery', severity: 'WARNING', type: 'MOCK_WARNING' });
        assert.equal(result.sent, 1);
        assert.equal(deliveries, 1);
        assert.ok(configured);
        state.pushSubscriptions.clear();
    } finally {
        Module._load = originalLoad;
        delete process.env.VAPID_PUBLIC_KEY;
        delete process.env.VAPID_PRIVATE_KEY;
        delete process.env.VAPID_SUBJECT;
    }
}

async function run() {
    await testPushManagerWithMock();
    const androidDir = path.join(PRODUCT_ROOT, 'ApkWinSock_Android64');
    const android = fs.readdirSync(androidDir)
        .filter(name => name === 'ApkWinSock.pas' || /^ApkWinSock\..+\.inc$/i.test(name))
        .sort().map(name => fs.readFileSync(path.join(androidDir, name), 'utf8')).join('\n');
    const constructorText = android.slice(android.indexOf('constructor TForm1.Create'), android.indexOf('destructor TForm1.Destroy'));
    assert.ok(constructorText.includes('FStartupTimer.Enabled := True'));
    assert.ok(!constructorText.includes('TApkRelayRuntime.Create'));
    assert.ok(!constructorText.includes('TApkDeviceSecurity.Create'));
    assert.ok(!constructorText.includes('GetClientDeviceKey'));
    assert.ok(!constructorText.includes('RequestPermission'));
    assert.ok(android.includes("FStartupTimer.Interval := 16"));

    const winProcessor = fs.readFileSync(path.join(PRODUCT_ROOT, 'WinSockServer_Win64', 'NumberProcessor.pas'), 'utf8');
    assert.ok(winProcessor.includes('NUMBER_BELOW_MIN'));
    assert.ok(winProcessor.includes('NUMBER_ABOVE_MAX'));
    assert.ok(winProcessor.includes('NUMBER_BLOCKED'));

    startRelay();
    await waitHealth();
    let session = await login();
    const server = await registerServer();

    const savedPolicy = await api(session, 'POST', '/api/processors/policy', { enabled: true, processor: 'DEFAULT', minValue: '-9007199254740993', maxValue: '9223372036854775807', blockedValues: '-9007199254740992, 42, 42' });
    assert.deepEqual(savedPolicy.policy.blockedValues, ['-9007199254740992', '42']);
    const configLine = await server.socket.waitFor(x => x.startsWith(`PROCESSOR_CONFIG|${savedPolicy.policy.revision}|`));
    assert.ok(configLine.includes('|-9007199254740993|9223372036854775807|-9007199254740992,42'));
    server.socket.send(`PROCESSOR_CONFIG_ACK|${savedPolicy.policy.revision}|OK|DEFAULT`);

    const license = await api(session, 'POST', '/api/licenses', { days: 30, memo: 'roadmap18-test' });
    const client = await connectClient(license.key);
    await authorizeBuild(server, client);
    client.socket.send(`SEND|PROCESS-OK-1|${client.id}|41`);
    await client.socket.waitFor(x => x === 'SENT|OK|PROCESS-OK-1');
    await server.socket.waitFor(x => x === `NUMBER|PROCESS-OK-1|${client.id}|TYPE1|41`);
    server.socket.send(`ACK|PROCESS-OK-1|${client.id}|OK|7|DEFAULT|NUMBER_ACCEPTED`);
    await client.socket.waitFor(x => x.startsWith('ACK|OK|PROCESS-OK-1'));

    client.socket.send(`SEND|PROCESS-BLOCK-1|${client.id}|42`);
    await client.socket.waitFor(x => x === 'SENT|OK|PROCESS-BLOCK-1');
    await server.socket.waitFor(x => x === `NUMBER|PROCESS-BLOCK-1|${client.id}|TYPE1|42`);
    server.socket.send(`ACK|PROCESS-BLOCK-1|${client.id}|ERROR|NUMBER_BLOCKED|2|DEFAULT|POLICY_BLOCKED_VALUE`);
    await client.socket.waitFor(x => x.startsWith('ACK|ERROR|PROCESS-BLOCK-1|NUMBER_BLOCKED'));

    const overview = await api(session, 'GET', '/api/processors');
    const stats = overview.processors.stats.find(x => x.processor === 'DEFAULT');
    assert.equal(stats.requests, 2);
    assert.equal(stats.success, 1);
    assert.equal(stats.error, 1);
    assert.equal(stats.avgMs, 4.5);
    assert.equal(overview.processors.servers.find(x => x.serverId === server.id).ack.status, 'OK');

    const push = await api(session, 'GET', '/api/push/status');
    assert.equal(push.push.available, false);
    assert.equal(push.push.reason, 'VAPID_KEYS_NOT_CONFIGURED');

    const generated = await api(session, 'POST', '/api/reports/daily/generate', {});
    assert.equal(generated.report.ack.ok, 1);
    assert.equal(generated.report.ack.error, 1);
    assert.equal(generated.report.sends, 2);

    client.socket.close();
    server.socket.close();
    await stopRelay();
    startRelay();
    await waitHealth();
    session = await login();
    const persisted = await api(session, 'GET', '/api/processors');
    assert.equal(persisted.processors.policy.minValue, '-9007199254740993');
    assert.equal(persisted.processors.stats.find(x => x.processor === 'DEFAULT').requests, 2);
    const reports = await api(session, 'GET', '/api/reports/daily');
    assert.ok(reports.daily.reports.some(x => x.date === generated.report.date));

    console.log('ROADMAP 15-18 + ANDROID STARTUP E2E PASS');
    console.log('- Android first-frame staged initialization: PASS');
    console.log('- Int64 processor policy sync and persistence: PASS');
    console.log('- Processor ACK statistics: PASS');
    console.log('- PWA Push delivery mock and safe disabled state: PASS');
    console.log('- Daily Health generation and persistence: PASS');
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    console.error(relayOutput);
    process.exitCode = 1;
}).finally(async () => {
    await stopRelay();
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (_) {}
});
