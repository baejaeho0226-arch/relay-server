'use strict';
// Request parsing and authorization gates precede every feature route.
const { config, buildQrRoutes, productionRoutes, deviceRegistry, historyCleanup, Json, ApiError, RequireAdmin, RequireOperation, ReadJsonBody, BuildDashboard, BuildServers } = require('./apiContext');

async function HandleApiRequest(req, res, session) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = String(req.method || 'GET').toUpperCase();
    let body = {};

    if (!['GET', 'HEAD'].includes(method)) {
        const maxBodyBytes = pathname === '/api/qr-auth/scan'
            ? Math.ceil(config.QR_AUTH_MAX_IMAGE_BYTES * 1.4) + 64 * 1024
            : 128 * 1024;
        try { body = await ReadJsonBody(req, maxBodyBytes); }
        catch (error) { ApiError(res, error.message === 'BODY_TOO_LARGE' ? 413 : 400, error.message); return; }
    }

    if (!['GET', 'HEAD'].includes(method) && pathname !== '/api/logout' && !require('../services/haCoordinator').CanAcceptTraffic()) {
        ApiError(res, 409, 'RELAY_STANDBY_READ_ONLY');
        return;
    }

    if (!['GET','HEAD'].includes(method) && require('../services/privilegedApproval').Required(pathname)) {
        const ticketId = String(req.headers['x-approval-ticket'] || '');
        const approval = require('../services/privilegedApproval').Consume(ticketId, session, method, pathname, body);
        if (!approval.ok) {
            if (approval.reason === 'DUAL_APPROVAL_REQUIRED') {
                const requested = require('../services/privilegedApproval').Request(session, method, pathname, body, 'AUTO_GUARD');
                ApiError(res, 428, approval.reason, requested.ok ? requested.ticket.ticketId : '');
            } else ApiError(res, 428, approval.reason);
            return;
        }
    }

    if (method === 'GET' && pathname === '/api/ha/status') {
        if (!RequireOperation(res, session, 'VIEW')) return;
        Json(res, 200, { ok: true, ha: require('../services/haCoordinator').Status() });
        return;
    }

    if (method === 'GET' && pathname === '/api/dashboard') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return;
        Json(res, 200, { ok: true, dashboard: BuildDashboard() });
        return;
    }

    if (method === 'POST' && pathname === '/api/pairing/repair') {
        if (!RequireAdmin(res, session)) return;
        const repair = deviceRegistry.RepairPairing();
        Json(res, 200, { ok: true, repair });
        return;
    }

    if (method === 'POST' && pathname === '/api/history/clean') {
        if (!RequireAdmin(res, session)) return;
        const result = historyCleanup.Clean(body.scope, `WEB_${String(session.role || 'ADMIN').toUpperCase()}`);
        if (!result.ok) { ApiError(res, 400, result.reason); return; }
        Json(res, 200, result);
        return;
    }

    if (await require('./routes/supportInstallationRoutes').Handle({
        method, pathname, url, body, res, session, RequireAdmin, Json, ApiError
    })) return;

    if (await buildQrRoutes.Handle({
        method, pathname, body, res, session,
        BuildServers, RequireAdmin, Json, ApiError
    })) return;

    if (await productionRoutes.Handle({
        method, pathname, body, req, res, session,
        RequireAdmin, Json, ApiError
    })) return;

    const context = { method, pathname, url, body, req, res, session };
    if (await require('./routes/memberRoutes').Handle(context)) return;
    if (await require('./routes/deviceRoutes').Handle(context)) return;
    if (await require('./routes/licenseRoutes').Handle(context)) return;
    if (await require('./routes/trafficRoutes').Handle(context)) return;
    if (await require('./routes/historyRoutes').Handle(context)) return;
    if (await require('./routes/reportRoutes').Handle(context)) return;
    if (await require('./routes/deploymentRoutes').Handle(context)) return;
    if (await require('./routes/infrastructureRoutes').Handle(context)) return;
    if (await require('./routes/systemRoutes').Handle(context)) return;
    ApiError(res, 404, 'NOT_FOUND');
}

module.exports = {
    Json,
    ApiError,
    ReadJsonBody,
    HandleApiRequest,
    BuildServers
};
