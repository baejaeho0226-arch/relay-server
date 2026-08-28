const net = require('net');
const crypto = require('crypto');


// ======================================================
// CONFIG
// ======================================================

const PORT = Number(process.env.PORT || 3000);

const API_TOKEN =
    process.env.API_TOKEN || '';


// ======================================================
// CURRENT WIN SOCK SERVER
// ======================================================

let serverSocket = null;
let serverId = null;


// ======================================================
// CLIENT LIST
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
// SEND LINE
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
// REGISTER WIN SOCK SERVER
//
// REGISTER|API_TOKEN
// ======================================================

function HandleRegister(socket, parts) {

    if (parts.length !== 2) {
        SendLine(
            socket,
            'ERROR|INVALID_REGISTER'
        );

        socket.destroy();
        return;
    }


    const token = parts[1];


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


    // 기존 WinSockServer가 있으면 종료
    if (
        serverSocket &&
        !serverSocket.destroyed &&
        serverSocket !== socket
    ) {
        serverSocket.destroy();
    }


    serverSocket = socket;
    serverSocket.isServer = true;


    // 새로운 SERVER-ID 발급
    serverId =
        GenerateID(
            'SERVER'
        );


    SendLine(
        socket,
        'REGISTERED|' +
        serverId
    );

}


// ======================================================
// APK CONNECT
//
// CONNECT
// ======================================================

function HandleClientConnect(socket) {

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
            socket: socket,
            serverId: serverId,
            connectedAt: Date.now()
        }
    );


    socket.clientId =
        clientId;


    SendLine(
        socket,
        'CONNECTED|' +
        clientId
    );

}


// ======================================================
// APK SEND NUMBER
//
// SEND|CLIENT-ID|NUMBER
// ======================================================

function HandleSend(socket, parts) {

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


    // Client-ID 검증
    const client =
        clients.get(
            clientId
        );


    if (
        !client ||
        client.socket !== socket
    ) {
        SendLine(
            socket,
            'ERROR|CLIENT_NOT_CONNECTED'
        );

        return;
    }


    // 숫자만 허용
    if (
        !/^-?\d+$/.test(number)
    ) {
        SendLine(
            socket,
            'ERROR|NUMBER_ONLY'
        );

        return;
    }


    // WinSockServer 확인
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


    // WinSockServer로 전달
    SendLine(
        serverSocket,
        'NUMBER|' +
        number
    );


    // APK 응답
    SendLine(
        socket,
        'SENT|OK'
    );

}


// ======================================================
// COMMAND PROCESS
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


    // --------------------------------------------------
    // WinSockServer REGISTER
    // --------------------------------------------------

    if (
        command === 'REGISTER'
    ) {

        HandleRegister(
            socket,
            parts
        );

        return;
    }


    // --------------------------------------------------
    // APK CONNECT
    // --------------------------------------------------

    if (
        command === 'CONNECT'
    ) {

        HandleClientConnect(
            socket
        );

        return;
    }


    // --------------------------------------------------
    // APK SEND
    // --------------------------------------------------

    if (
        command === 'SEND'
    ) {

        HandleSend(
            socket,
            parts
        );

        return;
    }


    // --------------------------------------------------
    // PONG
    // --------------------------------------------------

    if (
        command === 'PONG'
    ) {

        return;
    }


    // --------------------------------------------------
    // UNKNOWN
    // --------------------------------------------------

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

            let buffer = '';


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

                    // WinSockServer 종료
                    if (
                        serverSocket === socket
                    ) {

                        serverSocket =
                            null;

                        serverId =
                            null;

                    }


                    // APK 종료
                    if (
                        socket.clientId
                    ) {

                        clients.delete(
                            socket.clientId
                        );

                    }

                }
            );


            socket.on(
                'error',
                () => {
                    // 조용히 처리
                }
            );

        }
    );


// ======================================================
// PING
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
