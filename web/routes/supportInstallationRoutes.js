'use strict';
const support = require('../../services/supportCenter');
const installation = require('../../services/clientInstallation');
async function Handle({ method, pathname, body, url, res, session, RequireAdmin, Json, ApiError }) {
    if (!/^\/api\/(support(?:\/|$)|reinstall-blocks(?:\/|$))/.test(pathname)) return false;
    if (!RequireAdmin(res, session)) return true;
    const send = result => {
        if (!result || result.ok === false) ApiError(res, 409, result && result.reason || 'REQUEST_FAILED');
        else Json(res, 200, { ok: true, ...result });
    };
    if (method === 'GET' && pathname === '/api/support') { send({ threads: support.List(), settings: support.Info() }); return true; }
    if (method === 'GET' && pathname === '/api/reinstall-blocks') { send({ blocks: installation.List() }); return true; }
    if (method === 'POST' && pathname === '/api/support/presence') { send(support.Presence(session, body.active === true)); return true; }
    if (method === 'POST' && pathname === '/api/support/availability') { send(support.Availability(session, body.mode)); return true; }
    if (method === 'POST' && pathname === '/api/support/settings') { send(support.Settings(body)); return true; }
    let m = pathname.match(/^\/api\/support\/([0-9A-F]{16})(?:\/(reply|read|close|delete|reopen))?$/i);
    if (m) {
        const id = m[1].toUpperCase();
        if (method === 'GET' && !m[2]) { const thread = support.Read(id, url && url.searchParams.get('before')); send(thread ? { thread } : { ok: false, reason: 'SUPPORT_NOT_FOUND' }); return true; }
        if (method === 'POST' && m[2] === 'reply') { send(support.Reply(id, body.text, body.requestId, body.revision)); return true; }
        if (method === 'POST' && ['close', 'delete', 'reopen'].includes(m[2])) { send(support.Change(id, m[2], body.revision)); return true; }
        if (method === 'POST' && m[2] === 'read') { send(support.MarkRead(id, body.throughSeq, body.revision)); return true; }
    }
    m = pathname.match(/^\/api\/reinstall-blocks\/([0-9A-F]{64})\/release$/i);
    if (method === 'POST' && m) { send(installation.Release(m[1], 'WEB_ADMIN')); return true; }
    ApiError(res, 404, 'NOT_FOUND');
    return true;
}
module.exports = { Handle };
