'use strict';

const config =
    require(
        '../config/config'
    );

const state =
    require(
        '../core/state'
    );

const {
    DATA_DIR,
    MAX_CLIENTS_PER_SERVER,
    RATE_LIMIT_MAX
} = config;

const {
    Now
} = require(
    '../core/utils'
);

const {
    GetOnlineServer,
    GetOnlineClient
} = require(
    '../identity/identityManager'
);

const {
    GetLicenseStatus
} = require(
    '../license/licenseManager'
);


function GetDashboardStats() {
    let onlineServers =
        0;

    let onlineClients =
        0;

    let available =
        0;

    let bound =
        0;

    let expired =
        0;

    let suspended =
        0;

    for (
        const serverId
        of state.serverIdentities.values()
    ) {
        if (
            GetOnlineServer(
                serverId
            )
        ) {
            onlineServers++;
        }
    }

    for (
        const saved
        of state.clientIdentities.values()
    ) {
        if (
            GetOnlineClient(
                saved.id
            )
        ) {
            onlineClients++;
        }
    }

    for (
        const license
        of state.licenses.values()
    ) {
        const status =
            GetLicenseStatus(
                license
            );

        switch (
            status
        ) {
            case 'AVAILABLE':
                available++;
                break;

            case 'BOUND':
                bound++;
                break;

            case 'EXPIRED':
                expired++;
                break;

            case 'SUSPENDED':
                suspended++;
                break;
        }
    }

    return {
        service:
            state.serviceEnabled
                ? 'ONLINE'
                : 'OFFLINE',

        maintenance:
            state.maintenanceMode
                ? 'ON'
                : 'OFF',

        servers:
            state.serverIdentities.size,

        onlineServers,

        disabledServers:
            state.disabledServers.size,

        drainingServers:
            state.drainingServers.size,

        clients:
            state.clientIdentities.size,

        onlineClients,

        disabledClients:
            state.disabledClients.size,

        licenses:
            state.licenses.size,

        available,
        bound,
        expired,
        suspended,

        pendingAcks:
            state.pendingRequests.size,

        ackOk:
            state.runtimeStats.ackOk,

        ackError:
            state.runtimeStats.ackError,

        ackTimeout:
            state.runtimeStats.ackTimeout,

        ackRetries:
            state.runtimeStats.ackRetries,

        notices:
            state.runtimeStats.notices,

        totalConnections:
            state.runtimeStats.totalConnections,

        minProtocol:
            state.minProtocolVersion,

        minServerVersion:
            state.minServerVersion,

        minClientVersion:
            state.minClientVersion,

        maxClientsPerServer:
            MAX_CLIENTS_PER_SERVER,

        rateLimit:
            RATE_LIMIT_MAX,

        uptimeMs:
            Now() -
            state.runtimeStats.startedAt
    };
}


function BuildDashboardLine() {
    const stats =
        GetDashboardStats();

    return [
        'DASH',

        `SERVICE=${stats.service}`,

        `MAINTENANCE=${stats.maintenance}`,

        `SERVERS=${stats.servers}`,

        `ONLINE_SERVERS=${stats.onlineServers}`,

        `DISABLED_SERVERS=${stats.disabledServers}`,

        `DRAINING_SERVERS=${stats.drainingServers}`,

        `CLIENTS=${stats.clients}`,

        `ONLINE_CLIENTS=${stats.onlineClients}`,

        `DISABLED_CLIENTS=${stats.disabledClients}`,

        `LICENSES=${stats.licenses}`,

        `AVAILABLE=${stats.available}`,

        `BOUND=${stats.bound}`,

        `EXPIRED=${stats.expired}`,

        `SUSPENDED=${stats.suspended}`,

        `PENDING_ACKS=${stats.pendingAcks}`,

        `ACK_OK=${stats.ackOk}`,

        `ACK_ERROR=${stats.ackError}`,

        `ACK_TIMEOUT=${stats.ackTimeout}`,

        `ACK_RETRIES=${stats.ackRetries}`,

        `NOTICES=${stats.notices}`,

        `TOTAL_CONNECTIONS=${stats.totalConnections}`,

        `MIN_PROTOCOL=${stats.minProtocol}`,

        `MIN_SERVER_VERSION=${stats.minServerVersion}`,

        `MIN_CLIENT_VERSION=${stats.minClientVersion}`,

        `MAX_CLIENTS_PER_SERVER=${stats.maxClientsPerServer}`,

        `RATE_LIMIT=${stats.rateLimit}`,

        `UPTIME_MS=${stats.uptimeMs}`
    ].join('|');
}


function HealthSnapshot() {
    const stats =
        GetDashboardStats();

    return {
        ok:
            state.serviceEnabled,

        serviceEnabled:
            state.serviceEnabled,

        maintenanceMode:
            state.maintenanceMode,

        startedAt:
            state.runtimeStats.startedAt,

        uptimeMs:
            stats.uptimeMs,

        servers: {
            total:
                stats.servers,

            online:
                stats.onlineServers,

            disabled:
                stats.disabledServers,

            draining:
                stats.drainingServers
        },

        clients: {
            total:
                stats.clients,

            online:
                stats.onlineClients,

            disabled:
                stats.disabledClients
        },

        licenses: {
            total:
                stats.licenses,

            available:
                stats.available,

            bound:
                stats.bound,

            expired:
                stats.expired,

            suspended:
                stats.suspended
        },

        pendingAcks:
            stats.pendingAcks,

        ack: {
            ok:
                stats.ackOk,

            error:
                stats.ackError,

            timeout:
                stats.ackTimeout,

            retries:
                stats.ackRetries
        },

        versionPolicy: {
            minProtocolVersion:
                state.minProtocolVersion,

            minServerVersion:
                state.minServerVersion,

            minClientVersion:
                state.minClientVersion
        },

        limits: {
            maxClientsPerServer:
                MAX_CLIENTS_PER_SERVER,

            rateLimitPerSecond:
                RATE_LIMIT_MAX
        },

        dataDir:
            DATA_DIR
    };
}


function GetRecentDashboardEvents(
    count = 20
) {
    count =
        Math.max(
            1,
            Math.min(
                Number(
                    count
                ) ||
                20,
                100
            )
        );

    return state.events.slice(
        -count
    );
}


module.exports = {
    GetDashboardStats,
    BuildDashboardLine,

    HealthSnapshot,

    GetRecentDashboardEvents
};
