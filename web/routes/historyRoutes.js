'use strict';
const { fs, path, CreateBackup, RestoreBackup, AuditSearch, LogEvent, VerifyBackup, ListAdminActivity, ListSessions, RevokeSession, RevokeOtherSessions, RevokeAllSessions, BACKUP_DIR, Json, ApiError, DecodePart, RequireAdmin, RequireOperation, BuildBackups } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method === 'GET' && pathname === '/api/audit') {
        if (!RequireOperation(res, session, 'AUDIT')) return true;
        const query = url.searchParams.get('query') || '';
        const type = url.searchParams.get('type') || 'ALL';
        const since = Number(url.searchParams.get('since') || 0);
        Json(res, 200, { ok: true, events: AuditSearch(query, type, since).slice().reverse() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/backups') {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        Json(res, 200, { ok: true, backups: BuildBackups() });
        return true;
    }

    if (method === 'POST' && pathname === '/api/backups/create') {
        if (!RequireAdmin(res, session)) return true;
        const file = CreateBackup('web_manual');
        if (!file) { ApiError(res, 500, 'BACKUP_FAILED'); return true; }
        Json(res, 201, { ok: true, file });
        return true;
    }

    match = pathname.match(/^\/api\/backups\/([^/]+)\/verify$/);
    if (method === 'GET' && match) {
        if (!RequireOperation(res, session, 'VIEW')) return true;
        const result = VerifyBackup(DecodePart(match[1]));
        Json(res, result.errors && result.errors.some(x => x.code === 'NOT_FOUND') ? 404 : 200, { ok: true, verification: result });
        return true;
    }

    match = pathname.match(/^\/api\/backups\/([^/]+)\/(restore|delete)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const file = path.basename(DecodePart(match[1]));
        const action = match[2];
        if (action === 'restore') {
            const result = RestoreBackup(file);
            if (!result.ok) { ApiError(res, 400, result.reason); return true; }
            Json(res, 200, { ok: true, ...result });
            return true;
        }
        const full = path.join(BACKUP_DIR, file);
        if (!fs.existsSync(full)) { ApiError(res, 404, 'NOT_FOUND'); return true; }
        try {
            fs.unlinkSync(full);
            LogEvent('BACKUP_DELETE', file);
            Json(res, 200, { ok: true, file });
        } catch (_) {
            ApiError(res, 500, 'DELETE_FAILED');
        }
        return true;
    }

    if (method === 'GET' && pathname === '/api/admin-activity') {
        if (!RequireAdmin(res, session)) return true;
        const query = url.searchParams.get('query') || '';
        const limit = Number(url.searchParams.get('limit') || 300);
        Json(res, 200, { ok: true, activities: ListAdminActivity(query, limit) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/sessions') {
        if (!RequireAdmin(res, session)) return true;
        Json(res, 200, { ok: true, sessions: ListSessions(session) });
        return true;
    }

    match = pathname.match(/^\/api\/sessions\/([^/]+)\/revoke$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const sessionId = DecodePart(match[1]);
        const target = ListSessions(session).find(x => x.id === sessionId);
        if (!target) { ApiError(res, 404, 'SESSION_NOT_FOUND'); return true; }
        const current = target.current;
        RevokeSession(sessionId);
        Json(res, 200, { ok: true, id: sessionId, current });
        return true;
    }

    if (method === 'POST' && pathname === '/api/sessions/revoke-others') {
        if (!RequireAdmin(res, session)) return true;
        const count = RevokeOtherSessions(session);
        Json(res, 200, { ok: true, count });
        return true;
    }

    if (method === 'POST' && pathname === '/api/sessions/revoke-all') {
        if (!RequireAdmin(res, session)) return true;
        const count = RevokeAllSessions();
        Json(res, 200, { ok: true, count, currentRevoked: true });
        return true;
    }


    return false;
}
module.exports = { Handle };
