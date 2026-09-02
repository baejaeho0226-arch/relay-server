'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function EnsureDirs(...args) { return require('../core/utils').EnsureDirs(...args); }
function LogEvent(...args) { return require('./audit').LogEvent(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function NormalizeLicenseKey(...args) { return require('../core/utils').NormalizeLicenseKey(...args); }
function NormalizeVersion(...args) { return require('../core/utils').NormalizeVersion(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }

function BuildDatabaseObject() {
    return {
        version: 128,
        serviceEnabled: state.serviceEnabled,
        maintenanceMode: state.maintenanceMode,
        minProtocolVersion: state.minProtocolVersion,
        minServerVersion: state.minServerVersion,
        minClientVersion: state.minClientVersion,
        maintenanceSchedule: state.maintenanceSchedule,
        disabledServers: Array.from(disabledServers),
        drainingServers: Array.from(drainingServers),
        disabledClients: Array.from(disabledClients),
        serverAliases: Object.fromEntries(state.serverAliases),
        clientAliases: Object.fromEntries(state.clientAliases),
        serverNotes: Object.fromEntries(state.serverNotes),
        clientNotes: Object.fromEntries(state.clientNotes),
        serverDrainMeta: Object.fromEntries(state.serverDrainMeta),
        desiredRuntimeConfig: state.desiredRuntimeConfig,
        serverFeatureOverrides: Object.fromEntries(state.serverFeatureOverrides),
        clientFeatureOverrides: Object.fromEntries(state.clientFeatureOverrides),
        serverProtocolProfiles: Object.fromEntries(state.serverProtocolProfiles),
        clientProtocolProfiles: Object.fromEntries(state.clientProtocolProfiles),
        deviceSecrets: Object.fromEntries(state.deviceSecrets),
        releaseCatalog: Object.fromEntries(state.releaseCatalog),
        deviceReleaseChannels: Object.fromEntries(state.deviceReleaseChannels),
        configHistory: state.configHistory,
        enrollmentPolicy: state.enrollmentPolicy,
        deviceEnrollments: Object.fromEntries(state.deviceEnrollments),
        deviceSecretRotations: Object.fromEntries(state.deviceSecretRotations),
        deviceSecretMeta: Object.fromEntries(state.deviceSecretMeta),
        deviceNetworkProfiles: Object.fromEntries(state.deviceNetworkProfiles),
        emergencyFailoverPolicy: state.emergencyFailoverPolicy,
        clientFailoverEnabled: Array.from(state.clientFailoverEnabled),
        clientFailoverRecords: Object.fromEntries(state.clientFailoverRecords),
        clientServerBindings: Object.fromEntries(state.clientServerBindings),
        offlineQueuePolicy: state.offlineQueuePolicy,
        clientOfflineQueueEnabled: Array.from(state.clientOfflineQueueEnabled),
        offlineQueue: Object.fromEntries(state.offlineQueue),
        deadLetters: Object.fromEntries(state.deadLetters),
        numberProcessingPolicy: state.numberProcessingPolicy,
        processorStats: Object.fromEntries(state.processorStats),
        pushSubscriptions: Object.fromEntries(state.pushSubscriptions),
        dailyHealthReports: Object.fromEntries(state.dailyHealthReports),
        dailyHealthAccumulator: state.dailyHealthAccumulator,
        qrAuthRequests: Object.fromEntries(state.qrAuthRequests),
        clientPasswordProfiles: Object.fromEntries(state.clientPasswordProfiles),
        pendingBuildGrants: Object.fromEntries(state.pendingBuildGrants),
        buildSessions: Object.fromEntries(state.buildSessions),
        clientBuildBindings: Object.fromEntries(state.clientBuildBindings),
        accessGroupGuids: Object.fromEntries(state.accessGroupGuids),
        buildSessionPolicy: state.buildSessionPolicy,
        licenseRevision: Number(state.licenseRevision) || 0,
        servers: Object.fromEntries(serverIdentities),
        clients: Object.fromEntries(clientIdentities),
        licenses: Object.fromEntries(licenses)
    };
}

function SaveJsonRecoveryMirror(snapshot) {
    const tmp = DB_FILE + '.tmp';
    const text = JSON.stringify(snapshot, null, 2);
    if (fs.existsSync(DB_FILE)) {
        try { fs.copyFileSync(DB_FILE, DB_BAK_FILE); } catch (_) {}
    }
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, DB_FILE);
}

function SaveDatabase(options = {}) {
    const tmp = DB_FILE + '.tmp';
    if (config.HA_ENABLED && !options.replicated) {
        try { if (require('../services/haCoordinator').Status().role === 'STANDBY') return true; } catch (_) {}
    }
    try {
        const snapshot = BuildDatabaseObject();
        let result = null;
        if (config.STORAGE_ENGINE === 'sqlite') {
            result = require('./sqliteDatabase').SaveSnapshot(snapshot, {
                revision: Number(options.revision) || 0,
                sourceInstance: options.sourceInstance || config.HA_INSTANCE_ID
            });
            try { SaveJsonRecoveryMirror(snapshot); } catch (mirrorError) {
                console.error('DATABASE RECOVERY MIRROR ERROR:', mirrorError.message);
            }
        } else {
            SaveJsonRecoveryMirror(snapshot);
            result = { revision: 0, savedAt: Date.now(), size: Buffer.byteLength(JSON.stringify(snapshot)) };
        }
        state.runtimeStats.lastDatabaseSaveAt = Date.now();
        state.runtimeStats.lastDatabaseSaveOk = true;
        try { state.runtimeStats.lastDatabaseSize = fs.statSync(config.STORAGE_ENGINE === 'sqlite' ? config.SQLITE_FILE : DB_FILE).size; } catch (_) {}
        try { require('./licenseSnapshot').SaveLicenseSnapshot(); } catch (_) {}
        if (!options.replicated) {
            try { require('../services/haCoordinator').OnLocalSnapshot(snapshot, result); } catch (_) {}
        }
        return true;
    } catch (error) {
        state.runtimeStats.lastDatabaseSaveAt = Date.now();
        state.runtimeStats.lastDatabaseSaveOk = false;
        console.error('DATABASE SAVE ERROR:', error.message);
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        return false;
    }
}

function ImportDatabaseObject(data) {
    if (!data || typeof data !== 'object') return false;

    const newServers = new Map();
    const newClients = new Map();
    const newLicenses = new Map();
    const used = new Set();

    if (data.servers && typeof data.servers === 'object') {
        for (const [deviceKey, rawId] of Object.entries(data.servers)) {
            const key = String(deviceKey || '').trim();
            const id = NormalizeID(rawId);
            if (!key || !id || used.has(id)) continue;
            newServers.set(key, id);
            used.add(id);
        }
    }

    if (data.clients && typeof data.clients === 'object') {
        for (const [deviceKey, value] of Object.entries(data.clients)) {
            if (!value || typeof value !== 'object') continue;
            const key = String(deviceKey || '').trim();
            const id = NormalizeID(value.id || value.clientId);
            const rawServerId = String(value.serverId || '').trim();
            const serverId = rawServerId ? NormalizeID(rawServerId) : '';
            if (!key || !id || (rawServerId && !serverId) || used.has(id)) continue;
            newClients.set(key, {
                id,
                serverId,
                createdAt: Number(value.createdAt) || Now(),
                lastSeenAt: Number(value.lastSeenAt) || 0,
                lastAuthAt: Number(value.lastAuthAt) || 0,
                lastIP: String(value.lastIP || ''),
                authCount: Number(value.authCount) || 0,
                sendCount: Number(value.sendCount) || 0,
                reconnectCount: Number(value.reconnectCount) || 0
            });
            used.add(id);
        }
    }

    if (data.licenses && typeof data.licenses === 'object') {
        for (const [rawKey, value] of Object.entries(data.licenses)) {
            if (!value || typeof value !== 'object') continue;
            const key = NormalizeLicenseKey(rawKey);
            const expiresAt = Number(value.expiresAt);
            if (!key || !Number.isFinite(expiresAt) || expiresAt <= 0) continue;
            newLicenses.set(key, {
                createdAt: Number(value.createdAt) || Now(),
                expiresAt,
                boundClient: NormalizeID(value.boundClient || ''),
                boundAt: Number(value.boundAt) || 0,
                lastAuthAt: Number(value.lastAuthAt) || 0,
                lastSeenAt: Number(value.lastSeenAt) || 0,
                lastIP: String(value.lastIP || ''),
                authCount: Number(value.authCount) || 0,
                sendCount: Number(value.sendCount) || 0,
                suspended: Boolean(value.suspended),
                memo: SafeField(value.memo || ''),
                tags: require('../license/licenseManager').NormalizeTags(value.tags || []),
                accessType: require('../services/clientPassword').NormalizeAccessType(value.accessType)
            });
        }
    }

    serverIdentities.clear();
    clientIdentities.clear();
    licenses.clear();
    disabledServers.clear();
    drainingServers.clear();
    disabledClients.clear();
    state.serverAliases.clear();
    state.clientAliases.clear();
    state.serverNotes.clear();
    state.clientNotes.clear();
    state.serverDrainMeta.clear();
    state.serverFeatureOverrides.clear(); state.clientFeatureOverrides.clear();
    state.serverProtocolProfiles.clear(); state.clientProtocolProfiles.clear(); state.deviceSecrets.clear(); state.releaseCatalog.clear(); state.deviceReleaseChannels.clear(); state.configHistory.length=0; state.deviceEnrollments.clear(); state.deviceSecretRotations.clear(); state.deviceSecretMeta.clear(); state.deviceNetworkProfiles.clear(); state.clientFailoverEnabled.clear(); state.clientFailoverRecords.clear(); state.clientServerBindings.clear(); state.clientOfflineQueueEnabled.clear(); state.offlineQueue.clear(); state.deadLetters.clear(); state.processorStats.clear(); state.pushSubscriptions.clear(); state.dailyHealthReports.clear(); state.qrAuthRequests.clear(); state.clientPasswordProfiles.clear(); state.clientPasswordChallenges.clear(); state.pendingBuildGrants.clear(); state.buildSessions.clear(); state.clientBuildBindings.clear(); state.accessGroupGuids.clear();

    for (const [k, v] of newServers) serverIdentities.set(k, v);
    for (const [k, v] of newClients) clientIdentities.set(k, v);
    for (const [k, v] of newLicenses) licenses.set(k, v);

    for (const id of Array.isArray(data.disabledServers) ? data.disabledServers : []) {
        const n = NormalizeID(id); if (n) disabledServers.add(n);
    }
    for (const id of Array.isArray(data.drainingServers) ? data.drainingServers : []) {
        const n = NormalizeID(id); if (n) drainingServers.add(n);
    }
    for (const id of Array.isArray(data.disabledClients) ? data.disabledClients : []) {
        const n = NormalizeID(id); if (n) disabledClients.add(n);
    }

    if (data.serverAliases && typeof data.serverAliases === 'object') {
        for (const [rawId, rawAlias] of Object.entries(data.serverAliases)) {
            const id = NormalizeID(rawId);
            const alias = SafeField(rawAlias || '').slice(0, 64);
            if (id && alias && Array.from(serverIdentities.values()).includes(id)) state.serverAliases.set(id, alias);
        }
    }
    if (data.clientAliases && typeof data.clientAliases === 'object') {
        for (const [rawId, rawAlias] of Object.entries(data.clientAliases)) {
            const id = NormalizeID(rawId);
            const alias = SafeField(rawAlias || '').slice(0, 64);
            if (id && alias && Array.from(clientIdentities.values()).some(x => x.id === id)) state.clientAliases.set(id, alias);
        }
    }


    if (data.serverNotes && typeof data.serverNotes === 'object') {
        for (const [rawId, rawNote] of Object.entries(data.serverNotes)) {
            const id = NormalizeID(rawId);
            const note = String(rawNote || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
            if (id && note && Array.from(serverIdentities.values()).includes(id)) state.serverNotes.set(id, note);
        }
    }
    if (data.clientNotes && typeof data.clientNotes === 'object') {
        for (const [rawId, rawNote] of Object.entries(data.clientNotes)) {
            const id = NormalizeID(rawId);
            const note = String(rawNote || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
            if (id && note && Array.from(clientIdentities.values()).some(x => x.id === id)) state.clientNotes.set(id, note);
        }
    }

    if (data.serverDrainMeta && typeof data.serverDrainMeta === 'object') {
        for (const [rawId, rawMeta] of Object.entries(data.serverDrainMeta)) {
            const id = NormalizeID(rawId);
            if (!id || !drainingServers.has(id) || !Array.from(serverIdentities.values()).includes(id) || !rawMeta || typeof rawMeta !== 'object') continue;
            state.serverDrainMeta.set(id, {
                startedAt: Math.max(0, Number(rawMeta.startedAt) || 0),
                initialClients: Math.max(0, Number(rawMeta.initialClients) || 0),
                readyNotified: Boolean(rawMeta.readyNotified)
            });
        }
    }


    if (data.desiredRuntimeConfig && typeof data.desiredRuntimeConfig === 'object') {
        const d=data.desiredRuntimeConfig;
        state.desiredRuntimeConfig={
            revision:Math.max(1,Number(d.revision)||1), reconnectBaseMs:Math.max(100,Number(d.reconnectBaseMs)||500),
            reconnectMaxMs:Math.max(100,Number(d.reconnectMaxMs)||30000), reconnectJitterPct:Math.max(0,Math.min(100,Number(d.reconnectJitterPct)||0)),
            heartbeatMs:Math.max(1000,Number(d.heartbeatMs)||10000), featureFlags:(d.featureFlags&&typeof d.featureFlags==='object')?d.featureFlags:{}
        };
    }
    for (const [src,map] of [[data.serverFeatureOverrides,state.serverFeatureOverrides],[data.clientFeatureOverrides,state.clientFeatureOverrides],[data.serverProtocolProfiles,state.serverProtocolProfiles],[data.clientProtocolProfiles,state.clientProtocolProfiles]]) {
        if(src&&typeof src==='object') for(const [id,v] of Object.entries(src)){const n=NormalizeID(id);if(n&&v&&typeof v==='object')map.set(n,v);}
    }
    if(data.deviceSecrets&&typeof data.deviceSecrets==='object') for(const [key,secret] of Object.entries(data.deviceSecrets)){if(/^(SERVER|CLIENT):[0-9A-F]{16}$/.test(key)&&/^[A-Za-z0-9_-]{40,64}$/.test(String(secret||'')))state.deviceSecrets.set(key,String(secret));}
    if(data.releaseCatalog&&typeof data.releaseCatalog==='object') for(const [key,value] of Object.entries(data.releaseCatalog)){if(/^(SERVER|CLIENT):(STABLE|BETA|TEST)$/.test(key)&&value&&typeof value==='object')state.releaseCatalog.set(key,{...value});}
    if(data.deviceReleaseChannels&&typeof data.deviceReleaseChannels==='object') for(const [key,value] of Object.entries(data.deviceReleaseChannels)){const ch=String(value||'').toUpperCase();if(/^(SERVER|CLIENT):[0-9A-F]{16}$/.test(key)&&['STABLE','BETA','TEST'].includes(ch))state.deviceReleaseChannels.set(key,ch);}
    if(Array.isArray(data.configHistory)) state.configHistory.push(...data.configHistory.slice(0,100).filter(x=>x&&typeof x==='object'));
    if(data.enrollmentPolicy&&typeof data.enrollmentPolicy==='object') state.enrollmentPolicy={enabled:!!data.enrollmentPolicy.enabled,updatedAt:Number(data.enrollmentPolicy.updatedAt)||0};
    if(data.deviceEnrollments&&typeof data.deviceEnrollments==='object') for(const [key,value] of Object.entries(data.deviceEnrollments)){if(/^(SERVER|CLIENT):/.test(key)&&value&&typeof value==='object')state.deviceEnrollments.set(key,{...value});}
    if(data.deviceSecretRotations&&typeof data.deviceSecretRotations==='object') for(const [key,value] of Object.entries(data.deviceSecretRotations)){if(/^(SERVER|CLIENT):[0-9A-F]{16}$/.test(key)&&value&&typeof value==='object')state.deviceSecretRotations.set(key,{...value});}
    if(data.deviceSecretMeta&&typeof data.deviceSecretMeta==='object') for(const [key,value] of Object.entries(data.deviceSecretMeta)){if(/^(SERVER|CLIENT):[0-9A-F]{16}$/.test(key)&&value&&typeof value==='object')state.deviceSecretMeta.set(key,{createdAt:Number(value.createdAt)||0,rotatedAt:Number(value.rotatedAt)||0,rotationCount:Math.max(0,Number(value.rotationCount)||0)});}
    if(data.deviceNetworkProfiles&&typeof data.deviceNetworkProfiles==='object'){
        const networkSecurity=require('../services/networkSecurity');
        for(const [key,value] of Object.entries(data.deviceNetworkProfiles)){
            if(!/^(SERVER|CLIENT):[0-9A-F]{16}$/.test(key)) continue;
            const normalized=networkSecurity.NormalizeStoredProfile(value);
            if(normalized) state.deviceNetworkProfiles.set(key,normalized);
        }
    }
    state.emergencyFailoverPolicy = require('../services/emergencyFailover').NormalizePolicy(data.emergencyFailoverPolicy);
    if(Array.isArray(data.clientFailoverEnabled)) for(const rawId of data.clientFailoverEnabled){const id=NormalizeID(rawId);if(id&&Array.from(newClients.values()).some(x=>x.id===id))state.clientFailoverEnabled.add(id);}
    if(data.clientFailoverRecords&&typeof data.clientFailoverRecords==='object'){
        for(const [rawClientId,value] of Object.entries(data.clientFailoverRecords)){
            const clientId=NormalizeID(rawClientId); if(!clientId||!value||typeof value!=='object')continue;
            const saved=Array.from(newClients.values()).find(x=>x.id===clientId); if(!saved)continue;
            const primaryServerId=NormalizeID(value.primaryServerId), failoverServerId=NormalizeID(value.failoverServerId);
            if(!primaryServerId||!failoverServerId||!Array.from(newServers.values()).includes(primaryServerId)||!Array.from(newServers.values()).includes(failoverServerId))continue;
            state.clientFailoverRecords.set(clientId,{clientId,primaryServerId,failoverServerId,failedOverAt:Number(value.failedOverAt)||0,lastMoveAt:Number(value.lastMoveAt)||0,moveCount:Math.max(1,Number(value.moveCount)||1),reason:String(value.reason||''),selectedBy:String(value.selectedBy||'AUTO_FALLBACK'),lastReturnAt:Number(value.lastReturnAt)||0});
        }
    }
    require('../services/requestRecovery').ImportPersisted(data);
    require('../services/processorCenter').ImportPersisted(data);
    require('../services/pushManager').ImportPersisted(data);
    require('../services/dailyHealth').ImportPersisted(data);
    require('../services/qrApproval').ImportPersisted(data);
    require('../services/buildGate').ImportPersisted(data);
    require('../services/userDashboard').ImportPersisted(data);
    if (data.clientPasswordProfiles && typeof data.clientPasswordProfiles === 'object') {
        for (const [rawClientId, raw] of Object.entries(data.clientPasswordProfiles)) {
            const clientId = NormalizeID(rawClientId);
            if (!clientId || !raw || typeof raw !== 'object') continue;
            const salt = String(raw.salt || '').toUpperCase();
            const verifier = String(raw.verifier || '').toUpperCase();
            const iterations = Math.max(1, Math.min(20000, Number(raw.iterations) || 4096));
            if (!/^[0-9A-F]{32}$/.test(salt) || !/^[0-9A-F]{64}$/.test(verifier)) continue;
            state.clientPasswordProfiles.set(clientId, {
                salt,
                iterations,
                verifier,
                pinDigits: Number(raw.pinDigits) === 6 ? 6 : 0,
                accessType: require('../services/clientPassword').NormalizeAccessType(raw.accessType),
                createdAt: Number(raw.createdAt) || Now(),
                updatedAt: Number(raw.updatedAt) || 0,
                failedAttempts: Math.max(0, Math.min(4, Number(raw.failedAttempts) || 0)),
                lockUntil: Math.max(0, Number(raw.lockUntil) || 0),
                resetAt: Math.max(0, Number(raw.resetAt) || 0),
                resetBy: String(raw.resetBy || '').replace(/[\r\n|]/g, '').slice(0, 64)
            });
        }
    }
    state.licenseRevision=Math.max(0,Number(data.licenseRevision)||0);

    if (typeof data.serviceEnabled === 'boolean') state.serviceEnabled = data.serviceEnabled;
    if (typeof data.maintenanceMode === 'boolean') state.maintenanceMode = data.maintenanceMode;

    const p = Number(data.minProtocolVersion);
    if (Number.isInteger(p) && p >= 1 && p <= CURRENT_PROTOCOL_VERSION) state.minProtocolVersion = p;
    const sv = NormalizeVersion(data.minServerVersion);
    const cv = NormalizeVersion(data.minClientVersion);
    if (sv) state.minServerVersion = sv;
    if (cv) state.minClientVersion = cv;

    if (data.maintenanceSchedule && typeof data.maintenanceSchedule === 'object') {
        const startAt = Number(data.maintenanceSchedule.startAt);
        const endAt = Number(data.maintenanceSchedule.endAt);
        if (startAt > 0 && endAt > startAt) {
            state.maintenanceSchedule = require('../services/maintenance').NormalizeSchedule(data.maintenanceSchedule);
        }
    } else {
        state.maintenanceSchedule = null;
    }
    return true;
}

function LatestBackupFile() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(x => x.endsWith('.json'))
            .map(file => ({ file, time: fs.statSync(path.join(BACKUP_DIR, file)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        return files.length ? path.join(BACKUP_DIR, files[0].file) : '';
    } catch (_) { return ''; }
}

function TryLoadJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function LoadDatabase() {
    EnsureDirs();
    if (config.STORAGE_ENGINE === 'sqlite') {
        try {
            const stored = require('./sqliteDatabase').LoadSnapshot();
            if (stored && ImportDatabaseObject(stored.data)) {
                state.runtimeStats.lastDatabaseSaveAt = stored.savedAt;
                state.runtimeStats.lastDatabaseSaveOk = true;
                try { state.runtimeStats.lastDatabaseSize = fs.statSync(config.SQLITE_FILE).size; } catch (_) {}
                return;
            }
        } catch (error) {
            console.error('SQLITE LOAD ERROR:', error.message);
            LogEvent('SQLITE_LOAD_ERROR', error.message);
        }
    }
    const candidates = [DB_FILE, DB_BAK_FILE, LatestBackupFile()].filter(Boolean);
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const data = TryLoadJson(file);
        if (data && ImportDatabaseObject(data)) {
            LogEvent(config.STORAGE_ENGINE === 'sqlite' ? 'DATABASE_SQLITE_CUTOVER' : (file !== DB_FILE ? 'DATABASE_AUTO_RECOVER' : 'DATABASE_LOAD'), path.basename(file));
            try { if (require('./licenseSnapshot').RecoverIfNewer()) LogEvent('LICENSE_SNAPSHOT_RECOVER', `revision=${state.licenseRevision}`); } catch (_) {}
            SaveDatabase();
            return;
        }
    }
    SaveDatabase();
}

module.exports = {
    BuildDatabaseObject,
    SaveDatabase,
    ImportDatabaseObject,
    LatestBackupFile,
    TryLoadJson,
    LoadDatabase
};
