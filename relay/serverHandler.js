'use strict';

const state =
    require(
        '../core/state'
    );

const {
    Now,
    SafeIP,
    SendLine
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

const {
    CreateServerIdentity,
    GetOnlineServer,
    GetKickUntil,
    TrackIP
} = require(
    '../identity/identityManager'
);

const {
    GetUsableLicenseForConnection
} = require(
    '../license/licenseManager'
);

const {
    NotifyServerAuthorized,
    NotifyServerUnauthorized
} = require(
    './notifications'
);

const {
    HandlePong
} = require(
    './heartbeat'
);

const {
    HandleServerAck
} = require(
    './ackManager'
);

const {
    ValidateProtocolAndVersion
} = require(
    '../services/versionPolicy'
);


function RegisterServer(
    connection,
    deviceKey,
    protocolVersion,
    appVersion
) {
    deviceKey =
        String(
            deviceKey ||
            ''
        ).trim();

    if (
        !deviceKey
    ) {
        SendLine(
            connection.socket,
            'ERROR|DEVICE_KEY_REQUIRED'
        );

        return false;
    }

    if (
        !ValidateProtocolAndVersion(
            connection,
            'server',
            protocolVersion,
            appVersion
        )
    ) {
        return false;
    }

    /*
        MachineGuid 기준으로
        기존 SERVER-ID가 있으면 그대로 사용.
        없으면 서버에서 새로 발급.
    */
    const serverId =
        CreateServerIdentity(
            deviceKey
        );

    if (
        !serverId
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_ID_CREATE_FAILED'
        );

        return false;
    }

    /*
        영구 DISABLE 상태.
    */
    if (
        state.disabledServers.has(
            serverId
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_DISABLED'
        );

        return false;
    }

    /*
        관리자 KICK 후
        차단시간이 아직 남아 있으면 거부.
    */
    const kickedUntil =
        GetKickUntil(
            state.kickedServers,
            serverId
        );

    if (
        kickedUntil >
        Now()
    ) {
        SendLine(
            connection.socket,
            `ERROR|SERVER_KICKED|${kickedUntil}`
        );

        return false;
    }

    /*
        동일 SERVER-ID가 이미 온라인이면
        새 연결을 살리고 기존 연결 종료.
    */
    const old =
        GetOnlineServer(
            serverId
        );

    if (
        old &&
        old !==
        connection
    ) {
        SendLine(
            old.socket,
            'ERROR|REPLACED'
        );

        try {
            old.socket.destroy();
        } catch (_) {}
    }

    connection.identityKey =
        deviceKey;

    connection.serverId =
        serverId;

    connection.registered =
        true;

    connection.connected =
        false;

    connection.lastSeen =
        Now();

    connection.lastIP =
        SafeIP(
            connection.socket
        );

    connection.clients =
        new Set();

    connection.reconnectCount =
        (
            state.runtimeStats
                .serverReconnects
                .get(
                    serverId
                ) ||
            0
        ) + 1;

    state.runtimeStats
        .serverReconnects
        .set(
            serverId,
            connection.reconnectCount
        );

    state.servers.set(
        serverId,
        connection
    );

    TrackIP(
        'SERVER',
        serverId,
        connection.lastIP
    );

    SaveDatabase();

    SendLine(
        connection.socket,
        [
            'REGISTERED',
            serverId,
            connection.protocolVersion,
            connection.appVersion
        ].join('|')
    );

    LogEvent(
        'SERVER_ONLINE',
        `${serverId} v${connection.appVersion}`
    );

    /*
        Server가 재접속하면 현재 붙어 있는 Client의
        인증 상태를 다시 동기화한다.
    */
    for (
        const client
        of state.clients.values()
    ) {
        if (
            client.serverId !==
            serverId
        ) {
            continue;
        }

        connection.clients.add(
            client.clientId
        );

        client.lastServerAuthState =
            '';

        if (
            client.licenseAuthorized
        ) {
            const active =
                GetUsableLicenseForConnection(
                    client
                );

            if (
                active
            ) {
                NotifyServerAuthorized(
                    client.clientId,
                    serverId,
                    active.license.expiresAt
                );
            } else {
                NotifyServerUnauthorized(
                    client.clientId,
                    'LICENSE_REQUIRED'
                );
            }
        } else {
            NotifyServerUnauthorized(
                client.clientId,
                'LICENSE_REQUIRED'
            );
        }
    }

    return true;
}


function HandleRegisterLine(
    connection,
    line
) {
    if (
        connection.registered
    ) {
        SendLine(
            connection.socket,
            'ERROR|ALREADY_REGISTERED'
        );

        return;
    }

    const parts =
        line.split('|');

    /*
        신버전:
        REGISTER|2|2.0.0|WIN-...

        구버전:
        REGISTER|WIN-...
    */
    let protocolVersion =
        1;

    let appVersion =
        '1.0.0';

    let deviceKey =
        '';

    if (
        parts.length >=
        4
    ) {
        protocolVersion =
            Number(
                parts[1]
            );

        appVersion =
            String(
                parts[2] ||
                ''
            ).trim();

        deviceKey =
            parts
                .slice(3)
                .join('|')
                .trim();
    } else if (
        parts.length >=
        2
    ) {
        deviceKey =
            String(
                parts[1] ||
                ''
            ).trim();
    }

    const ok =
        RegisterServer(
            connection,
            deviceKey,
            protocolVersion,
            appVersion
        );

    if (
        !ok
    ) {
        /*
            ERROR 응답이 상대방에게 전달될
            약간의 시간을 준 뒤 종료.
        */
        setTimeout(
            () => {
                try {
                    connection.socket.destroy();
                } catch (_) {}
            },
            150
        );
    }
}


function HandleServerLine(
    connection,
    line
) {
    line =
        String(
            line ||
            ''
        ).trim();

    if (
        !line
    ) {
        return;
    }

    if (
        line ===
        'REGISTER' ||
        line.startsWith(
            'REGISTER|'
        )
    ) {
        HandleRegisterLine(
            connection,
            line
        );

        return;
    }

    if (
        line ===
        'PONG' ||
        line.startsWith(
            'PONG|'
        )
    ) {
        HandlePong(
            connection,
            line.split('|')
        );

        return;
    }

    if (
        line.startsWith(
            'ACK|'
        )
    ) {
        HandleServerAck(
            connection,
            line
        );

        return;
    }

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}


module.exports = {
    RegisterServer,
    HandleServerLine
};
