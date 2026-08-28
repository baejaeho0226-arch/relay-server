const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);

// API TOKEN은 Railway 환경변수에만 둔다.
// 기본값을 넣지 않는다.
const API_TOKEN = process.env.API_TOKEN;

if (!API_TOKEN) {
    console.error('ERROR: API_TOKEN environment variable is missing');
    process.exit(1);
}


// ======================================================
// 현재 PC WinSockServer
// ======================================================

let winSockServer = null;


// ======================================================
// 현재 SERVER-ID
//
// WinSockServer가 REGISTER할 때마다 새로 발급
// ======================================================

let currentServerId = null;


// ======================================================
// APK Client 목록
//
// clientId -> 정보
// ======================================================

const clients = new Map();


// ======================================================
// 랜덤 SERVER-ID
// ======================================================

function createServerId() {

    return (
        'SERVER-' +
        crypto
            .randomBytes(6)
            .toString('hex')
            .toUpperCase()
    );

}


// ======================================================
// 랜덤 CLIENT-ID
// ======================================================

function createClientId() {

    let id;

    do {

        id =
            'CLIENT-' +
            crypto
                .randomBytes(8)
                .toString('hex')
                .toUpperCase();

    } while (clients.has(id));

    return id;

}


// ======================================================
// 한 줄 전송
// ======================================================

function sendLine(socket, text) {

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
// REGISTER
//
// REGISTER|API_TOKEN
//
// Relay가 SERVER-ID를 랜덤 발급
// ======================================================

function handleRegister(
    socket,
    parts
) {

    if (parts.length !== 2) {

        sendLine(
            socket,
            'ERROR|INVALID_DATA'
        );

        return;

    }


    const token =
        parts[1];


    if (token !== API_TOKEN) {

        sendLine(
            socket,
            'ERROR|INVALID_TOKEN'
        );

        return;

    }


    // 기존 WinSockServer 종료
    if (
        winSockServer &&
        !winSockServer.destroyed &&
        winSockServer !== socket
    ) {

        winSockServer.destroy();

    }


    // 새로운 SERVER-ID 발급
    currentServerId =
        createServerId();


    winSockServer =
        socket;


    socket.role =
        'server';


    socket.serverId =
        currentServerId;


    sendLine(
        socket,
        'REGISTERED|' +
        currentServerId
    );


    console.log(
        'SERVER REGISTERED: ' +
        currentServerId
    );

}


// ======================================================
// APK CONNECT
//
// CONNECT
//
// CLIENT-ID를 Relay가 랜덤 발급
// ======================================================

function handleConnect(
    socket
) {

    // 현재 WinSockServer가 없으면 접속 거부
    if (
        !winSockServer ||
        winSockServer.destroyed ||
        !currentServerId
    ) {

        sendLine(
            socket,
            'ERROR|SERVER_OFFLINE'
        );

        return;

    }


    const clientId =
        createClientId();


    clients.set(
        clientId,
        {
            serverId: currentServerId,
            connectedAt: Date.now()
        }
    );


    socket.role =
        'client';


    socket.clientId =
        clientId;


    socket.serverId =
        currentServerId;


    sendLine(
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

function handleSend(
    socket,
    parts
) {

    if (parts.length !== 3) {

        sendLine(
            socket,
            'ERROR|INVALID_DATA'
        );

        return;

    }


    const clientId =
        parts[1];

    const number =
        parts[2];


    // Client 확인
    const client =
        clients.get(
            clientId
        );


    if (!client) {

        sendLine(
            socket,
            'ERROR|CLIENT_NOT_CONNECTED'
        );

        return;

    }


    // 숫자만 허용
    if (!/^-?\d+$/.test(number)) {

        sendLine(
            socket,
            'ERROR|NUMBER_ONLY'
        );

        return;

    }


    // WinSockServer 확인
    if (
        !winSockServer ||
        winSockServer.destroyed
    ) {

        sendLine(
            socket,
            'ERROR|SERVER_OFFLINE'
        );

        return;

    }


    // WinSockServer로 숫자 전달
    sendLine(
        winSockServer,
        'NUMBER|' + number
    );


    // APK에는 전송 성공만 응답
    sendLine(
        socket,
        'SENT|OK'
    );


    console.log(
        'NUMBER: ' +
        number +
        ' CLIENT=' +
        clientId
    );

}


// ======================================================
// PING
// ======================================================

function handlePing(
    socket
) {

    sendLine(
        socket,
        'PONG'
    );

}


// ======================================================
// 명령 처리
// ======================================================

function processCommand(
    socket,
    line
) {

    line =
        line.trim();


    if (line === '') {
        return;
    }


    const parts =
        line.split('|');


    const command =
        parts[0];


    switch (command) {

        case 'REGISTER':

            handleRegister(
                socket,
                parts
            );

            break;


        case 'CONNECT':

            handleConnect(
                socket
            );

            break;


        case 'SEND':

            handleSend(
                socket,
                parts
            );

            break;


        case 'PING':

            handlePing(
                socket
            );

            break;


        case 'PONG':

            // 정상적인 Keep-Alive 응답
            break;


        default:

            sendLine(
                socket,
                'ERROR|UNKNOWN_COMMAND'
            );

            break;

    }

}


// ======================================================
// TCP SERVER
// ======================================================

const tcpServer =
    net.createServer(
        socket => {

            socket.setEncoding(
                'utf8'
            );


            let buffer =
                '';


            socket.on(
                'data',
                data => {

                    buffer += data;


                    while (true) {

                        const pos =
                            buffer.indexOf(
                                '\n'
                            );


                        if (pos < 0) {
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


                        processCommand(
                            socket,
                            line
                        );

                    }

                }
            );


            socket.on(
                'close',
                () => {

                    // WinSockServer 종료
                    if (
                        winSockServer === socket
                    ) {

                        winSockServer =
                            null;

                        currentServerId =
                            null;


                        console.log(
                            'SERVER DISCONNECTED'
                        );

                    }


                    // APK 종료
                    if (
                        socket.role === 'client' &&
                        socket.clientId
                    ) {

                        clients.delete(
                            socket.clientId
                        );


                        console.log(
                            'CLIENT DISCONNECTED: ' +
                            socket.clientId
                        );

                    }

                }
            );


            socket.on(
                'error',
                () => {

                    // 에러는 close에서 정리

                }
            );

        }
    );


// ======================================================
// WinSockServer Keep-Alive
// ======================================================

setInterval(
    () => {

        if (
            winSockServer &&
            !winSockServer.destroyed
        ) {

            sendLine(
                winSockServer,
                'PING'
            );

        }

    },
    10000
);


// ======================================================
// 시작
// ======================================================

tcpServer.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '================================'
        );

        console.log(
            '       PURE TCP RELAY'
        );

        console.log(
            '================================'
        );

        console.log(
            'PORT: ' +
            PORT
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
            'SERVER-ID: AUTO'
        );

        console.log(
            'CLIENT-ID: AUTO'
        );

        console.log(
            '================================'
        );

    }
);
