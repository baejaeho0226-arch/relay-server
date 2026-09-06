'use strict';
const { state, Now, NormalizeID, SafeField, SendLine, GetOnlineServer, GetOnlineClient, ServerExists, ClientExists, ClientMove, NoticeClient, NotifyServerUnauthorized, SaveDatabase, LogEvent, StartDrain, StopDrain, ClearDrainMeta, GetDrainStatus, clientBiometric, deviceRegistry, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, Json, ApiError, DecodePart, NormalizeAlias, NormalizeNote, RequireAdmin, RequireOperation, BuildServers, BuildServerDetail, BuildClients, BuildClientDetail } = require('../apiContext');
async function Handle({ method, pathname, url, body, req, res, session }) {
    let match, m;
    if (method === 'GET' && pathname === '/api/servers') {
        if (!RequireOperation(res, session, 'SERVER_LIST')) return true;
        Json(res, 200, { ok: true, servers: BuildServers() });
        return true;
    }

    match = pathname.match(/^\/api\/servers\/([^/]+)$/);
    if (method === 'DELETE' && match) {
        if (!RequireAdmin(res, session)) return true;
        const result = deviceRegistry.DeleteServer(DecodePart(match[1]));
        if (!result.ok) { ApiError(res, 404, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }
    if (method === 'GET' && match) {
        if (!RequireOperation(res, session, 'SERVER_TREE')) return true;
        const item = BuildServerDetail(DecodePart(match[1]));
        if (!item) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return true; }
        Json(res, 200, { ok: true, server: item });
        return true;
    }

    match = pathname.match(/^\/api\/servers\/([^/]+)\/alias$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ServerExists(id)) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return true; }
        const alias = NormalizeAlias(body.alias);
        if (alias) state.serverAliases.set(id, alias); else state.serverAliases.delete(id);
        SaveDatabase();
        LogEvent('SERVER_ALIAS', `${id} -> ${alias || '(cleared)'}`);
        Json(res, 200, { ok: true, id, alias });
        return true;
    }

    match = pathname.match(/^\/api\/servers\/([^/]+)\/note$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'NOTE')) return true;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ServerExists(id)) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return true; }
        const note = NormalizeNote(body.note);
        if (note) state.serverNotes.set(id, note); else state.serverNotes.delete(id);
        SaveDatabase();
        LogEvent('SERVER_NOTE', `${id} ${note ? 'updated' : 'cleared'}`);
        Json(res, 200, { ok: true, id, note });
        return true;
    }

    match = pathname.match(/^\/api\/servers\/([^/]+)\/(kick|disable|enable|drain-on|drain-off)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        const action = match[2];
        if (!ServerExists(id)) { ApiError(res, 404, 'SERVER_NOT_FOUND'); return true; }

        if (action === 'kick') {
            const until = Now() + SERVER_KICK_BLOCK_MS;
            state.kickedServers.set(id, until);
            const live = GetOnlineServer(id);
            if (live) { SendLine(live.socket, `ERROR|ADMIN_KICK|${until}`); live.socket.destroy(); }
            LogEvent('SERVER_KICK', `${id} until ${until}`);
            Json(res, 200, { ok: true, id, kickedUntil: until });
            return true;
        }
        if (action === 'disable') {
            state.disabledServers.add(id);
            ClearDrainMeta(id);
            state.kickedServers.delete(id);
            SaveDatabase();
            const live = GetOnlineServer(id);
            if (live) { SendLine(live.socket, 'ERROR|SERVER_DISABLED'); live.socket.destroy(); }
            LogEvent('SERVER_DISABLE', id);
        } else if (action === 'enable') {
            state.disabledServers.delete(id);
            state.kickedServers.delete(id);
            SaveDatabase();
            LogEvent('SERVER_ENABLE', id);
        } else if (action === 'drain-on') {
            const result = StartDrain(id);
            if (!result.ok) { ApiError(res, 409, result.reason); return true; }
            LogEvent('SERVER_DRAIN_ON', `${id} initialClients=${result.status.initialClients}`);
        } else if (action === 'drain-off') {
            StopDrain(id);
            LogEvent('SERVER_DRAIN_OFF', id);
        }
        Json(res, 200, { ok: true, id, action, drain: GetDrainStatus(id) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/clients') {
        if (!RequireOperation(res, session, 'CLIENT_LIST')) return true;
        Json(res, 200, { ok: true, clients: BuildClients() });
        return true;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (method === 'DELETE' && match) {
        if (!RequireAdmin(res, session)) return true;
        const result = deviceRegistry.DeleteClient(DecodePart(match[1]));
        if (!result.ok) { ApiError(res, 404, result.reason); return true; }
        Json(res, 200, result);
        return true;
    }
    if (method === 'GET' && match) {
        if (!RequireOperation(res, session, 'CLIENT_DETAIL')) return true;
        const item = BuildClientDetail(DecodePart(match[1]));
        if (!item) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return true; }
        Json(res, 200, { ok: true, client: item });
        return true;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/alias$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ClientExists(id)) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return true; }
        const alias = NormalizeAlias(body.alias);
        if (alias) state.clientAliases.set(id, alias); else state.clientAliases.delete(id);
        SaveDatabase();
        LogEvent('CLIENT_ALIAS', `${id} -> ${alias || '(cleared)'}`);
        Json(res, 200, { ok: true, id, alias });
        return true;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/note$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'NOTE')) return true;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ClientExists(id)) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return true; }
        const note = NormalizeNote(body.note);
        if (note) state.clientNotes.set(id, note); else state.clientNotes.delete(id);
        SaveDatabase();
        LogEvent('CLIENT_NOTE', `${id} ${note ? 'updated' : 'cleared'}`);
        Json(res, 200, { ok: true, id, note });
        return true;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/biometric\/reset$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        if (!ClientExists(id)) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return true; }
        const result = clientBiometric.Reset(id, `WEB_${String(session.role || 'ADMIN').toUpperCase()}`);
        if (!result.ok) { ApiError(res, 400, result.reason); return true; }
        Json(res, 200, { ok: true, id, biometric: result.status });
        return true;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/(kick|disable|enable)$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        const action = match[2];
        if (!ClientExists(id)) { ApiError(res, 404, 'CLIENT_NOT_FOUND'); return true; }

        if (action === 'kick') {
            const until = Now() + CLIENT_KICK_BLOCK_MS;
            state.kickedClients.set(id, until);
            NotifyServerUnauthorized(id, 'ADMIN_KICK');
            const live = GetOnlineClient(id);
            if (live) { SendLine(live.socket, `ERROR|CLIENT_KICKED|${until}`); live.socket.destroy(); }
            LogEvent('CLIENT_KICK', `${id} until ${until}`);
            Json(res, 200, { ok: true, id, kickedUntil: until });
            return true;
        }
        if (action === 'disable') {
            state.disabledClients.add(id);
            state.kickedClients.delete(id);
            SaveDatabase();
            NotifyServerUnauthorized(id, 'CLIENT_DISABLED');
            const live = GetOnlineClient(id);
            if (live) { SendLine(live.socket, 'ERROR|CLIENT_DISABLED'); live.socket.destroy(); }
            LogEvent('CLIENT_DISABLE', id);
        } else {
            state.disabledClients.delete(id);
            state.kickedClients.delete(id);
            SaveDatabase();
            LogEvent('CLIENT_ENABLE', id);
        }
        Json(res, 200, { ok: true, id, action });
        return true;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/move$/);
    if (method === 'POST' && match) {
        if (!RequireAdmin(res, session)) return true;
        const id = NormalizeID(DecodePart(match[1]));
        const newServerId = NormalizeID(body.serverId || '');
        const result = ClientMove(id, newServerId);
        if (!result.ok) { ApiError(res, 409, result.reason); return true; }
        Json(res, 200, { ok: true, id, serverId: newServerId, oldServerId: result.oldServerId });
        return true;
    }

    match = pathname.match(/^\/api\/clients\/([^/]+)\/notice$/);
    if (method === 'POST' && match) {
        if (!RequireOperation(res, session, 'NOTICE')) return true;
        const id = NormalizeID(DecodePart(match[1]));
        const message = SafeField(body.message || '');
        if (!message) { ApiError(res, 400, 'MESSAGE_REQUIRED'); return true; }
        if (!NoticeClient(id, message)) { ApiError(res, 409, 'CLIENT_OFFLINE'); return true; }
        Json(res, 200, { ok: true, id });
        return true;
    }


    return false;
}
module.exports = { Handle };
