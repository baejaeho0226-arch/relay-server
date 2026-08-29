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
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX
} = config;

const {
    Now,
    NormalizeID,
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
    GetOnlineServer,
    GetOnlineClient,
    GetSavedClientByID,

    GetKickUntil,
    TrackIP,

    FindAvailableServer,
    CreateClientIdentity
} = require(
    '../identity/identityManager'
);

const {
    AuthorizeClient,
    GetUsableLicenseForConnection
} = require(
    '../license/licenseManager'
);

const {
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
    IsDuplicateRequest,
    RegisterPendingRequest
} = require(
    './ackManager'
);

const {
    ValidateProtocolAndVersion
} = require(
    '../services/versionPolicy'
);


function AttachClient(
    connection,
    saved
) {
    if (
        !connection ||
        !saved
    ) {
        return false;
    }

    /*
        같은 Client-ID가 이미 접속 중이면
        새 연결을 살리고 기존 연결을 종료.
    */
    const old =
        GetOnlineClient(
            saved.id
        );

    if (
        old &&
        old !==
        connection
    ) {
        const oldServer =
            GetOnlineServer(
                old.serverId
            );

        if (
            oldServer
        ) {
            oldServer.clients.delete(
                saved.id
            );
        }

        SendLine(
            old.socket,
            'ERROR|REPLACED'
        );

        try {
            old.socket.destroy();
        } catch (_) {}
    }

    connection.clientId =
        saved.id;

    connection.serverId =
        saved.serverId;

    connection.connected =
        true;

    connection.registered =
        false;

    /*
        CONNECT 자체로는 License 인증하지 않는다.
    */
    connection.licenseAuthorized =
        false;

    connection.licenseKey =
        '';

    connection.licenseExpiresAt =
        0;

    connection.lastExpiryWarningDay =
        null;

    connection.lastServerAuthState =
        '';

    connection.lastSeen =
        Now();

    connection.lastIP =
        SafeIP(
            connection.socket
        );

    state.clients.set(
        saved.id,
        connection
    );

    saved.lastSeenAt =
        Now();

    saved.lastIP =
        connection.lastIP;

    saved.reconnectCount =
        Number(
            saved.reconnectCount ||
            0
        ) + 1;

    state.runtimeStats
        .clientReconnects
        .set(
            saved.id,
            saved.reconnectCount
        );

    TrackIP(
        'CLIENT',
        saved.id,
        saved.lastIP
    );

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (
        server
    ) {
        server.clients.add(
            saved.id
        );
    }

    SaveDatabase();

    SendLine(
        connection.socket,
        [
            'CONNECTED',
            saved.id,
            saved.serverId,
            connection.protocolVersion,
            connection.appVersion
        ].join('|')
    );

    /*
        Binding이 있어도 CONNECT 순간에는
        무조건 Unauthorized.

        APK가 LICENSE_AUTH를 명시적으로 보내야 함.
    */
    NotifyServerUnauthorized(
        saved.id,
        'LICENSE_REQUIRED'
    );

    LogEvent(
        'CLIENT_ONLINE',
        `${saved.id} v${connection.appVersion}`
    );

    return true;
}


function HandleClientConnect(
    connection,
    deviceKey,
    protocolVersion,
    appVersion
) {
    if (
        !ValidateProtocolAndVersion(
            connection,
            'client',
            protocolVersion,
            appVersion
        )
    ) {
        setTimeout(
            () => {
                try {
                    connection.socket.destroy();
                } catch (_) {}
            },
            150
        );

        return false;
    }

    /*
        SERVICE STOP:
        신규 CONNECT 거부.
    */
    if (
        !state.serviceEnabled
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|DISABLED'
        );

        return false;
    }

    /*
        Maintenance:
        신규 CONNECT 거부.
        기존 인증된 세션은 다른 socket에서 계속 사용.
    */
    if (
        state.maintenanceMode
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|MAINTENANCE'
        );

        return false;
    }

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

    let saved =
        state.clientIdentities.get(
            deviceKey
        );

    /*
        이미 등록된 Device.
        기존 Client-ID / Server-ID 그대로.
    */
    if (
        saved
    ) {
        if (
            state.disabledClients.has(
                saved.id
            )
        ) {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_DISABLED'
            );

            return false;
        }

        const clientKickUntil =
            GetKickUntil(
                state.kickedClients,
                saved.id
            );

        if (
            clientKickUntil >
            Now()
        ) {
            SendLine(
                connection.socket,
                `ERROR|CLIENT_KICKED|${clientKickUntil}`
            );

            return false;
        }

        if (
            state.disabledServers.has(
                saved.serverId
            )
        ) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_DISABLED'
            );

            return false;
        }

        const serverKickUntil =
            GetKickUntil(
                state.kickedServers,
                saved.serverId
            );

        if (
            serverKickUntil >
            Now()
        ) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_OFFLINE'
            );

            return false;
        }

        /*
            기존 Client는 DRAIN Server에 붙어 있어도
            그대로 사용할 수 있다.
        */
        if (
            !GetOnlineServer(
                saved.serverId
            )
        ) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_OFFLINE'
            );

            return false;
        }
    } else {
        /*
            신규 Device만
            사용 가능한 Server 중 하나를 배정.
        */
        const server =
            FindAvailableServer();

        if (
            !server
        ) {
            SendLine(
                connection.socket,
                'ERROR|NO_SERVER'
            );

            return false;
        }

        saved =
            CreateClientIdentity(
                deviceKey,
                server.serverId
            );

        if (
            !saved
        ) {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_ID_CREATE_FAILED'
            );

            return false;
        }
    }

    return AttachClient(
        connection,
        saved
    );
}


