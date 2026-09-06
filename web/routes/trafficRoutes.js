'use strict';
const { ListNotifications, NotificationSummary, MarkRead, MarkAllRead, ClearNotifications, requestRecovery, Json, ApiError, DecodePart, RequireAdmin, RequireOperation } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method === 'GET' && pathname === '/api/notifications') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return true;
        Json(res, 200, {
            ok: true,
            summary: NotificationSummary(),
            notifications: ListNotifications({
                unreadOnly: url.searchParams.get('unread') === '1',
                severity: url.searchParams.get('severity') || 'ALL',
                limit: Number(url.searchParams.get('limit') || 200)
            })
        });
        return true;
    }

    match = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'DASHBOARD')) return true;
        if (!MarkRead(DecodePart(match[1]), body.read !== false)) { ApiError(res, 404, 'NOTIFICATION_NOT_FOUND'); return true; }
        Json(res, 200, { ok: true, summary: NotificationSummary() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/notifications/read-all') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return true;
        MarkAllRead();
        Json(res, 200, { ok: true, summary: NotificationSummary() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/notifications/clear') {
        if (!RequireAdmin(res, session)) return true;
        ClearNotifications();
        Json(res, 200, { ok: true, summary: NotificationSummary() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/request-traces') {
        if (!RequireOperation(res, session, 'DASHBOARD')) return true;
        const traces = require('../../services/requestTrace').SearchTraces(url.searchParams.get('query') || '');
        Json(res, 200, { ok: true, traces });
        return true;
    }

    if (method === 'POST' && pathname === '/api/request-traces/replay') {
        if (!RequireAdmin(res, session)) return true;
        const result = requestRecovery.ReplayTrace(String(body.key || ''), session.role);
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    if (method === 'GET' && pathname === '/api/request-recovery') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, recovery: requestRecovery.BuildStatus(url.searchParams.get('query') || '') });
        return true;
    }

    if (method === 'POST' && pathname === '/api/request-recovery/policy') {
        if (!RequireAdmin(res, session)) return true;
        const policy = requestRecovery.SetPolicy({
            enabled: Boolean(body.enabled),
            maxItemsPerClient: Number(body.maxItemsPerClient),
            ttlSeconds: Number(body.ttlSeconds),
            maxDeliveryAttempts: Number(body.maxDeliveryAttempts)
        });
        Json(res, 200, { ok: true, policy });
        return true;
    }

    match = pathname.match(/^\/api\/request-recovery\/clients\/([^/]+)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const result = requestRecovery.SetClientEnabled(DecodePart(match[1]), Boolean(body.enabled));
        if (!result.ok) { ApiError(res, 404, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }

    match = pathname.match(/^\/api\/dead-letters\/([^/]+)\/(retry|discard)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = DecodePart(match[1]);
        const result = match[2] === 'retry'
            ? requestRecovery.RetryDeadLetter(id, session.role)
            : requestRecovery.DiscardDeadLetter(id, session.role);
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }


    return false;
}
module.exports = { Handle };
