'use strict';

const state = require('../core/state');
const { NormalizeID, SendLine } = require('../core/utils');

function Identity() { return require('../identity/identityManager'); }
function Save() { return require('../storage/database').SaveDatabase(); }
function Log(type, detail) { require('../storage/audit').LogEvent(type, detail); }

function DeleteDeviceMaps(type, id, deviceKey) {
    const key = `${type}:${id}`;
    const enrollmentKey = `${type}:${deviceKey}`;
    for (const map of [
        state.deviceSecrets, state.deviceAuthStatus, state.deviceAuthChallenges,
        state.deviceInfo, state.deviceCapabilities, state.deviceDiagnostics,
        state.deviceReleaseChannels, state.deviceUpdateStatus,
        state.deviceSecretRotations, state.deviceSecretMeta,
        state.deviceNetworkProfiles
    ]) map.delete(key);
    state.deviceEnrollments.delete(enrollmentKey);
    state.ipHistory.delete(key);
    for (const [commandId, command] of Array.from(state.pendingDeviceCommands.entries()))
        if (command && command.type === type && NormalizeID(command.id) === id)
            state.pendingDeviceCommands.delete(commandId);
}

function DeleteServerState(id, deviceKey) {
    state.disabledServers.delete(id);
    state.drainingServers.delete(id);
    state.kickedServers.delete(id);
    state.serverAliases.delete(id);
    state.serverNotes.delete(id);
    state.serverDrainMeta.delete(id);
    state.serverFeatureOverrides.delete(id);
    state.serverProtocolProfiles.delete(id);
    state.runtimeStats.serverReconnects.delete(id);
    state.runtimeStats.serverAckStats.delete(id);
    state.runtimeStats.serverReconnectHistory.delete(id);
    state.runtimeStats.serverFlappingAlerts.delete(id);
    DeleteDeviceMaps('SERVER', id, deviceKey);
}

function DeleteClientState(id, deviceKey) {
    state.disabledClients.delete(id);
    state.kickedClients.delete(id);
    state.clientAliases.delete(id);
    state.clientNotes.delete(id);
    state.clientFeatureOverrides.delete(id);
    state.clientProtocolProfiles.delete(id);
    state.clientUiStates.delete(id);
    state.clientPasswordProfiles.delete(id);
    state.clientPasswordChallenges.delete(id);
    state.clientFailoverEnabled.delete(id);
    state.clientFailoverRecords.delete(id);
    state.clientServerBindings.delete(id);
    state.clientOfflineQueueEnabled.delete(id);
    state.runtimeStats.clientReconnects.delete(id);
    state.runtimeStats.clientAckStats.delete(id);
    state.runtimeStats.clientReconnectHistory.delete(id);
    state.runtimeStats.clientFlappingAlerts.delete(id);
    DeleteDeviceMaps('CLIENT', id, deviceKey);
}

function AssignWaitingOnlineClients() {
    const identity = Identity();
    let assigned = 0;
    const waiting = Array.from(state.clientIdentities.values())
        .filter(saved => saved && !saved.serverId && !saved.requiresPairingApproval && identity.GetOnlineClient(saved.id))
        .sort((a, b) => (Number(a.lastSeenAt) || 0) - (Number(b.lastSeenAt) || 0) || String(a.id).localeCompare(String(b.id)));
    for (const saved of waiting) {
        const server = identity.FindAvailableServer();
        if (!server) break;
        saved.serverId = server.serverId;
        const live = identity.GetOnlineClient(saved.id);
        if (live) {
            live.serverId = server.serverId;
            live.buildCompleted = false;
            live.buildSessionId = '';
            server.clients.add(saved.id);
            SendLine(live.socket, `SERVER_ASSIGNED|${server.serverId}`);
            require('./buildGate').TryDispatchClient(saved.id);
        }
        assigned++;
        Log('CLIENT_PAIR_RECOVERED', `${saved.id} -> ${server.serverId}`);
    }
    return assigned;
}

function RepairPairing() {
    const identity = Identity();
    const orphaned = identity.RepairOrphanAssignments();
    const duplicate = identity.RepairOneToOneAssignments();
    const assigned = AssignWaitingOnlineClients();
    if (assigned) Save();
    return { orphaned, duplicate, assigned, policy: 'ONE_TO_ONE_RESERVATION_QR_FINAL' };
}

