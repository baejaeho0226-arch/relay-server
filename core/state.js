'use strict';

const config =
    require(
        '../config/config'
    );

module.exports = {
    serviceEnabled: true,

    maintenanceMode: false,

    minProtocolVersion:
        config.DEFAULT_MIN_PROTOCOL_VERSION,

    minServerVersion:
        config.DEFAULT_MIN_SERVER_VERSION,

    minClientVersion:
        config.DEFAULT_MIN_CLIENT_VERSION,

    maintenanceSchedule:
        null,

    servers:
        new Map(),

    clients:
        new Map(),

    serverIdentities:
        new Map(),

    clientIdentities:
        new Map(),

    licenses:
        new Map(),

    disabledServers:
        new Set(),

    drainingServers:
        new Set(),

    disabledClients:
        new Set(),

    kickedServers:
        new Map(),

    kickedClients:
        new Map(),

    requestHistory:
        new Map(),

    pendingRequests:
        new Map(),

    rateLimits:
        new Map(),

    events:
        [],

    confirmTokens:
        new Map(),

    ipHistory:
        new Map(),

    runtimeStats: {
        startedAt:
            Date.now(),

        totalConnections:
            0,

        serverReconnects:
            new Map(),

        clientReconnects:
            new Map(),

        ackOk:
            0,

        ackError:
            0,

        ackTimeout:
            0,

        ackRetries:
            0,

        notices:
            0
    }
};
