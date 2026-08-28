const net = require('net');

const PORT = Number(process.env.PORT || 3000);

const SERVER_ID =
    process.env.SERVER_ID || 'SERVER-D6EB849D4436';

const API_TOKEN =
    process.env.API_TOKEN || 'Relay_2026_X7pK29mQ8zL4';


// SERVER-ID별 대기 숫자
const queues = {};


// 연결된 APK Client 목록
const clients = new Map();


function log(message) {
    console.log(
        new Date().toISOString() +
        ' ' +
        message
    );
}


function sendLine(socket, text) {

    if (!socket.destroyed) {
        socket.write(text + '\n');
    }
}


function processCommand(socket, line) {

    line = line.trim();

    if (line === '') {
        return;
    }


    const parts = line.split('|');

    const command = parts[0];


    // ==================================================
    // CONNECT
    //
    // CONNECT|TOKEN|SERVER_ID|CLIENT_ID
    // ==================================================

    if (command === 'CONNECT') {

        if (parts.length !== 4) {

            sendLine(
                socket,
                'ERROR|INVALID_DATA'
            );

            return;
        }


        const token = parts[1];
        const serverId = parts[2];
        const clientId = parts[3];


        // Token 검사
        if (token !== API_TOKEN) {

            sendLine(
                socket,
                'ERROR|INVALID_TOKEN'
            );

            log(
                'CONNECT FAILED: INVALID_TOKEN'
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
                'CONNECT FAILED: INVALID SERVER-ID = ' +
                serverId
            );

            return;
        }


        // Client-ID 검사
        if (clientId === '') {

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


        // Queue 생성
        if (!queues[serverId]) {
            queues[serverId] = [];
        }


        // 성공 응답
        sendLine(
            socket,
            'CONNECTED|' +
            serverId +
            '|' +
            clientId
        );


        log(
            'CLIENT CONNECTED: ' +
            clientId +
            ' SERVER=' +
            serverId
        );


        return;
    }


    // ==================================================
    // SEND
    //
    // SEND|TOKEN|SERVER_ID|CLIENT_ID|NUMBER
    // ==================================================

    if (command === 'SEND') {

        if (parts.length !== 5) {

            sendLine(
                socket,
                'ERROR|INVALID_DATA'
            );

            return;
        }


        const token = parts[1];
        const serverId = parts[2];
        const clientId = parts[3];
        const number = parts[4];


        // Token 검사
        if (token !== API_TOKEN) {

            sendLine(
                socket,
                'ERROR|INVALID_TOKEN'
            );

            return;
        }


        // SERVER-ID 검사
        if (serverId !== SERVER_ID) {

            sendLine(
                socket,
                'ERROR|SERVER_NOT_FOUND'
            );

            return;
        }


        // Client 연결 검사
        const client =
            clients.get(clientId);


        if (!client) {

            sendLine(
                socket,
                'ERROR|CLIENT_NOT_CONNECTED'
            );

            return;
        }


        // 다른 SERVER-ID에 등록된 Client인지 검사
        if (client.serverId !== serverId) {

            sendLine(
                socket,
                'ERROR|SERVER_NOT_FOUND'
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


        // Queue 생성
        if (!queues[serverId]) {
            queues[serverId] = [];
        }


        // 숫자 저장
        queues[serverId].push(
            {
                clientId: clientId,
                number: number,
                time: Date.now()
            }
        );


        // 성공 응답
        sendLine(
            socket,
            'SENT|OK'
        );


        log(
            'NUMBER QUEUED: ' +
            number +
            ' CLIENT=' +
            clientId
        );


        return;
    }


    // ==================================================
    // POLL
    //
    // POLL|TOKEN|SERVER_ID
    // ==================================================

    if (command === 'POLL') {

        if (parts.length !== 3) {

            sendLine(
                socket,
                'ERROR|INVALID_DATA'
            );

            return;
        }


        const token = parts[1];
        const serverId = parts[2];


        // Token 검사
        if (token !== API_TOKEN) {

            sendLine(
                socket,
                'ERROR|INVALID_TOKEN'
            );

            return;
        }


        // SERVER-ID 검사
        if (serverId !== SERVER_ID) {

            sendLine(
                socket,
                'ERROR|SERVER_NOT_FOUND'
            );

            return;
        }


        // Queue가 없는 경우
        if (
            !queues[serverId] ||
            queues[serverId].length === 0
        ) {

            sendLine(
                socket,
                'EMPTY'
            );

            return;
        }


        // 가장 오래된 숫자 가져오기
        const item =
            queues[serverId].shift();


        // 숫자 반환
        sendLine(
            socket,
            'NUMBER|' +
            item.number
        );


        log(
            'NUMBER DELIVERED: ' +
            item.number +
            ' CLIENT=' +
            item.clientId
        );


        return;
    }


    // ==================================================
    // 잘못된 명령
    // ==================================================

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


            let buffer = '';


            socket.setEncoding(
                'utf8'
            );


            socket.on(
                'data',
                data => {

                    buffer += data;


                    while (true) {

                        const newlineIndex =
                            buffer.indexOf('\n');


                        if (
                            newlineIndex === -1
                        ) {
                            break;
                        }


                        let line =
                            buffer.substring(
                                0,
                                newlineIndex
                            );


                        buffer =
                            buffer.substring(
                                newlineIndex + 1
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

                    // 해당 Socket을 사용하는 Client 제거
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
                                'CLIENT DISCONNECTED: ' +
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
                        'SOCKET ERROR ' +
                        remote +
                        ': ' +
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
            '       RAW TCP RELAY SERVER'
        );

        console.log(
            '================================'
        );

        console.log(
            'SERVER-ID: ' +
            SERVER_ID
        );

        console.log(
            'TCP PORT: ' +
            PORT
        );

        console.log(
            'Protocol: PURE TCP'
        );

        console.log(
            'HTTP: DISABLED'
        );

        console.log(
            'HTTPS: DISABLED'
        );

        console.log(
            'WebSocket: DISABLED'
        );

        console.log(
            'FTP: DISABLED'
        );

        console.log(
            '================================'
        );
    }
);
