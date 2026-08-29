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
    MAX_CLIENTS_PER_SERVER
} = config;

const {
    Now,
    RandomID,
    NormalizeID,
    SafeIP
} = require(
    '../core/utils'
);

const {
    SaveDatabase
} = require(
    '../storage/database'
);

const {
    LogEvent
} = require(
    '../storage/audit'
);


function GetOnlineServer(
    serverId
) {
    serverId =
        NormalizeID(
            serverId
        );

    if (!serverId) {
        return null;
    }

    const connection =
        state.servers.get(
            serverId
        );

    if (
        !connection ||
        !connection.registered ||
        !connection.socket ||
        connection.socket.destroyed
    ) {
        return null;
    }

    return connection;
}


function GetOnlineClient(
    clientId
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return null;
    }

    const connection =
        state.clients.get(
            clientId
        );

    if (
        !connection ||
        !connection.connected ||
        !connection.socket ||
        connection.socket.destroyed
    ) {
        return null;
    }

    return connection;
}


function GetSavedClientByID(
    clientId
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return null;
    }

    for (
        const saved
        of state.clientIdentities.values()
    ) {
        if (
            saved.id ===
            clientId
        ) {
            return saved;
        }
    }

    return null;
}


function FindClientDeviceKey(
    clientId
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return '';
    }

    for (
        const [
            deviceKey,
            saved
        ]
        of state.clientIdentities
    ) {
        if (
            saved.id ===
            clientId
        ) {
            return deviceKey;
        }
    }

    return '';
}


function FindServerDeviceKey(
    serverId
) {
    serverId =
        NormalizeID(
            serverId
        );

    if (!serverId) {
        return '';
    }

    for (
        const [
            deviceKey,
            id
        ]
        of state.serverIdentities
    ) {
        if (
            id ===
            serverId
        ) {
            return deviceKey;
        }
    }

    return '';
}


function ServerExists(
    serverId
) {
    serverId =
        NormalizeID(
            serverId
        );

    if (!serverId) {
        return false;
    }

    for (
        const id
        of state.serverIdentities.values()
    ) {
        if (
            id ===
            serverId
        ) {
            return true;
        }
    }

    return false;
}


function ClientExists(
    clientId
) {
    return !!GetSavedClientByID(
        clientId
    );
}


function GetUsedIDs() {
    const used =
        new Set();

    for (
        const id
        of state.serverIdentities.values()
    ) {
        if (
            id
        ) {
            used.add(
                id
            );
        }
    }

    for (
        const saved
        of state.clientIdentities.values()
    ) {
        if (
            saved &&
            saved.id
        ) {
            used.add(
                saved.id
            );
        }
    }

    return used;
}


function MakeUniqueID() {
    const used =
        GetUsedIDs();

    let id;

    do {
        id =
            RandomID();
    } while (
        used.has(id)
    );

    return id;
}


function GetKickUntil(
    map,
    id
) {
    const until =
        Number(
            map.get(id) ||
            0
        );

    if (
        until > 0 &&
        Now() >= until
    ) {
        map.delete(
            id
        );

        return 0;
    }

    return until;
}


function TrackIP(
    kind,
    id,
    ip
) {
    if (
        !kind ||
        !id ||
        !ip
    ) {
        return;
    }

    const key =
        `${kind}:${id}`;

    const previous =
        state.ipHistory.get(
            key
        );

    if (
        previous &&
        previous.ip &&
        previous.ip !==
        ip
    ) {
        LogEvent(
            'IP_CHANGED',
            `${key} ${previous.ip} -> ${ip}`
        );
    }

    state.ipHistory.set(
        key,
        {
            ip,

            changedAt:
                Now()
        }
    );
}


function GetServerClientCount(
    serverId
) {
    serverId =
        NormalizeID(
            serverId
        );

    if (!serverId) {
        return 0;
    }

    let count =
        0;

    for (
        const saved
        of state.clientIdentities.values()
    ) {
        if (
            saved.serverId ===
            serverId
        ) {
            count++;
        }
    }

    return count;
}


