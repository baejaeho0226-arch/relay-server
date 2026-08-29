const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const SERVER_ID_PREFIX = 'SERVER-';
const CLIENT_ID_PREFIX = 'CLIENT-';
const LICENSE_PREFIX = 'LIC-';

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');

const servers = new Map();
const clients = new Map();

const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map();

function RandomID(prefix) {
    return prefix + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function RandomLicense() {
    const a = crypto.randomBytes(4).toString('hex').toUpperCase();
    const b = crypto.randomBytes(4).toString('hex').toUpperCase();
    const c = crypto.randomBytes(4).toString('hex').toUpperCase();
    const d = crypto.randomBytes(4).toString('hex').toUpperCase();

    return `${LICENSE_PREFIX}${a}-${b}-${c}-${d}`;
}

function MakeUniqueID(prefix, identityMap) {
    let id;

    do {
        id = RandomID(prefix);
    } while (
        [...identityMap.values()].some(value => {
            if (typeof value === 'string')
                return value === id;

            return value &&
                (
                    value.clientId === id ||
                    value.serverId === id
                );
        })
    );

    return id;
}

function MakeUniqueLicense() {
    let license;

    do {
        license = RandomLicense();
    } while (licenses.has(license));

    return license;
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed)
        return false;

    try {
        socket.write(text + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function LoadIdentities() {
    try {
        if (!fs.existsSync(IDENTITY_FILE))
            return;

        const data = JSON.parse(
            fs.readFileSync(IDENTITY_FILE, 'utf8')
        );

        if (data.servers && typeof data.servers === 'object') {
            for (const [key, id] of Object.entries(data.servers)) {
                if (
                    typeof key === 'string' &&
                    typeof id === 'string'
                ) {
                    serverIdentities.set(key, id);
                }
            }
        }

        if (data.clients && typeof data.clients === 'object') {
            for (const [key, value] of Object.entries(data.clients)) {
                if (!value || typeof value !== 'object')
                    continue;

                if (typeof value.clientId !== 'string')
                    continue;

                if (typeof value.serverId !== 'string')
                    continue;

                clientIdentities.set(key, {
                    clientId: value.clientId,
                    serverId: value.serverId
                });
            }
        }

        if (data.licenses && typeof data.licenses === 'object') {
            for (const [key, value] of Object.entries(data.licenses)) {
                if (!value || typeof value !== 'object')
                    continue;

                if (typeof key !== 'string')
                    continue;

                licenses.set(key, {
                    expiresAt:
                        typeof value.expiresAt === 'number'
                            ? value.expiresAt
                            : 0,

                    status:
                        value.status === 'banned'
                            ? 'banned'
                            : 'active',

                    clientId:
                        typeof value.clientId === 'string'
                            ? value.clientId
                            : null,

                    activatedAt:
                        typeof value.activatedAt === 'number'
                            ? value.activatedAt
                            : null
                });
            }
        }

        console.log(
            'Loaded:',
            serverIdentities.size,
            'servers,',
            clientIdentities.size,
            'clients,',
            licenses.size,
            'licenses'
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
        version: 2,

        servers:
            Object.fromEntries(serverIdentities),

        clients:
            Object.fromEntries(clientIdentities),

        licenses:
            Object.fromEntries(licenses)
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
            if (fs.existsSync(temp))
                fs.unlinkSync(temp);
        } catch (_) {}
    }
}

function NormalizeLicense(value) {
    return String(value || '')
        .trim()
        .toUpperCase();
}

function GetLicenseStatus(licenseKey) {
    const key = NormalizeLicense(licenseKey);

    const license = licenses.get(key);

    if (!license)
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };

    if (license.status === 'banned')
        return {
            ok: false,
            reason: 'BANNED'
        };

    if (
        license.expiresAt > 0 &&
        Date.now() >= license.expiresAt
    ) {
        return {
            ok: false,
            reason: 'EXPIRED'
        };
    }

    return {
        ok: true,
        license
    };
}

function FormatDate(timestamp) {
    if (!timestamp)
        return 'NEVER';

    return new Date(timestamp).toISOString();
}

function CreateLicense(days) {
    const licenseKey = MakeUniqueLicense();

    const expiresAt =
        days <= 0
            ? 0
            : Date.now() + (days * 24 * 60 * 60 * 1000);

    licenses.set(licenseKey, {
        expiresAt,
        status: 'active',
        clientId: null,
        activatedAt: null
    });

    SaveIdentities();

    console.log('');
    console.log('================================');
    console.log('LICENSE CREATED');
    console.log('LICENSE : ' + licenseKey);
    console.log('DAYS    : ' + (days <= 0 ? 'UNLIMITED' : days));
    console.log('EXPIRES : ' + FormatDate(expiresAt));
    console.log('================================');
    console.log('');

    return licenseKey;
}

function CreateCustomLicense(key, days) {
    const licenseKey = NormalizeLicense(key);

    if (!licenseKey) {
        console.log('LICENSE CREATE: key required');
        return;
    }

    if (licenses.has(licenseKey)) {
        console.log('LICENSE ALREADY EXISTS');
        return;
    }

    const expiresAt =
        days <= 0
            ? 0
            : Date.now() + (days * 24 * 60 * 60 * 1000);

    licenses.set(licenseKey, {
        expiresAt,
        status: 'active',
        clientId: null,
        activatedAt: null
    });

    SaveIdentities();

    console.log('');
    console.log('================================');
    console.log('LICENSE CREATED');
    console.log('LICENSE : ' + licenseKey);
    console.log('DAYS    : ' + (days <= 0 ? 'UNLIMITED' : days));
    console.log('EXPIRES : ' + FormatDate(expiresAt));
    console.log('================================');
    console.log('');
}

function BanLicense(key) {
    const licenseKey = NormalizeLicense(key);
    const license = licenses.get(licenseKey);

    if (!license) {
        console.log('LICENSE NOT FOUND');
        return;
    }

    license.status = 'banned';

    SaveIdentities();

    console.log(
        'LICENSE BANNED:',
        licenseKey
    );
}

function UnbanLicense(key) {
    const licenseKey = NormalizeLicense(key);
    const license = licenses.get(licenseKey);

    if (!license) {
        console.log('LICENSE NOT FOUND');
        return;
    }

    license.status = 'active';

    SaveIdentities();

    console.log(
        'LICENSE UNBANNED:',
        licenseKey
    );
}

function RevokeLicense(key) {
    const licenseKey = NormalizeLicense(key);

    if (!licenses.has(licenseKey)) {
        console.log('LICENSE NOT FOUND');
        return;
    }

    licenses.delete(licenseKey);

    SaveIdentities();

    console.log(
        'LICENSE REVOKED:',
        licenseKey
    );
}

function ListLicenses() {
    console.log('');
    console.log('========== LICENSES ==========');

    if (licenses.size === 0) {
        console.log('No licenses');
        console.log('==============================');
        return;
    }

    for (const [key, license] of licenses) {
        console.log('');
        console.log('LICENSE : ' + key);
        console.log('STATUS  : ' + license.status);
        console.log('EXPIRES : ' + FormatDate(license.expiresAt));
        console.log('CLIENT  : ' + (license.clientId || 'NONE'));
    }

    console.log('');
    console.log('==============================');
}

function ClearLicenseBinding(licenseKey, clientId) {
    const license = licenses.get(licenseKey);

    if (!license)
        return;

    if (license.clientId === clientId) {
        license.clientId = null;
        license.activatedAt = null;
        SaveIdentities();
    }
}

function GetOnlineServer(serverId) {
    const server = servers.get(serverId);

    if (!server)
        return null;

    if (!server.registered)
        return null;

    if (!server.socket || server.socket.destroyed)
        return null;

    return server;
}

function IsServerAlreadyAssigned(serverId) {
    for (const saved of clientIdentities.values()) {
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

    for (const server of servers.values()) {
        if (!server.registered)
            continue;

        if (!server.socket || server.socket.destroyed)
            continue;

        if (IsServerAlreadyAssigned(server.serverId))
            continue;

        list.push(server);
    }

    if (list.length === 0)
        return null;

    const index =
        crypto.randomInt(0, list.length);

    return list[index];
}

function RegisterServer(connection, identityKey) {
    let serverId =
        serverIdentities.get(identityKey);

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

    connection.identityKey = identityKey;
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

    if (line === '')
        return;

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
    for (const saved of clientIdentities.values()) {
        if (
            saved &&
            saved.clientId === clientId
        ) {
            return saved;
        }
    }

    return null;
}

function AttachClient(connection, saved) {
    const old =
        clients.get(saved.clientId);

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

    connection.connected = true;
    connection.lastSeen = Date.now();

    clients.set(
        saved.clientId,
        connection
    );

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (server)
        server.clients.add(
            saved.clientId
        );

    SendLine(
        connection.socket,
        'CONNECTED|' +
        saved.clientId +
        '|' +
        saved.serverId
    );
}

function HandleLicense(connection, licenseKey) {
    const key =
        NormalizeLicense(licenseKey);

    if (!key) {
        SendLine(
            connection.socket,
            'LICENSE|ERROR|EMPTY'
        );
        return;
    }

    const result =
        GetLicenseStatus(key);

    if (!result.ok) {
        SendLine(
            connection.socket,
            'LICENSE|ERROR|' +
            result.reason
        );
        return;
    }

    const license =
        result.license;

    /*
     * 이미 다른 CLIENT에 묶여 있다면
     * 동일 라이선스의 무분별한 공유를 막는다.
     */
    if (
        license.clientId &&
        clients.has(license.clientId)
    ) {
        SendLine(
            connection.socket,
            'LICENSE|ERROR|IN_USE'
        );
        return;
    }

    const server =
        license.clientId
            ? GetSavedClientByID(
                license.clientId
            )
            : null;

    let savedClient = null;

    /*
     * 기존 라이선스가 이전 CLIENT를 가지고 있으면
     * 해당 CLIENT-ID를 유지한다.
     */
    if (license.clientId) {
        savedClient =
            GetSavedClientByID(
                license.clientId
            );

        if (
            savedClient &&
            !GetOnlineServer(
                savedClient.serverId
            )
        ) {
            SendLine(
                connection.socket,
                'LICENSE|ERROR|SERVER_OFFLINE'
            );
            return;
        }
    }

    /*
     * 처음 사용하는 라이선스라면
     * 아직 배정되지 않은 SERVER를 배정한다.
     */
    if (!savedClient) {
        const relayServer =
            GetAvailableServer();

        if (!relayServer) {
            SendLine(
                connection.socket,
                'LICENSE|ERROR|NO_SERVER'
            );
            return;
        }

        savedClient = {
            clientId:
                MakeUniqueID(
                    CLIENT_ID_PREFIX,
                    clientIdentities
                ),

            serverId:
                relayServer.serverId
        };

        /*
         * 라이선스와 CLIENT-ID를 연결한다.
         */
        license.clientId =
            savedClient.clientId;

        license.activatedAt =
            Date.now();

        /*
         * 기존 client identity에도 등록한다.
         * 여기서는 라이선스 자체를 identity key로 사용한다.
         */
        clientIdentities.set(
            key,
            savedClient
        );

        SaveIdentities();
    }

    /*
     * 현재 연결에 인증 상태를 부여한다.
     */
    connection.licenseKey = key;
    connection.licensed = true;

    AttachClient(
        connection,
        savedClient
    );

    SendLine(
        connection.socket,
        'LICENSE|OK|' +
        savedClient.clientId +
        '|' +
        savedClient.serverId +
        '|' +
        license.expiresAt
    );
}

function HandleClientLine(connection, line) {
    line = line.trim();

    if (line === '')
        return;

    /*
     * PING/PONG은 라이선스 인증 전에도
     * 처리할 수 있도록 한다.
     */
    if (line === 'PONG') {
        connection.lastSeen =
            Date.now();

        return;
    }

    /*
     * LICENSE
     */
    if (
        line === 'LICENSE' ||
        line.startsWith('LICENSE|')
    ) {
        const parts =
            line.split('|');

        const licenseKey =
            parts.length >= 2
                ? parts[1].trim()
                : '';

        HandleLicense(
            connection,
            licenseKey
        );

        return;
    }

    /*
     * 라이선스 인증 전에는
     * CONNECT / SEND를 막는다.
     */
    if (!connection.licensed) {
        SendLine(
            connection.socket,
            'ERROR|LICENSE_REQUIRED'
        );

        return;
    }

    /*
     * 기존 CONNECT도 호환시킨다.
     * 하지만 이제 LICENSE 인증이 먼저 필요하다.
     */
    if (
        line === 'CONNECT' ||
        line.startsWith('CONNECT|')
    ) {
        SendLine(
            connection.socket,
            'CONNECTED|' +
            connection.clientId +
            '|' +
            connection.serverId
        );

        return;
    }

    /*
     * SEND
     */
    if (line.startsWith('SEND|')) {
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

function DisconnectConnection(connection) {
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
            connection.licenseKey
        ) {
            /*
             * 연결이 끊겼다고 라이선스를 삭제하지 않는다.
             * 다음 접속에서 같은 CLIENT-ID를 재사용한다.
             */
        }
    }
}

function CreateConnection(socket) {
    const connection = {
        socket,

        type: null,

        registered: false,
        connected: false,
        licensed: false,

        identityKey: null,

        licenseKey: null,

        serverId: null,
        clientId: null,

        lastSeen: Date.now(),

        clients: new Set(),

        buffer: ''
    };

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    socket.on('data', data => {
        connection.buffer +=
            data.toString('utf8');

        while (true) {
            const pos =
                connection.buffer.indexOf(
                    '\n'
                );

            if (pos < 0)
                break;

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
                    line.startsWith(
                        'REGISTER|'
                    )
                ) {
                    connection.type =
                        'server';
                }
                else if (
                    line === 'LICENSE' ||
                    line.startsWith(
                        'LICENSE|'
                    ) ||
                    line === 'CONNECT' ||
                    line.startsWith(
                        'CONNECT|'
                    ) ||
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
    });

    socket.on('close', () => {
        DisconnectConnection(
            connection
        );
    });

    socket.on('error', () => {});
}

LoadIdentities();

const server =
    net.createServer(socket => {
        CreateConnection(socket);
    });

server.on('error', error => {
    console.error(
        'SERVER ERROR:',
        error.message
    );
});

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
            '       LICENSE ENABLED'
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
            '================================'
        );

        console.log(
            'Commands:'
        );

        console.log(
            'LICENSE CREATE <days>'
        );

        console.log(
            'LICENSE CREATE <key> <days>'
        );

        console.log(
            'LICENSE LIST'
        );

        console.log(
            'LICENSE BAN <key>'
        );

        console.log(
            'LICENSE UNBAN <key>'
        );

        console.log(
            'LICENSE REVOKE <key>'
        );

        console.log(
            '================================'
        );
    }
);

/*
 * Console license manager
 */
process.stdin.setEncoding('utf8');

process.stdin.on('data', data => {
    const line =
        data.trim();

    if (!line)
        return;

    const parts =
        line.split(/\s+/);

    if (
        parts[0].toUpperCase() !==
        'LICENSE'
    ) {
        console.log(
            'Unknown command'
        );
        return;
    }

    const command =
        (parts[1] || '')
            .toUpperCase();

    if (command === 'CREATE') {
        /*
         * LICENSE CREATE 30
         */
        if (parts.length === 3) {
            const days =
                Number(parts[2]);

            if (
                !Number.isInteger(days) ||
                days < 0
            ) {
                console.log(
                    'Days must be 0 or greater'
                );
                return;
            }

            CreateLicense(days);
            return;
        }

        /*
         * LICENSE CREATE MYKEY 30
         */
        if (parts.length === 4) {
            const key =
                parts[2];

            const days =
                Number(parts[3]);

            if (
                !Number.isInteger(days) ||
                days < 0
            ) {
                console.log(
                    'Days must be 0 or greater'
                );
                return;
            }

            CreateCustomLicense(
                key,
                days
            );

            return;
        }

        console.log(
            'Usage: LICENSE CREATE <days>'
        );

        console.log(
            '   or: LICENSE CREATE <key> <days>'
        );

        return;
    }

    if (command === 'LIST') {
        ListLicenses();
        return;
    }

    if (command === 'BAN') {
        BanLicense(parts[2]);
        return;
    }

    if (command === 'UNBAN') {
        UnbanLicense(parts[2]);
        return;
    }

    if (command === 'REVOKE') {
        RevokeLicense(parts[2]);
        return;
    }

    console.log('Unknown LICENSE command');
});

setInterval(() => {
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
}, 10000);
