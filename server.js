const net = require('net');
const crypto = require('crypto');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const SERVER_ID_PREFIX = 'SERVER-';
const CLIENT_ID_PREFIX = 'CLIENT-';

const servers = new Map();
const clients = new Map();

function RandomID(prefix) {
    return prefix +
        crypto.randomBytes(8).toString('hex').toUpperCase();
}

function MakeUniqueID(prefix, map) {
    let id;

    do {
        id = RandomID(prefix);
    } while (map.has(id));

    return id;
}

function SendLine(socket, text) {
    if (!socket.destroyed) {
        socket.write(text + '\n');
    }
}

function RemoveServer(server) {
    if (!server || !server.serverId) {
        return;
    }

    const current =
        servers.get(server.serverId);

    if (current === server) {
        servers.delete(server.serverId);
    }

    for (const [clientId, client] of clients) {
        if (client.serverId === server.serverId) {
            clients.delete(clientId);
        }
    }
}

function RemoveClient(client) {
    if (!client || !client.clientId) {
        return;
    }

    const current =
        clients.get(client.clientId);

    if (current === client) {
        clients.delete(client.clientId);
    }
}

function GetAvailableServer() {
    const now = Date.now();

    const available = [];

    for (const server of servers.values()) {
        if (server.socket.destroyed) {
            continue;
        }

        if (now - server.lastSeen > 30000) {
            continue;
        }

        available.push(server);
    }

    if (available.length === 0) {
        return null;
    }

    available.sort(
        (a, b) =>
            a.clients.size -
            b.clients.size
    );

    return available[0];
}

