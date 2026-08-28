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
        crypto.randomBytes(8)
            .toString('hex')
            .toUpperCase();
}

function MakeUniqueID(prefix, map) {
    let id;

    do {
        id = RandomID(prefix);
    } while (map.has(id));

    return id;
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed) {
        return false;
    }

    try {
        socket.write(text + '\n');
        return true;
    } catch (error) {
        return false;
    }
}

function RemoveServer(connection) {
    if (!connection.serverId) {
        return;
    }

    const server = servers.get(connection.serverId);

    if (server === connection) {
        servers.delete(connection.serverId);
    }

    for (const [clientId, client] of clients) {
        if (client.serverId === connection.serverId) {
            clients.delete(clientId);
        }
    }
}

function GetAvailableServer() {
    const now = Date.now();
    const list = [];

    for (const server of servers.values()) {
        if (!server.registered) {
            continue;
        }

        if (!server.socket || server.socket.destroyed) {
            continue;
        }

        if (now - server.lastSeen > 30000) {
            continue;
        }

        list.push(server);
    }

    if (list.length === 0) {
        return null;
    }

    list.sort((a, b) => {
        return a.clients.size - b.clients.size;
    });

    return list[0];
}

function HandleServerLine(connection, line) {
    line = line.trim();

    if (line === '') {
        return;
    }

    if (line === 'REGISTER') {
        if (connection.registered) {
            SendLine(
                connection.socket,
                'ERROR|ALREADY_REGISTERED'
            );

            return;
        }

        const serverId = MakeUniqueID(
            SERVER_ID_PREFIX,
            servers
        );

        connection.serverId = serverId;
        connection.registered = true;
        connection.lastSeen = Date.now();
        connection.clients = new Set();

        servers.set(
            serverId,
            connection
        );

        SendLine(
            connection.socket,
            'REGISTERED|' + serverId
        );

        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Date.now();
        return;
    }

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function HandleClientLine(connection, line) {
    line = line.trim();

    if (line === '') {
        return;
    }

    // ============================================
    // CONNECT
    // ============================================

    if (line === 'CONNECT') {
        const server = GetAvailableServer();

        if (!server) {
            SendLine(
                connection.socket,
                'ERROR|NO_SERVER'
            );

            return;
        }

        const clientId = MakeUniqueID(
            CLIENT_ID_PREFIX,
            clients
        );

        const client = {
            clientId: clientId,
            serverId: server.serverId,
            connectedAt: Date.now()
        };

        clients.set(
            clientId,
            client
        );

        server.clients.add(
            clientId
        );

        SendLine(
            connection.socket,
            'CONNECTED|' +
            clientId +
            '|' +
            server.serverId
        );

        return;
    }

    // ============================================
    // SEND
    // ============================================

    if (line.startsWith('SEND|')) {
        const parts = line.split('|');

        if (parts.length !== 3) {
            SendLine(
                connection.socket,
                'ERROR|INVALID_SEND'
            );

            return;
        }

        const clientId = parts[1].trim();
        const number = parts[2].trim();

        if (clientId === '') {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_ID_EMPTY'
            );

            return;
        }

        if (number === '') {
            SendLine(
                connection.socket,
                'ERROR|NUMBER_EMPTY'
            );

            return;
        }

        if (!/^-?\d+$/.test(number)) {
            SendLine(
                connection.socket,
                'ERROR|NUMBER_ONLY'
            );

            return;
        }

        const client = clients.get(clientId);

        if (!client) {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_NOT_FOUND'
            );

            return;
        }

        const server = servers.get(
            client.serverId
        );

        if (!server) {
            clients.delete(clientId);

            SendLine(
                connection.socket,
                'ERROR|SERVER_OFFLINE'
            );

            return;
        }

        if (!server.socket || server.socket.destroyed) {
            RemoveServer(server);

            SendLine(
                connection.socket,
                'ERROR|SERVER_OFFLINE'
            );

            return;
        }

        const packet =
            'NUMBER|' +
            clientId +
            '|' +
            number;

        const sent = SendLine(
            server.socket,
            packet
        );

        if (!sent) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_SEND_FAILED'
            );

            return;
        }

        SendLine(
            connection.socket,
            'SENT|OK'
        );

        return;
    }

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function CreateConnection(socket) {
    const connection = {
        socket: socket,
        type: null,
        registered: false,
        serverId: null,
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
            connection.buffer += data.toString('utf8');

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

                // ==================================
                // 최초 명령으로 타입 판별
                // ==================================

                if (!connection.type) {
                    if (line === 'REGISTER') {
                        connection.type = 'server';
                    } else if (line === 'CONNECT') {
                        connection.type = 'client';
                    } else if (line.startsWith('SEND|')) {
                        connection.type = 'client';
                    } else {
                        SendLine(
                            socket,
                            'ERROR|UNKNOWN_COMMAND'
                        );

                        continue;
                    }
                }

                if (connection.type === 'server') {
                    HandleServerLine(
                        connection,
                        line
                    );
                } else {
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
            if (connection.type === 'server') {
                RemoveServer(
                    connection
                );
            }
        }
    );

    socket.on(
        'error',
        () => {
        }
    );
}

const server = net.createServer(
    socket => {
        CreateConnection(
            socket
        );
    }
);

server.on(
    'error',
    error => {
        console.error(
            'SERVER ERROR:',
            error.message
        );
    }
);

server.listen(
    PORT,
    HOST,
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
            'Port: ' +
            PORT
        );

        console.log(
            'Protocol: RAW TCP'
        );

        console.log(
            '================================'
        );
    }
);

// ================================================
// WinSockServer 상태 체크
// ================================================

setInterval(
    () => {
        const now = Date.now();

        for (const connection of servers.values()) {
            if (!connection.socket ||
                connection.socket.destroyed) {
                RemoveServer(
                    connection
                );

                continue;
            }

            if (now - connection.lastSeen > 30000) {
                connection.socket.destroy();

                RemoveServer(
                    connection
                );

                continue;
            }

            SendLine(
                connection.socket,
                'PING'
            );
        }
    },
    10000
);
