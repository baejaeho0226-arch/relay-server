'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function AuthorizeClient(...args) { return require('../license/licenseManager').AuthorizeClient(...args); }
function CreateClientIdentity(...args) { return require('../identity/identityManager').CreateClientIdentity(...args); }
function FindAssignableServerId(...args) { return require('../identity/identityManager').FindAssignableServerId(...args); }
function GetKickUntil(...args) { return require('../identity/identityManager').GetKickUntil(...args); }
function GetOnlineClient(...args) { return require('../identity/identityManager').GetOnlineClient(...args); }
function GetOnlineServer(...args) { return require('../identity/identityManager').GetOnlineServer(...args); }
function GetSavedClientByID(...args) { return require('../identity/identityManager').GetSavedClientByID(...args); }
function GetUsableLicenseForConnection(...args) { return require('../license/licenseManager').GetUsableLicenseForConnection(...args); }
function HandlePong(...args) { return require('./heartbeat').HandlePong(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function MakeRequestKey(...args) { return require('./ackManager').MakeRequestKey(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function NotifyServerUnauthorized(...args) { return require('./notifications').NotifyServerUnauthorized(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function SafeIP(...args) { return require('../core/utils').SafeIP(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }
function TrackIP(...args) { return require('../identity/identityManager').TrackIP(...args); }
function ValidateProtocolAndVersion(...args) { return require('../services/versionPolicy').ValidateProtocolAndVersion(...args); }
function RepairOneToOneAssignments(...args) { return require('../identity/identityManager').RepairOneToOneAssignments(...args); }
function RepairOrphanAssignments(...args) { return require('../identity/identityManager').RepairOrphanAssignments(...args); }

function LegacyClientDeviceKey(deviceKey) {
    const match = /^ANDROID2-([0-9A-F]{8,32})-[0-9A-F]{16}$/i.exec(String(deviceKey || '').trim());
    return match ? `ANDROID-${match[1].toUpperCase()}` : '';
}

function MigrateLegacyClientIdentity(deviceKey) {
    const legacyKey = LegacyClientDeviceKey(deviceKey);
    if (!legacyKey) return null;
    const saved = clientIdentities.get(legacyKey);
    if (!saved) return null;
    clientIdentities.delete(legacyKey);
    clientIdentities.set(deviceKey, saved);
    const oldEnrollmentKey = `CLIENT:${legacyKey}`;
    const newEnrollmentKey = `CLIENT:${deviceKey}`;
    if (state.deviceEnrollments.has(oldEnrollmentKey) && !state.deviceEnrollments.has(newEnrollmentKey)) {
        const record = state.deviceEnrollments.get(oldEnrollmentKey);
        state.deviceEnrollments.delete(oldEnrollmentKey);
        record.deviceKey = deviceKey;
        state.deviceEnrollments.set(newEnrollmentKey, record);
    }
    SaveDatabase();
    LogEvent('CLIENT_LOCAL_ID_MIGRATED', `${saved.id} ${legacyKey} -> ${deviceKey}`);
    return saved;
}

function AttachClient(connection, saved) {
    const old = GetOnlineClient(saved.id);
    if (old && old !== connection) {
        // The late close event from the replaced socket must never revoke the
        // newly established client's biometric/build session.
        old.superseded = true;
        const oldServer = GetOnlineServer(old.serverId);
        if (oldServer) oldServer.clients.delete(saved.id);
        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.clientId = saved.id;
    connection.serverId = saved.serverId;
    connection.connected = true;
    connection.licenseAuthorized = false;
    connection.licenseKey = '';
    connection.licenseExpiresAt = 0;
    connection.biometricVerified = false;
    connection.accessType = '';
    connection.buildCompleted = false;
    connection.buildSessionId = '';
    connection.lastServerAuthState = '';
    connection.deviceAuthVerified = false;
    connection.lastSeen = Now();
    connection.lastIP = SafeIP(connection.socket);
    clients.set(saved.id, connection);

    saved.lastSeenAt = Now();
    saved.lastIP = connection.lastIP;
    saved.reconnectCount = Number(saved.reconnectCount || 0) + 1;
    runtimeStats.clientReconnects.set(saved.id, saved.reconnectCount);
    require('../services/reconnectMonitor').RecordReconnect('CLIENT', saved.id);
    TrackIP('CLIENT', saved.id, saved.lastIP);

    const server = GetOnlineServer(saved.serverId);
    if (server) server.clients.add(saved.id);
    SaveDatabase();

    SendLine(connection.socket, `CONNECTED|${saved.id}|${saved.serverId}|${connection.protocolVersion}|${connection.appVersion}`);
    NotifyServerUnauthorized(saved.id, 'LICENSE_REQUIRED');
    LogEvent('CLIENT_ONLINE', `${saved.id} v${connection.appVersion}`);
}

function HandleClientConnect(connection, deviceKey, protocolVersion, appVersion) {
    if (!ValidateProtocolAndVersion(connection, 'client', protocolVersion, appVersion)) {
        setTimeout(() => { try { connection.socket.destroy(); } catch (_) {} }, 150);
        return;
    }
    if (!state.serviceEnabled) { SendLine(connection.socket, 'SERVICE_STATE|DISABLED'); return; }
    if (state.maintenanceMode) { SendLine(connection.socket, 'SERVICE_STATE|MAINTENANCE'); return; }

    deviceKey = String(deviceKey || '').trim();
    if (!deviceKey) { SendLine(connection.socket, 'ERROR|DEVICE_KEY_REQUIRED'); return; }

    if (!require('../services/clientInstallation').CheckDeviceKey(connection, deviceKey)) return;
    let saved = clientIdentities.get(deviceKey);
    if (!saved) saved = MigrateLegacyClientIdentity(deviceKey);
    if (saved) {
        if (disabledClients.has(saved.id)) { SendLine(connection.socket, 'ERROR|CLIENT_DISABLED'); return; }
        const kickedUntil = GetKickUntil(kickedClients, saved.id);
        if (kickedUntil > Now()) { SendLine(connection.socket, `ERROR|CLIENT_KICKED|${kickedUntil}`); return; }
        if (saved.serverId && disabledServers.has(saved.serverId)) { SendLine(connection.socket, 'ERROR|SERVER_DISABLED'); return; }
        if (saved.serverId && GetKickUntil(kickedServers, saved.serverId) > Now()) { SendLine(connection.socket, 'ERROR|SERVER_OFFLINE'); return; }
    } else {
        const enrollment = require('../services/deviceEnrollment').Request('CLIENT', deviceKey, { ip: SafeIP(connection.socket), appVersion, protocolVersion });
        if (!enrollment.allowed) {
            SaveDatabase();
            const requestId = enrollment.record && enrollment.record.requestId ? enrollment.record.requestId : '';
            SendLine(connection.socket, enrollment.rejected ? 'ERROR|ENROLLMENT_REJECTED' : `ERROR|ENROLLMENT_PENDING|${requestId}`);
            LogEvent(enrollment.rejected ? 'CLIENT_ENROLLMENT_REJECTED' : 'CLIENT_ENROLLMENT_PENDING', `${deviceKey} ${requestId}`);
            return;
        }
        // QR enrollment belongs to Relay, not to a live WinSockServer session.
        // Prefer a usable persisted binding, but allow a first device to remain
        // unassigned until the first WinSockServer registers.
        saved = CreateClientIdentity(deviceKey, FindAssignableServerId());
        require('../services/deviceEnrollment').MarkBound('CLIENT', deviceKey, saved.id);
        SaveDatabase();
    }
    RepairOrphanAssignments();
    RepairOneToOneAssignments();
    // Existing rows released by one-to-one repair and phones that came online
    // before any PC must claim an actually online empty server here.
    if (!saved.serverId) {
        const availableServerId = FindAssignableServerId();
        if (availableServerId) {
            saved.serverId = availableServerId;
            SaveDatabase();
            LogEvent('CLIENT_LIVE_ONE_TO_ONE_BIND', `${saved.id} -> ${availableServerId}`);
        }
    }
    AttachClient(connection, saved);
}

function IsRateLimited(connection) {
    const key = connection.clientId || `IP:${SafeIP(connection.socket)}`;
    const now = Now();
    let state = rateLimits.get(key);
    if (!state || now - state.startedAt >= RATE_LIMIT_WINDOW_MS) {
        state = { startedAt: now, count: 0 };
        rateLimits.set(key, state);
    }
    state.count++;
    return state.count > RATE_LIMIT_MAX;
}

function HandleClientSend(connection, line) {
    if (!state.serviceEnabled) { SendLine(connection.socket, 'SERVICE_STATE|DISABLED'); return; }
    const deviceAuth = require('../services/deviceAuth');
    if (deviceAuth.Enforced('CLIENT',connection.clientId) && !deviceAuth.Verified('CLIENT',connection.clientId)) { SendLine(connection.socket,'ERROR|DEVICE_AUTH_REQUIRED'); deviceAuth.IssueChallenge('CLIENT',connection.clientId); return; }
    // Maintenance intentionally allows already-authorized live sessions to continue.
    if (state.maintenanceMode && !connection.licenseAuthorized) { SendLine(connection.socket, 'SERVICE_STATE|MAINTENANCE'); return; }
    if (IsRateLimited(connection)) { SendLine(connection.socket, 'ERROR|RATE_LIMIT'); return; }

    if (!connection.biometricVerified) {
        SendLine(connection.socket, 'ERROR|BIOMETRIC_AUTH_REQUIRED');
        require('../services/clientBiometric').Begin(connection, connection.accessType);
        return;
    }

    const parts = line.split('|');
    if (parts.length !== 4) { SendLine(connection.socket, 'ERROR|INVALID_SEND'); return; }
    const requestId = String(parts[1] || '').trim();
    const clientId = NormalizeID(parts[2] || '');
    const number = String(parts[3] || '').trim();
    if (!requestId || requestId.length > 64) { SendLine(connection.socket, 'ERROR|REQUEST_ID_INVALID'); return; }
    if (!clientId || connection.clientId !== clientId) { SendLine(connection.socket, 'ERROR|CLIENT_NOT_OWNER'); return; }
    if (!/^-?\d+$/.test(number)) { SendLine(connection.socket, 'ERROR|NUMBER_ONLY'); return; }

    const requestKey = MakeRequestKey(clientId, requestId);
    if (requestHistory.has(requestKey) || require('../services/requestRecovery').IsQueued(clientId, requestId)) { SendLine(connection.socket, 'ERROR|DUPLICATE_REQUEST'); return; }

    const active = GetUsableLicenseForConnection(connection);
    if (!active) {
        connection.licenseAuthorized = false;
        connection.licenseExpiresAt = 0;
        SendLine(connection.socket, 'ERROR|LICENSE_REQUIRED');
        NotifyServerUnauthorized(clientId, 'LICENSE_REQUIRED');
        return;
    }

    const saved = GetSavedClientByID(clientId);
    const server = saved ? GetOnlineServer(saved.serverId) : null;
    if (!saved) { SendLine(connection.socket, 'ERROR|CLIENT_NOT_FOUND'); return; }
    const buildSession = require('../services/buildGate').ActiveSessionForClient(clientId);
    const payloadAccessType = buildSession ? buildSession.accessType : require('../services/accessType').NormalizeAccessType(connection.accessType);
    const payload = `NUMBER|${requestId}|${clientId}|${payloadAccessType}|${number}`;
    const recovery = require('../services/requestRecovery');
    const recordAccepted = () => {
        active.license.lastSeenAt = Now();
        active.license.lastIP = SafeIP(connection.socket);
        active.license.sendCount = Number(active.license.sendCount || 0) + 1;
        saved.lastSeenAt = Now();
        saved.lastIP = active.license.lastIP;
        saved.sendCount = Number(saved.sendCount || 0) + 1;
        require('../services/dailyHealth').Record('sends');
        SaveDatabase();
    };
    let unavailableReason = '';
    if (!server) unavailableReason = 'SERVER_OFFLINE';
    else if (!buildSession || buildSession.serverId !== saved.serverId || buildSession.expiresAt <= Now()) unavailableReason = 'SERVER_BUILD_REQUIRED';
    else if (server.buildGateCapable && (!(server.buildClients instanceof Set) || !server.buildClients.has(clientId))) unavailableReason = 'SERVER_BUILD_REQUIRED';
    else if (deviceAuth.Enforced('SERVER',saved.serverId) && !deviceAuth.Verified('SERVER',saved.serverId)) {
        unavailableReason = 'SERVER_AUTH_REQUIRED';
        deviceAuth.IssueChallenge('SERVER',saved.serverId);
    }
    if (unavailableReason) {
        if (unavailableReason === 'SERVER_BUILD_REQUIRED') {
            SendLine(connection.socket, 'ERROR|SERVER_BUILD_REQUIRED');
            return;
        }
        const queued = recovery.EnqueueRequest({ clientId, serverId: saved.serverId, requestId, number, accessType: payloadAccessType, payload, source: 'CLIENT', notifyClient: true }, unavailableReason);
        if (!queued.ok) {
            recovery.AddDeadLetter({ clientId, serverId: saved.serverId, requestId, number, payload, source: 'CLIENT', notifyClient: true }, unavailableReason, { detail: queued.reason });
            SendLine(connection.socket, `ERROR|${unavailableReason}`);
            return;
        }
        recordAccepted();
        SendLine(connection.socket, `QUEUED|OK|${requestId}|${queued.position}`);
        return;
    }
    if (!SendLine(server.socket, payload)) {
        const queued = recovery.EnqueueRequest({ clientId, serverId: saved.serverId, requestId, number, accessType: payloadAccessType, payload, source: 'CLIENT', notifyClient: true }, 'SERVER_SEND_FAILED');
        if (queued.ok) { recordAccepted(); SendLine(connection.socket, `QUEUED|OK|${requestId}|${queued.position}`); return; }
        recovery.AddDeadLetter({ clientId, serverId: saved.serverId, requestId, number, payload, source: 'CLIENT', notifyClient: true }, 'SERVER_SEND_FAILED', { detail: queued.reason });
        SendLine(connection.socket, 'ERROR|SERVER_SEND_FAILED');
        return;
    }

    const forwardedAt = Now();
    requestHistory.set(requestKey, forwardedAt);
    require('../services/requestTrace').StartTrace(clientId, requestId, saved.serverId, number, forwardedAt, { source: 'CLIENT', notifyClient: true });
    pendingRequests.set(requestKey, {
        clientId, serverId: saved.serverId, requestId, number, payload,
        createdAt: forwardedAt, originCreatedAt: forwardedAt, lastSendAt: forwardedAt, retries: 0,
        source: 'CLIENT', replayOf: '', notifyClient: true
    });

    recordAccepted();

    SendLine(connection.socket, `SENT|OK|${requestId}`);
    LogEvent('NUMBER_SEND', `${requestId} / ${clientId} / ${number}`);
}

function HandleClientBuild(connection, line) {
    if (!state.serviceEnabled) { SendLine(connection.socket, 'SERVICE_STATE|DISABLED'); return; }
    if (state.maintenanceMode && !connection.licenseAuthorized) { SendLine(connection.socket, 'SERVICE_STATE|MAINTENANCE'); return; }
    if (IsRateLimited(connection)) { SendLine(connection.socket, 'ERROR|RATE_LIMIT'); return; }

    const parts = line.split('|');
    if (parts.length !== 3) { SendLine(connection.socket, 'ERROR|INVALID_BUILD'); return; }
    const requestId = String(parts[1] || '').trim();
    const clientId = NormalizeID(parts[2] || '');
    if (!requestId || requestId.length > 64) { SendLine(connection.socket, 'ERROR|REQUEST_ID_INVALID'); return; }
    if (!clientId || connection.clientId !== clientId) { SendLine(connection.socket, 'ERROR|CLIENT_NOT_OWNER'); return; }

    const deviceAuth = require('../services/deviceAuth');
    if (!deviceAuth.Verified('CLIENT', clientId)) {
        SendLine(connection.socket, 'ERROR|DEVICE_AUTH_REQUIRED');
        deviceAuth.IssueChallenge('CLIENT', clientId);
        return;
    }
    if (!connection.biometricVerified) {
        SendLine(connection.socket, 'ERROR|BIOMETRIC_AUTH_REQUIRED');
        require('../services/clientBiometric').Begin(connection, connection.accessType);
        return;
    }
    const active = GetUsableLicenseForConnection(connection);
    if (!active) {
        connection.licenseAuthorized = false;
        connection.licenseExpiresAt = 0;
        SendLine(connection.socket, 'ERROR|LICENSE_REQUIRED');
        NotifyServerUnauthorized(clientId, 'LICENSE_REQUIRED');
        return;
    }

    const saved = GetSavedClientByID(clientId);
    if (!saved) { SendLine(connection.socket, 'ERROR|CLIENT_NOT_FOUND'); return; }
    const buildGate = require('../services/buildGate');
    const existingGrant = state.pendingBuildGrants.get(clientId);
    if (existingGrant) {
        connection.buildCompleted = false;
        connection.buildSessionId = '';
        SendLine(connection.socket, `BUILD_WAITING|${existingGrant.requestId}|${existingGrant.expiresAt}|${existingGrant.sessionId}`);
        buildGate.TryDispatchClient(clientId);
        return;
    }
    const requestKey = MakeRequestKey(clientId, requestId);
    if (requestHistory.has(requestKey) || pendingRequests.has(requestKey)) {
        SendLine(connection.socket, 'ERROR|DUPLICATE_REQUEST');
        return;
    }
    const queued = buildGate.Queue(connection, requestId);
    if (!queued.ok) {
        if (queued.reason === 'BUILD_SESSION_ACTIVE') {
            const session = buildGate.PublicSession(buildGate.ActiveSessionForClient(clientId));
            if (session) {
                connection.buildCompleted = true;
                connection.buildSessionId = session.sessionId;
                SendLine(connection.socket, `BUILD_OK|${requestId}|${session.sessionId}|${session.expiresAt}|${session.accessType}`);
                return;
            }
        }
        SendLine(connection.socket, `ERROR|${queued.reason}`);
        return;
    }
    buildGate.TryDispatchClient(clientId);
}

function HandleClientLine(connection, line) {
    line = line.trim();
    if (!line) return;
    if (connection.reinstallBlocked || require('../services/clientInstallation').IsBlocked(connection)) { require('../services/clientInstallation').Reject(connection); return; }
    if (line.startsWith('SUPPORT_OPEN|') || line.startsWith('SUPPORT_SEND|')) { require('../services/supportCenter').Handle(connection, line); return; }

    if (connection.clientId) {
        if (line.startsWith('CLIENT_INSTALLATION|')) { require('../services/clientInstallation').HandleToken(connection, line.substring('CLIENT_INSTALLATION|'.length)); return; }
        if (line.startsWith('CAPABILITIES|')) { const dc=require('../services/deviceControl'); dc.RecordCapabilities('CLIENT', connection.clientId, line.substring('CAPABILITIES|'.length)); dc.PushDesiredConfig('CLIENT', connection.clientId); require('../services/releaseManager').NotifyDevice('CLIENT', connection.clientId); require('../services/deviceAuth').SendEnrollmentSecret('CLIENT', connection.clientId, false); return; }
        if (line.startsWith('DEVICE_INFO|')) { require('../services/deviceControl').RecordDeviceInfo('CLIENT', connection.clientId, line.split('|').slice(1)); return; }
        if (line.startsWith('PROTOCOL_PROFILE|')) { const p=line.split('|'); require('../services/protocolReadiness').RecordProfile('CLIENT', connection.clientId, p[1], p[2], p.slice(3).join('|')); return; }
        if (line === 'DEVICE_SECRET_ACK' || line.startsWith('DEVICE_SECRET_ACK|')) { require('../services/deviceAuth').HandleSecretAck('CLIENT', connection.clientId); return; }
        if (line.startsWith('DEVICE_AUTH|')) { const p=line.split('|'); require('../services/deviceAuth').HandleAuth('CLIENT', connection.clientId, p[1], p[2]); return; }
        if (line.startsWith('DEVICE_AUTH_ERROR|')) { require('../services/deviceAuth').HandleDeviceAuthError('CLIENT', connection.clientId, line.split('|')); return; }
        if (line.startsWith('COMMAND_ACK|')) { require('../services/deviceControl').RecordCommandAck('CLIENT', connection.clientId, line.split('|')); return; }
        if (line.startsWith('DIAGNOSTICS|')) { require('../services/deviceControl').RecordDiagnostics('CLIENT', connection.clientId, line.split('|').slice(2).join('|')); return; }
        if (line.startsWith('UPDATE_ACK|')) { require('../services/releaseManager').RecordUpdateAck('CLIENT', connection.clientId, line.split('|')); return; }
        if (line.startsWith('DEVICE_SECRET_ROTATE_ACK|')) { const r=require('../services/deviceSecretRotation').HandleAck('CLIENT',connection.clientId,line.split('|')); if(!r.ok) SendLine(connection.socket,`DEVICE_SECRET_ROTATE_ERROR|${line.split('|')[1]||''}|${r.reason}`); return; }
        if (line.startsWith('CONFIG_ACK|')) {  connection.configAck = line; return; }
        if (line.startsWith('UI_STATE|')) { const p=line.split('|'); require('../services/deviceControl').RecordUiState(connection.clientId,p[1],p.slice(2).join('|')); return; }
    }

    if (line === 'CONNECT' || line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        let protocolVersion = 1, appVersion = '1.0.0', deviceKey = '';
        if (parts.length >= 4) {
            protocolVersion = Number(parts[1]);
            appVersion = String(parts[2] || '').trim();
            deviceKey = parts.slice(3).join('|').trim();
        } else if (parts.length >= 2) {
            deviceKey = parts[1].trim();
        }
        HandleClientConnect(connection, deviceKey, protocolVersion, appVersion);
        return;
    }

    if (line === 'LINK_PING' || line.startsWith('LINK_PING|')) {
        if (!connection.clientId) { SendLine(connection.socket, 'ERROR|CONNECT_REQUIRED'); return; }
        const token = String(line.split('|')[1] || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
        SendLine(connection.socket, token ? `LINK_PONG|${token}` : 'LINK_PONG');
        return;
    }

    if (line.startsWith('LICENSE_AUTH|')) {
        const parts = line.split('|');
        const requestedClient = parts.length >= 3 ? NormalizeID(parts[2]) : '';
        if (requestedClient && requestedClient !== connection.clientId) { SendLine(connection.socket, 'LICENSE_ERROR|CLIENT_NOT_OWNER'); return; }
        const da=require('../services/deviceAuth');
        if (da.Enforced('CLIENT',connection.clientId) && !da.Verified('CLIENT',connection.clientId)) { SendLine(connection.socket,'ERROR|DEVICE_AUTH_REQUIRED'); da.IssueChallenge('CLIENT',connection.clientId); return; }
        AuthorizeClient(connection, parts[1] || '');
        return;
    }

    if (line.startsWith('QR_AUTH_RESUME|')) {
        const parts = line.split('|');
        const requestedClient = parts.length >= 2 ? NormalizeID(parts[1]) : '';
        if (requestedClient && requestedClient !== connection.clientId) { SendLine(connection.socket, 'QR_AUTH_ERROR|CLIENT_NOT_OWNER'); return; }
        require('../services/qrApproval').Resume(connection);
        return;
    }

    if (line.startsWith('USER_DASHBOARD|')) {
        // USER_DASHBOARD is Relay -> APK only.  Rejecting an inbound copy
        // prevents a client from spoofing group metadata into server state.
        SendLine(connection.socket, 'ERROR|DIRECTION_NOT_ALLOWED');
        return;
    }

    if (line.startsWith('QR_AUTH_STATUS|')) {
        const parts = line.split('|');
        const requestedClient = parts.length >= 3 ? NormalizeID(parts[2]) : '';
        if (requestedClient && requestedClient !== connection.clientId) { SendLine(connection.socket, 'QR_AUTH_ERROR|CLIENT_NOT_OWNER'); return; }
        require('../services/qrApproval').Status(connection, parts[1] || '');
        return;
    }

    if (line.startsWith('BIOMETRIC_BEGIN|')) {
        const requestedClient = NormalizeID(line.split('|')[1] || '');
        if (requestedClient && requestedClient !== connection.clientId) {
            SendLine(connection.socket, 'BIOMETRIC_ERROR|CLIENT_NOT_OWNER');
            return;
        }
        require('../services/clientBiometric').Begin(connection, connection.accessType);
        return;
    }

    if (line.startsWith('BIOMETRIC_PROOF|')) {
        require('../services/clientBiometric').HandleProof(connection, line.split('|'));
        return;
    }

    if (line.startsWith('SUPPORT_REQUEST|')) {
        const parts = line.split('|');
        const requestId = String(parts[1] || '').trim().slice(0, 64);
        const clientId = NormalizeID(parts[2] || '');
        const screen = String(parts[3] || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '').slice(0, 32);
        if (!requestId || clientId !== connection.clientId) {
            SendLine(connection.socket, `SUPPORT_ERROR|${requestId}|INVALID_REQUEST`);
            return;
        }
        if (!require('../services/deviceAuth').Verified('CLIENT', clientId)) {
            SendLine(connection.socket, `SUPPORT_ERROR|${requestId}|DEVICE_AUTH_REQUIRED`);
            return;
        }
        if (IsRateLimited(connection)) {
            SendLine(connection.socket, `SUPPORT_ERROR|${requestId}|RATE_LIMIT`);
            return;
        }
        require('../services/notificationCenter').AddNotification({
            severity: 'INFO', type: 'REALTIME_SUPPORT', title: '실시간 지원 요청',
            message: `${clientId} 사용자가 ${screen || 'UNKNOWN'} 화면에서 지원을 요청했습니다.`,
            entityType: 'CLIENT', entityId: clientId,
            dedupeKey: `REALTIME_SUPPORT|${clientId}|${requestId}`
        });
        require('../storage/audit').LogEvent('REALTIME_SUPPORT_REQUEST',
            `${clientId} / ${screen || 'UNKNOWN'} / ${requestId}`);
        SaveDatabase();
        SendLine(connection.socket, `SUPPORT_OK|${requestId}`);
        return;
    }

    if (line === 'PONG' || line.startsWith('PONG|')) { HandlePong(connection, line.split('|')); return; }
    if (line.startsWith('BUILD|')) { HandleClientBuild(connection, line); return; }
    if (line.startsWith('SEND|')) { HandleClientSend(connection, line); return; }
    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

module.exports = {
    LegacyClientDeviceKey,
    MigrateLegacyClientIdentity,
    AttachClient,
    HandleClientConnect,
    IsRateLimited,
    HandleClientSend,
    HandleClientBuild,
    HandleClientLine
};
