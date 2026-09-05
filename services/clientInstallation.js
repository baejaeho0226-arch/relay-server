'use strict';

const crypto = require('crypto');
const state = require('../core/state');
const { Now, SendLine } = require('../core/utils');
const identity = require('../identity/identityManager');
const Save = () => require('../storage/database').SaveDatabase();

function AndroidBase(deviceKey) {
    const m = /^(?:ANDROID2-([0-9A-F]{8,32})-[0-9A-F]{16}|ANDROID-([0-9A-F]{8,32}))$/i.exec(String(deviceKey || '').trim());
    return m ? (m[1] || m[2]).toUpperCase() : '';
}
function RegistryKey(deviceKey) {
    const base = AndroidBase(deviceKey);
    return base ? crypto.createHash('sha256').update(`APK-INSTALLATION:${base}`).digest('hex').toUpperCase() : '';
}
function DeviceKey(connection) {
    return connection.installationDeviceKey || identity.FindClientDeviceKey(connection.clientId) || '';
}
function Record(deviceKey, create = false) {
    const key = RegistryKey(deviceKey);
    if (!key) return null;
    if (!state.clientInstallations.has(key) && create)
        state.clientInstallations.set(key, { key, authorized: [], blockedAt: 0, attemptKey: '', releasedAt: 0, releasedBy: '' });
    return state.clientInstallations.get(key) || null;
}
function WasAuthorized(saved) {
    if (!saved) return false;
    const profile = state.clientBiometricProfiles.get(saved.id);
    return Number(saved.installationAuthorizedAt || 0) > 0 ||
        Number(profile && profile.verifiedAt || 0) > 0 || state.clientBuildBindings.has(saved.id);
}
function Remember(deviceKey, saved) {
    if (!WasAuthorized(saved)) return;
    const record = Record(deviceKey, true);
    if (!record) return;
    const previous = record.authorized.find(x => x.deviceKey === deviceKey);
    const value = { deviceKey, clientId: saved.id, token: saved.installationToken || '', at: saved.installationAuthorizedAt || Now() };
    if (previous) Object.assign(previous, value); else record.authorized.push(value);
}
function IsBlocked(connection) {
    const r = Record(DeviceKey(connection));
    return !!(r && r.blockedAt);
}
function Disconnect(connection, reason = 'REINSTALL_NOT_ALLOWED') {
    connection.reinstallBlocked = true;
    connection.connected = false;
    connection.deviceAuthVerified = false;
    connection.biometricVerified = false;
    connection.licenseAuthorized = false;
    connection.licenseKey = '';
    connection.licenseExpiresAt = 0;
    connection.buildCompleted = false;
    connection.buildSessionId = '';
    if (connection.clientId) {
        state.clientBiometricChallenges.delete(connection.clientId);
        for (const [key, challenge] of state.deviceAuthChallenges)
            if (challenge.type === 'CLIENT' && challenge.id === connection.clientId) state.deviceAuthChallenges.delete(key);
        state.deviceAuthStatus.delete(`CLIENT:${connection.clientId}`);
        require('./buildGate').RevokeForClient(connection.clientId, reason);
    }
    if (connection.installationDisconnectSent) return;
    connection.installationDisconnectSent = true;
    SendLine(connection.socket, `ERROR|${reason}`);
    // Flush the terminal reason, then close both sides even for old/malicious APKs.
    try { if (connection.socket.end) connection.socket.end(); } catch (_) {}
    const timer = setTimeout(() => { try { connection.socket.destroy(); } catch (_) {} }, 150);
    if (timer.unref) timer.unref();
}
function Reject(connection) {
    const deviceKey = DeviceKey(connection);
    const r = Record(deviceKey, true);
    if (r) {
        const fresh = !r.blockedAt;
        r.blockedAt = r.blockedAt || Now();
        r.attemptKey = deviceKey;
        Save(); // Durable before disconnect. Registry is independent of identity rows.
        for (const live of state.clients.values())
            if (live !== connection && RegistryKey(DeviceKey(live)) === r.key) Disconnect(live);
        for (const entry of r.authorized) require('./buildGate').RevokeForClient(entry.clientId, 'REINSTALL_NOT_ALLOWED');
        if (fresh) require('../storage/audit').LogEvent('CLIENT_REINSTALL_BLOCKED', r.key);
    }
    Disconnect(connection);
    return false;
}
function CheckDeviceKey(connection, deviceKey) {
    connection.installationDeviceKey = deviceKey;
    Backfill();
    const r = Record(deviceKey);
    if (!r) return true;
    if (r.blockedAt) return Reject(connection);
    const exact = r.authorized.find(x => x.deviceKey === deviceKey);
    // Deleting a registered CLIENT never grants a fresh installation/secret.
    if (exact) return state.clientIdentities.has(deviceKey) ? true : Reject(connection);
    if (r.authorized.some(x => !x.deviceKey.startsWith('ANDROID-'))) return Reject(connection);
    return true; // Legacy migration must still prove the retained secret.
}
function HandleToken(connection, token) {
    token = String(token || '').trim().toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(token)) {
        SendLine(connection.socket, 'ERROR|INSTALLATION_TOKEN_INVALID');
        return false;
    }
    const saved = identity.GetSavedClientByID(connection.clientId);
    if (!saved || connection.reinstallBlocked || IsBlocked(connection)) return Reject(connection);
    const r = Record(DeviceKey(connection));
    const entry = r && r.authorized.find(x => x.deviceKey === DeviceKey(connection));
    const expected = (entry && entry.token) || saved.installationToken;
    if (expected && expected !== token) return Reject(connection);
    connection.installationToken = token;
    return true;
}
function Ready(connection) {
    if (!connection || connection.reinstallBlocked) return false;
    if (IsBlocked(connection)) return Reject(connection);
    const saved = identity.GetSavedClientByID(connection.clientId);
    if (!saved) return false;
    const r = Record(DeviceKey(connection));
    const entry = r && r.authorized.find(x => x.deviceKey === DeviceKey(connection));
    const expected = (entry && entry.token) || saved.installationToken;
    if (expected && expected !== connection.installationToken) {
        if (connection.installationToken) return Reject(connection);
        SendLine(connection.socket, 'ERROR|INSTALLATION_TOKEN_REQUIRED');
        return false;
    }
    return true;
}
function MarkAuthorized(connection) {
    const saved = identity.GetSavedClientByID(connection.clientId);
    if (!saved || !connection.deviceAuthVerified || !connection.biometricVerified ||
        !connection.licenseAuthorized || !Ready(connection)) return false;
    if (!saved.installationAuthorizedAt) saved.installationAuthorizedAt = Now();
    if (!saved.installationToken && connection.installationToken) saved.installationToken = connection.installationToken;
    Remember(DeviceKey(connection), saved);
    return true;
}
function Backfill() {
    for (const [key, saved] of state.clientIdentities) {
        if (!saved.installationAuthorizedAt && WasAuthorized(saved)) {
            const profile = state.clientBiometricProfiles.get(saved.id);
            saved.installationAuthorizedAt = Number(profile && profile.verifiedAt) || Now();
        }
        Remember(key, saved);
    }
}
function List() {
    Backfill();
    return [...state.clientInstallations.values()].filter(r => r.blockedAt).map(r => ({
        key: r.key, blockedAt: r.blockedAt, attemptKey: r.attemptKey,
        clientIds: [...new Set(r.authorized.map(x => x.clientId))], releasedAt: r.releasedAt
    })).sort((a, b) => b.blockedAt - a.blockedAt);
}
function Release(key, actor) {
    const r = state.clientInstallations.get(String(key || '').toUpperCase());
    if (!r || !r.blockedAt) return { ok: false, reason: 'REINSTALL_BLOCK_NOT_FOUND' };
    // This is the sole release path. Reset enrollment proofs, never grant access.
    // Release stale registration/PC slot; the phone must pass new QR + biometric proof.
    const ids = new Set(r.authorized.map(x => x.clientId));
    for (const [deviceKey, saved] of state.clientIdentities) {
        if (RegistryKey(deviceKey) !== r.key) continue;
        ids.add(saved.id);
        saved.installationAuthorizedAt = 0;
        saved.installationToken = '';
        const live = identity.GetOnlineClient(saved.id);
        if (live) Disconnect(live, 'INSTALLATION_RESET');
        // A reinstalled phone has a new key. Release stale identity/pairing so it
        // cannot consume the only PC slot; generic DeleteClient preserves r.
        require('./deviceRegistry').DeleteClient(saved.id);
    }
    for (const id of ids) {
        require('./buildGate').PurgeClient(id);
        state.clientBiometricProfiles.delete(id);
    }
    r.authorized = [];
    r.blockedAt = 0;
    r.attemptKey = '';
    r.releasedAt = Now();
    r.releasedBy = String(actor || 'WEB_ADMIN').slice(0, 64);
    if (!Save()) { r.blockedAt = Now(); return { ok: false, reason: 'STORAGE_SAVE_FAILED' }; }
    require('../storage/audit').LogEvent('CLIENT_REINSTALL_RELEASED', `${r.key} BY ${r.releasedBy}`);
    return { ok: true, key: r.key, requiresQrApproval: true };
}
function ImportPersisted(data) {
    state.clientInstallations.clear();
    for (const [key, raw] of Object.entries(data.clientInstallations || {})) {
        if (!/^[0-9A-F]{64}$/.test(key) || !raw || !Array.isArray(raw.authorized)) continue;
        const authorized = raw.authorized.filter(x => x && RegistryKey(x.deviceKey) === key && /^[0-9A-F]{16}$/.test(x.clientId))
            .map(x => ({ deviceKey: x.deviceKey, clientId: x.clientId, token: /^[0-9A-F]{32}$/.test(x.token) ? x.token : '', at: Number(x.at) || 0 }));
        state.clientInstallations.set(key, { key, authorized, blockedAt: Math.max(0, Number(raw.blockedAt) || 0),
            attemptKey: RegistryKey(raw.attemptKey) === key ? raw.attemptKey : '', releasedAt: Math.max(0, Number(raw.releasedAt) || 0), releasedBy: String(raw.releasedBy || '').slice(0, 64) });
    }
}
module.exports = { AndroidBase, RegistryKey, WasAuthorized, CheckDeviceKey, HandleToken, Ready,
    MarkAuthorized, Backfill, Reject, IsBlocked, List, Release, ImportPersisted };