function DeleteServer(serverId, actor = 'WEB_ADMIN') {
    const identity = Identity();
    const id = NormalizeID(serverId);
    if (!identity.ServerExists(id)) return { ok: false, reason: 'SERVER_NOT_FOUND' };
    const deviceKey = identity.FindServerDeviceKey(id);
    const live = identity.GetOnlineServer(id);
    const tombstone = require('./deviceDeletion').Add('SERVER', deviceKey, id, actor);
    if (!tombstone) return { ok: false, reason: 'DELETE_TOMBSTONE_FAILED' };
    if (live) {
        live.administrativelyDeleted = true;
        live.superseded = true;
    }
    require('../services/buildGate').PurgeServer(id);
    try { require('../relay/ackManager').FailPendingRequestsForServer(id, 'SERVER_DELETED'); } catch (_) {}

    for (const [clientId, binding] of Array.from(state.clientServerBindings.entries())) {
        const primary = NormalizeID(binding && binding.primaryServerId);
        const backup = NormalizeID(binding && binding.backupServerId);
        if (primary !== id && backup !== id) continue;
        state.clientServerBindings.delete(clientId);
        state.clientFailoverRecords.delete(clientId);
    }

    let releasedClients = 0;
    for (const saved of state.clientIdentities.values()) {
        if (!saved || NormalizeID(saved.serverId) !== id) continue;
        require('../services/buildGate').PurgeClient(saved.id);
        saved.serverId = '';
        saved.requiresPairingApproval = true;
        saved.pairingApprovedAt = 0;
        saved.pairingApprovedBy = '';
        state.clientServerBindings.delete(saved.id);
        state.clientFailoverRecords.delete(saved.id);
        const client = identity.GetOnlineClient(saved.id);
        if (client) {
            client.serverId = '';
            client.buildCompleted = false;
            client.buildSessionId = '';
            SendLine(client.socket, 'SERVER_UNASSIGNED|SERVER_DELETED');
        }
        releasedClients++;
    }

    state.serverIdentities.delete(deviceKey);
    state.servers.delete(id);
    DeleteServerState(id, deviceKey);
    if (live) {
        live.superseded = true;
        SendLine(live.socket, 'ERROR|SERVER_DELETED');
        try { live.socket.destroy(); } catch (_) {}
    }
    Save();
    Log('SERVER_DELETE', `${id} released=${releasedClients} tombstone=${tombstone.tombstoneId}`);
    return { ok: true, id, deviceRef: tombstone.deviceRef, tombstoneId: tombstone.tombstoneId, releasedClients, reassignedClients: 0 };
}

function DeleteClient(clientId, actor = 'WEB_ADMIN') {
    const identity = Identity();
    const id = NormalizeID(clientId);
    if (!identity.ClientExists(id)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    const deviceKey = identity.FindClientDeviceKey(id);
    const saved = identity.GetSavedClientByID(id);
    const live = identity.GetOnlineClient(id);
    const tombstone = require('./deviceDeletion').Add('CLIENT', deviceKey, id, actor);
    if (!tombstone) return { ok: false, reason: 'DELETE_TOMBSTONE_FAILED' };
    if (live) {
        live.administrativelyDeleted = true;
        live.superseded = true;
    }
    const server = saved ? identity.GetOnlineServer(saved.serverId) : null;
    if (server) server.clients.delete(id);
    require('../services/buildGate').PurgeClient(id);

    for (const license of state.licenses.values()) {
        if (NormalizeID(license && license.boundClient) === id) {
            license.boundClient = '';
            license.boundAt = 0;
        }
    }
    for (const [key, request] of Array.from(state.pendingRequests.entries())) if (request && request.clientId === id) state.pendingRequests.delete(key);
    for (const [key, item] of Array.from(state.offlineQueue.entries())) if (item && item.clientId === id) state.offlineQueue.delete(key);
    for (const [key, item] of Array.from(state.deadLetters.entries())) if (item && item.clientId === id) state.deadLetters.delete(key);
    for (const [key, item] of Array.from(state.requestTraces.entries())) if (item && item.clientId === id) state.requestTraces.delete(key);
    for (const key of Array.from(state.requestHistory.keys())) if (String(key).startsWith(`${id}|`)) state.requestHistory.delete(key);
    for (const [key, item] of Array.from(state.qrAuthRequests.entries())) if (item && item.clientId === id) state.qrAuthRequests.delete(key);
    for (const [key, item] of Array.from(state.buildSessions.entries())) if (item && item.clientId === id) state.buildSessions.delete(key);

    state.clientIdentities.delete(deviceKey);
    state.clients.delete(id);
    DeleteClientState(id, deviceKey);
    if (live) {
        live.superseded = true;
        SendLine(live.socket, 'ERROR|CLIENT_DELETED');
        try { live.socket.destroy(); } catch (_) {}
    }
    Save();
    Log('CLIENT_DELETE', `${id} device=${tombstone.deviceRef} tombstone=${tombstone.tombstoneId}`);
    return { ok: true, id, deviceRef: tombstone.deviceRef, tombstoneId: tombstone.tombstoneId };
}

module.exports = { RepairPairing, DeleteServer, DeleteClient, AssignWaitingOnlineClients };
