'use strict';
const { LogEvent, CheckCurrentDatabase, BuildStatistics, processorCenter, pushManager, dailyHealth, Json, ApiError, RequireAdmin, RequireOperation, GlobalSearch } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method === 'GET' && pathname === '/api/system/integrity') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, integrity: CheckCurrentDatabase() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/statistics') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return true;
        Json(res, 200, { ok: true, statistics: BuildStatistics(url.searchParams.get('range') || '1H') });
        return true;
    }

    if (method === 'GET' && pathname === '/api/processors') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, processors: processorCenter.Overview() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/processors/policy') {
        if (!RequireAdmin(res, session)) return true;
        try {
            const result = processorCenter.SetPolicy(body);
            Json(res, 200, { ok: true, ...result });
        } catch (error) {
            ApiError(res, 400, error.message || 'INVALID_PROCESSOR_POLICY');
        }
        return true;
    }

    if (method === 'POST' && pathname === '/api/processors/push') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, pushes: processorCenter.PushAll() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/processors/stats/reset') {
        if (!RequireAdmin(res, session)) return true;
        processorCenter.ResetStats();
        Json(res, 200, { ok: true });
        return true;
    }

    if (method === 'GET' && pathname === '/api/push/status') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return true;
        Json(res, 200, { ok: true, push: pushManager.Status() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/push/subscribe') {
        if (!RequireAdmin(res, session)) return true;
        try {
            const result = pushManager.Subscribe(body.subscription, { role: session.role, userAgent: req.headers['user-agent'] || '' });
            Json(res, 200, { ok: true, ...result });
        } catch (error) {
            ApiError(res, 400, error.message || 'PUSH_SUBSCRIBE_FAILED');
        }
        return true;
    }

    if (method === 'POST' && pathname === '/api/push/unsubscribe') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, removed: pushManager.Unsubscribe(body.endpoint || body.id || '') });
        return true;
    }

    if (method === 'POST' && pathname === '/api/push/test') {
        if (!RequireAdmin(res, session)) return true;
        const result = await pushManager.Send({ title: 'Relay Push Test', body: 'Web Admin Push 알림이 정상적으로 연결되었습니다.', severity: 'INFO', type: 'PUSH_TEST', url: '/?view=notifications' }, { force: true });
        Json(res, result.ok ? 200 : 409, { ok: result.ok, ...result, error: result.ok ? undefined : result.reason });
        return true;
    }

    if (method === 'GET' && pathname === '/api/reports/daily') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, daily: dailyHealth.Overview(Number(url.searchParams.get('limit') || 90)) });
        return true;
    }

    if (method === 'POST' && pathname === '/api/reports/daily/generate') {
        if (!RequireAdmin(res, session)) return true;
        const report = dailyHealth.GenerateCurrent(`MANUAL:${session.role}`);
        LogEvent('DAILY_HEALTH_MANUAL', report.date);
        Json(res, 200, { ok: true, report });
        return true;
    }

    if (method === 'GET' && pathname === '/api/search') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return true;
        Json(res, 200, { ok: true, results: GlobalSearch(url.searchParams.get('q') || '') });
        return true;
    }


    

    return false;
}
module.exports = { Handle };
