'use strict';
const { state, NormalizeID, NormalizeLicenseKey, FindLicense, CreateLicense, ExtendLicense, UnbindLicense, SuspendLicense, ResumeLicense, DeleteLicense, ReissueLicense, TransferLicense, SetLicenseTags, SaveDatabase, LogEvent, Json, ApiError, DecodePart, RequireAdmin, RequireOperation, BuildLicenses } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method !== 'GET' && /^\/api\/licenses(?:\/|$)/.test(pathname) && !state.serviceEnabled) {
        ApiError(res, 409, 'SERVICE_DISABLED'); return true;
    }
    if (method === 'GET' && pathname === '/api/licenses') {
        if (!RequireOperation(res, session, 'LIST')) return true;
        Json(res, 200, {
            ok: true,
            licenses: BuildLicenses(url.searchParams.get('query') || '', url.searchParams.get('status') || 'ALL', url.searchParams.get('expiry') || 'ALL')
        });
        return true;
    }

    if (method === 'POST' && pathname === '/api/licenses') {
        if (!RequireAdmin(res, session)) return true;
        const days = Number(body.days);
        if (!Number.isInteger(days) || days <= 0 || days > 36500) { ApiError(res, 400, 'INVALID_DAYS'); return true; }
        const created = CreateLicense(days, body.memo || '', body.tags || []);
        Json(res, 201, { ok: true, ...created });
        return true;
    }

    match = pathname.match(/^\/api\/licenses\/([^/]+)\/tags$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'EXTEND')) return true;
        const key = NormalizeLicenseKey(DecodePart(match[1]));
        if (!FindLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return true; }
        const tags = SetLicenseTags(key, body.tags || []);
        Json(res, 200, { ok: true, key, tags });
        return true;
    }

    if (method === 'POST' && pathname === '/api/licenses/bulk') {
        const bulk = require('../../license/bulkActions');
        const input = bulk.Validate(body);
        if (!input.ok) { ApiError(res, 400, input.reason); return true; }
        const permission = bulk.ACTIONS[input.action];
        if (permission === 'ADMIN' ? !RequireAdmin(res, session) : !RequireOperation(res, session, permission)) return true;
        if (!state.serviceEnabled) { ApiError(res, 409, 'SERVICE_DISABLED'); return true; }
        const result = bulk.Execute(input);
        LogEvent('WEB_LICENSE_BULK', `${input.action} ${result.success}/${result.total}`);
        Json(res, 200, result);
        return true;
    }

    match = pathname.match(/^\/api\/licenses\/([^/]+)\/(extend|unbind|suspend|resume|reissue|transfer|delete)$/);
    if (method === 'POST' && match) {
        const key = NormalizeLicenseKey(DecodePart(match[1]));
        const action = match[2];
        if (!FindLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return true; }

        if (action === 'reissue' || action === 'delete') {
            if (!RequireAdmin(res, session)) return true;
        } else {
            const permission = { extend: 'EXTEND', unbind: 'UNBIND', suspend: 'SUSPEND', resume: 'RESUME', transfer: 'TRANSFER' }[action];
            if (!RequireOperation(res, session, permission)) return true;
        }

        if (action === 'extend') {
            const days = Number(body.days);
            if (!Number.isInteger(days) || days <= 0 || days > 36500) { ApiError(res, 400, 'INVALID_DAYS'); return true; }
            if (!ExtendLicense(key, days)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return true; }
            SaveDatabase(); LogEvent('LICENSE_EXTEND', `${key} +${days}`);
            Json(res, 200, { ok: true, key, expiresAt: FindLicense(key).expiresAt });
            return true;
        }
        if (action === 'unbind') {
            if (!UnbindLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return true; }
            SaveDatabase(); LogEvent('LICENSE_UNBIND', key); Json(res, 200, { ok: true, key }); return true;
        }
        if (action === 'suspend') {
            if (!SuspendLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return true; }
            SaveDatabase(); LogEvent('LICENSE_SUSPEND', key); Json(res, 200, { ok: true, key }); return true;
        }
        if (action === 'resume') {
            if (!ResumeLicense(key)) { ApiError(res, 400, 'NOT_FOUND_OR_EXPIRED'); return true; }
            SaveDatabase(); LogEvent('LICENSE_RESUME', key); Json(res, 200, { ok: true, key }); return true;
        }
        if (action === 'reissue') {
            const result = ReissueLicense(key);
            if (!result) { ApiError(res, 400, 'REISSUE_FAILED'); return true; }
            Json(res, 200, { ok: true, ...result }); return true;
        }
        if (action === 'transfer') {
            const result = TransferLicense(key, body.clientId || '');
            if (!result.ok) { ApiError(res, 400, result.reason); return true; }
            Json(res, 200, { ok: true, key, clientId: NormalizeID(body.clientId || '') }); return true;
        }
        if (action === 'delete') {
            if (!DeleteLicense(key)) { ApiError(res, 404, 'LICENSE_NOT_FOUND'); return true; }
            SaveDatabase(); LogEvent('LICENSE_DELETE', key); Json(res, 200, { ok: true, key }); return true;
        }
    }


    return false;
}
module.exports = { Handle };
