'use strict';
const { state, NormalizeVersion, SafeField, SendLine, NoticeAll, SaveDatabase, LogEvent, EnforceVersionPolicy, BuildSystemHealth, ClientIP, maintenanceService, CURRENT_PROTOCOL_VERSION, Json, ApiError, RequireAdmin, RequireOperation, BuildSystem } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method === 'GET' && pathname === '/api/system/health') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, health: BuildSystemHealth() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/system') {
        if (!RequireOperation(res, session, 'VERSION_STATUS')) return true;
        Json(res, 200, { ok: true, system: BuildSystem() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/service/start') {
        if (!RequireAdmin(res, session)) return true;
        const result = require('../../services/serviceLifecycle').Start(`WEB ${ClientIP(req)}`);
        if (!result.ok) { ApiError(res, 500, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/service/stop') {
        if (!RequireAdmin(res, session)) return true;
        const result = require('../../services/serviceLifecycle').Stop(`WEB ${ClientIP(req)}`);
        if (!result.ok) { ApiError(res, 500, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/on') {
        if (!RequireAdmin(res, session)) return true;
        if (!state.serviceEnabled) { ApiError(res, 409, 'SERVICE_DISABLED'); return true; }
        state.maintenanceMode = true;
        SaveDatabase();
        for (const c of state.clients.values()) if (!c.licenseAuthorized) SendLine(c.socket, 'SERVICE_STATE|MAINTENANCE');
        LogEvent('MAINTENANCE_ON', `WEB ${ClientIP(req)}`);
        Json(res, 200, { ok: true });
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/off') {
        if (!RequireAdmin(res, session)) return true;
        state.maintenanceMode = false;
        SaveDatabase();
        for (const c of state.clients.values()) SendLine(c.socket, 'SERVICE_STATE|ONLINE');
        LogEvent('MAINTENANCE_OFF', `WEB ${ClientIP(req)}`);
        Json(res, 200, { ok: true });
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/schedule') {
        if (!RequireAdmin(res, session)) return true;
        const result = maintenanceService.ScheduleMaintenance({
            startAt: Number(body.startAt),
            endAt: Number(body.endAt),
            message: SafeField(body.message || 'Scheduled maintenance'),
            autoDrain: Boolean(body.autoDrain),
            drainLeadMinutes: Number(body.drainLeadMinutes) || 0,
            forceStart: Boolean(body.forceStart)
        });
        if (!result.ok) { ApiError(res, 400, result.reason || 'INVALID_TIME'); return true; }
        Json(res, 200, result);
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/maintenance/clear') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, maintenanceService.ClearMaintenanceSchedule('WEB'));
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/version') {
        if (!RequireAdmin(res, session)) return true;
        const protocol = Number(body.protocol);
        const serverVersion = NormalizeVersion(body.serverVersion);
        const clientVersion = NormalizeVersion(body.clientVersion);
        if (!Number.isInteger(protocol) || protocol < 1 || protocol > CURRENT_PROTOCOL_VERSION || !serverVersion || !clientVersion) {
            ApiError(res, 400, 'INVALID_VERSION');
            return true;
        }
        state.minProtocolVersion = protocol;
        state.minServerVersion = serverVersion;
        state.minClientVersion = clientVersion;
        SaveDatabase();
        LogEvent('VERSION_POLICY_CHANGED', `P=${protocol} S=${serverVersion} C=${clientVersion}`);
        setTimeout(EnforceVersionPolicy, 250);
        Json(res, 200, { ok: true, protocol, serverVersion, clientVersion });
        return true;
    }

    if (method === 'POST' && pathname === '/api/system/notice') {
        if (!RequireOperation(res, session, 'NOTICE')) return true;
        const message = SafeField(body.message || '');
        if (!message) { ApiError(res, 400, 'MESSAGE_REQUIRED'); return true; }
        const count = NoticeAll(message);
        Json(res, 200, { ok: true, count });
        return true;
    }


    return false;
}
module.exports = { Handle };
