const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');

const servers = new Map();
const clients = new Map();
const serverIdentities = new Map();
const clientIdentities = new Map();

function RandomID() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function MakeUniqueID(identityMap, usedIds) {
    let id;

    do {
        id = RandomID();
    } while (
        usedIds.has(id) ||
        [...identityMap.values()].some(value => {
            if (typeof value === 'string') {
                return value === id;
            }

            return value && value.id === id;
        })
    );

    return id;
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed) {
        return false;
    }

    try {
        socket.write(text + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function LoadIdentities() {
    try {
        if (!fs.existsSync(IDENTITY_FILE)) {
            return;
        }

        const data = JSON.parse(
            fs.readFileSync(IDENTITY_FILE, 'utf8')
        );

        if (data.servers && typeof data.servers === 'object') {
            for (const [deviceKey, serverId] of Object.entries(data.servers)) {
                if (
                    typeof deviceKey === 'string' &&
                    typeof serverId === 'string' &&
                    deviceKey &&
                    serverId
                ) {
                    serverIdentities.set(deviceKey, serverId);
                }
            }
        }

        if (data.clients && typeof data.clients === 'object') {
            for (const [deviceKey, value] of Object.entries(data.clients)) {
                if (!value || typeof value !== 'object') {
                    continue;
                }

                const id =
                    typeof value.id === 'string'
                        ? value.id
                        : value.clientId;

                if (typeof id !== 'string') {
                    continue;
                }

                if (typeof value.serverId !== 'string') {
                    continue;
                }

                clientIdentities.set(deviceKey, {
                    id,
                    serverId: value.serverId
                });
            }
        }
    } catch (error) {
        console.error('IDENTITY LOAD ERROR:', error.message);
    }
}

function SaveIdentities() {
    const data = {
        version: 2,
        servers: Object.fromEntries(serverIdentities),
        clients: Object.fromEntries(clientIdentities)
    };

    const temp = IDENTITY_FILE + '.tmp';

    try {
        fs.writeFileSync(
            temp,
            JSON.stringify(data, null, 2),
            'utf8'
        );

        fs.renameSync(temp, IDENTITY_FILE);
    } catch (error) {
        console.error('IDENTITY SAVE ERROR:', error.message);

        try {
            if (fs.existsSync(temp)) {
                fs.unlinkSync(temp);
            }
        } catch (_) {}
    }
}

function GetOnlineServer(serverId) {
    const server = servers.get(serverId);

    if (!server) {
        return null;
    }

    if (!server.registered) {
        return null;
    }

    if (!server.socket || server.socket.destroyed) {
        return null;
    }

    return server;
}

function GetAvailableServer() {
    const list = [];

    for (const server of servers.values()) {
        if (!server.registered) {
            continue;
        }

        if (!server.socket || server.socket.destroyed) {
            continue;
        }

        list.push(server);
    }

    if (list.length === 0) {
        return null;
    }

    list.sort((a, b) => a.clients.size - b.clients.size);

    return list[0];
}

function GetUsedServerIds() {
    return new Set(serverIdentities.values());
}

function GetUsedClientIds() {
    return new Set(
        [...clientIdentities.values()].map(value => value.id)
    );
}

function RegisterServer(connection, deviceKey) {
    let serverId = serverIdentities.get(deviceKey);

    if (!serverId) {
        serverId = MakeUniqueID(
            serverIdentities,
            GetUsedServerIds()
        );

        serverIdentities.set(
            deviceKey,
            serverId
        );

        SaveIdentities();
    }

    const old = servers.get(serverId);

    if (
        old &&
        old !== connection &&
        old.socket &&
        !old.socket.destroyed
    ) {
        SendLine(
            old.socket,
            'ERROR|REPLACED'
        );

        old.socket.destroy();
    }

    connection.identityKey = deviceKey;
    connection.serverId = serverId;
    connection.registered = true;
    connection.lastSeen = Date.now();
    connection.clients =
        connection.clients || new Set();

    servers.set(
        serverId,
        connection
    );

    SendLine(
        connection.socket,
        'REGISTERED|' + serverId
    );
}

function HandleServerLine(connection, line) {
    line = line.trim();

    if (line === '') {
        return;
    }

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

        const parts = line.split('|');
        const deviceKey =
            parts.length >= 2
                ? parts[1].trim()
                : '';

        if (!deviceKey) {
            SendLine(
                connection.socket,
                'ERROR|DEVICE_KEY_REQUIRED'
            );

            return;
        }

        RegisterServer(
            connection,
            deviceKey
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

function GetSavedClientByID(clientId) {
    for (const saved of clientIdentities.values()) {
        if (saved.id === clientId) {
            return saved;
        }
    }

    return null;
}

function AttachClient(connection, saved) {
    const old = clients.get(saved.id);

    if (
        old &&
        old !== connection &&
        old.socket &&
        !old.socket.destroyed
    ) {
        SendLine(
            old.socket,
            'ERROR|REPLACED'
        );

        old.socket.destroy();
    }

    connection.clientId = saved.id;
    connection.serverId = saved.serverId;
    connection.connected = true;
    connection.lastSeen = Date.now();

    clients.set(
        saved.id,
        connection
    );

    const server = GetOnlineServer(
        saved.serverId
    );

    if (server) {
        server.clients.add(
            saved.id
        );
    }

    SendLine(
        connection.socket,
        'CONNECTED|' +
        saved.id +
        '|' +
        saved.serverId
    );
}

function HandleClientLine(connection, line) {
    line = line.trim();

    if (line === '') {
        return;
    }

    if (
        line === 'CONNECT' ||
        line.startsWith('CONNECT|')
    ) {
        const parts = line.split('|');
        const deviceKey =
            parts.length >= 2
                ? parts[1].trim()
                : '';

        if (!deviceKey) {
            SendLine(
                connection.socket,
                'ERROR|DEVICE_KEY_REQUIRED'
            );

            return;
        }

        let saved =
            clientIdentities.get(deviceKey);

        if (saved) {
            if (!GetOnlineServer(saved.serverId)) {
                SendLine(
                    connection.socket,
                    'ERROR|SERVER_OFFLINE'
                );

                return;
            }
        } else {
            const server =
                GetAvailableServer();

            if (!server) {
                SendLine(
                    connection.socket,
                    'ERROR|NO_SERVER'
                );

                return;
            }

            saved = {
                id: MakeUniqueID(
                    clientIdentities,
                    GetUsedClientIds()
                ),
                serverId: server.serverId
            };

            clientIdentities.set(
                deviceKey,
                saved
            );

            SaveIdentities();
        }

        AttachClient(
            connection,
            saved
        );

        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Date.now();
        return;
    }

    if (line.startsWith('SEND|')) {
        const parts = line.split('|');

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

        if (!clientId) {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_ID_EMPTY'
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

        const saved =
            GetSavedClientByID(clientId);

        if (!saved) {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_NOT_FOUND'
            );

            return;
        }

        if (connection.clientId !== clientId) {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_NOT_OWNER'
            );

            return;
        }

        const server =
            GetOnlineServer(
                saved.serverId
            );

        if (!server) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_OFFLINE'
            );

            return;
        }

        if (
            !SendLine(
                server.socket,
                'NUMBER|' +
                clientId +
                '|' +
                number
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

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function DisconnectConnection(connection) {
    if (connection.type === 'server') {
        if (
            connection.serverId &&
            servers.get(connection.serverId) === connection
        ) {
            servers.delete(
                connection.serverId
            );
        }

        return;
    }

    if (connection.type === 'client') {
        if (
            connection.clientId &&
            clients.get(connection.clientId) === connection
        ) {
            clients.delete(
                connection.clientId
            );
        }
    }
}

function CreateConnection(socket) {
    const connection = {
        socket,
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

    socket.setNoDelay(true);
    socket.setKeepAlive(
        true,
        10000
    );

    socket.on('data', data => {
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

            if (!connection.type) {
                if (
                    line === 'REGISTER' ||
                    line.startsWith('REGISTER|')
                ) {
                    connection.type = 'server';
                } else if (
                    line === 'CONNECT' ||
                    line.startsWith('CONNECT|') ||
                    line.startsWith('SEND|')
                ) {
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
    });

    socket.on('close', () => {
        DisconnectConnection(
            connection
        );
    });

    socket.on('error', () => {});
}

LoadIdentities();

const server = net.createServer(
    socket => {
        CreateConnection(socket);
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
            'Port: ' + PORT
        );

        console.log(
            'Protocol: RAW TCP'
        );

        console.log(
            'Identity Storage: SERVER'
        );

        console.log(
            'ID Format: RANDOM HEX ONLY'
        );

        console.log(
            '================================'
        );
    }
);

setInterval(() => {
    const now = Date.now();

    for (const connection of servers.values()) {
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
            now - connection.lastSeen > 30000
        ) {
            connection.socket.destroy();

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

    for (const connection of clients.values()) {
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
            now - connection.lastSeen > 30000
        ) {
            connection.socket.destroy();

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
}, 10000);
