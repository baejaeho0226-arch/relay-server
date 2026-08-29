'use strict';

const config =
    require(
        '../config/config'
    );

const state =
    require(
        './state'
    );

const {
    MAX_INPUT_BUFFER
} = config;

const {
    Now,
    SafeIP,
    SendLine
} = require(
    './utils'
);

const {
    HandleServerLine
} = require(
    '../relay/serverHandler'
);

const {
    HandleClientLine
} = require(
    '../relay/clientHandler'
);

const {
    HandleAdminLine
} = require(
    '../admin/adminHandler'
);

const {
    DisconnectConnection
} = require(
    './lifecycle'
);


function CreateConnection(
    socket
) {
    state
        .runtimeStats
        .totalConnections++;

    const connection = {
        socket,

        /*
            아직 첫 명령을 안 받았으므로
            server / client / admin 미정.
        */
        type: null,

        registered: false,
        connected: false,

        identityKey: '',

        serverId: '',
        clientId: '',

        protocolVersion: 0,
        appVersion: '',

        /*
            License
        */
        licenseAuthorized: false,
        licenseKey: '',
        licenseExpiresAt: 0,

        lastExpiryWarningDay: null,
        lastServerAuthState: '',

        /*
            Admin
        */
        adminAuthenticated: false,
        adminAuthenticatedAt: 0,

        adminNonce: '',
        adminNonceCreatedAt: 0,

        adminRole: '',
        pendingAdminRole: '',

        /*
            Connection 상태
        */
        lastSeen:
            Now(),

        lastIP:
            SafeIP(
                socket
            ),

        /*
            Server일 경우
            연결 Client 목록.
        */
        clients:
            new Set(),

        /*
            TCP는 Line 단위로 오지 않을 수 있으므로
            지속 Buffer 사용.
        */
        buffer: '',

        /*
            Heartbeat
        */
        pendingPingToken: '',
        pendingPingAt: 0,

        rttMs: -1,

        reconnectCount: 0,

        /*
            close 중복 처리 방지.
        */
        disconnected: false
    };

    /*
        작은 TCP 명령 지연 최소화.
    */
    socket.setNoDelay(
        true
    );

    /*
        OS TCP KeepAlive.
    */
    socket.setKeepAlive(
        true,
        10000
    );

    socket.on(
        'data',
        data => {
            /*
                실제 데이터가 왔다는 것 자체도
                연결이 살아 있다는 증거.
            */
            connection.lastSeen =
                Now();

            connection.buffer +=
                data.toString(
                    'utf8'
                );

            /*
                비정상 Client가 newline 없이
                무한 데이터를 보내는 것 방지.
            */
            if (
                connection
                    .buffer
                    .length >
                MAX_INPUT_BUFFER
            ) {
                SendLine(
                    socket,
                    'ERROR|BUFFER_OVERFLOW'
                );

                socket.destroy();

                return;
            }

            /*
                TCP packet 하나에
                여러 Line이 올 수도 있고,

                Line 하나가
                여러 packet으로 나뉠 수도 있음.
            */
            while (
                true
            ) {
                const pos =
                    connection
                        .buffer
                        .indexOf(
                            '\n'
                        );

                if (
                    pos < 0
                ) {
                    break;
                }

                let line =
                    connection
                        .buffer
                        .substring(
                            0,
                            pos
                        )
                        .replace(
                            /\r$/,
                            ''
                        );

                connection.buffer =
                    connection
                        .buffer
                        .substring(
                            pos +
                            1
                        );

                if (!line) {
                    continue;
                }

                /*
                    첫 명령으로 연결 종류 결정.
                */
                if (
                    !connection.type
                ) {
                    if (
                        line ===
                        'REGISTER' ||
                        line.startsWith(
                            'REGISTER|'
                        )
                    ) {
                        connection.type =
                            'server';
                    } else if (
                        line ===
                        'CONNECT' ||
                        line.startsWith(
                            'CONNECT|'
                        ) ||
                        line.startsWith(
                            'LICENSE_AUTH|'
                        ) ||
                        line.startsWith(
                            'SEND|'
                        )
                    ) {
                        connection.type =
                            'client';
                    } else if (
                        line ===
                        'ADMIN_HELLO' ||
                        line.startsWith(
                            'ADMIN_HELLO|'
                        ) ||
                        line.startsWith(
                            'ADMIN_AUTH|'
                        )
                    ) {
                        connection.type =
                            'admin';
                    } else {
                        SendLine(
                            socket,
                            'ERROR|UNKNOWN_COMMAND'
                        );

                        continue;
                    }
                }

                /*
                    종류별 Handler로 전달.
                */
                if (
                    connection.type ===
                    'server'
                ) {
                    HandleServerLine(
                        connection,
                        line
                    );
                } else if (
                    connection.type ===
                    'client'
                ) {
                    HandleClientLine(
                        connection,
                        line
                    );
                } else {
                    HandleAdminLine(
                        connection,
                        line
                    );
                }
            }
        }
    );

    socket.on(
        'close',
        () => {
            DisconnectConnection(
                connection
            );
        }
    );

    socket.on(
        'error',
        error => {
            console.error(
                '[SOCKET ERROR]',
                error.message
            );
        }
    );

    return connection;
}


module.exports = {
    CreateConnection
};
