'use strict';

const state = require('../core/state');
const { Now, SafeField } = require('../core/utils');

function ResetSnapshot(source) {
    const snapshot = JSON.parse(JSON.stringify(source));
    snapshot.servers = {};
    snapshot.clients = {};
    snapshot.disabledServers = [];
    snapshot.drainingServers = [];
    snapshot.disabledClients = [];
    snapshot.serverAliases = {};
    snapshot.clientAliases = {};
    snapshot.serverNotes = {};
    snapshot.clientNotes = {};
    snapshot.serverDrainMeta = {};
    snapshot.serverFeatureOverrides = {};
    snapshot.clientFeatureOverrides = {};
    snapshot.serverProtocolProfiles = {};
    snapshot.clientProtocolProfiles = {};
    snapshot.deviceSecrets = {};
    snapshot.deviceReleaseChannels = {};
    snapshot.deviceEnrollments = {};
    snapshot.deletedDevices = {};
    snapshot.deviceSecretRotations = {};
    snapshot.deviceSecretMeta = {};
    snapshot.deviceNetworkProfiles = {};
    snapshot.clientFailoverEnabled = [];
    snapshot.clientFailoverRecords = {};
    snapshot.clientServerBindings = {};
    snapshot.clientOfflineQueueEnabled = [];
    snapshot.offlineQueue = {};
    snapshot.deadLetters = {};
    snapshot.processorStats = {};
    snapshot.dailyHealthReports = {};
    snapshot.dailyHealthAccumulator = null;
    snapshot.qrAuthRequests = {};
    snapshot.clientPasswordProfiles = {};
    snapshot.pendingBuildGrants = {};
    snapshot.buildSessions = {};
    snapshot.clientBuildBindings = {};
    snapshot.accessGroupGuids = {};
    snapshot.licenseRevision = Math.max(0, Number(snapshot.licenseRevision) || 0) + 1;

    for (const license of Object.values(snapshot.licenses || {})) {
        if (!license || typeof license !== 'object') continue;
        license.boundClient = '';
        license.boundAt = 0;
    }
    if (snapshot.productionControl && typeof snapshot.productionControl === 'object') {
        snapshot.productionControl.updateTransactions = {};
        snapshot.productionControl.anomalyFindings = {};
        snapshot.productionControl.diagnosticsBundles = [];
    }
    return snapshot;
}

function ClearTransientState() {
    state.servers.clear();
    state.clients.clear();
    state.kickedServers.clear();
    state.kickedClients.clear();
    state.requestHistory.clear();
    state.requestTraces.clear();
    state.pendingRequests.clear();
    state.rateLimits.clear();
    state.confirmTokens.clear();
    state.ipHistory.clear();
    state.deviceAuthStatus.clear();
    state.deviceAuthChallenges.clear();
    state.deviceInfo.clear();
    state.deviceCapabilities.clear();
    state.deviceDiagnostics.clear();
    state.clientUiStates.clear();
    state.deviceUpdateStatus.clear();
    state.pendingDeviceCommands.clear();
    state.clientPasswordChallenges.clear();
    state.production.pairingClaims.clear();
    state.notifications.length = 0;
    state.events.length = 0;
    state.nextNotificationId = 1;

    for (const map of [
        state.runtimeStats.serverReconnects,
        state.runtimeStats.clientReconnects,
        state.runtimeStats.serverAckStats,
        state.runtimeStats.clientAckStats,
        state.runtimeStats.serverReconnectHistory,
        state.runtimeStats.clientReconnectHistory,
        state.runtimeStats.serverFlappingAlerts,
        state.runtimeStats.clientFlappingAlerts
    ]) map.clear();
    state.runtimeStats.startedAt = Now();
    state.runtimeStats.totalConnections = 0;
    state.runtimeStats.ackOk = 0;
    state.runtimeStats.ackError = 0;
    state.runtimeStats.ackTimeout = 0;
    state.runtimeStats.ackRetries = 0;
    state.runtimeStats.queuedRequests = 0;
    state.runtimeStats.dequeuedRequests = 0;
    state.runtimeStats.replayedRequests = 0;
    state.runtimeStats.deadLetteredRequests = 0;
    state.runtimeStats.notices = 0;
}

function Reset(actor = 'WEB_ADMIN') {
    const onlineServers = state.servers.size;
    const onlineClients = state.clients.size;
    if (onlineServers || onlineClients) {
        return {
            ok: false,
            reason: 'DEVICES_MUST_BE_OFFLINE',
            onlineServers,
            onlineClients
        };
    }

    const database = require('../storage/database');
    const before = database.BuildDatabaseObject();
    const removed = {
        servers: Object.keys(before.servers || {}).length,
        clients: Object.keys(before.clients || {}).length,
        qrRequests: Object.keys(before.qrAuthRequests || {}).length,
        buildSessions: Object.keys(before.buildSessions || {}).length,
        deletedLocks: Object.keys(before.deletedDevices || {}).length
    };
    const licensesUnbound = Object.values(before.licenses || {})
        .filter(license => license && String(license.boundClient || '')).length;
    const backup = require('../storage/backup').CreateBackup('pre_device_registry_reset');
    if (!backup) return { ok: false, reason: 'REGISTRY_RESET_BACKUP_FAILED' };

    const passwordChallenges = new Map(state.clientPasswordChallenges);
    const candidate = ResetSnapshot(before);
    if (!database.ImportDatabaseObject(candidate)) {
        return { ok: false, reason: 'REGISTRY_RESET_IMPORT_FAILED', backup };
    }
    if (!database.SaveDatabase()) {
        database.ImportDatabaseObject(before);
        state.clientPasswordChallenges.clear();
        for (const [key, value] of passwordChallenges) state.clientPasswordChallenges.set(key, value);
        database.SaveDatabase();
        return { ok: false, reason: 'REGISTRY_RESET_PERSIST_FAILED', backup };
    }

    ClearTransientState();
    const resetAt = Now();
    const resetBy = SafeField(actor).slice(0, 64) || 'WEB_ADMIN';
    require('../storage/audit').LogEvent(
        'DEVICE_REGISTRY_RESET',
        `servers=${removed.servers} clients=${removed.clients} qr=${removed.qrRequests} build=${removed.buildSessions} locks=${removed.deletedLocks} / ${resetBy}`
    );
    return { ok: true, resetAt, resetBy, backup, removed, licensesUnbound };
}

module.exports = { ResetSnapshot, ClearTransientState, Reset };
