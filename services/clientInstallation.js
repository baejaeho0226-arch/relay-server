'use strict';

const state = require('../core/state');
const { Now, SendLine } = require('../core/utils');
const identity = require('../identity/identityManager');

function AndroidBase(deviceKey) {
    const match = /^(?:ANDROID2-([0-9A-F]{8,32})-[0-9A-F]{16}|ANDROID-([0-9A-F]{8,32}))$/i
        .exec(String(deviceKey || '').trim());
    return match ? (match[1] || match[2]).toUpperCase() : '';
}

function WasAuthorized(saved) {
    if (!saved) return false;
    const profile = state.clientBiometricProfiles.get(saved.id);
    return Number(saved.installationAuthorizedAt || 0) > 0 ||
        Number(profile && profile.verifiedAt || 0) > 0 ||
        state.clientBuildBindings.has(saved.id);
}

function Reject(connection) {
    connection.reinstallBlocked = true;
    connection.deviceAuthVerified = false;
    connection.biometricVerified = false;
    connection.licenseAuthorized = false;
    connection.buildCompleted = false;
    connection.buildSessionId = '';
    if (connection.clientId) {
        state.clientBiometricChallenges.delete(connection.clientId);
        require('./buildGate').RevokeForClient(connection.clientId, 'REINSTALL_NOT_ALLOWED');
    }
    SendLine(connection.socket, 'ERROR|REINSTALL_NOT_ALLOWED');
    return false;
}

function CheckDeviceKey(connection, deviceKey) {
    const base = AndroidBase(deviceKey);
    if (!base) return true;
    // Keep each already-authorized installation working, including historical
    // vendor ID collisions. A new installation must not replace any of them.
    if (WasAuthorized(state.clientIdentities.get(deviceKey))) return true;
    for (const [oldKey, saved] of state.clientIdentities) {
        if (oldKey !== deviceKey && AndroidBase(oldKey) === base && WasAuthorized(saved)) {
            // Legacy ANDROID -> ANDROID2 upgrade still has to prove possession
            // of the original device secret. Missing secrets are denied below.
            if (oldKey.toUpperCase() === `ANDROID-${base}`) continue;
            return Reject(connection);
        }
    }
    return true;
}

function HandleToken(connection, token) {
    token = String(token || '').trim().toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(token)) {
        SendLine(connection.socket, 'ERROR|INSTALLATION_TOKEN_INVALID');
        return false;
    }
    const saved = identity.GetSavedClientByID(connection.clientId);
    if (!saved || connection.reinstallBlocked) return false;
    if (saved.installationToken && saved.installationToken !== token)
        return Reject(connection);
    connection.installationToken = token;
    return true;
}

function Ready(connection) {
    if (!connection || connection.reinstallBlocked) return false;
    const saved = identity.GetSavedClientByID(connection.clientId);
    if (!saved) return false;
    if (saved.installationToken && saved.installationToken !== connection.installationToken) {
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
    // The no-backup token is bound only after both device and biometric proof.
    if (!saved.installationToken && connection.installationToken)
        saved.installationToken = connection.installationToken;
    return true;
}

function Backfill() {
    for (const saved of state.clientIdentities.values()) {
        if (!saved.installationAuthorizedAt && WasAuthorized(saved)) {
            const profile = state.clientBiometricProfiles.get(saved.id);
            saved.installationAuthorizedAt = Number(profile && profile.verifiedAt) || Now();
        }
    }
}

module.exports = { AndroidBase, WasAuthorized, CheckDeviceKey, HandleToken,
    Ready, MarkAuthorized, Backfill, Reject };
