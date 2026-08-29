'use strict';

const config = require('../config/config');
const state = require('../core/state');

const {
    CURRENT_PROTOCOL_VERSION
} = config;

const {
    NormalizeVersion,
    IsVersionAtLeast,
    SendLine
} = require('../core/utils');

function ValidateProtocolAndVersion(connection, kind, protocolVersion, appVersion) {
    protocolVersion = Number(protocolVersion);
    appVersion = String(appVersion || '').trim();

    if (!Number.isInteger(protocolVersion) || protocolVersion < state.minProtocolVersion) {
        SendLine(connection.socket, `ERROR|PROTOCOL_UPDATE_REQUIRED|${state.minProtocolVersion}`);
        return false;
    }

    if (protocolVersion > CURRENT_PROTOCOL_VERSION) {
        SendLine(connection.socket, `ERROR|PROTOCOL_NOT_SUPPORTED|${CURRENT_PROTOCOL_VERSION}`);
        return false;
    }

    let requiredVersion = '';

    if (kind === 'server') {
        requiredVersion = state.minServerVersion;
    } else if (kind === 'client') {
        requiredVersion = state.minClientVersion;
    } else {
        SendLine(connection.socket, 'ERROR|INVALID_CONNECTION_TYPE');
        return false;
    }

    if (!NormalizeVersion(appVersion) || !IsVersionAtLeast(appVersion, requiredVersion)) {
        SendLine(
            connection.socket,
            `ERROR|${kind === 'server' ? 'SERVER' : 'CLIENT'}_UPDATE_REQUIRED|${requiredVersion}`
        );
        return false;
    }

    connection.protocolVersion = protocolVersion;
    connection.appVersion = appVersion;
    return true;
}

function EnforceVersionPolicy() {
    for (const connection of Array.from(state.servers.values())) {
        if (!connection || !connection.socket || connection.socket.destroyed) {
            continue;
        }

        if (connection.protocolVersion < state.minProtocolVersion) {
            SendLine(connection.socket, `ERROR|PROTOCOL_UPDATE_REQUIRED|${state.minProtocolVersion}`);
            connection.socket.destroy();
            continue;
        }

        if (connection.protocolVersion > CURRENT_PROTOCOL_VERSION) {
            SendLine(connection.socket, `ERROR|PROTOCOL_NOT_SUPPORTED|${CURRENT_PROTOCOL_VERSION}`);
            connection.socket.destroy();
            continue;
        }

        if (!IsVersionAtLeast(connection.appVersion, state.minServerVersion)) {
            SendLine(connection.socket, `ERROR|SERVER_UPDATE_REQUIRED|${state.minServerVersion}`);
            connection.socket.destroy();
        }
    }

    for (const connection of Array.from(state.clients.values())) {
        if (!connection || !connection.socket || connection.socket.destroyed) {
            continue;
        }

        if (connection.protocolVersion < state.minProtocolVersion) {
            SendLine(connection.socket, `ERROR|PROTOCOL_UPDATE_REQUIRED|${state.minProtocolVersion}`);
            connection.socket.destroy();
            continue;
        }

        if (connection.protocolVersion > CURRENT_PROTOCOL_VERSION) {
            SendLine(connection.socket, `ERROR|PROTOCOL_NOT_SUPPORTED|${CURRENT_PROTOCOL_VERSION}`);
            connection.socket.destroy();
            continue;
        }

        if (!IsVersionAtLeast(connection.appVersion, state.minClientVersion)) {
            SendLine(connection.socket, `ERROR|CLIENT_UPDATE_REQUIRED|${state.minClientVersion}`);
            connection.socket.destroy();
        }
    }
}

module.exports = {
    ValidateProtocolAndVersion,
    EnforceVersionPolicy
};
