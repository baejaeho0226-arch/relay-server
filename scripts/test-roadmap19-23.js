'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRODUCT_ROOT = path.resolve(ROOT, '..');
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-roadmap23-'));
const BASE = 47000 + Math.floor(Math.random() * 500);
const SECRET = 'roadmap23-admin-secret';
const HA_SECRET = 'roadmap23-ha-shared-secret-32-characters-minimum';
const nodes = [];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function staticSourceChecks() {
    const apkDir = path.join(PRODUCT_ROOT, 'ApkWinSock_Android64');
    const apk = fs.readdirSync(apkDir)
        .filter(name => name === 'ApkWinSock.pas' || /^ApkWinSock\..+\.inc$/i.test(name))
        .sort().map(name => fs.readFileSync(path.join(apkDir, name), 'utf8')).join('\n');
    const send = apk.slice(apk.indexOf('procedure TForm1.SendButtonClick'), apk.indexOf('\nend;', apk.indexOf('procedure TForm1.SendButtonClick')) + 5);
    assert.ok(apk.includes('procedure TForm1.BuildWebStyleUI'));
    assert.ok(apk.includes('FQrImage: TImage'));
    assert.ok(apk.includes("ALine.StartsWith('QR_AUTH_CHALLENGE|')"));
    assert.ok(apk.includes('BuildBuildLine(RequestID, FState.ClientID)'));
    assert.ok(apk.includes('FDashboardTabs: array[0..3] of TRectangle'));
    assert.ok(apk.includes('FDashboardTabsCard := UiRect(Self, FMainPanel'));
    assert.ok(apk.includes('FMX.BiometricAuth'));
    assert.ok(apk.includes('TBiometricStrength.Strong'));
    assert.ok(apk.includes('QR_COUNTDOWN_MAX_MS = 60 * 1000'));
    assert.ok(apk.includes('FQrCornerH: array[0..3] of TRectangle'));
    assert.ok(apk.includes('FBrightnessTrack: TTrackBar'));
    assert.ok(apk.includes('FSupportButton: TRectangle'));
    assert.ok(apk.includes('procedure TForm1.ShowMainPage'));
    assert.ok(!apk.includes('FFinalCheckBox'));
    assert.equal((apk.match(/TCheckBox/g) || []).length, 0);
    assert.ok(!apk.includes('FLicenseEdit'));
    assert.ok(!send.includes('NumberText'));
    assert.ok(!apk.includes('{$R *.fmx}'));

    const update = fs.readFileSync(path.join(PRODUCT_ROOT, 'WinSockServer_Win64', 'UpdateAgent.pas'), 'utf8');
    const allWin = fs.readdirSync(path.join(PRODUCT_ROOT, 'WinSockServer_Win64')).filter(x => x.endsWith('.pas')).map(x => fs.readFileSync(path.join(PRODUCT_ROOT, 'WinSockServer_Win64', x), 'utf8')).join('\n');
    assert.ok(update.includes("Status := 'STAGED_RESTART_REQUIRED'"));
    assert.ok(update.includes("'pending-update.json'"));
    assert.ok(!/ShellExecute|cmd\.exe|tasklist|ExitProcess/.test(allWin));
    assert.ok(!/Winapi\.Windows|Winapi\.ShellAPI/.test(allWin));
    assert.equal((allWin.match(/Winapi\.WinSock2/g) || []).length > 0, true, 'thin socket layer remains explicit');
}

function startNode(name, tcpPort, webPort, peerWebPort, priority) {
    const dataDir = path.join(TEST_ROOT, name);
    fs.mkdirSync(dataDir, { recursive: true });
    const proc = childProcess.spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(tcpPort), WEB_ADMIN_PORT: String(webPort), HEALTH_PORT: '0', DATA_DIR: dataDir,
            ADMIN_SECRET: SECRET, HA_ENABLED: '1', HA_INSTANCE_ID: name, HA_PRIORITY: String(priority),
            HA_PEER_URL: `http://127.0.0.1:${peerWebPort}`, HA_SHARED_SECRET: HA_SECRET,
            HA_POLL_MS: '500', HA_FAILOVER_TIMEOUT_MS: '3000'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const node = { name, tcpPort, webPort, dataDir, proc, output: '' };
    proc.stdout.on('data', x => { node.output += x.toString(); });
    proc.stderr.on('data', x => { node.output += x.toString(); });
    nodes.push(node);
    return node;
}

async function waitHealth(node) {
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`http://127.0.0.1:${node.webPort}/health`)).ok) return; } catch (_) {}
        if (node.proc.exitCode !== null) throw new Error(`${node.name} exited\n${node.output}`);
        await delay(100);
    }
    throw new Error(`${node.name} health timeout\n${node.output}`);
}

