'use strict';
const { NormalizeID, LogEvent, loadSimulator, storageMigration, securityDashboard, networkSecurity, emergencyFailover, Json, ApiError, DecodePart, RequireAdmin, RequireOperation } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method === 'GET' && pathname === '/api/load-simulator') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, simulator: loadSimulator.Overview() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/load-simulator/command') {
        if (!RequireAdmin(res, session)) return true;
        const options = loadSimulator.NormalizeOptions(body || {});
        Json(res, 200, { ok: true, options, command: loadSimulator.BuildCommand(options) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/storage/migration/status') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, migration: storageMigration.Status() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/storage/migration/schema') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, schema: storageMigration.Schema() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/storage/migration/export') {
        if (!RequireAdmin(res, session)) return true;
        const result = storageMigration.ExportBundle();
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        LogEvent('SQLITE_MIGRATION_EXPORT', `${result.directory} ${result.checksum}`);
        Json(res, 201, result);
        return true;
    }

    if (method === 'GET' && pathname === '/api/security/dashboard') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, security: securityDashboard.Build() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/security/network') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, summary: networkSecurity.Summary(), devices: networkSecurity.Overview(), geo: networkSecurity.GeoStatus() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/security/network/trust') {
        if (!RequireAdmin(res, session)) return true;
        const type = String(body.type || '').toUpperCase();
        const id = NormalizeID(body.id);
        if (!['SERVER', 'CLIENT'].includes(type) || !id) { ApiError(res, 400, 'INVALID_DEVICE'); return true; }
        if (!networkSecurity.Trust(type, id)) { ApiError(res, 404, 'NETWORK_PROFILE_NOT_FOUND'); return true; }
        Json(res, 200, { ok: true, profile: networkSecurity.Get(type, id) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/failover') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, failover: emergencyFailover.BuildStatus() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/failover/policy') {
        if (!RequireAdmin(res, session)) return true;
        const policy = emergencyFailover.SetPolicy({
            enabled: Boolean(body.enabled),
            autoReturn: body.autoReturn !== false,
            offlineGraceSeconds: Number(body.offlineGraceSeconds),
            returnGraceSeconds: Number(body.returnGraceSeconds),
            maxMovesPerCycle: Number(body.maxMovesPerCycle)
        });
        Json(res, 200, { ok: true, policy });
        return true;
    }

    if (method === 'POST' && pathname === '/api/failover/run') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, result: emergencyFailover.Evaluate(), failover: emergencyFailover.BuildStatus() });
        return true;
    }

    match = pathname.match(/^\/api\/failover\/clients\/([^/]+)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        const result = emergencyFailover.SetClientEnabled(id, Boolean(body.enabled));
        if (!result.ok) { ApiError(res, 404, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    match = pathname.match(/^\/api\/failover\/clients\/([^/]+)\/return$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        const result = emergencyFailover.ReturnToPrimary(id, true);
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    match = pathname.match(/^\/api\/failover\/clients\/([^/]+)\/binding$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const result = emergencyFailover.SetBinding(
            DecodePart(match[1]),
            body.primaryServerId,
            body.backupServerId,
            Boolean(body.allowAutomaticFallback)
        );
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    match = pathname.match(/^\/api\/failover\/clients\/([^/]+)\/binding\/clear$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const result = emergencyFailover.ClearBinding(DecodePart(match[1]));
        if (!result.ok) { ApiError(res, 404, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }


    return false;
}
module.exports = { Handle };
