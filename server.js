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

function NormalizeID(id) {
    if (typeof id !== 'string') {
        return '';
    }

    id = id.trim().toUpperCase();

    if (id.startsWith('SERVER-')) {
        id = id.substring(7);
    }

    if (id.startsWith('CLIENT-')) {
        id = id.substring(7);
    }

    if (!/^[0-9A-F]{16}$/.test(id)) {
        return '';
    }

    return id;
}

function GetAllUsedIDs() {
    const used = new Set();

    for (const id of serverIdentities.values()) {
        if (id) {
            used.add(id);
        }
    }

    for (const value of clientIdentities.values()) {
        if (value && value.id) {
            used.add(value.id);
        }
    }

    return used;
}

function MakeUniqueID() {
    const used = GetAllUsedIDs();

    let id;

    do {
        id = RandomID();
    } while (used.has(id));

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

function SaveIdentities() {
    const data = {
        version: 4,
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

        fs.renameSync(
            temp,
            IDENTITY_FILE
        );
    } catch (error) {
        console.error(
            'IDENTITY SAVE ERROR:',
            error.message
        );

        try {
            if (fs.existsSync(temp)) {
                fs.unlinkSync(temp);
            }
        } catch (_) {}
    }
}

function LoadIdentities() {
    try {
        if (!fs.existsSync(IDENTITY_FILE)) {
            return;
        }

        const data = JSON.parse(
            fs.readFileSync(
                IDENTITY_FILE,
                'utf8'
            )
        );

        const used = new Set();

        if (
            data.servers &&
            typeof data.servers === 'object'
        ) {
            for (
                const [deviceKey, rawId]
                of Object.entries(data.servers)
            ) {
                if (
                    typeof deviceKey !== 'string' ||
                    typeof rawId !== 'string'
                ) {
                    continue;
                }

                const key = deviceKey.trim();
                const id = NormalizeID(rawId);

                if (!key || !id) {
                    continue;
                }

                if (used.has(id)) {
                    console.error(
                        'DUPLICATE SERVER ID:',
                        id
                    );

                    continue;
                }

                serverIdentities.set(
                    key,
                    id
                );

                used.add(id);
            }
        }

        if (
            data.clients &&
            typeof data.clients === 'object'
        ) {
            for (
                const [deviceKey, value]
                of Object.entries(data.clients)
            ) {
                if (
                    !value ||
                    typeof value !== 'object'
                ) {
                    continue;
                }

                const key = deviceKey.trim();

                const rawId =
                    typeof value.id === 'string'
                        ? value.id
                        : value.clientId;

                const id = NormalizeID(rawId);

                if (
                    !key ||
                    !id ||
                    typeof value.serverId !== 'string'
                ) {
                    continue;
                }

                if (used.has(id)) {
                    console.error(
                        'DUPLICATE CLIENT ID:',
                        id
                    );

                    continue;
                }

                const serverId =
                    NormalizeID(
                        value.serverId
                    );

                if (!serverId) {
                    continue;
                }

                clientIdentities.set(
                    key,
                    {
                        id,
                        serverId
                    }
                );

                used.add(id);
            }
        }

        SaveIdentities();

        console.log(
            'IDENTITIES LOADED: ' +
            serverIdentities.size +
            ' servers, ' +
            clientIdentities.size +
            ' clients'
        );
    } catch (error) {
        console.error(
            'IDENTITY LOAD ERROR:',
            error.message
        );
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

    if (
        !server.socket ||
        server.socket.destroyed
    ) {
        return null;
    }

    return server;
}

function FindServerDeviceByID(serverId) {
    for (
        const [deviceKey, id]
        of serverIdentities.entries()
    ) {
        if (id === serverId) {
            return deviceKey;
        }
    }

    return null;
}

function FindClientDeviceByID(clientId) {
    for (
        const [deviceKey, value]
        of clientIdentities.entries()
    ) {
        if (
            value &&
            value.id === clientId
        ) {
            return deviceKey;
        }
    }

    return null;
}

function RegisterServer(connection, deviceKey) {
    deviceKey = deviceKey.trim();

    let serverId =
        serverIdentities.get(deviceKey);

    if (!serverId) {
        serverId = MakeUniqueID();

        serverIdentities.set(
            deviceKey,
            serverId
        );

        SaveIdentities();

        console.log(
            'NEW SERVER ID: ' +
            serverId +
            ' -> ' +
            deviceKey
        );
    }

    const owner =
        FindServerDeviceByID(serverId);

    if (
        owner &&
        owner !== deviceKey
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_ID_CONFLICT'
        );

        return false;
    }

    const old =
        servers.get(serverId);

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

    connection.identityKey =
        deviceKey;

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

    SendLine(
        connection.socket,
        'REGISTERED|' + serverId
    );

    console.log(
        'SERVER ONLINE: ' +
        serverId
    );

    return true;
}

function HandleServerLine(connection, line) {
    line = line.trim();

    if (!line) {
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

        const parts =
            line.split('|');

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
        connection.lastSeen =
            Date.now();

        return;
    }

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function GetSavedClientByID(clientId) {
    clientId =
        NormalizeID(clientId);

    if (!clientId) {
        return null;
    }

    for (
        const saved
        of clientIdentities.values()
    ) {
        if (
            saved &&
            saved.id === clientId
        ) {
            return saved;
        }
    }

    return null;
}

function AttachClient(connection, saved) {
    const old =
        clients.get(saved.id);

    if (
        old &&
        old !== connection &&
        old.socket &&
        !old.socket.destroyed
    ) {
        const oldServer =
            GetOnlineServer(
                old.serverId
            );

        if (oldServer) {
            oldServer.clients.delete(
                saved.id
            );
        }

        SendLine(
            old.socket,
            'ERROR|REPLACED'
        );

        old.socket.destroy();
    }

    connection.clientId =
        saved.id;

    connection.serverId =
        saved.serverId;

    connection.connected =
        true;

    connection.lastSeen =
        Date.now();

    clients.set(
        saved.id,
        connection
    );

    const server =
        GetOnlineServer(
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

function CreateNewClientIdentity(
    deviceKey,
    serverId
) {
    const existing =
        clientIdentities.get(
            deviceKey
        );

    if (existing) {
        return existing;
    }

    const clientId =
        MakeUniqueID();

    const saved = {
        id: clientId,
        serverId
    };

    clientIdentities.set(
        deviceKey,
        saved
    );

    SaveIdentities();

    console.log(
        'NEW CLIENT ID: ' +
        clientId +
        ' -> ' +
        deviceKey +
        ' -> SERVER ' +
        serverId
    );

    return saved;
}

function HandleClientConnect(
    connection,
    deviceKey
) {
    let saved =
        clientIdentities.get(
            deviceKey
        );

    if (saved) {
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

        AttachClient(
            connection,
            saved
        );

        return;
    }

    const server =
        GetAvailableServer();

    if (!server) {
        SendLine(
            connection.socket,
            'ERROR|NO_SERVER'
        );

        return;
    }

    saved =
        CreateNewClientIdentity(
            deviceKey,
            server.serverId
        );

    AttachClient(
        connection,
        saved
    );
}

function HandleClientSend(
    connection,
    line
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
        NormalizeID(
            parts[1].trim()
        );

    const number =
        parts[2].trim();

    if (!clientId) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_ID_INVALID'
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

    if (
        connection.clientId !== clientId
    ) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_OWNER'
        );

        return;
    }

    const saved =
        GetSavedClientByID(
            clientId
        );

    if (!saved) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_FOUND'
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
}

function HandleClientLine(
    connection,
    line
) {
    line = line.trim();

    if (!line) {
        return;
    }

    if (
        line === 'CONNECT' ||
        line.startsWith('CONNECT|')
    ) {
        const parts =
            line.split('|');

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

        HandleClientConnect(
            connection,
            deviceKey
        );

        return;
    }

    if (line === 'PONG') {
        connection.lastSeen =
            Date.now();

        return;
    }

    if (line.startsWith('SEND|')) {
        HandleClientSend(
            connection,
            line
        );

        return;
    }

    SendLine(
        connection.socket,
        'ERROR|UNKNOWN_COMMAND'
    );
}

function DisconnectConnection(
    connection
) {
    if (
        connection.type === 'server'
    ) {
        if (
            connection.serverId &&
            servers.get(
                connection.serverId
            ) === connection
        ) {
            servers.delete(
                connection.serverId
            );
        }

        return;
    }

    if (
        connection.type === 'client'
    ) {
        if (
            connection.clientId &&
            clients.get(
                connection.clientId
            ) === connection
        ) {
            clients.delete(
                connection.clientId
            );
        }

        if (
            connection.clientId &&
            connection.serverId
        ) {
            const server =
                GetOnlineServer(
                    connection.serverId
                );

            if (server) {
                server.clients.delete(
                    connection.clientId
                );
            }
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

    socket.on(
        'data',
        data => {
            connection.buffer +=
                data.toString('utf8');

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
                        line === 'REGISTER' ||
                        line.startsWith('REGISTER|')
                    ) {
                        connection.type =
                            'server';
                    } else if (
                        line === 'CONNECT' ||
                        line.startsWith('CONNECT|') ||
                        line.startsWith('SEND|')
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
        () => {}
    );
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
        (a, b) => {
            return (
                a.clients.size -
                b.clients.size
            );
        }
    );

    return list[0];
}

LoadIdentities();

const server =
    net.createServer(
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
            'ID Format: 16 HEX'
        );

        console.log(
            'Device Identity: SERVER'
        );

        console.log(
            'Client/Server Binding: FIXED'
        );

        console.log(
            '================================'
        );
    }
);

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

        for (
            const connection
            of clients.values()
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
    },
    10000
);
