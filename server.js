const net = require('net');

const PORT = Number(process.env.PORT || 3000);

const SERVER_ID =
    process.env.SERVER_ID || 'SERVER-D6EB849D4436';

const API_TOKEN =
    process.env.API_TOKEN || 'Relay_2026_X7pK29mQ8zL4';


// ======================================================
// 현재 연결된 WinSockServer
// ======================================================

let serverSocket = null;


// ======================================================
// 연결된 APK Client
//
// 이제 socket을 저장하지 않는다.
// CONNECT 성공 여부만 기억한다.
// ======================================================

const clients = new Map();


// ======================================================
// LOG
// ======================================================

function log(text) {

    console.log(
        new Date().toISOString() +
        ' ' +
        text
    );

}


// ======================================================
// SEND LINE
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
// WinSockServer REGISTER
//
// REGISTER|TOKEN|SERVER_ID
// ======================================================

function handleRegister(
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


    const token =
        parts[1];

    const serverId =
        parts[2];


    if (token !== API_TOKEN) {

        sendLine(
            socket,
            'ERROR|INVALID_TOKEN'
        );

        log(
            'REGISTER ERROR: INVALID_TOKEN'
        );

        return;

    }


    if (serverId !== SERVER_ID) {

        sendLine(
            socket,
            'ERROR|SERVER_NOT_FOUND'
        );

        log(
            'REGISTER ERROR: SERVER_NOT_FOUND'
        );

        return;

    }


    // 기존 WinSockServer가 있으면 종료
    if (
        serverSocket &&
        !serverSocket.destroyed &&
        serverSocket !== socket
    ) {

        serverSocket.destroy();

    }


    serverSocket =
        socket;


    socket.isWinSockServer =
        true;


    sendLine(
        socket,
        'REGISTERED|' +
        SERVER_ID
    );


    log(
        'WINSOCKSERVER REGISTERED: ' +
        SERVER_ID
    );

}


// ======================================================
// APK CONNECT
//
// CONNECT|TOKEN|SERVER_ID|CLIENT_ID
// ======================================================

function handleConnect(
    socket,
    parts
) {

    if (parts.length !== 4) {

        sendLine(
            socket,
            'ERROR|INVALID_DATA'
        );

        return;

    }


    const token =
        parts[1];

    const serverId =
        parts[2];

    const clientId =
        parts[3];


    // Token
    if (token !== API_TOKEN) {

        sendLine(
            socket,
            'ERROR|INVALID_TOKEN'
        );

        return;

    }


    // SERVER-ID
    if (serverId !== SERVER_ID) {

        sendLine(
            socket,
            'ERROR|SERVER_NOT_FOUND'
        );

        log(
            'APK CONNECT FAILED: ' +
            serverId
        );

        return;

    }


    if (!clientId) {

        sendLine(
            socket,
            'ERROR|INVALID_CLIENT_ID'
        );

        return;

    }


    // ================================================
    // Client ID만 기억한다.
    //
    // APK TCP socket은 저장하지 않는다.
    // ================================================

    clients.set(
        clientId,
        {
            serverId: serverId,
            connectedAt: Date.now()
        }
    );


    sendLine(
        socket,
        'CONNECTED|' +
        serverId +
        '|' +
        clientId
    );


    log(
        'APK CONNECTED: ' +
        clientId
    );

}


// ======================================================
// APK SEND
//
// SEND|TOKEN|SERVER_ID|CLIENT_ID|NUMBER
// ======================================================

function handleSend(
    socket,
    parts
) {

    if (parts.length !== 5) {

        sendLine(
            socket,
            'ERROR|INVALID_DATA'
        );

        return;

    }


    const token =
        parts[1];

    const serverId =
        parts[2];

    const clientId =
        parts[3];

    const number =
        parts[4];


    // Token
    if (token !== API_TOKEN) {

        sendLine(
            socket,
            'ERROR|INVALID_TOKEN'
        );

        return;

    }


    // SERVER-ID
    if (serverId !== SERVER_ID) {

        sendLine(
            socket,
            'ERROR|SERVER_NOT_FOUND'
        );

        log(
            'SEND ERROR: SERVER_NOT_FOUND'
        );

        return;

    }


    // Client CONNECT 여부
    if (!clients.has(clientId)) {

        sendLine(
            socket,
            'ERROR|CLIENT_NOT_CONNECTED'
        );

        log(
            'SEND ERROR: CLIENT_NOT_CONNECTED ' +
            clientId
        );

        return;

    }


    // 숫자 검사
    if (!/^-?\d+$/.test(number)) {

        sendLine(
            socket,
            'ERROR|NUMBER_ONLY'
        );

        return;

    }


    // WinSockServer 연결 검사
    if (
        !serverSocket ||
        serverSocket.destroyed
    ) {

        sendLine(
            socket,
            'ERROR|SERVER_OFFLINE'
        );

        log(
            'SEND ERROR: SERVER_OFFLINE'
        );

        return;

    }


    // ================================================
    // WinSockServer로 즉시 전송
    // ================================================

    sendLine(
        serverSocket,
        'NUMBER|' + number
    );


    log(
        'NUMBER SENT: ' +
        number +
        ' CLIENT=' +
        clientId
    );


    // APK 응답
    sendLine(
        socket,
        'SENT|OK'
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
// COMMAND
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
                socket,
                parts
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

            const remote =
                socket.remoteAddress +
                ':' +
                socket.remotePort;


            log(
                'TCP CONNECT: ' +
                remote
            );


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


                        if (pos === -1) {
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

                    if (
                        serverSocket === socket
                    ) {

                        serverSocket =
                            null;


                        log(
                            'WINSOCKSERVER DISCONNECTED'
                        );

                    }


                    log(
                        'TCP CLOSE: ' +
                        remote
                    );

                }
            );


            socket.on(
                'error',
                error => {

                    log(
                        'TCP ERROR: ' +
                        error.message
                    );

                }
            );

        }
    );


// ======================================================
// KEEP ALIVE
//
// 10초마다 WinSockServer에 PING
// ======================================================

setInterval(
    () => {

        if (
            serverSocket &&
            !serverSocket.destroyed
        ) {

            sendLine(
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
            'SERVER-ID: ' +
            SERVER_ID
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
            'HTTPS: OFF'
        );

        console.log(
            'WebSocket: OFF'
        );

        console.log(
            'FTP: OFF'
        );

        console.log(
            '================================'
        );

    }
);