function IsRateLimited(
    connection
) {
    const key =
        connection.clientId ||
        (
            'IP:' +
            SafeIP(
                connection.socket
            )
        );

    const now =
        Now();

    let rate =
        state.rateLimits.get(
            key
        );

    if (
        !rate ||
        now -
        rate.startedAt >=
        RATE_LIMIT_WINDOW_MS
    ) {
        rate = {
            startedAt:
                now,

            count:
                0
        };

        state.rateLimits.set(
            key,
            rate
        );
    }

    rate.count++;

    return (
        rate.count >
        RATE_LIMIT_MAX
    );
}


function HandleClientSend(
    connection,
    line
) {
    if (
        !state.serviceEnabled
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|DISABLED'
        );

        return;
    }

    /*
        Maintenance에서는
        기존 인증 세션은 SEND 가능.

        인증되지 않은 연결만 거부.
    */
    if (
        state.maintenanceMode &&
        !connection.licenseAuthorized
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|MAINTENANCE'
        );

        return;
    }

    if (
        IsRateLimited(
            connection
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|RATE_LIMIT'
        );

        return;
    }

    const parts =
        line.split('|');

    /*
        SEND|RequestID|ClientID|Number
    */
    if (
        parts.length !==
        4
    ) {
        SendLine(
            connection.socket,
            'ERROR|INVALID_SEND'
        );

        return;
    }

    const requestId =
        String(
            parts[1] ||
            ''
        ).trim();

    const clientId =
        NormalizeID(
            parts[2] ||
            ''
        );

    const number =
        String(
            parts[3] ||
            ''
        ).trim();

    if (
        !requestId ||
        requestId.length >
        64
    ) {
        SendLine(
            connection.socket,
            'ERROR|REQUEST_ID_INVALID'
        );

        return;
    }

    if (
        !clientId ||
        connection.clientId !==
        clientId
    ) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_OWNER'
        );

        return;
    }

    if (
        !/^-?\d+$/.test(
            number
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|NUMBER_ONLY'
        );

        return;
    }

    /*
        이미 성공적으로 Server로 넘긴 Request-ID만
        requestHistory에 존재한다.
    */
    if (
        IsDuplicateRequest(
            clientId,
            requestId
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|DUPLICATE_REQUEST'
        );

        return;
    }

    const active =
        GetUsableLicenseForConnection(
            connection
        );

    if (
        !active
    ) {
        connection.licenseAuthorized =
            false;

        connection.licenseExpiresAt =
            0;

        connection.lastServerAuthState =
            '';

        SendLine(
            connection.socket,
            'ERROR|LICENSE_REQUIRED'
        );

        NotifyServerUnauthorized(
            clientId,
            'LICENSE_REQUIRED'
        );

        return;
    }

    const saved =
        GetSavedClientByID(
            clientId
        );

    if (
        !saved
    ) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_FOUND'
        );

        return;
    }

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (
        !server
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_OFFLINE'
        );

        return;
    }

    const payload =
        [
            'NUMBER',
            requestId,
            clientId,
            number
        ].join('|');

    /*
        Server로 실제 전달 성공한 뒤에만
        Request ID를 소비한다.
    */
    if (
        !SendLine(
            server.socket,
            payload
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_SEND_FAILED'
        );

        return;
    }

    RegisterPendingRequest(
        clientId,
        saved.serverId,
        requestId,
        payload
    );

    active.license.lastSeenAt =
        Now();

    active.license.lastIP =
        SafeIP(
            connection.socket
        );

    active.license.sendCount =
        Number(
            active.license.sendCount ||
            0
        ) + 1;

    saved.lastSeenAt =
        Now();

    saved.lastIP =
        active.license.lastIP;

    saved.sendCount =
        Number(
            saved.sendCount ||
            0
        ) + 1;

    SaveDatabase();

    /*
        SENT OK =
        Relay -> WinSockServer 전달 성공.

        실제 처리 완료는 ACK OK가 따로 온다.
    */
    SendLine(
        connection.socket,
        `SENT|OK|${requestId}`
    );

    LogEvent(
        'NUMBER_SEND',
        `${requestId} / ${clientId} / ${number}`
    );
}


function HandleConnectLine(
    connection,
    line
) {
    const parts =
        line.split('|');

    let protocolVersion =
        1;

    let appVersion =
        '1.0.0';

    let deviceKey =
        '';

    /*
        신버전:
        CONNECT|2|2.0.0|ANDROID-...

        구버전:
        CONNECT|ANDROID-...
    */
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

    HandleClientConnect(
        connection,
        deviceKey,
        protocolVersion,
        appVersion
    );
}


function HandleLicenseAuthLine(
    connection,
    line
) {
    const parts =
        line.split('|');

    /*
        LICENSE_AUTH|LicenseKey|ClientID
    */
    const requestedClient =
        parts.length >=
        3
            ? NormalizeID(
                parts[2]
            )
            : '';

    if (
        requestedClient &&
        requestedClient !==
        connection.clientId
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|CLIENT_NOT_OWNER'
        );

        return;
    }

    AuthorizeClient(
        connection,
        parts[1] ||
        ''
    );
}


function HandleClientLine(
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
        'CONNECT' ||
        line.startsWith(
            'CONNECT|'
        )
    ) {
        HandleConnectLine(
            connection,
            line
        );

        return;
    }

    if (
        line.startsWith(
            'LICENSE_AUTH|'
        )
    ) {
        HandleLicenseAuthLine(
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
            'SEND|'
        )
    ) {
        HandleClientSend(
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
    AttachClient,
    HandleClientConnect,

    IsRateLimited,
    HandleClientSend,

    HandleClientLine
};
