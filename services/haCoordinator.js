'use strict';

const crypto = require('crypto');
const config = require('../config/config');

const runtime = {
    role: config.HA_ENABLED ? 'CANDIDATE' : 'DISABLED',
    reason: config.HA_ENABLED ? 'STARTING' : 'HA_DISABLED',
    startedAt: Date.now(),
    changedAt: Date.now(),
    lastPeerSeenAt: 0,
    lastReplicationAt: 0,
    lastReplicationRevision: 0,
    lastReplicationError: '',
    peer: null,
    latestSnapshot: null,
    latestSave: null,
    pollBusy: false,
    timer: null
};

function EnabledAndConfigured() {
    return config.HA_ENABLED && /^https?:\/\//i.test(config.HA_PEER_URL) && config.HA_SHARED_SECRET.length >= 32;
}

function CurrentRevision() {
    try { return Number(require('../storage/sqliteDatabase').Status().revision) || 0; } catch (_) { return 0; }
}

function WinsAgainst(peerId, peerPriority, peerRevision = 0) {
    const localRevision = CurrentRevision();
    const otherRevision = Number(peerRevision) || 0;
    if (localRevision !== otherRevision) return localRevision > otherRevision;
    const otherPriority = Number(peerPriority) || 0;
    if (config.HA_PRIORITY !== otherPriority) return config.HA_PRIORITY > otherPriority;
    return config.HA_INSTANCE_ID.localeCompare(String(peerId || '')) < 0;
}

function SetRole(role, reason) {
    if (runtime.role === role && runtime.reason === reason) return;
    runtime.role = role;
    runtime.reason = reason;
    runtime.changedAt = Date.now();
    try { require('../storage/audit').LogEvent('HA_ROLE_CHANGE', `${config.HA_INSTANCE_ID} ${role} ${reason}`); } catch (_) {}
}

function CanAcceptTraffic() {
    return !config.HA_ENABLED || runtime.role === 'ACTIVE';
}

function Status() {
    return {
        enabled: config.HA_ENABLED,
        configured: EnabledAndConfigured(),
        instanceId: config.HA_INSTANCE_ID,
        priority: config.HA_PRIORITY,
        role: runtime.role,
        reason: runtime.reason,
        acceptsTraffic: CanAcceptTraffic(),
        peerUrlConfigured: Boolean(config.HA_PEER_URL),
        peer: runtime.peer,
        lastPeerSeenAt: runtime.lastPeerSeenAt,
        lastReplicationAt: runtime.lastReplicationAt,
        lastReplicationRevision: runtime.lastReplicationRevision,
        lastReplicationError: runtime.lastReplicationError,
        storageRevision: CurrentRevision(),
        failoverTimeoutMs: config.HA_FAILOVER_TIMEOUT_MS
    };
}

function PeerSummary(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        enabled: Boolean(value.enabled),
        configured: Boolean(value.configured),
        instanceId: String(value.instanceId || ''),
        priority: Number(value.priority) || 0,
        role: String(value.role || 'UNKNOWN'),
        reason: String(value.reason || ''),
        acceptsTraffic: Boolean(value.acceptsTraffic),
        storageRevision: Number(value.storageRevision) || 0,
        lastReplicationRevision: Number(value.lastReplicationRevision) || 0
    };
}

function BodyHash(body) {
    return crypto.createHash('sha256').update(body).digest('hex');
}

function Signature(timestamp, method, pathname, body) {
    const canonical = `${timestamp}\n${method}\n${pathname}\n${BodyHash(body)}`;
    return crypto.createHmac('sha256', config.HA_SHARED_SECRET).update(canonical).digest('hex');
}

function SignedHeaders(method, pathname, body) {
    const timestamp = String(Date.now());
    return {
        'content-type': 'application/json',
        'x-relay-ha-instance': config.HA_INSTANCE_ID,
        'x-relay-ha-time': timestamp,
        'x-relay-ha-signature': Signature(timestamp, method, pathname, body)
    };
}

function VerifyRequest(req, pathname, body) {
    const timestamp = String(req.headers['x-relay-ha-time'] || '');
    const provided = String(req.headers['x-relay-ha-signature'] || '');
    if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(provided)) return false;
    if (Math.abs(Date.now() - Number(timestamp)) > 30000) return false;
    const expected = Signature(timestamp, String(req.method || 'GET').toUpperCase(), pathname, body);
    return crypto.timingSafeEqual(Buffer.from(provided.toLowerCase()), Buffer.from(expected));
}

function ReadBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) { reject(new Error('HA_BODY_TOO_LARGE')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function PeerRequest(pathname, method = 'GET', payload = null) {
    const body = payload == null ? '' : JSON.stringify(payload);
    const response = await fetch(config.HA_PEER_URL + pathname, {
        method,
        headers: SignedHeaders(method, pathname, body),
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(Math.min(config.HA_POLL_MS, 5000))
    });
    if (!response.ok) throw new Error(`PEER_HTTP_${response.status}`);
    return response.json();
}

async function ReplicateLatest() {
    if (runtime.role !== 'ACTIVE' || !runtime.latestSnapshot || !runtime.latestSave) return;
    const result = await PeerRequest('/internal/ha/replicate', 'POST', {
        instanceId: config.HA_INSTANCE_ID,
        priority: config.HA_PRIORITY,
        revision: runtime.latestSave.revision,
        savedAt: runtime.latestSave.savedAt,
        checksum: runtime.latestSave.checksum,
        snapshot: runtime.latestSnapshot
    });
    runtime.lastReplicationAt = Date.now();
    runtime.lastReplicationRevision = Number(result.revision) || runtime.latestSave.revision;
    runtime.lastReplicationError = '';
}

async function Poll() {
    if (!EnabledAndConfigured() || runtime.pollBusy) return;
    runtime.pollBusy = true;
    try {
        const peerStatus = await PeerRequest('/internal/ha/status');
        runtime.peer = PeerSummary(peerStatus.ha);
        runtime.lastPeerSeenAt = Date.now();
        const localWins = WinsAgainst(runtime.peer && runtime.peer.instanceId, runtime.peer && runtime.peer.priority, runtime.peer && runtime.peer.storageRevision);
        SetRole(localWins ? 'ACTIVE' : 'STANDBY', localWins ? 'PRIORITY_WINNER' : 'PEER_PRIORITY_WINNER');
        if (localWins) await ReplicateLatest();
    } catch (error) {
        runtime.lastReplicationError = error.message;
        const reference = runtime.lastPeerSeenAt || runtime.startedAt;
        if (runtime.role === 'ACTIVE') SetRole('ACTIVE', 'PEER_UNREACHABLE_KEEP_ACTIVE');
        else if (Date.now() - reference >= config.HA_FAILOVER_TIMEOUT_MS) SetRole('ACTIVE', 'PEER_TIMEOUT_PROMOTION');
        else SetRole('CANDIDATE', 'WAITING_FOR_PEER_TIMEOUT');
    } finally {
        runtime.pollBusy = false;
    }
}

function OnLocalSnapshot(snapshot, saveResult) {
    runtime.latestSnapshot = snapshot;
    runtime.latestSave = saveResult;
    if (EnabledAndConfigured() && runtime.role === 'ACTIVE') {
        ReplicateLatest().catch(error => { runtime.lastReplicationError = error.message; });
    }
}

function Start() {
    if (!config.HA_ENABLED) return;
    if (!EnabledAndConfigured()) {
        SetRole('MISCONFIGURED', 'HA_PEER_URL_AND_32_CHAR_SECRET_REQUIRED');
        return;
    }
    try {
        const sqlite = require('../storage/sqliteDatabase').LoadSnapshot();
        if (sqlite) OnLocalSnapshot(sqlite.data, sqlite);
    } catch (_) {}
    Poll();
    runtime.timer = setInterval(Poll, config.HA_POLL_MS);
}

async function HandleInternal(req, res, pathname) {
    if (!pathname.startsWith('/internal/ha/')) return false;
    const method = String(req.method || 'GET').toUpperCase();
    const body = method === 'GET' ? '' : await ReadBody(req);
    if (!EnabledAndConfigured() || !VerifyRequest(req, pathname, body)) {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'HA_AUTH_FAILED' }));
        return true;
    }
    if (pathname === '/internal/ha/status' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ha: Status() }));
        return true;
    }
    if (pathname === '/internal/ha/replicate' && method === 'POST') {
        try {
            const payload = JSON.parse(body);
            if (!payload || !payload.snapshot) throw new Error('INVALID_SNAPSHOT');
            if (!/^[a-f0-9]{64}$/i.test(String(payload.checksum || '')) || BodyHash(JSON.stringify(payload.snapshot)) !== String(payload.checksum).toLowerCase()) throw new Error('REPLICATION_CHECKSUM_MISMATCH');
            const current = require('../storage/sqliteDatabase').Status();
            if (Number(payload.revision) <= Number(current.revision)) {
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: true, stale: true, revision: current.revision }));
                return true;
            }
            if (!require('../storage/database').ImportDatabaseObject(payload.snapshot)) throw new Error('INVALID_SNAPSHOT');
            if (!require('../storage/database').SaveDatabase({ replicated: true, revision: Number(payload.revision), sourceInstance: payload.instanceId })) throw new Error('SQLITE_SAVE_FAILED');
            runtime.lastPeerSeenAt = Date.now();
            runtime.lastReplicationAt = Date.now();
            runtime.lastReplicationRevision = Number(payload.revision);
            runtime.latestSnapshot = payload.snapshot;
            runtime.latestSave = { revision: Number(payload.revision), savedAt: Number(payload.savedAt) || Date.now(), checksum: String(payload.checksum) };
            runtime.peer = { instanceId: payload.instanceId, priority: Number(payload.priority), role: 'ACTIVE' };
            SetRole('STANDBY', 'REPLICATION_FROM_LEADER');
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, revision: payload.revision }));
        } catch (error) {
            res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: error.message }));
        }
        return true;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    return true;
}

module.exports = { Start, Status, CanAcceptTraffic, OnLocalSnapshot, HandleInternal };
