const net = require('net');

const PORT = Number(process.env.PORT || 3000);

const SERVER_ID =
    process.env.SERVER_ID || 'SERVER-D6EB849D4436';

const API_TOKEN =
    process.env.API_TOKEN || 'Relay_2026_X7pK29mQ8zL4';


// ======================================================
// WinSockServer 연결
// ======================================================

let serverSocket = null;


// ======================================================
// APK Client 목록
// ======================================================

const clients = new Map();


// ======================================================
// 로그
// ======================================================

function log(message) {

    console.log(
        new Date().toISOString() +
        ' ' +
        message
    );

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
// CONNECT
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


    // Token 검사
    if (token !== API_TOKEN) {

        sendLine(
            socket,
            'ERROR|INVALID_TOKEN'
        );

        log(
            'CONNECT ERROR: INVALID_TOKEN'
        );

        return;

    }


    // SERVER-ID 검사
    if (serverId !== SERVER_ID) {

        sendLine(
            socket,
            'ERROR|SERVER_NOT_FOUND'
        );

        log(
            'CONNECT ERROR: SERVER_NOT_FOUND ' +
            serverId
        );

        return;

    }


    // Client-ID 검사
    if (!clientId) {

        sendLine(
            socket,
            'ERROR|INVALID_CLIENT_ID'
        );

        return;

    }


    // Client 등록
    clients.set(
        clientId,
        {
            socket: socket,
            serverId: serverId,
            connectedAt: Date.now()
        }
    );


    // 성공
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
// SEND
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


    // Client 연결 여부
    const client =
        clients.get(
            clientId
        );


    if (!client) {

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


    // ==================================================
    // WinSockServer 연결 확인
    // ==================================================

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


    // ==================================================
    // APK에 전송 성공 응답
    // ==================================================

    sendLine(
        socket,
        'SENT|OK'
    );


    // ==================================================
    // WinSockServer에 숫자 즉시 전달
    // ==================================================

    sendLine(
        serverSocket,
        'NUMBER|' + number
    );


    log(
        'NUMBER SENT TO WINSOCKSERVER: ' +
        number +
        ' CLIENT=' +
        clientId
    );

}


// ======================================================
// REGISTER
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


    // Token 검사
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


    // SERVER-ID 검사
    if (serverId !== SERVER_ID) {

        sendLine(
            socket,
            'ERROR|SERVER_NOT_FOUND'
        );

        log(
            'REGISTER ERROR: SERVER_NOT_FOUND ' +
            serverId
        );

        return;

    }


    // 기존 서버 연결 종료
    if (
        serverSocket &&
        !serverSocket.destroyed &&
        serverSocket !== socket
    ) {

        serverSocket.destroy();

    }


    // 새로운 WinSockServer 등록
    serverSocket =
        socket;


    sendLine(
        socket,
        'REGISTERED|' +
        SERVER_ID
    );


    log(
        'WINSOCKSERVER REGISTERED: ' +
        serverId
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


    // CONNECT
    if (
        command === 'CONNECT'
    ) {

        handleConnect(
            socket,
            parts
        );

        return;

    }


    // SEND
    if (
        command === 'SEND'
    ) {

        handleSend(
            socket,
            parts
        );

        return;

    }


    // REGISTER
    if (
        command === 'REGISTER'
    ) {

        handleRegister(
            socket,
            parts
        );

        return;

    }


    // UNKNOWN
    sendLine(
        socket,
        'ERROR|UNKNOWN_COMMAND'
    );

}


// ======================================================
// TCP SERVER
// ======================================================

const server =
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

                    // WinSockServer 연결 해제
                    if (
                        serverSocket === socket
                    ) {

                        serverSocket =
                            null;


                        log(
                            'WINSOCKSERVER DISCONNECTED'
                        );

                    }


                    // APK Client 제거
                    for (
                        const [
                            clientId,
                            client
                        ] of clients
                    ) {

                        if (
                            client.socket === socket
                        ) {

                            clients.delete(
                                clientId
                            );


                            log(
                                'APK DISCONNECTED: ' +
                                clientId
                            );

                        }

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
// LISTEN
// ======================================================

server.listen(
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