function FindAvailableServer() {
    const list =
        [];

    for (
        const server
        of state.servers.values()
    ) {
        if (
            !server.registered ||
            !server.socket ||
            server.socket.destroyed
        ) {
            continue;
        }

        if (
            state.disabledServers.has(
                server.serverId
            )
        ) {
            continue;
        }

        /*
            Drain Server:
            기존 Client는 유지되지만
            신규 Client는 배정하지 않는다.
        */
        if (
            state.drainingServers.has(
                server.serverId
            )
        ) {
            continue;
        }

        if (
            GetKickUntil(
                state.kickedServers,
                server.serverId
            ) >
            Now()
        ) {
            continue;
        }

        if (
            server.clients.size >=
            MAX_CLIENTS_PER_SERVER
        ) {
            continue;
        }

        list.push(
            server
        );
    }

    /*
        현재 온라인 Client가 가장 적은
        Server부터 신규 Client 배정.
    */
    list.sort(
        (
            a,
            b
        ) =>
            a.clients.size -
            b.clients.size
    );

    return (
        list[0] ||
        null
    );
}


function CreateClientIdentity(
    deviceKey,
    serverId
) {
    deviceKey =
        String(
            deviceKey ||
            ''
        ).trim();

    serverId =
        NormalizeID(
            serverId
        );

    if (
        !deviceKey ||
        !serverId
    ) {
        return null;
    }

    const existing =
        state.clientIdentities.get(
            deviceKey
        );

    if (
        existing
    ) {
        return existing;
    }

    const saved = {
        id:
            MakeUniqueID(),

        serverId,

        createdAt:
            Now(),

        lastSeenAt:
            0,

        lastAuthAt:
            0,

        lastIP:
            '',

        authCount:
            0,

        sendCount:
            0,

        reconnectCount:
            0
    };

    state.clientIdentities.set(
        deviceKey,
        saved
    );

    SaveDatabase();

    LogEvent(
        'CLIENT_CREATE',
        `${saved.id} -> ${deviceKey}`
    );

    return saved;
}


function CreateServerIdentity(
    deviceKey
) {
    deviceKey =
        String(
            deviceKey ||
            ''
        ).trim();

    if (!deviceKey) {
        return '';
    }

    const existing =
        state.serverIdentities.get(
            deviceKey
        );

    if (
        existing
    ) {
        return existing;
    }

    const serverId =
        MakeUniqueID();

    state.serverIdentities.set(
        deviceKey,
        serverId
    );

    SaveDatabase();

    LogEvent(
        'SERVER_CREATE',
        `${serverId} -> ${deviceKey}`
    );

    return serverId;
}


function ClientMove(
    clientId,
    newServerId
) {
    clientId =
        NormalizeID(
            clientId
        );

    newServerId =
        NormalizeID(
            newServerId
        );

    const saved =
        GetSavedClientByID(
            clientId
        );

    if (!saved) {
        return {
            ok: false,
            reason: 'CLIENT_NOT_FOUND'
        };
    }

    if (
        !ServerExists(
            newServerId
        )
    ) {
        return {
            ok: false,
            reason: 'SERVER_NOT_FOUND'
        };
    }

    if (
        state.disabledServers.has(
            newServerId
        )
    ) {
        return {
            ok: false,
            reason: 'SERVER_DISABLED'
        };
    }

    if (
        GetServerClientCount(
            newServerId
        ) >=
        MAX_CLIENTS_PER_SERVER &&
        saved.serverId !==
        newServerId
    ) {
        return {
            ok: false,
            reason: 'SERVER_FULL'
        };
    }

    const oldServerId =
        saved.serverId;

    saved.serverId =
        newServerId;

    SaveDatabase();

    const live =
        GetOnlineClient(
            clientId
        );

    /*
        현재 연결을 끊고
        새 고정 Server로 재접속시킨다.
    */
    if (
        live
    ) {
        try {
            const oldServer =
                GetOnlineServer(
                    oldServerId
                );

            if (
                oldServer
            ) {
                oldServer.clients.delete(
                    clientId
                );
            }

            live.serverId =
                newServerId;

            if (
                live.socket &&
                !live.socket.destroyed
            ) {
                require(
                    '../core/utils'
                ).SendLine(
                    live.socket,
                    `ERROR|CLIENT_MOVED|${newServerId}`
                );

                live.socket.destroy();
            }
        } catch (_) {}
    }

    LogEvent(
        'CLIENT_MOVE',
        `${clientId} ${oldServerId} -> ${newServerId}`
    );

    return {
        ok: true,

        oldServerId,
        newServerId
    };
}


module.exports = {
    GetOnlineServer,
    GetOnlineClient,

    GetSavedClientByID,

    FindClientDeviceKey,
    FindServerDeviceKey,

    ServerExists,
    ClientExists,

    GetUsedIDs,
    MakeUniqueID,

    GetKickUntil,
    TrackIP,

    GetServerClientCount,
    FindAvailableServer,

    CreateClientIdentity,
    CreateServerIdentity,

    ClientMove
};
