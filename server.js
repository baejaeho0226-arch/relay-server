const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const SERVER_ID_PREFIX = 'SERVER-';
const CLIENT_ID_PREFIX = 'CLIENT-';

const IDENTITY_FILE =
    path.join(__dirname, 'relay-identities.json');

const servers = new Map();
const clients = new Map();

const serverIdentities = new Map();
const clientIdentities = new Map();

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

function RandomKey() {
    return crypto
        .randomBytes(24)
        .toString('hex')
        .toUpperCase();
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

function LoadIdentities() {
    try {
        if (!fs.existsSync(IDENTITY_FILE)) {
            return;
        }

        const text =
            fs.readFileSync(
                IDENTITY_FILE,
                'utf8'
            );

        if (!text.trim()) {
            return;
        }

        const data =
            JSON.parse(text);

        if (data.servers) {
            for (const [key, value] of
                Object.entries(data.servers)) {

                if (
                    typeof key === 'string' &&
                    typeof value === 'string' &&
                    value.startsWith(SERVER_ID_PREFIX)
                ) {
                    serverIdentities.set(
                        key,
                        value
                    );
                }
            }
        }

        if (data.clients) {
            for (const [key, value] of
                Object.entries(data.clients)) {

                if (!value) {
                    continue;
                }

                if (
                    typeof value.clientId !== 'string' ||
                    typeof value.serverId !== 'string'
                ) {
                    continue;
                }

                clientIdentities.set(
                    key,
                    {
                        clientId: value.clientId,
                        serverId: value.serverId
                    }
                );
            }
        }

        console.log(
            'IDENTITIES LOADED'
        );

        console.log(
            'SERVER IDENTITIES: ' +
            serverIdentities.size
        );

        console.log(
            'CLIENT IDENTITIES: ' +
            clientIdentities.size
        );

    } catch (error) {

        console.error(
            'IDENTITY LOAD ERROR:',
            error.message
        );
    }
}

function SaveIdentities() {
    const data = {
        version: 1,
        servers: {},
        clients: {}
    };

    for (
        const [key, serverId]
        of serverIdentities
    ) {
        data.servers[key] =
            serverId;
    }

    for (
        const [key, client]
        of clientIdentities
    ) {
        data.clients[key] = {
            clientId: client.clientId,
            serverId: client.serverId
        };
    }

    const tempFile =
        IDENTITY_FILE + '.tmp';

    try {

        fs.writeFileSync(
            tempFile,
            JSON.stringify(
                data,
                null,
                2
            ),
            'utf8'
        );

        fs.renameSync(
            tempFile,
            IDENTITY_FILE
        );

    } catch (error) {

        console.error(
            'IDENTITY SAVE ERROR:',
            error.message
        );

        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch (_) {
        }
    }
}

function GetServerByID(serverId) {
    if (!serverId) {
        return null;
    }

    const server =
        servers.get(serverId);

    if (!server) {
        return null;
    }

    if (!server.registered) {
        return null;
    }

    if (
        !server.socket ||
        server.socket.destroyed
    ) {
        return null;
    }

    return server;
}

function GetAvailableServer() {
    const list = [];

    for (
        const server
        of servers.values()
    ) {

        if (!server.registered) {
            continue;
        }

        if (
            !server.socket ||
            server.socket.destroyed
        ) {
            continue;
        }

        list.push(server);
    }

    if (list.length === 0) {
        return null;
    }

    list.sort(
        (a, b) =>
            a.clients.size -
            b.clients.size
    );

    return list[0];
}

function AttachServer(connection, serverId) {
    const old =
        servers.get(serverId);

    if (
        old &&
        old !== connection &&
        old.socket &&
        !old.socket.destroyed
    ) {
        try {
            SendLine(
                old.socket,
                'ERROR|REPLACED'
            );

            old.socket.destroy();
        } catch (_) {
        }
    }

    connection.serverId =
        serverId;

    connection.registered =
        true;

    connection.lastSeen =
        Date.now();

    if (!connection.clients) {
        connection.clients =
            new Set();
    }

    servers.set(
        serverId,
        connection
    );
}

function HandleServerLine(
    connection,
    line
) {
    line = line.trim();

    if (line === '') {
        return;
    }

    // ============================================
    // 최초 등록
    //
    // REGISTER|SERVER-KEY
    // ============================================

    if (
        line === 'REGISTER' ||
        line.startsWith('REGISTER|')
    ) {

        if (connection.registered) {
            SendLine(
                connection.socket,
                'ERROR|ALREADY_REGISTERED'
            );

            return;
        }

        const parts =
            line.split('|');

        let identityKey = '';

        if (parts.length >= 2) {
            identityKey =
                parts[1].trim();
        }

        if (identityKey === '') {
            SendLine(
                connection.socket,
                'ERROR|SERVER_KEY_REQUIRED'
            );

            return;
        }

        let serverId =
            serverIdentities.get(
                identityKey
            );

        if (!serverId) {

            serverId =
                MakeUniqueID(
                    SERVER_ID_PREFIX,
                    serverIdentities
                );

            serverIdentities.set(
                identityKey,
                serverId
            );

            SaveIdentities();
        }

        connection.identityKey =
            identityKey;

        connection.serverId =
            serverId;

        connection.registered =
            true;

        connection.lastSeen =
            Date.now();

        connection.clients =
            new Set();

        AttachServer(
            connection,
            serverId
        );

        SendLine(
            connection.socket,
            'REGISTERED|' +
            serverId
        );

        return;
    }

    // ============================================
    // PONG
    // ============================================

    if (line === 'PONG') {

        if (!connection.registered) {
            return;
        }

        connection.lastSeen =
            Date.now();

        return;
    }

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function HandleClientLine(
    connection,
    line
) {
    line = line.trim();

    if (line === '') {
        return;
    }

    // ============================================
    // CONNECT
    //
    // CONNECT|CLIENT-KEY
    // ============================================

    if (
        line === 'CONNECT' ||
        line.startsWith('CONNECT|')
    ) {

        const parts =
            line.split('|');

        let identityKey = '';

        if (parts.length >= 2) {
            identityKey =
                parts[1].trim();
        }

        if (identityKey === '') {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_KEY_REQUIRED'
            );

            return;
        }

        let saved =
            clientIdentities.get(
                identityKey
            );

        let server = null;

        // ========================================
        // 기존 CLIENT
        // ========================================

        if (saved) {

            server =
                GetServerByID(
                    saved.serverId
                );

            if (!server) {

                SendLine(
                    connection.socket,
                    'ERROR|SERVER_OFFLINE'
                );

                return;
            }

            connection.clientId =
                saved.clientId;

            connection.serverId =
                saved.serverId;

        }

        // ========================================
        // 최초 CLIENT
        // ========================================

        else {

            server =
                GetAvailableServer();

            if (!server) {

                SendLine(
                    connection.socket,
                    'ERROR|NO_SERVER'
                );

                return;
            }

            const clientId =
                MakeUniqueID(
                    CLIENT_ID_PREFIX,
                    clients
                );

            saved = {
                clientId: clientId,
                serverId: server.serverId
            };

            clientIdentities.set(
                identityKey,
                saved
            );

            SaveIdentities();

            connection.clientId =
                clientId;

            connection.serverId =
                server.serverId;
        }

        // ========================================
        // CLIENT 연결 정보
        // ========================================

        connection.identityKey =
            identityKey;

        connection.type =
            'client';

        connection.connected =
            true;

        connection.lastSeen =
            Date.now();

        clients.set(
            connection.clientId,
            connection
        );

        if (!server.clients) {
            server.clients =
                new Set();
        }

        server.clients.add(
            connection.clientId
        );

        SendLine(
            connection.socket,
            'CONNECTED|' +
            connection.clientId +
            '|' +
            connection.serverId
        );

        return;
    }

    // ============================================
    // SEND
    // ============================================

    if (
        line.startsWith('SEND|')
    ) {

        const parts =
            line.split('|');

        if (parts.length !== 3) {

            SendLine(
                connection.socket,
                'ERROR|INVALID_SEND'
            );

            return;
        }

        const clientId =
            parts[1].trim();

        const number =
            parts[2].trim();

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

        const savedClient =
            clientIdentitiesByID(
                clientId
            );

        if (!savedClient) {

            SendLine(
                connection.socket,
                'ERROR|CLIENT_NOT_FOUND'
            );

            return;
        }

        const server =
            GetServerByID(
                savedClient.serverId
            );

        if (!server) {

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

        if (
            !SendLine(
                server.socket,
                packet
            )
        ) {

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

    // ============================================
    // PONG
    // ============================================

    if (line === 'PONG') {

        connection.lastSeen =
            Date.now();

        return;
    }

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function clientIdentitiesByID(
    clientId
) {
    for (
        const saved
        of clientIdentities.values()
    ) {

        if (
            saved.clientId ===
            clientId
        ) {
            return saved;
        }
    }

    return null;
}

function DisconnectConnection(
    connection
) {
    if (
        connection.type ===
        'server'
    ) {

        if (connection.serverId) {

            const server =
                servers.get(
                    connection.serverId
                );

            if (
                server ===
                connection
            ) {
                servers.delete(
                    connection.serverId
                );
            }
        }

        // ========================================
        // 중요
        //
        // SERVER ID 자체는 절대 삭제하지 않는다.
        // CLIENT ID / 매칭도 삭제하지 않는다.
        // ========================================

        return;
    }

    if (
        connection.type ===
        'client'
    ) {

        if (
            connection.clientId
        ) {

            const current =
                clients.get(
                    connection.clientId
                );

            if (
                current ===
                connection
            ) {
                clients.delete(
                    connection.clientId
                );
            }
        }

        // ========================================
        // 중요
        //
        // CLIENT ID는 삭제하지 않는다.
        // CLIENT ↔ SERVER 매칭도 삭제하지 않는다.
        // ========================================

        return;
    }
}

function CreateConnection(socket) {
    const connection = {
        socket: socket,
        type: null,
        registered: false,
        connected: false,

        identityKey: null,

        serverId: null,
        clientId: null,

        lastSeen: Date.now(),

        clients: new Set(),

        buffer: ''
    };

    socket.setNoDelay(
        true
    );

    socket.setKeepAlive(
        true,
        10000
    );

    socket.on(
        'data',
        data => {

            connection.buffer +=
                data.toString(
                    'utf8'
                );

            while (true) {

                const pos =
                    connection.buffer.indexOf(
                        '\n'
                    );

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

                if (!connection.type) {

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
                            'SEND|'
                        )
                    ) {

                        connection.type =
                            'client';

                    } else {

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

            DisconnectConnection(
                connection
            );
        }
    );

    socket.on(
        'error',
        () => {
        }
    );
}

LoadIdentities();

const server =
    net.createServer(
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
            'Identity Storage: SERVER'
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

        const now =
            Date.now();

        for (
            const connection
            of servers.values()
        ) {

            if (
                !connection.socket ||
                connection.socket.destroyed
            ) {

                DisconnectConnection(
                    connection
                );

                continue;
            }

            if (
                now -
                connection.lastSeen >
                30000
            ) {

                try {
                    connection.socket.destroy();
                } catch (_) {
                }

                DisconnectConnection(
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
