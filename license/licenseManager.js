'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function GetOnlineClient(...args) { return require('../identity/identityManager').GetOnlineClient(...args); }
function GetSavedClientByID(...args) { return require('../identity/identityManager').GetSavedClientByID(...args); }
function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function NormalizeID(...args) { return require('../core/utils').NormalizeID(...args); }
function NormalizeLicenseKey(...args) { return require('../core/utils').NormalizeLicenseKey(...args); }
function NotifyServerAuthorized(...args) { return require('../relay/notifications').NotifyServerAuthorized(...args); }
function NotifyServerUnauthorized(...args) { return require('../relay/notifications').NotifyServerUnauthorized(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function RandomLicenseKey(...args) { return require('../core/utils').RandomLicenseKey(...args); }
function SafeField(...args) { return require('../core/utils').SafeField(...args); }
function SafeIP(...args) { return require('../core/utils').SafeIP(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }
function PersistLicenseChange() { state.licenseRevision = Math.max(0, Number(state.licenseRevision) || 0) + 1; return SaveDatabase(); }

function NormalizeTags(value) {
    const items = Array.isArray(value) ? value : String(value || '').split(',');
    const out = [];
    for (const raw of items) {
        const tag = SafeField(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
        if (tag && !out.includes(tag)) out.push(tag);
        if (out.length >= 10) break;
    }
    return out;
}

function FindLicense(key) {
    return licenses.get(NormalizeLicenseKey(key)) || null;
}

function GetBoundLicenseEntry(clientId) {
    clientId = NormalizeID(clientId);
    for (const [key, license] of licenses) {
        if (license.boundClient === clientId) return { key, license };
    }
    return null;
}

function GetLicenseStatus(license) {
    if (!license) return 'UNKNOWN';
    if (license.suspended) return 'SUSPENDED';
    if (Now() >= license.expiresAt) return 'EXPIRED';
    if (license.boundClient) return 'BOUND';
    return 'AVAILABLE';
}

function GetUsableLicenseForConnection(connection) {
    if (!connection || !connection.clientId || !connection.licenseAuthorized || !state.serviceEnabled) return null;
    const license = FindLicense(connection.licenseKey);
    if (!license) return null;
    if (license.boundClient !== connection.clientId || license.suspended || Now() >= license.expiresAt) return null;
    return { key: connection.licenseKey, license };
}

function CompleteAuthorization(connection, licenseKey, license, source = 'LICENSE', requestId = '') {
    const eventSource = source === 'QR' || source === 'QR_RESUME' ? source : 'LICENSE';
    const accessType = require('../services/accessType').NormalizeAccessType(license.accessType);
    license.accessType = accessType;
    if (!license.boundClient) {
        license.boundClient = connection.clientId;
        license.boundAt = Now();
        LogEvent('LICENSE_BOUND', `${licenseKey} -> ${connection.clientId}`);
    }

    license.lastAuthAt = Now();
    license.lastSeenAt = Now();
    license.lastIP = SafeIP(connection.socket);
    license.authCount = Number(license.authCount || 0) + 1;

    const saved = GetSavedClientByID(connection.clientId);
    if (saved) {
        saved.lastAuthAt = Now();
        saved.lastSeenAt = Now();
        saved.lastIP = license.lastIP;
        saved.authCount = Number(saved.authCount || 0) + 1;
    }

    connection.licenseAuthorized = true;
    connection.licenseKey = licenseKey;
    connection.licenseExpiresAt = license.expiresAt;
    connection.biometricVerified = false;
    connection.accessType = accessType;
    connection.lastServerAuthState = '';
    SaveDatabase();

    if (eventSource === 'LICENSE') SendLine(connection.socket, `LICENSE_OK|${licenseKey}|${license.expiresAt}`);
    else SendLine(connection.socket, `QR_AUTH_OK|${requestId || 'RESUME'}|${license.expiresAt}|${accessType}`);
    NotifyServerUnauthorized(connection.clientId, 'BIOMETRIC_REQUIRED');
    require('../services/clientBiometric').Begin(connection, accessType);

    const remainingDays = Math.ceil((license.expiresAt - Now()) / 86400000);
    if (remainingDays <= 7) SendLine(connection.socket, `LICENSE_WARNING|${remainingDays}|${license.expiresAt}`);
    const auditReference = eventSource === 'LICENSE' ? licenseKey : `QR-${String(licenseKey).slice(-8)}`;
    LogEvent(eventSource === 'LICENSE' ? 'LICENSE_AUTH' : 'QR_LICENSE_AUTH', `${auditReference} -> ${connection.clientId} / ${eventSource}`);
    return true;
}

function ValidateAuthorizationTarget(connection, licenseKey) {
    if (!state.serviceEnabled) { SendLine(connection.socket, 'SERVICE_STATE|DISABLED'); return; }
    if (state.maintenanceMode && !connection.licenseAuthorized) { SendLine(connection.socket, 'SERVICE_STATE|MAINTENANCE'); return; }
    if (!connection.connected || !connection.clientId) { SendLine(connection.socket, 'LICENSE_ERROR|CLIENT_NOT_CONNECTED'); return; }

    licenseKey = NormalizeLicenseKey(licenseKey);
    const license = FindLicense(licenseKey);
    if (!licenseKey || !license) { SendLine(connection.socket, 'LICENSE_ERROR|INVALID_KEY'); return null; }
    if (license.suspended) { SendLine(connection.socket, 'LICENSE_ERROR|SUSPENDED'); NotifyServerUnauthorized(connection.clientId, 'SUSPENDED'); return null; }
    if (Now() >= license.expiresAt) { SendLine(connection.socket, 'LICENSE_ERROR|EXPIRED'); NotifyServerUnauthorized(connection.clientId, 'EXPIRED'); return null; }
    if (license.boundClient && license.boundClient !== connection.clientId) { SendLine(connection.socket, 'LICENSE_ERROR|BOUND_OTHER'); return null; }

    const already = GetBoundLicenseEntry(connection.clientId);
    if (already && already.key !== licenseKey) { SendLine(connection.socket, 'LICENSE_ERROR|CLIENT_ALREADY_LICENSED'); return null; }
    return { licenseKey, license };
}

function AuthorizeClient(connection, licenseKey) {
    const target = ValidateAuthorizationTarget(connection, licenseKey);
    if (!target) return false;
    return CompleteAuthorization(connection, target.licenseKey, target.license, 'LICENSE', '');
}

function AuthorizeClientByQr(connection, licenseKey, requestId = '') {
    const target = ValidateAuthorizationTarget(connection, licenseKey);
    if (!target) return false;
    return CompleteAuthorization(connection, target.licenseKey, target.license, requestId === 'RESUME' ? 'QR_RESUME' : 'QR', requestId);
}

function AuthorizeBoundClientByQr(connection, requestId = 'RESUME') {
    if (!connection || !connection.clientId) return false;
    const bound = GetBoundLicenseEntry(connection.clientId);
    if (!bound) return false;
    return AuthorizeClientByQr(connection, bound.key, requestId);
}

function CreateLicense(days, memo, tags = [], source = 'LICENSE') {
    let key;
    do { key = RandomLicenseKey(); } while (licenses.has(key));
    const now = Now();
    const license = {
        createdAt: now, expiresAt: now + days * 86400000,
        boundClient: '', boundAt: 0, lastAuthAt: 0, lastSeenAt: 0, lastIP: '',
        authCount: 0, sendCount: 0, suspended: false, memo: SafeField(memo), tags: NormalizeTags(tags), accessType: 'TYPE1'
    };
    licenses.set(key, license);
    if (!PersistLicenseChange()) { licenses.delete(key); return null; }
    LogEvent(source === 'QR' ? 'QR_LICENSE_CREATE' : 'LICENSE_CREATE', source === 'QR' ? `QR-${key.slice(-8)}` : key);
    setImmediate(() => { try { require('../services/licenseMonitor').ScanLicenseExpiryAlerts(); } catch (_) {} });
    return { key, expiresAt: license.expiresAt };
}


function SetLicenseTags(key, tags) {
    const license = FindLicense(key);
    if (!license) return false;
    license.tags = NormalizeTags(tags);
    PersistLicenseChange();
    LogEvent('LICENSE_TAGS', `${NormalizeLicenseKey(key)} -> ${license.tags.join(',') || '(cleared)'}`);
    return license.tags;
}

function ExtendLicense(key, days) {
    const license = FindLicense(key);
    if (!license) return false;
    license.expiresAt = Math.max(Now(), license.expiresAt) + days * 86400000;
    if (license.boundClient) {
        const client = GetOnlineClient(license.boundClient);
        if (client && client.licenseAuthorized && client.biometricVerified && client.licenseKey === NormalizeLicenseKey(key)) {
            client.licenseExpiresAt = license.expiresAt;
            SendLine(client.socket, `LICENSE_UPDATED|${license.expiresAt}`);
            NotifyServerAuthorized(client.clientId, client.serverId, license.expiresAt);
        }
    }
    PersistLicenseChange();
    return true;
}

function RevokeLiveLicense(clientId, reason) {
    const client = GetOnlineClient(clientId);
    if (client) {
        client.licenseAuthorized = false;
        client.licenseExpiresAt = 0;
        client.biometricVerified = false;
        client.accessType = '';
        state.clientBiometricChallenges.delete(clientId);
        client.lastServerAuthState = '';
        SendLine(client.socket, `LICENSE_ERROR|${reason}`);
    }
    NotifyServerUnauthorized(clientId, reason);
}

function UnbindLicense(key) {
    key = NormalizeLicenseKey(key);
    const license = FindLicense(key);
    if (!license) return false;
    const oldClient = license.boundClient;
    license.boundClient = '';
    license.boundAt = 0;
    license.lastAuthAt = 0;
    license.lastSeenAt = 0;
    license.lastIP = '';
    if (oldClient) RevokeLiveLicense(oldClient, 'UNBOUND');
    PersistLicenseChange();
    return true;
}

function SuspendLicense(key) {
    const license = FindLicense(key);
    if (!license) return false;
    license.suspended = true;
    if (license.boundClient) RevokeLiveLicense(license.boundClient, 'SUSPENDED');
    PersistLicenseChange();
    return true;
}

function ResumeLicense(key) {
    const license = FindLicense(key);
    if (!license || Now() >= license.expiresAt) return false;
    license.suspended = false;
    if (license.boundClient) {
        const client = GetOnlineClient(license.boundClient);
        if (client) SendLine(client.socket, `LICENSE_STATE|RESUMED|${license.expiresAt}`);
    }
    PersistLicenseChange();
    return true;
}

function DeleteLicense(key) {
    key = NormalizeLicenseKey(key);
    const license = FindLicense(key);
    if (!license) return false;
    const clientId = license.boundClient;
    licenses.delete(key);
    if (clientId) RevokeLiveLicense(clientId, 'REVOKED');
    PersistLicenseChange();
    return true;
}

function ReissueLicense(oldKey) {
    oldKey = NormalizeLicenseKey(oldKey);
    const old = FindLicense(oldKey);
    if (!old || old.expiresAt <= Now()) return null;
    let newKey;
    do { newKey = RandomLicenseKey(); } while (licenses.has(newKey));
    const copy = { ...old, createdAt: Now(), lastAuthAt: 0, lastSeenAt: 0, lastIP: '', authCount: 0, sendCount: 0, suspended: false };
    const oldClient = old.boundClient;
    licenses.set(newKey, copy);
    licenses.delete(oldKey);
    if (oldClient) RevokeLiveLicense(oldClient, 'REISSUED');
    SaveDatabase();
    LogEvent('LICENSE_REISSUE', `${oldKey} -> ${newKey}`);
    return { oldKey, newKey, expiresAt: copy.expiresAt };
}

function TransferLicense(key, newClientId) {
    key = NormalizeLicenseKey(key);
    newClientId = NormalizeID(newClientId);
    const license = FindLicense(key);
    if (!license) return { ok: false, reason: 'NOT_FOUND' };
    if (!GetSavedClientByID(newClientId)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
    const existing = GetBoundLicenseEntry(newClientId);
    if (existing && existing.key !== key) return { ok: false, reason: 'CLIENT_ALREADY_LICENSED' };
    const oldClient = license.boundClient;
    license.boundClient = newClientId;
    license.boundAt = Now();
    license.lastAuthAt = 0;
    license.lastSeenAt = 0;
    license.lastIP = '';
    if (oldClient && oldClient !== newClientId) RevokeLiveLicense(oldClient, 'TRANSFERRED');
    const target = GetOnlineClient(newClientId);
    if (target) NotifyServerUnauthorized(newClientId, 'LICENSE_REQUIRED');
    PersistLicenseChange();
    LogEvent('LICENSE_TRANSFER', `${key} -> ${newClientId}`);
    return { ok: true };
}

function SendLicenseItem(socket, key, license) {
    SendLine(socket, [
        'LIC_ITEM', key, GetLicenseStatus(license), license.expiresAt,
        license.boundClient || '', SafeField(license.memo), license.createdAt,
        license.boundAt, license.lastAuthAt, license.lastSeenAt,
        license.lastIP, license.authCount, license.sendCount
    ].join('|'));
}

function SearchLicenses(query, status) {
    query = String(query || '').trim().toUpperCase();
    status = String(status || 'ALL').trim().toUpperCase();
    const tagQuery = query.startsWith('TAG:') ? query.substring(4).trim() : '';
    const out = [];
    for (const [key, license] of licenses) {
        const st = GetLicenseStatus(license);
        if (status !== 'ALL' && st !== status) continue;
        const tags = NormalizeTags(license.tags || []);
        if (tagQuery) {
            if (!tags.includes(tagQuery)) continue;
        } else if (query && !`${key}|${license.boundClient}|${license.memo}|${tags.join(',')}`.toUpperCase().includes(query)) continue;
        out.push({ key, license });
        if (out.length >= MAX_SEARCH_RESULTS) break;
    }
    return out;
}

function ValidateClientLicense(connection) {
    if (!connection || !connection.connected || !connection.clientId || !connection.licenseAuthorized) return;
    if (!state.serviceEnabled) return;
    const active = GetUsableLicenseForConnection(connection);
    if (active) {
        if (connection.licenseExpiresAt !== active.license.expiresAt) {
            connection.licenseExpiresAt = active.license.expiresAt;
            SendLine(connection.socket, `LICENSE_UPDATED|${active.license.expiresAt}`);
        }
        const remainingDays = Math.ceil((active.license.expiresAt - Now()) / 86400000);
        if (remainingDays <= 7 && connection.lastExpiryWarningDay !== remainingDays) {
            connection.lastExpiryWarningDay = remainingDays;
            SendLine(connection.socket, `LICENSE_WARNING|${remainingDays}|${active.license.expiresAt}`);
        }
        return;
    }
    const bound = GetBoundLicenseEntry(connection.clientId);
    connection.licenseAuthorized=false;connection.licenseExpiresAt=0;connection.biometricVerified=false;connection.accessType='';connection.lastServerAuthState='';
    state.clientBiometricChallenges.delete(connection.clientId);
    if(bound&&bound.license.suspended){SendLine(connection.socket,'LICENSE_ERROR|SUSPENDED');NotifyServerUnauthorized(connection.clientId,'SUSPENDED');}
    else if(bound&&Now()>=bound.license.expiresAt){SendLine(connection.socket,'LICENSE_ERROR|EXPIRED');NotifyServerUnauthorized(connection.clientId,'EXPIRED');}
    else {SendLine(connection.socket,'LICENSE_ERROR|LICENSE_REQUIRED');NotifyServerUnauthorized(connection.clientId,'LICENSE_REQUIRED');}
}

module.exports = {
    NormalizeTags,
    FindLicense,
    GetBoundLicenseEntry,
    GetLicenseStatus,
    GetUsableLicenseForConnection,
    AuthorizeClient,
    AuthorizeClientByQr,
    AuthorizeBoundClientByQr,
    CreateLicense,
    SetLicenseTags,
    ExtendLicense,
    RevokeLiveLicense,
    UnbindLicense,
    SuspendLicense,
    ResumeLicense,
    DeleteLicense,
    ReissueLicense,
    TransferLicense,
    SendLicenseItem,
    SearchLicenses,
    ValidateClientLicense
};
