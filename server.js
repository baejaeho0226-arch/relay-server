const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const SERVER_ID_PREFIX = 'SERVER-';
const CLIENT_ID_PREFIX = 'CLIENT-';

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');

/*
 * 실제 사용 시에는 환경변수 LICENSES를 권장.
 *
 * 예:
 * LICENSES=AAAA-BBBB,CCCC-DDDD
 *
 * 테스트 목적으로 환경변수가 없으면
 * 아래 TEST 라이선스를 사용한다.
 */
const LICENSES = new Set(
    String(
        process.env.LICENSES ||
        'TEST-1234,TEST-5678'
    )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

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

function MakeUniqueID(prefix, identityMap) {
    let id;

    do {
        id = RandomID(prefix);
    } while (
        [...identityMap.values()].some(value => {
            if (typeof value === 'string') {
                return value === id;
            }

            return value &&
                value.clientId === id;
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

function IsValidLicense(license) {
    if (!license) {
        return false;
    }

    return LICENSES.has(license);
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

        if (
            data.servers &&
            typeof data.servers === 'object'
        ) {
            for (
                const [key, id]
                of Object.entries(data.servers)
            ) {
                if (
                    typeof key === 'string' &&
                    typeof id === 'string'
                ) {
                    serverIdentities.set(key, id);
                }
            }
        }

        if (
            data.clients &&
            typeof data.clients === 'object'
        ) {
            for (
                const [key, value]
                of Object.entries(data.clients)
            ) {
                if (!value || typeof value !== 'object') {
                    continue;
                }

                if (
                    typeof value.clientId !== 'string' ||
                    typeof value.serverId !== 'string'
                ) {
                    continue;
                }

                clientIdentities.set(key, {
                    clientId: value.clientId,
                    serverId: value.serverId
                });
            }
        }
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
        servers: Object.fromEntries(
            serverIdentities
        ),
        clients: Object.fromEntries(
            clientIdentities
        )
    };

    const temp =
        IDENTITY_FILE + '.tmp';

    try {
        fs.writeFileSync(
            temp,
            JSON.stringify(
                data,
                null,
                2
            ),
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

function IsServerAlreadyAssigned(serverId) {
    for (
        const saved
        of clientIdentities.values()
    ) {
        if (
            saved &&
            saved.serverId === serverId
        ) {
            return true;
        }
    }

    return false;
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

        if (
            IsServerAlreadyAssigned(
                server.serverId
            )
        ) {
            continue;
        }

        list.push(server);
    }

    if (list.length === 0) {
        return null;
    }

    const index =
        crypto.randomInt(
            0,
            list.length
        );

    return list[index];
}

function RegisterServer(
    connection,
    identityKey
) {
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
        identityKey;

    connection.serverId =
        serverId;

    connection.registered = true;
    connection.lastSeen =
        Date.now();

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

function HandleServerLine(
    connection,
    line
) {
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

        const parts =
            line.split('|');

        const identityKey =
            parts.length >= 2
                ? parts[1].trim()
                : '';

        if (!identityKey) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_KEY_REQUIRED'
            );

            return;
        }

        RegisterServer(
            connection,
            identityKey
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
    for (
        const saved
        of clientIdentities.values()
    ) {
        if (
            saved.clientId === clientId
        ) {
            return saved;
        }
    }

    return null;
}

function AttachClient(
    connection,
    saved,
    license
) {
    const old =
        clients.get(
            saved.clientId
        );

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

    connection.clientId =
        saved.clientId;

    connection.serverId =
        saved.serverId;

    connection.license =
        license;

    connection.authenticated =
        true;

    connection.connected =
        true;

    connection.lastSeen =
        Date.now();

    clients.set(
        saved.clientId,
        connection
    );

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (server) {
        server.clients.add(
            saved.clientId
        );
    }

    SendLine(
        connection.socket,
        'AUTH|OK|' +
        saved.clientId +
        '|' +
        saved.serverId
    );
}

function HandleClientAuth(
    connection,
    parts
) {
    if (connection.authenticated) {
        SendLine(
            connection.socket,
            'AUTH|FAIL|ALREADY_AUTHENTICATED'
        );

        return;
    }

    if (parts.length < 3) {
        SendLine(
            connection.socket,
            'AUTH|FAIL|INVALID_REQUEST'
        );

        return;
    }

    const identityKey =
        parts[1].trim();

    const license =
        parts.slice(2)
            .join('|')
            .trim();

    if (!identityKey) {
        SendLine(
            connection.socket,
            'AUTH|FAIL|CLIENT_KEY_REQUIRED'
        );

        return;
    }

    if (!license) {
        SendLine(
            connection.socket,
            'AUTH|FAIL|LICENSE_REQUIRED'
        );

        return;
    }

    if (!IsValidLicense(license)) {
        SendLine(
            connection.socket,
            'AUTH|FAIL|INVALID_LICENSE'
        );

        return;
    }

    let saved =
        clientIdentities.get(
            identityKey
        );

    if (saved) {
        if (
            !GetOnlineServer(
                saved.serverId
            )
        ) {
            SendLine(
                connection.socket,
                'AUTH|FAIL|SERVER_OFFLINE'
            );

            return;
        }
    } else {
        const server =
            GetAvailableServer();

        if (!server) {
            SendLine(
                connection.socket,
                'AUTH|FAIL|NO_SERVER'
            );

            return;
        }

        saved = {
            clientId:
                MakeUniqueID(
                    CLIENT_ID_PREFIX,
                    clientIdentities
                ),

            serverId:
                server.serverId
        };

        clientIdentities.set(
            identityKey,
            saved
        );

        SaveIdentities();
    }

    AttachClient(
        connection,
        saved,
        license
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

    if (
        line === 'AUTH' ||
        line.startsWith('AUTH|')
    ) {
        const parts =
            line.split('|');

        HandleClientAuth(
            connection,
            parts
        );

        return;
    }

    if (line === 'PONG') {
        connection.lastSeen =
            Date.now();

        return;
    }

    if (line.startsWith('SEND|')) {
        if (!connection.authenticated) {
            SendLine(
                connection.socket,
                'ERROR|NOT_AUTHENTICATED'
            );

            return;
        }

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

        if (
            connection.clientId !==
            clientId
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
    if (connection.type === 'server') {
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

    if (connection.type === 'client') {
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
    }
}

function CreateConnection(socket) {
    const connection = {
        socket,

        type: null,

        registered: false,
        connected: false,
        authenticated: false,

        identityKey: null,

        clientId: null,
        serverId: null,

        license: null,

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
                    connection.buffer
                        .indexOf('\n');

                if (pos < 0) {
                    break;
                }

                let line =
                    connection.buffer
                        .substring(
                            0,
                            pos
                        );

                connection.buffer =
                    connection.buffer
                        .substring(
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
                        line.startsWith(
                            'REGISTER|'
                        )
                    ) {
                        connection.type =
                            'server';
                    } else if (
                        line === 'AUTH' ||
                        line.startsWith(
                            'AUTH|'
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
        () => {}
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
            'Port: ' + PORT
        );

        console.log(
            'Protocol: RAW TCP'
        );

        console.log(
            'License Auth: ENABLED'
        );

        console.log(
            'Identity Storage: SERVER'
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
