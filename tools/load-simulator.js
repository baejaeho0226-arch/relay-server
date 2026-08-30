'use strict';

const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

function Arg(name, fallback = '') {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function IntArg(name, fallback, min, max) {
    const n = Number(Arg(name, fallback));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

const relayHost = Arg('relay-host', '127.0.0.1');
const relayPort = IntArg('relay-port', 3000, 1, 65535);
const webUrl = Arg('web-url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const adminSecret = Arg('admin-secret', process.env.ADMIN_SECRET || '');
const serverCount = IntArg('servers', 10, 1, 500);
const clientCount = IntArg('clients', 100, 1, 5000);
const requestsPerClient = IntArg('requests', 1, 0, 100);
const mode = Arg('mode', 'connect').toLowerCase() === 'full' ? 'full' : 'connect';
const holdMs = IntArg('hold-ms', 5000, 100, 600000);
const timeoutMs = IntArg('timeout-ms', 10000, 1000, 60000);

if (mode === 'full' && !adminSecret) {
    console.error('FULL mode requires --admin-secret or ADMIN_SECRET.');
    process.exit(2);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randHex(bytes = 8) { return crypto.randomBytes(bytes).toString('hex').toUpperCase(); }

function httpJson(method, pathname, body, auth = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(pathname, webUrl);
        const payload = body === undefined ? '' : JSON.stringify(body);
        const lib = u.protocol === 'https:' ? https : http;
        const headers = { Accept: 'application/json' };
        if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
        if (auth.cookie) headers.Cookie = auth.cookie;
        if (auth.csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = auth.csrf;
        const req = lib.request(u, { method, headers, timeout: timeoutMs }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                let data = {};
                try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`${method} ${u.pathname}: HTTP ${res.statusCode} ${data.error || ''}`.trim()));
                    return;
                }
                resolve({ data, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('HTTP_TIMEOUT')));
        if (payload) req.write(payload);
        req.end();
    });
}

async function loginAdmin() {
    const r = await httpJson('POST', '/api/login', { role: 'admin', password: adminSecret });
    const setCookie = Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie'];
    if (!setCookie) throw new Error('LOGIN_COOKIE_MISSING');
    return { cookie: setCookie.split(';')[0], csrf: r.data.csrf };
}

class LineSocket {
    constructor(kind, index) {
        this.kind = kind;
        this.index = index;
        this.socket = null;
        this.buffer = '';
        this.waiters = [];
        this.lines = [];
        this.id = '';
        this.serverId = '';
        this.closed = false;
    }
    connect() {
        return new Promise((resolve, reject) => {
            const s = net.createConnection({ host: relayHost, port: relayPort });
            this.socket = s;
            const timer = setTimeout(() => { s.destroy(); reject(new Error(`${this.kind} CONNECT_TIMEOUT`)); }, timeoutMs);
            s.setEncoding('utf8');
            s.on('connect', () => { clearTimeout(timer); resolve(); });
            s.on('data', data => this.onData(data));
            s.on('error', error => {
                if (!this.closed) this.rejectAll(error);
            });
            s.on('close', () => { this.closed = true; this.rejectAll(new Error(`${this.kind} SOCKET_CLOSED`)); });
        });
    }
    onData(data) {
        this.buffer += data;
        let p;
        while ((p = this.buffer.indexOf('\n')) >= 0) {
            let line = this.buffer.slice(0, p);
            this.buffer = this.buffer.slice(p + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (!line) continue;
            // Event Sequence compatibility: unwrap payload for simulator behavior.
            if (line.startsWith('SEQ|')) {
                const parts = line.split('|');
                line = parts.slice(2).join('|');
            }
            if (this.kind === 'SERVER') this.handleServerCommand(line);
            this.lines.push(line);
            this.flushWaiters();
        }
    }
    handleServerCommand(line) {
        if (line.startsWith('NUMBER|')) {
            const p = line.split('|');
            if (p.length >= 4) this.send(`ACK|${p[1]}|${p[2]}|OK|1|SIMULATOR|OK`);
        } else if (line.startsWith('PING|')) {
            this.send(`PONG|${line.split('|')[1] || ''}`);
        }
    }
    send(line) {
        if (!this.socket || this.socket.destroyed) return false;
        this.socket.write(`${line}\n`);
        return true;
    }
    waitFor(predicate, label) {
        const existingIndex = this.lines.findIndex(predicate);
        if (existingIndex >= 0) return Promise.resolve(this.lines.splice(existingIndex, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, label, timer: null };
            waiter.timer = setTimeout(() => {
                this.waiters = this.waiters.filter(x => x !== waiter);
                reject(new Error(`${this.kind} ${label || 'WAIT'} TIMEOUT`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }
    flushWaiters() {
        for (const waiter of [...this.waiters]) {
            const index = this.lines.findIndex(waiter.predicate);
            if (index < 0) continue;
            const line = this.lines.splice(index, 1)[0];
            clearTimeout(waiter.timer);
            this.waiters = this.waiters.filter(x => x !== waiter);
            waiter.resolve(line);
        }
    }
    rejectAll(error) {
        for (const w of this.waiters) { clearTimeout(w.timer); w.reject(error); }
        this.waiters = [];
    }
    close() { this.closed = true; try { this.socket?.destroy(); } catch (_) {} }
}

async function createServers() {
    const list = [];
    for (let i = 0; i < serverCount; i++) {
        const s = new LineSocket('SERVER', i);
        await s.connect();
        s.send(`REGISTER|2|2.0.0|WIN-SIM-${randHex(8)}-${i}`);
        const line = await s.waitFor(x => x.startsWith('REGISTERED|'), 'REGISTERED');
        s.id = line.split('|')[1];
        list.push(s);
        if ((i + 1) % 25 === 0 || i + 1 === serverCount) console.log(`Servers: ${i + 1}/${serverCount}`);
    }
    return list;
}

async function createClients(auth) {
    const list = [];
    const licenses = [];
    for (let i = 0; i < clientCount; i++) {
        const c = new LineSocket('CLIENT', i);
        await c.connect();
        c.send(`CONNECT|2|2.0.0|ANDROID-SIM-${randHex(8)}-${i}`);
        const line = await c.waitFor(x => x.startsWith('CONNECTED|'), 'CONNECTED');
        const p = line.split('|');
        c.id = p[1];
        c.serverId = p[2];
        if (mode === 'full') {
            const r = await httpJson('POST', '/api/licenses', { days: 1, memo: 'LOAD-SIMULATOR', tags: ['LOAD-SIM'] }, auth);
            const key = r.data.key;
            licenses.push(key);
            c.send(`LICENSE_AUTH|${key}|${c.id}`);
            await c.waitFor(x => x.startsWith('LICENSE_OK|'), 'LICENSE_OK');
        }
        list.push(c);
        if ((i + 1) % 100 === 0 || i + 1 === clientCount) console.log(`Clients: ${i + 1}/${clientCount}`);
    }
    return { list, licenses };
}

async function sendRequests(clients) {
    if (mode !== 'full' || requestsPerClient <= 0) return { ok: 0, error: 0 };
    let ok = 0, error = 0;
    for (const c of clients) {
        for (let n = 0; n < requestsPerClient; n++) {
            const requestId = `SIM-${Date.now().toString(36)}-${randHex(4)}`;
            c.send(`SEND|${requestId}|${c.id}|${1000 + n}`);
            try {
                await c.waitFor(x => x === `SENT|OK|${requestId}`, 'SENT');
                await c.waitFor(x => x.startsWith(`ACK|OK|${requestId}`), 'ACK');
                ok++;
            } catch (_) { error++; }
        }
    }
    return { ok, error };
}

async function cleanupLicenses(auth, keys) {
    if (!keys.length) return;
    for (let i = 0; i < keys.length; i += 500) {
        await httpJson('POST', '/api/licenses/bulk', { action: 'delete', keys: keys.slice(i, i + 500) }, auth);
    }
}

(async () => {
    const started = Date.now();
    const sockets = [];
    let auth = {};
    let licenses = [];
    try {
        console.log('Relay Load Simulator');
        console.log(`Target: ${relayHost}:${relayPort}`);
        console.log(`Mode: ${mode} / Servers: ${serverCount} / Clients: ${clientCount} / Requests per client: ${requestsPerClient}`);
        console.log('Use a dedicated staging deployment. Simulator identities remain in the test database.');
        if (mode === 'full') auth = await loginAdmin();
        const servers = await createServers(); sockets.push(...servers);
        const created = await createClients(auth); sockets.push(...created.list); licenses = created.licenses;
        const requests = await sendRequests(created.list);
        const connectedServerIds = new Set(servers.map(x => x.id));
        const foreignAssignments = created.list.filter(x => !connectedServerIds.has(x.serverId)).length;
        console.log(JSON.stringify({
            ok: true,
            mode,
            servers: servers.length,
            clients: created.list.length,
            requests,
            foreignAssignments,
            elapsedMs: Date.now() - started
        }, null, 2));
        await sleep(holdMs);
    } catch (error) {
        console.error('LOAD SIMULATOR ERROR:', error && error.stack ? error.stack : error);
        process.exitCode = 1;
    } finally {
        for (const s of sockets) s.close();
        if (mode === 'full' && licenses.length) {
            try { await cleanupLicenses(auth, licenses); console.log(`Temporary licenses deleted: ${licenses.length}`); }
            catch (error) { console.error('License cleanup failed:', error.message); }
        }
    }
})();