function HandleServerLine(server, line) {

    line = line.trim();

    if (line === '') {
        return;
    }

    // -----------------------------------------------
    // REGISTER
    // -----------------------------------------------

    if (line === 'REGISTER') {

        if (server.registered) {
            SendLine(
                server.socket,
                'ERROR|ALREADY_REGISTERED'
            );

            return;
        }

        const serverId =
            MakeUniqueID(
                SERVER_ID_PREFIX,
                servers
            );

        server.serverId =
            serverId;

        server.registered =
            true;

        server.lastSeen =
            Date.now();

        server.clients =
            new Set();

        servers.set(
            serverId,
            server
        );

        SendLine(
            server.socket,
            'REGISTERED|' +
            serverId
        );

        return;
    }


    // -----------------------------------------------
    // PONG
    // -----------------------------------------------

    if (line === 'PONG') {

        server.lastSeen =
            Date.now();

        return;
    }


    // -----------------------------------------------
    // UNKNOWN
    // -----------------------------------------------

    SendLine(
        server.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function HandleClientLine(client, line) {

    line = line.trim();

    if (line === '') {
        return;
    }


    // -----------------------------------------------
    // CONNECT
    // -----------------------------------------------

    if (line === 'CONNECT') {

        if (client.connected) {

            SendLine(
                client.socket,
                'CONNECTED|' +
                client.clientId +
                '|' +
                client.serverId
            );

            return;
        }


        const server =
            GetAvailableServer();


        if (!server) {

            SendLine(
                client.socket,
                'ERROR|NO_SERVER'
            );

            return;
        }


        const clientId =
            MakeUniqueID(
                CLIENT_ID_PREFIX,
                clients
            );


        client.clientId =
            clientId;

        client.serverId =
            server.serverId;

        client.connected =
            true;

        clients.set(
            clientId,
            client
        );

        server.clients.add(
            clientId
        );


        SendLine(
            client.socket,
            'CONNECTED|' +
            clientId +
            '|' +
            server.serverId
        );

        return;
    }


    // -----------------------------------------------
    // SEND|CLIENT-ID|NUMBER
    // -----------------------------------------------

    if (line.startsWith('SEND|')) {

        const parts =
            line.split('|');


        if (parts.length !== 3) {

            SendLine(
                client.socket,
                'ERROR|INVALID_SEND'
            );

            return;
        }


        const clientId =
            parts[1];

        const number =
            parts[2].trim();


        if (!/^-?\d+$/.test(number)) {

            SendLine(
                client.socket,
                'ERROR|NUMBER_ONLY'
            );

            return;
        }


        if (!client.connected) {

            SendLine(
                client.socket,
                'ERROR|NOT_CONNECTED'
            );

            return;
        }


        if (
            clientId !==
            client.clientId
        ) {

            SendLine(
                client.socket,
                'ERROR|CLIENT_ID'
            );

            return;
        }


        const server =
            servers.get(
                client.serverId
            );


        if (
            !server ||
            server.socket.destroyed
        ) {

            SendLine(
                client.socket,
                'ERROR|SERVER_OFFLINE'
            );

            return;
        }


        SendLine(
            server.socket,
            'NUMBER|' +
            client.clientId +
            '|' +
            number
        );


        SendLine(
            client.socket,
            'SENT|OK'
        );

        return;
    }


    // -----------------------------------------------
    // UNKNOWN
    // -----------------------------------------------

    SendLine(
        client.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function CreateConnection(socket) {

    const connection = {
        socket: socket,

        type: null,

        registered: false,

        serverId: null,

        clientId: null,

        connected: false,

        clients: new Set(),

        lastSeen: Date.now(),

        buffer: ''
    };


    socket.setNoDelay(true);

    socket.setKeepAlive(
        true,
        10000
    );


    socket.on(
        'data',
        data => {

            connection.buffer +=
                data.toString('utf8');


            while (true) {

                const pos =
                    connection.buffer.indexOf('\n');


                if (pos < 0) {
                    break;
                }


                let line =
                    connection.buffer.substring(
                        0,
                        pos
                    );


                connection.buffer =
                    connection.buffer.substring(
                        pos + 1
                    );


                line =
                    line.replace(
                        /\r$/,
                        ''
                    );


                // -----------------------------------
                // 최초 명령으로 종류 판별
                // -----------------------------------

                if (!connection.type) {

                    if (
                        line ===
                        'REGISTER'
                    ) {

                        connection.type =
                            'server';

                    }

                    else if (
                        line ===
                        'CONNECT'
                    ) {

                        connection.type =
                            'client';

                    }

                    else if (
                        line.startsWith(
                            'SEND|'
                        )
                    ) {

                        connection.type =
                            'client';

                    }

                    else {

                        SendLine(
                            socket,
                            'ERROR|UNKNOWN_COMMAND'
                        );

                        continue;
                    }
                }


                if (
                    connection.type ===
                    'server'
                ) {

                    HandleServerLine(
                        connection,
                        line
                    );

                }

                else {

                    HandleClientLine(
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

            if (
                connection.type ===
                'server'
            ) {

                RemoveServer(
                    connection
                );

            }

            else if (
                connection.type ===
                'client'
            ) {

                if (
                    connection.serverId
                ) {

                    const server =
                        servers.get(
                            connection.serverId
                        );

                    if (server) {

                        server.clients.delete(
                            connection.clientId
                        );

                    }
                }


                RemoveClient(
                    connection
                );
            }
        }
    );


    socket.on(
        'error',
        () => {

            // 오류 메시지는 사용자 화면에 출력하지 않음

        }
    );
}

const server =
    net.createServer(
        socket => {

            CreateConnection(
                socket
            );

        }
    );


server.listen(
    PORT,
    HOST,
    () => {

        console.log(
            'PURE TCP RELAY SERVER'
        );

        console.log(
            'PORT: ' +
            PORT
        );

    }
);


// ----------------------------------------------------
// 서버 상태 확인
// ----------------------------------------------------

setInterval(
    () => {

        const now =
            Date.now();


        for (
            const server
            of servers.values()
        ) {

            if (
                server.socket.destroyed
            ) {

                RemoveServer(
                    server
                );

                continue;
            }


            if (
                now -
                server.lastSeen >
                30000
            ) {

                server.socket.destroy();

                RemoveServer(
                    server
                );

                continue;
            }


            SendLine(
                server.socket,
                'PING'
            );
        }

    },
    10000
);
