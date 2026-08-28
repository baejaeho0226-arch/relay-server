const net = require('net');
const crypto = require('crypto');


// ======================================================
// Railway
// ======================================================

const PORT =
    Number(process.env.PORT || 3000);


// ======================================================
// 서버 인증용 비밀값
//
// Railway Variables에 API_TOKEN을 넣어두세요.
// 코드에 실제 토큰을 넣지 않습니다.
// ======================================================

const API_TOKEN =
    process.env.API_TOKEN || '';


// ======================================================
// 현재 WinSockServer
// ======================================================

let serverSocket = null;

let serverId = null;


// ======================================================
// 접속한 APK Client
//
// clientId => 정보
// ======================================================

const clients = new Map();


// ======================================================
// RANDOM ID
// ======================================================

function GenerateID(prefix) {

    return (
        prefix +
        '-' +
        crypto
            .randomBytes(6)
            .toString('hex')
            .toUpperCase()
    );

}


// ======================================================
// LINE SEND
// ======================================================

function SendLine(socket, text) {

    if (
        socket &&
        !socket.destroyed
    ) {

        socket.write(
            text + '\n'
        );

    }

}


// ======================================================
// WinSockServer REGISTER
//
// REGISTER|API_TOKEN
// ======================================================

function HandleRegister(
    socket,
    parts
) {

    if (parts.length !== 2) {

        SendLine(
            socket,
            'ERROR|INVALID_REGISTER'
        );

        socket.destroy();

        return;

    }


    const token =
        parts[1];


    if (
        !API_TOKEN ||
        token !== API_TOKEN
    ) {

        SendLine(
            socket,
            'ERROR|INVALID_TOKEN'
        );

        socket.destroy();

        return;

    }


    // 기존 서버가 있다면 종료
    if (
        serverSocket &&
        !serverSocket.destroyed &&
        serverSocket !== socket
    ) {

        serverSocket.destroy();

    }


    serverSocket =
        socket;


    serverSocket.isServer =
        true;


    // ================================================
    // 새로운 SERVER-ID 발급
    // ================================================

    serverId =
        GenerateID(
            'SERVER'
        );


    SendLine(
        socket,
        'REGISTERED|' +
        serverId
    );


    console.log(
        'SERVER REGISTERED: ' +
        serverId
    );

}


// ======================================================
// APK CONNECT
//
// CONNECT
// ======================================================

function HandleClientConnect(
    socket
) {

    if (
        !serverSocket ||
        serverSocket.destroyed
    ) {

        SendLine(
            socket,
            'ERROR|SERVER_OFFLINE'
        );

        return;

    }


    // ================================================
    // Client-ID 자동 생성
    // ================================================

    let clientId;


    do {

        clientId =
            GenerateID(
                'CLIENT'
            );

    } while (
        clients.has(clientId)
    );


    clients.set(
        clientId,
        {
            connectedAt: Date.now(),
            serverId: serverId
        }
    );


    // ================================================
    // APK에 Client-ID 전달
    // ================================================

    SendLine(
        socket,
        'CONNECTED|' +
        clientId
    );


    console.log(
        'CLIENT CONNECTED: ' +
        clientId
    );

}


// ======================================================
// APK SEND
//
// SEND|CLIENT_ID|NUMBER
// ======================================================

function HandleSend(
    socket,
    parts
) {

    if (parts.length !== 3) {

        SendLine(
            socket,
            'ERROR|INVALID_DATA'
        );

        return;

    }


    const clientId =
        parts[1];

    const number =
        parts[2];


    // ================================================
    // Client 존재 여부
    // ================================================

    if (
        !clients.has(clientId)
    ) {

        SendLine(
            socket,
            'ERROR|CLIENT_NOT_CONNECTED'
        );

        return;

    }


    // ================================================
    // 숫자만 허용
    // ================================================

    if (
        !/^-?\d+$/.test(number)
    ) {

        SendLine(
            socket,
            'ERROR|NUMBER_ONLY'
        );

        return;

    }


    // ================================================
    // WinSockServer 확인
    // ================================================

    if (
        !serverSocket ||
        serverSocket.destroyed
    ) {

        SendLine(
            socket,
            'ERROR|SERVER_OFFLINE'
        );

        return;

    }


    // ================================================
    // WinSockServer로 숫자 전달
    // ================================================

    SendLine(
        serverSocket,
        'NUMBER|' +
        number
    );


    // ================================================
    // APK 응답
    // ================================================

    SendLine(
        socket,
        'SENT|OK'
    );

}


// ======================================================
// PONG
// ======================================================

function HandlePong(socket) {

    // 아무 작업도 하지 않음

}


// ======================================================
// COMMAND
// ======================================================

function ProcessCommand(
    socket,
    line
) {

    line =
        line.trim();


    if (!line) {
        return;
    }


    const parts =
        line.split('|');


    const command =
        parts[0];


    // ================================================
    // WinSockServer
    // ================================================

    if (
        command === 'REGISTER'
    ) {

        HandleRegister(
            socket,
            parts
        );

        return;

    }


    // ================================================
    // APK
    // ================================================

    if (
        command === 'CONNECT'
    ) {

        HandleClientConnect(
            socket
        );

        return;

    }


    if (
        command === 'SEND'
    ) {

        HandleSend(
            socket,
            parts
        );

        return;

    }


    // ================================================
    // Keep Alive
    // ================================================

    if (
        command === 'PONG'
    ) {

        HandlePong(
            socket
        );

        return;

    }


    SendLine(
        socket,
        'ERROR|UNKNOWN_COMMAND'
    );

}


// ======================================================
// TCP SERVER
// ======================================================

const tcpServer =
    net.createServer(
        socket => {

            let buffer =
                '';


            socket.setEncoding(
                'utf8'
            );


            socket.on(
                'data',
                data => {

                    buffer += data;


                    while (true) {

                        const pos =
                            buffer.indexOf(
                                '\n'
                            );


                        if (
                            pos === -1
                        ) {
                            break;
                        }


                        let line =
                            buffer.substring(
                                0,
                                pos
                            );


                        buffer =
                            buffer.substring(
                                pos + 1
                            );


                        line =
                            line.replace(
                                /\r$/,
                                ''
                            );


                        ProcessCommand(
                            socket,
                            line
                        );

                    }

                }
            );


            socket.on(
                'close',
                () => {

                    if (
                        serverSocket === socket
                    ) {

                        serverSocket =
                            null;

                        serverId =
                            null;

                        console.log(
                            'SERVER DISCONNECTED'
                        );

                    }

                }
            );


            socket.on(
                'error',
                () => {

                    // 정상적인 TCP 종료 과정에서
                    // 발생할 수 있으므로 출력하지 않음

                }
            );

        }
    );


// ======================================================
// SERVER KEEP ALIVE
// ======================================================

setInterval(
    () => {

        if (
            serverSocket &&
            !serverSocket.destroyed
        ) {

            SendLine(
                serverSocket,
                'PING'
            );

        }

    },
    10000
);


// ======================================================
// START
// ======================================================

tcpServer.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '================================'
        );

        console.log(
            '        PURE TCP RELAY'
        );

        console.log(
            '================================'
        );

        console.log(
            'Protocol: RAW TCP'
        );

        console.log(
            'HTTP: OFF'
        );

        console.log(
            'WebSocket: OFF'
        );

        console.log(
            'FTP: OFF'
        );

        console.log(
            'Port: ' +
            PORT
        );

        console.log(
            '================================'
        );

    }
);
