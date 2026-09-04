'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('../config/config');
const state = require('../core/state');
const { NormalizeID, Now, SafeField, SafeIP, SendLine } = require('../core/utils');
const { GetOnlineClient, FindClientDeviceKey } = require('../identity/identityManager');
const { GetBoundLicenseEntry, CreateLicense, AuthorizeClientByQr, AuthorizeBoundClientByQr } = require('../license/licenseManager');
const { DecodeQrImage } = require('./qrImageDecoder');

const ephemeralSecret = crypto.randomBytes(32).toString('base64url');

function SigningSecret() { return config.QR_APPROVAL_SECRET || ephemeralSecret; }
function Hash(value) { return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex'); }
function Sign(value) { return crypto.createHmac('sha256', SigningSecret()).update(value, 'utf8').digest('hex').toUpperCase(); }
function EqualHex(a, b) {
    try {
        const aa = Buffer.from(String(a || ''), 'hex');
        const bb = Buffer.from(String(b || ''), 'hex');
        return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
    } catch (_) { return false; }
}

function PublicRecord(record) {
    if (!record) return null;
    return {
        requestId: record.requestId,
        clientId: record.clientId,
        deviceKey: record.deviceKey,
        status: record.status,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        approvedAt: record.approvedAt || 0,
        approvedBy: record.approvedBy || '',
        rejectedAt: record.rejectedAt || 0,
        rejectedBy: record.rejectedBy || '',
        reason: record.reason || '',
        licenseRef: record.licenseRef || (record.licenseKey ? `QR-${String(record.licenseKey).slice(-8)}` : ''),
        serverId: NormalizeID(record.serverId),
        accessType: require('./accessType').NormalizeAccessType(record.accessType),
        lastIP: record.lastIP || '',
        scanCount: Number(record.scanCount || 0)
    };
}

function BuildPayload(requestId, clientId, expiresAt, token) {
    const base = `1|${requestId}|${clientId}|${expiresAt}|${token}`;
    const signature = Sign(base);
    return `relayqr://approve?v=1&r=${encodeURIComponent(requestId)}&c=${encodeURIComponent(clientId)}&e=${expiresAt}&t=${encodeURIComponent(token)}&s=${signature}`;
}

function ParsePayload(payload) {
    let url;
    try { url = new URL(String(payload || '')); }
    catch (_) { throw new Error('QR_PAYLOAD_INVALID'); }
    if (url.protocol !== 'relayqr:' || url.hostname !== 'approve') throw new Error('QR_PAYLOAD_INVALID');
    const version = url.searchParams.get('v') || '';
    const requestId = String(url.searchParams.get('r') || '').toUpperCase();
    const clientId = NormalizeID(url.searchParams.get('c') || '');
    const expiresAt = Number(url.searchParams.get('e') || 0);
    const token = String(url.searchParams.get('t') || '');
    const signature = String(url.searchParams.get('s') || '').toUpperCase();
    if (version !== '1' || !/^QRA-[0-9A-F]{24}$/.test(requestId) || !clientId || !Number.isSafeInteger(expiresAt) || !/^[A-Za-z0-9_-]{40,64}$/.test(token) || !/^[0-9A-F]{64}$/.test(signature)) throw new Error('QR_PAYLOAD_INVALID');
    const expected = Sign(`${version}|${requestId}|${clientId}|${expiresAt}|${token}`);
    if (!EqualHex(signature, expected)) throw new Error('QR_SIGNATURE_INVALID');
    return { version, requestId, clientId, expiresAt, token, signature };
}

function ApprovalToken(record) {
    return Sign(`APPROVE|${record.requestId}|${record.clientId}|${record.tokenHash}|${record.expiresAt}`);
}

function VerifyApprovalToken(record, value) {
    return EqualHex(String(value || '').toUpperCase(), ApprovalToken(record));
}

function QrMatrix(payload) {
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    let bits = '';
    for (let i = 0; i < qr.modules.data.length; i++) bits += qr.modules.data[i] ? '1' : '0';
    return { size, bits };
}

function RequireQrSecurity(connection) {
    if (!connection || !connection.connected || !connection.clientId) return { ok: false, reason: 'CLIENT_NOT_CONNECTED' };
    const deviceAuth = require('./deviceAuth');
    const capabilities = require('./deviceControl').Capabilities('CLIENT', connection.clientId);
    if (!capabilities.includes('QR_DEVICE_APPROVAL') || !capabilities.includes('DEVICE_HMAC')) {
        SendLine(connection.socket, 'QR_AUTH_ERROR||CAPABILITY_REQUIRED');
        return { ok: false, reason: 'CAPABILITY_REQUIRED' };
    }
    if (!deviceAuth.Verified('CLIENT', connection.clientId)) {
        SendLine(connection.socket, 'ERROR|DEVICE_AUTH_REQUIRED');
        deviceAuth.IssueChallenge('CLIENT', connection.clientId);
        return { ok: false, reason: 'DEVICE_AUTH_REQUIRED' };
    }
    return { ok: true };
}

function SupersedePending(clientId) {
    const now = Now();
    for (const record of state.qrAuthRequests.values()) {
        if (record.clientId === clientId && record.status === 'PENDING') {
            record.status = 'SUPERSEDED';
            record.reason = 'NEW_QR_ISSUED';
            record.rejectedAt = now;
        }
    }
}

function Issue(connection) {
    const gate = RequireQrSecurity(connection);
    if (!gate.ok) return gate;
    SupersedePending(connection.clientId);
    const requestId = `QRA-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    const token = crypto.randomBytes(32).toString('base64url');
    const issuedAt = Now();
    const expiresAt = issuedAt + config.QR_AUTH_TTL_MS;
    const payload = BuildPayload(requestId, connection.clientId, expiresAt, token);
    const matrix = QrMatrix(payload);
    const record = {
        requestId,
        clientId: connection.clientId,
        deviceKey: FindClientDeviceKey(connection.clientId) || '',
        tokenHash: Hash(token),
        issuedAt,
        expiresAt,
        status: 'PENDING',
        approvedAt: 0,
        approvedBy: '',
        rejectedAt: 0,
        rejectedBy: '',
        reason: '',
        licenseKey: '',
        licenseRef: '',
        accessType: 'TYPE1',
        lastIP: SafeIP(connection.socket),
        scanCount: 0
    };
    state.qrAuthRequests.set(requestId, record);
    Cleanup(false);
    require('../storage/database').SaveDatabase();
    // Include a relative duration as well as the absolute audit timestamp.
    // Android renders this against a monotonic clock, so an incorrect device
    // wall clock cannot turn a 10-minute token into 10:01 or two minutes.
    const remainingMs = Math.max(0, expiresAt - Now());
    SendLine(connection.socket, `QR_AUTH_CHALLENGE|${requestId}|${expiresAt}|${matrix.size}|${matrix.bits}|${remainingMs}`);
    require('../storage/audit').LogEvent('QR_AUTH_ISSUED', `${requestId} -> ${connection.clientId}`);
    return { ok: true, request: PublicRecord(record) };
}

function Resume(connection) {
    const gate = RequireQrSecurity(connection);
    if (!gate.ok) return gate;
    const bound = GetBoundLicenseEntry(connection.clientId);
    if (bound && !bound.license.suspended && Now() < Number(bound.license.expiresAt || 0)) {
        return { ok: AuthorizeBoundClientByQr(connection, 'RESUME'), resumed: true };
    }
    return Issue(connection);
}

function Status(connection, requestId) {
    const gate = RequireQrSecurity(connection);
    if (!gate.ok) return gate;
    requestId = String(requestId || '').toUpperCase();
    const record = state.qrAuthRequests.get(requestId);
    if (!record || record.clientId !== connection.clientId) {
        SendLine(connection.socket, `QR_AUTH_ERROR|${requestId}|REQUEST_NOT_FOUND`);
        return { ok: false, reason: 'REQUEST_NOT_FOUND' };
    }
    if (record.status === 'PENDING' && record.expiresAt <= Now()) {
        record.status = 'EXPIRED';
        record.reason = 'TIMEOUT';
        require('../storage/database').SaveDatabase();
    }
    if (record.status === 'APPROVED') {
        const ok = AuthorizeBoundClientByQr(connection, record.requestId);
        return { ok, status: record.status };
    }
    if (record.status === 'PENDING') {
        const remainingMs = Math.max(0, Number(record.expiresAt || 0) - Now());
        SendLine(connection.socket, `QR_AUTH_PENDING|${requestId}|${record.expiresAt}|${remainingMs}`);
    }
    else if (record.status === 'EXPIRED' || record.status === 'SUPERSEDED') SendLine(connection.socket, `QR_AUTH_EXPIRED|${requestId}|${record.reason || record.status}`);
    else if (record.status === 'REJECTED') SendLine(connection.socket, `QR_AUTH_REJECTED|${requestId}|${record.reason || 'ADMIN_REJECTED'}`);
    return { ok: true, status: record.status };
}

function InspectPayload(payload) {
    const parsed = ParsePayload(payload);
    const record = state.qrAuthRequests.get(parsed.requestId);
    if (!record || record.clientId !== parsed.clientId || record.expiresAt !== parsed.expiresAt) throw new Error('QR_REQUEST_NOT_FOUND');
    if (record.status !== 'PENDING') throw new Error(`QR_REQUEST_${record.status}`);
    if (record.expiresAt <= Now()) {
        record.status = 'EXPIRED';
        record.reason = 'TIMEOUT';
        require('../storage/database').SaveDatabase();
        throw new Error('QR_REQUEST_EXPIRED');
    }
    if (record.tokenHash !== Hash(parsed.token)) throw new Error('QR_TOKEN_INVALID');
    record.scanCount = Number(record.scanCount || 0) + 1;
    record.lastScannedAt = Now();
    require('../storage/database').SaveDatabase();
    return { request: PublicRecord(record), approvalToken: ApprovalToken(record) };
}

function ScanImage(imageData) {
    return InspectPayload(DecodeQrImage(imageData));
}

function Approve(requestId, approvalToken, options = {}, actor = 'admin') {
    requestId = String(requestId || '').toUpperCase();
    const record = state.qrAuthRequests.get(requestId);
    if (!record) return { ok: false, reason: 'QR_REQUEST_NOT_FOUND' };
    if (record.status !== 'PENDING') return { ok: false, reason: `QR_REQUEST_${record.status}` };
    if (record.expiresAt <= Now()) {
        record.status = 'EXPIRED';
        record.reason = 'TIMEOUT';
        require('../storage/database').SaveDatabase();
        return { ok: false, reason: 'QR_REQUEST_EXPIRED' };
    }
    if (!VerifyApprovalToken(record, approvalToken)) return { ok: false, reason: 'QR_APPROVAL_TOKEN_INVALID' };

    // QR/biometric enrollment belongs to the APK and never depends on a running
    // WinSockServer. A returning client keeps its fixed server identity; a new
    // client remains unassigned until an authenticated WinSockServer claims
    // its pending Build request.
    const existingSaved = require('../identity/identityManager').GetSavedClientByID(record.clientId);
    record.serverId = existingSaved ? NormalizeID(existingSaved.serverId) : '';

    const days = Math.max(1, Math.min(3650, Number(options.days) || config.QR_AUTH_DEFAULT_DAYS));
    const memo = SafeField(options.memo || `QR 승인 ${record.clientId}`).slice(0, 200);
    const tags = require('../license/licenseManager').NormalizeTags([...(Array.isArray(options.tags) ? options.tags : []), 'QR']);
    const accessType = require('./accessType').NormalizeAccessType(options.accessType);
    let bound = GetBoundLicenseEntry(record.clientId);
    if (bound && (bound.license.suspended || Now() >= Number(bound.license.expiresAt || 0))) {
        bound.license.boundClient = '';
        bound.license.boundAt = 0;
        bound = null;
    }
    if (!bound) {
        const created = CreateLicense(days, memo, tags, 'QR');
        if (!created) return { ok: false, reason: 'LICENSE_CREATE_FAILED' };
        const license = state.licenses.get(created.key);
        license.boundClient = record.clientId;
        license.boundAt = Now();
        bound = { key: created.key, license };
    }

    bound.license.accessType = accessType;
    require('./clientBiometric').SetAccessType(record.clientId, accessType);

    record.status = 'APPROVED';
    record.approvedAt = Now();
    record.approvedBy = SafeField(actor).slice(0, 32);
    record.licenseKey = '';
    record.licenseRef = `QR-${String(bound.key).slice(-8)}`;
    record.accessType = accessType;
    record.reason = '';
    require('../storage/database').SaveDatabase();

    const connection = GetOnlineClient(record.clientId);
    let delivered = false;
    if (connection && connection.connected) {
        const deviceAuth = require('./deviceAuth');
        if (deviceAuth.Verified('CLIENT', record.clientId)) {
            delivered = AuthorizeClientByQr(connection, bound.key, record.requestId);
        }
    }
    require('../storage/audit').LogEvent('QR_AUTH_APPROVED', `${record.requestId} -> ${record.clientId} / ${record.approvedBy}`);
    try { require('./notificationCenter').AddNotification({ severity: 'INFO', type: 'QR_AUTH_APPROVED', title: 'QR 기기 인증 승인', message: `${record.clientId} QR 승인이 완료되었습니다.`, entityType: 'CLIENT', entityId: record.clientId, dedupeKey: `QR_AUTH_APPROVED|${record.requestId}` }); } catch (_) {}
    return {
        ok: true,
        delivered,
        pairing: {
            clientId: record.clientId,
            serverId: record.serverId,
            deferred: !record.serverId
        },
        request: PublicRecord(record),
        expiresAt: bound.license.expiresAt
    };
}

function Reject(requestId, reason = 'ADMIN_REJECTED', actor = 'admin') {
    requestId = String(requestId || '').toUpperCase();
    const record = state.qrAuthRequests.get(requestId);
    if (!record) return { ok: false, reason: 'QR_REQUEST_NOT_FOUND' };
    if (record.status !== 'PENDING') return { ok: false, reason: `QR_REQUEST_${record.status}` };
    record.status = 'REJECTED';
    record.rejectedAt = Now();
    record.rejectedBy = SafeField(actor).slice(0, 32);
    record.reason = SafeField(reason || 'ADMIN_REJECTED').slice(0, 80) || 'ADMIN_REJECTED';
    require('../storage/database').SaveDatabase();
    const connection = GetOnlineClient(record.clientId);
    if (connection) SendLine(connection.socket, `QR_AUTH_REJECTED|${record.requestId}|${record.reason}`);
    require('../storage/audit').LogEvent('QR_AUTH_REJECTED', `${record.requestId} -> ${record.clientId} / ${record.rejectedBy}`);
    return { ok: true, request: PublicRecord(record) };
}

function List() {
    Cleanup(false);
    return Array.from(state.qrAuthRequests.values())
        .sort((a, b) => Number(b.issuedAt || 0) - Number(a.issuedAt || 0))
        .slice(0, config.QR_AUTH_MAX_REQUESTS)
        .map(PublicRecord);
}

function Summary() {
    const counts = { pending: 0, approved: 0, rejected: 0, expired: 0 };
    for (const record of state.qrAuthRequests.values()) {
        const key = String(record.status || '').toLowerCase();
        if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key]++;
    }
    return {
        ...counts,
        ttlMs: config.QR_AUTH_TTL_MS,
        maxImageBytes: config.QR_AUTH_MAX_IMAGE_BYTES,
        defaultDays: config.QR_AUTH_DEFAULT_DAYS,
        durableSigningSecret: Boolean(config.QR_APPROVAL_SECRET)
    };
}

function Cleanup(save = true) {
    const now = Now();
    let changed = false;
    for (const [requestId, record] of state.qrAuthRequests) {
        if (record.status === 'PENDING' && record.expiresAt <= now) {
            record.status = 'EXPIRED';
            record.reason = 'TIMEOUT';
            changed = true;
        }
        if (record.expiresAt < now - 7 * 86400000) {
            state.qrAuthRequests.delete(requestId);
            changed = true;
        }
    }
    const rows = Array.from(state.qrAuthRequests.values()).sort((a, b) => Number(b.issuedAt || 0) - Number(a.issuedAt || 0));
    for (const record of rows.slice(config.QR_AUTH_MAX_REQUESTS)) {
        state.qrAuthRequests.delete(record.requestId);
        changed = true;
    }
    if (changed && save) require('../storage/database').SaveDatabase();
    return changed;
}

function ClearHistory() {
    let removed = 0;
    for (const [requestId, record] of Array.from(state.qrAuthRequests.entries())) {
        if (record && record.status === 'PENDING') continue;
        state.qrAuthRequests.delete(requestId);
        removed++;
    }
    if (removed) require('../storage/database').SaveDatabase();
    return { removed, retainedPending: state.qrAuthRequests.size };
}

function ImportPersisted(data) {
    if (!data || typeof data.qrAuthRequests !== 'object' || !data.qrAuthRequests) return;
    for (const [rawId, raw] of Object.entries(data.qrAuthRequests)) {
        const requestId = String(rawId || '').toUpperCase();
        const clientId = NormalizeID(raw && raw.clientId || '');
        if (!/^QRA-[0-9A-F]{24}$/.test(requestId) || !clientId || !raw || typeof raw !== 'object') continue;
        const tokenHash = String(raw.tokenHash || '').toLowerCase();
        const status = String(raw.status || '').toUpperCase();
        if (!/^[0-9a-f]{64}$/.test(tokenHash) || !['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'].includes(status)) continue;
        const record = {
            requestId,
            clientId,
            deviceKey: String(raw.deviceKey || '').slice(0, 256),
            tokenHash,
            issuedAt: Number(raw.issuedAt) || 0,
            expiresAt: Number(raw.expiresAt) || 0,
            status: status === 'PENDING' && Number(raw.expiresAt) <= Now() ? 'EXPIRED' : status,
            approvedAt: Number(raw.approvedAt) || 0,
            approvedBy: SafeField(raw.approvedBy || '').slice(0, 32),
            rejectedAt: Number(raw.rejectedAt) || 0,
            rejectedBy: SafeField(raw.rejectedBy || '').slice(0, 32),
            reason: SafeField(raw.reason || '').slice(0, 80),
            licenseKey: '',
            licenseRef: String(raw.licenseRef || (raw.licenseKey ? `QR-${String(raw.licenseKey).slice(-8)}` : '')).slice(0, 16),
            accessType: require('./accessType').NormalizeAccessType(raw.accessType),
            lastIP: String(raw.lastIP || '').slice(0, 64),
            scanCount: Math.max(0, Number(raw.scanCount) || 0),
            lastScannedAt: Number(raw.lastScannedAt) || 0
        };
        state.qrAuthRequests.set(requestId, record);
    }
    Cleanup(false);
}

module.exports = {
    BuildPayload,
    ParsePayload,
    Issue,
    Resume,
    Status,
    InspectPayload,
    ScanImage,
    Approve,
    Reject,
    List,
    Summary,
    Cleanup,
    ClearHistory,
    ImportPersisted,
    PublicRecord
};