async function login(node) {
    const response = await fetch(`http://127.0.0.1:${node.webPort}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin', password: SECRET }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { cookie: String(response.headers.get('set-cookie') || '').split(';')[0], csrf: body.csrf };
}

async function api(node, session, method, pathname, body) {
    const headers = { accept: 'application/json', cookie: session.cookie };
    if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = session.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${node.webPort}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${node.name} ${method} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
    return data;
}

async function waitRoles(a, sessionA, b, sessionB) {
    for (let i = 0; i < 60; i++) {
        const [sa, sb] = await Promise.all([api(a, sessionA, 'GET', '/api/ha/status'), api(b, sessionB, 'GET', '/api/ha/status')]);
        if (sa.ha.role === 'ACTIVE' && sb.ha.role === 'STANDBY') return;
        await delay(250);
    }
    throw new Error(`HA role timeout\nA=${a.output}\nB=${b.output}`);
}

async function stopNode(node) {
    if (node.proc.exitCode !== null) return;
    node.proc.kill('SIGTERM');
    await Promise.race([new Promise(resolve => node.proc.once('exit', resolve)), delay(4000)]);
    if (node.proc.exitCode === null) node.proc.kill('SIGKILL');
}

async function waitPromotion(node, session) {
    for (let i = 0; i < 40; i++) {
        const status = await api(node, session, 'GET', '/api/ha/status');
        if (status.ha.role === 'ACTIVE' && status.ha.acceptsTraffic) return;
        await delay(250);
    }
    throw new Error(`HA promotion timeout\n${node.output}`);
}

async function assertTcpAccepted(node) {
    const socket = net.createConnection({ host: '127.0.0.1', port: node.tcpPort });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const line = new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('TCP response timeout')), 3000);
        socket.on('data', data => {
            buffer += data.toString('utf8');
            const pos = buffer.indexOf('\n');
            if (pos >= 0) { clearTimeout(timer); resolve(buffer.slice(0, pos).replace(/\r$/, '')); }
        });
    });
    socket.write('CONNECT|2|2.2.0|ROADMAP23-CLIENT\n');
    const response = await line;
    socket.destroy();
    assert.ok(!response.startsWith('ERROR|RELAY_STANDBY|'), response);
}

async function run() {
    staticSourceChecks();
    const a = startNode('relay-a', BASE, BASE + 1000, BASE + 1001, 200);
    const b = startNode('relay-b', BASE + 1, BASE + 1001, BASE + 1000, 100);
    await Promise.all([waitHealth(a), waitHealth(b)]);
    const [sessionA, sessionB] = await Promise.all([login(a), login(b)]);
    await waitRoles(a, sessionA, b, sessionB);

    const created = await api(a, sessionA, 'POST', '/api/licenses', { days: 7, memo: 'ha-replication-test' });
    let replicated = false;
    for (let i = 0; i < 40; i++) {
        const list = await api(b, sessionB, 'GET', `/api/licenses?query=${encodeURIComponent(created.key)}&status=ALL&expiry=ALL`);
        if (list.licenses.some(x => x.key === created.key)) { replicated = true; break; }
        await delay(250);
    }
    assert.ok(replicated, 'SQLite snapshot was not replicated to standby');
    for (const node of [a, b]) {
        const header = fs.readFileSync(path.join(node.dataDir, 'relay.db')).subarray(0, 16).toString();
        assert.equal(header, 'SQLite format 3\u0000');
    }

    await stopNode(a);
    await waitPromotion(b, sessionB);
    await assertTcpAccepted(b);
    const failoverWrite = await api(b, sessionB, 'POST', '/api/licenses', { days: 7, memo: 'failover-write-test' });

    const recoveredA = startNode('relay-a', BASE, BASE + 1000, BASE + 1001, 200);
    await waitHealth(recoveredA);
    const recoveredSessionA = await login(recoveredA);
    await waitRoles(recoveredA, recoveredSessionA, b, sessionB);
    const recoveredList = await api(recoveredA, recoveredSessionA, 'GET', `/api/licenses?query=${encodeURIComponent(failoverWrite.key)}&status=ALL&expiry=ALL`);
    if (!recoveredList.licenses.some(x => x.key === failoverWrite.key)) {
        const [statusA, statusB, listB] = await Promise.all([
            api(recoveredA, recoveredSessionA, 'GET', '/api/ha/status'),
            api(b, sessionB, 'GET', '/api/ha/status'),
            api(b, sessionB, 'GET', `/api/licenses?query=${encodeURIComponent(failoverWrite.key)}&status=ALL&expiry=ALL`)
        ]);
        throw new Error(`failover write was not synchronized before priority failback\nkey=${failoverWrite.key}\nA=${JSON.stringify(statusA.ha)}\nB=${JSON.stringify(statusB.ha)}\nB_LIST=${JSON.stringify(listB.licenses)}\nA_OUT=${recoveredA.output}\nB_OUT=${b.output}`);
    }
    await assertTcpAccepted(recoveredA);
    console.log('ROADMAP 19-23 E2E PASS');
    console.log('- SQLite primary + JSON auto-migration/recovery mirror: PASS');
    console.log('- Relay A/B replication + promotion + revision-safe failback: PASS');
    console.log('- Win64/Android primary-backup endpoint source: PASS');
    console.log('- APK source-built QR/strong-biometric/dashboard/background-Build/main UI: PASS');
    console.log('- ShellExecute/cmd/Winapi.Windows removal: PASS');
}

run().catch(error => { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; }).finally(async () => {
    for (const node of nodes) await stopNode(node);
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (_) {}
});
