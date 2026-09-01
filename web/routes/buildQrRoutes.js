'use strict';

const qrApproval = require('../../services/qrApproval');
const buildGate = require('../../services/buildGate');
const { SafeField } = require('../../core/utils');
const { LogEvent } = require('../../storage/audit');

async function Handle(context) {
    const {
        method, pathname, body, res, session,
        BuildServers, RequireAdmin, Json, ApiError
    } = context;

    if (method === 'GET' && pathname === '/api/qr-auth') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, requests: qrApproval.List(), summary: qrApproval.Summary() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/build-sessions') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, {
            ok: true,
            summary: buildGate.Summary(),
            sessions: buildGate.List(),
            bindings: buildGate.Bindings(),
            servers: BuildServers().map(item => ({ id: item.id, alias: item.alias, status: item.status, online: item.online }))
        });
        return true;
    }

    if (method === 'POST' && pathname === '/api/build-sessions/policy') {
        if (!RequireAdmin(res, session)) return true;
        const result = buildGate.SetPolicy(
            { ttlMinutes: Number(body.ttlMinutes) },
            `WEB_${String(session.role || 'ADMIN').toUpperCase()}`
        );
        if (!result.ok) { ApiError(res, 400, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    let match = pathname.match(/^\/api\/build-sessions\/(BLS-[0-9A-Fa-f]{32})\/revoke$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const result = buildGate.Revoke(
            match[1], body.reason || 'ADMIN_REVOKE',
            `WEB_${String(session.role || 'ADMIN').toUpperCase()}`
        );
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    match = pathname.match(/^\/api\/build-bindings\/([0-9A-Fa-f]{16})\/rebind$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const result = buildGate.Rebind(
            match[1], body.serverId,
            `WEB_${String(session.role || 'ADMIN').toUpperCase()}`
        );
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    if (method === 'POST' && pathname === '/api/qr-auth/scan') {
        if (!RequireAdmin(res, session)) return true;
        try {
            const result = qrApproval.ScanImage(body.imageData || '');
            LogEvent('QR_AUTH_SCANNED', `${result.request.requestId} -> ${result.request.clientId} / ${session.role}`);
            Json(res, 200, { ok: true, ...result });
        } catch (error) {
            const code = String(error && error.message || 'QR_SCAN_FAILED');
            LogEvent('QR_AUTH_SCAN_FAILED', `${code} / ${session.role}`);
            ApiError(res, code.includes('EXPIRED') || code.includes('APPROVED') || code.includes('REJECTED') ? 409 : 400, code);
        }
        return true;
    }

    if (method === 'POST' && pathname === '/api/qr-auth/approve') {
        if (!RequireAdmin(res, session)) return true;
        const result = qrApproval.Approve(body.requestId, body.approvalToken, {
            days: body.days,
            memo: body.memo,
            tags: body.tags,
            accessType: body.accessType
        }, session.role);
        if (!result.ok) {
            LogEvent('QR_AUTH_APPROVE_FAILED', `${SafeField(body.requestId || '').slice(0, 40)} / ${result.reason} / ${session.role}`);
            ApiError(res, 409, result.reason);
            return true;
        }
        Json(res, 200, result);
        return true;
    }

    if (method === 'POST' && pathname === '/api/qr-auth/reject') {
        if (!RequireAdmin(res, session)) return true;
        const result = qrApproval.Reject(body.requestId, body.reason, session.role);
        if (!result.ok) {
            LogEvent('QR_AUTH_REJECT_FAILED', `${SafeField(body.requestId || '').slice(0, 40)} / ${result.reason} / ${session.role}`);
            ApiError(res, 409, result.reason);
            return true;
        }
        Json(res, 200, result);
        return true;
    }

    return false;
}

module.exports = { Handle };
