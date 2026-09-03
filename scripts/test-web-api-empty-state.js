'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-web-api-test-'));
const portBase = 24000 + process.pid % 10000;
const webPort = portBase;
const relayPort = portBase + 1;
const adminSecret = 'web-api-empty-state-admin-secret';
let relay = null;
let output = '';

const endpoints = [
    '/api/session',
    '/api/ha/status',
    '/api/dashboard',
    '/api/qr-auth',
    '/api/production',
    '/api/build-sessions',
    '/api/servers',
    '/api/clients',
    '/api/licenses',
    '/api/notifications',
    '/api/request-traces',
    '/api/request-recovery',
    '/api/audit',
    '/api/backups',
    '/api/admin-activity',
    '/api/sessions',
    '/api/system/integrity',
    '/api/statistics?range=1H',
    '/api/processors',
    '/api/push/status',
    '/api/reports/daily?limit=120',
    '/api/search?q=EMPTY',
    '/api/releases',
    '/api/control/config-history',
    '/api/enrollment',
    '/api/control/devices',
    '/api/control/features',
    '/api/control/protocol-readiness',
    '/api/control/security',
    '/api/control/sequences',
    '/api/control/security/rotations',
    '/api/load-simulator',
    '/api/storage/migration/status',
    '/api/storage/migration/schema',
    '/api/security/dashboard',
    '/api/security/network',
    '/api/failover',
    '/api/system/health',
    '/api/system'
];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForWeb() {
    const url = `http://127.0.0.1:${webPort}/health`;
    for (let attempt = 0; attempt < 80; attempt++) {
        try {
            const response = await fetch(url);
            if (response.status === 200 || response.status === 503) return;
        } catch (_) {}
        if (relay && relay.exitCode !== null) throw new Error(`Relay exited early: ${relay.exitCode}\n${output}`);
        await delay(100);
    }
    throw new Error(`Web Admin did not start.\n${output}`);
}

async function run() {
    const { Json } = require('../web/webApi');
    const serializationResponse = {
        status: 0,
        body: '',
        writeHead(status) { this.status = status; },
        end(body) { this.body = String(body || ''); }
    };
    const originalConsoleError = console.error;
    console.error = () => {};
    try { Json(serializationResponse, 200, { ok: true, unsupported: 1n }); }
    finally { console.error = originalConsoleError; }
    assert.strictEqual(serializationResponse.status, 500);
    assert.strictEqual(JSON.parse(serializationResponse.body).error, 'RESPONSE_SERIALIZATION_FAILED');

    relay = childProcess.spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            DATA_DIR: dataDir,
            STORAGE_ENGINE: 'json',
            HOST: '127.0.0.1',
            PORT: String(relayPort),
            WEB_ADMIN_PORT: String(webPort),
            ADMIN_SECRET: adminSecret,
            QR_APPROVAL_SECRET: 'web-api-empty-state-qr-secret',
            ENABLE_LEGACY_TCP_ADMIN: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    relay.stdout.on('data', chunk => { output += chunk.toString(); });
    relay.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForWeb();

    const login = await fetch(`http://127.0.0.1:${webPort}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ role: 'admin', password: adminSecret })
    });
    assert.strictEqual(login.status, 200);
    const loginData = await login.json();
    assert.ok(loginData.csrf);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie);

    for (const endpoint of endpoints) {
        const response = await fetch(`http://127.0.0.1:${webPort}${endpoint}`, {
            headers: { Accept: 'application/json', Cookie: cookie }
        });
        const text = await response.text();
        let data = null;
        try { data = JSON.parse(text); } catch (_) {}
        assert.notStrictEqual(response.status, 500, `${endpoint}: HTTP 500 ${text}\n${output}`);
        assert.ok(data && typeof data === 'object', `${endpoint}: NO_DATA status=${response.status} body=${text}`);
        assert.notStrictEqual(data.error, 'INTERNAL_ERROR', `${endpoint}: INTERNAL_ERROR\n${output}`);
        assert.strictEqual(response.status, 200, `${endpoint}: status=${response.status} body=${text}`);
        assert.strictEqual(data.ok, true, `${endpoint}: ok=false body=${text}`);
    }

    for (const request of [
        { method: 'POST', endpoint: '/api/pairing/repair', body: {}, status: 200 },
        { method: 'POST', endpoint: '/api/history/clean', body: { scope: 'ALL' }, status: 200 },
        { method: 'DELETE', endpoint: '/api/servers/0000000000000000', status: 404, error: 'SERVER_NOT_FOUND' },
        { method: 'DELETE', endpoint: '/api/clients/0000000000000000', status: 404, error: 'CLIENT_NOT_FOUND' }
    ]) {
        const response = await fetch(`http://127.0.0.1:${webPort}${request.endpoint}`, {
            method: request.method,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie, 'X-CSRF-Token': loginData.csrf },
            body: request.body ? JSON.stringify(request.body) : undefined
        });
        const text = await response.text();
        const data = JSON.parse(text);
        assert.strictEqual(response.status, request.status, `${request.method} ${request.endpoint}: ${text}`);
        assert.notStrictEqual(data.error, 'INTERNAL_ERROR');
        if (request.error) assert.strictEqual(data.error, request.error);
        else assert.strictEqual(data.ok, true);
    }

    const adminSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
    const cssSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.css'), 'utf8');
    assert.ok(adminSource.includes('class="api-error"'));
    assert.ok(!adminSource.includes('`<div class="empty">${esc(error.message)}</div>`'));
    assert.ok(cssSource.includes('.api-error'));

    console.log(`WEB API EMPTY-STATE PASS: ${endpoints.length} authenticated GET endpoints`);
    console.log('- No HTTP 500 / INTERNAL_ERROR / empty JSON response: PASS');
    console.log('- Serialization fallback and dedicated error panel: PASS');
    console.log('- Pair repair, history clean and device delete HTTP routes: PASS');
}

run().finally(async () => {
    if (relay && relay.exitCode === null) {
        relay.kill('SIGTERM');
        for (let i = 0; i < 20 && relay.exitCode === null; i++) await delay(50);
        if (relay.exitCode === null) relay.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
}).catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
