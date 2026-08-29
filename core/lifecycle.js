'use strict';

const state =
    require(
        './state'
    );

const {
    SafeIP,
    SendLine
} = require(
    './utils'
);

const {
    GetOnlineServer
} = require(
    '../identity/identityManager'
);

const {
    FailPendingRequestsForServer
} = require(
    '../relay/ackManager'
);

const {
    LogEvent
} = require(
    '../storage/audit'
);


function DisconnectConnection(
    connection
) {
    /*
        close/error가 겹쳐도
        Disconnect를 한 번만 처리.
    */
    if (
        !connection ||
        connection.disconnected
    ) {
        return;
    }

    connection.disconnected =
        true;

    /*
        WinSockServer
    */
    if (
        connection.type ===
        'server'
    ) {
        if (
            connection.serverId &&
            state.servers.get(
                connection.serverId
            ) === connection
        ) {
            state.servers.delete(
                connection.serverId
            );
        }

        if (
            connection.serverId
        ) {
            /*
                Server가 죽었으면
                대기 중 ACK 즉시 실패.
            */
            FailPendingRequestsForServer(
                connection.serverId,
                'SERVER_OFFLINE'
            );

            LogEvent(
                'SERVER_OFFLINE',
                connection.serverId
            );
        }

        return;
    }

    /*
        Android Client
    */
    if (
        connection.type ===
        'client'
    ) {
        if (
            connection.clientId &&
            state.clients.get(
                connection.clientId
            ) === connection
        ) {
            state.clients.delete(
                connection.clientId
            );
        }

        if (
            connection.clientId &&
            connection.serverId
        ) {
            const server =
                GetOnlineServer(
                    connection.serverId
                );

            if (
                server
            ) {
                server.clients.delete(
                    connection.clientId
                );
            }
        }

        if (
            connection.clientId
        ) {
            LogEvent(
                'CLIENT_OFFLINE',
                connection.clientId
            );
        }

        return;
    }

    /*
        Admin
    */
    if (
        connection.type ===
        'admin'
    ) {
        LogEvent(
            'ADMIN_OFFLINE',
            SafeIP(
                connection.socket
            )
        );
    }
}


function ForceReconnectAll(
    reason
) {
    reason =
        String(
            reason ||
            'RECONNECT_REQUIRED'
        )
            .replace(
                /[\r\n|]/g,
                ' '
            )
            .trim();

    /*
        APK
    */
    for (
        const client
        of Array.from(
            state.clients.values()
        )
    ) {
        SendLine(
            client.socket,
            `ERROR|${reason}`
        );

        try {
            client.socket.destroy();
        } catch (_) {}
    }

    /*
        WinSockServer
    */
    for (
        const server
        of Array.from(
            state.servers.values()
        )
    ) {
        SendLine(
            server.socket,
            `ERROR|${reason}`
        );

        try {
            server.socket.destroy();
        } catch (_) {}
    }
}


module.exports = {
    DisconnectConnection,
    ForceReconnectAll
};
