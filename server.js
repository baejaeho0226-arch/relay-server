const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ADMIN-SECRET-KEY-1234';

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');

const ADMIN_AUTH_WINDOW_SECONDS = 60;
const ADMIN_SESSION_TIMEOUT = 10 * 60 * 1000;
const REQUEST_HISTORY_TIMEOUT = 10 * 60 * 1000;
const MAX_EVENT_LOG = 500;

const servers = new Map();
const clients = new Map();

const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map();

const requestHistory = new Map();
const events = [];

function RandomID() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function RandomLicenseKey() {
    return 'LICENSE-' +
        crypto.randomBytes(10).toString('hex').toUpperCase();
}

function RandomNonce() {
    return crypto.randomBytes(32).toString('hex').toUpperCase();
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

function NormalizeLicenseKey(key) {
    if (typeof key !== 'string') {
        return '';
    }

    return key.trim().toUpperCase();
}

function SanitizeMemo(memo) {
    if (typeof memo !== 'string') {
        return '';
    }

    return memo
        .replace(/\r/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\|/g, ' ')
        .trim();
}

function SafeIP(socket) {
    if (!socket) {
        return '';
    }

    return String(socket.remoteAddress || '');
}

function LogEvent(type, detail) {
    events.push({
        time: Date.now(),
        type,
        detail: String(detail || '')
    });

    while (events.length > MAX_EVENT_LOG) {
        events.shift();
    }
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

function ConstantTimeEqual(a, b) {
    if (
        typeof a !== 'string' ||
        typeof b !== 'string'
    ) {
        return false;
    }

    const aa = Buffer.from(a);
    const bb = Buffer.from(b);

    if (aa.length !== bb.length) {
        return false;
    }

    return crypto.timingSafeEqual(aa, bb);
}

function MakeAdminHmac(nonce, timestamp) {
    return crypto
        .createHmac(
            'sha256',
            ADMIN_SECRET
        )
        .update(
            nonce + '|' + timestamp,
            'utf8'
        )
        .digest('hex')
        .toUpperCase();
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

function SaveIdentities() {
    const data = {
        version: 8,
        servers: Object.fromEntries(serverIdentities),
        clients: Object.fromEntries(clientIdentities),
        licenses: Object.fromEntries(licenses)
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

        const usedIDs = new Set();

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

                if (usedIDs.has(id)) {
                    console.error(
                        'DUPLICATE SERVER ID IGNORED:',
                        id
                    );

                    continue;
                }

                serverIdentities.set(
                    key,
                    id
                );

                usedIDs.add(id);
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

                const key =
                    deviceKey.trim();

                const rawId =
                    typeof value.id === 'string'
                        ? value.id
                        : value.clientId;

                const id =
                    NormalizeID(rawId);

                const serverId =
                    NormalizeID(
                        value.serverId
                    );

                if (
                    !key ||
                    !id ||
                    !serverId
                ) {
                    continue;
                }

                if (usedIDs.has(id)) {
                    console.error(
                        'DUPLICATE CLIENT ID IGNORED:',
                        id
                    );

                    continue;
                }

                clientIdentities.set(
                    key,
                    {
                        id,
                        serverId,
                        createdAt:
                            Number(value.createdAt) || Date.now(),
                        lastSeenAt:
                            Number(value.lastSeenAt) || 0,
                        lastAuthAt:
                            Number(value.lastAuthAt) || 0,
                        lastIP:
                            String(value.lastIP || '')
                    }
                );

                usedIDs.add(id);
            }
        }

        if (
            data.licenses &&
            typeof data.licenses === 'object'
        ) {
            for (
                const [rawKey, value]
                of Object.entries(data.licenses)
            ) {
                if (
                    !value ||
                    typeof value !== 'object'
                ) {
                    continue;
                }

                const key =
                    NormalizeLicenseKey(
                        rawKey
                    );

                const expiresAt =
                    Number(value.expiresAt);

                if (
                    !key ||
                    !Number.isFinite(expiresAt) ||
                    expiresAt <= 0
                ) {
                    continue;
                }

                licenses.set(
                    key,
                    {
                        createdAt:
                            Number(value.createdAt) || Date.now(),

                        expiresAt,

                        boundClient:
                            NormalizeID(
                                value.boundClient || ''
                            ),

                        memo:
                            SanitizeMemo(
                                value.memo || ''
                            ),

                        boundAt:
                            Number(value.boundAt) || 0,

                        lastAuthAt:
                            Number(value.lastAuthAt) || 0,

                        lastSeenAt:
                            Number(value.lastSeenAt) || 0,

                        lastIP:
                            String(
                                value.lastIP || ''
                            ),

                        suspended:
                            Boolean(
                                value.suspended
                            )
                    }
                );
            }
        }

        SaveIdentities();

        console.log(
            'IDENTITIES LOADED: ' +
            serverIdentities.size +
            ' servers, ' +
            clientIdentities.size +
            ' clients, ' +
            licenses.size +
            ' licenses'
        );
    } catch (error) {
        console.error(
            'IDENTITY LOAD ERROR:',
            error.message
        );
    }
}

function GetOnlineServer(serverId) {
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

function GetOnlineClient(clientId) {
    const client =
        clients.get(clientId);

    if (!client) {
        return null;
    }

    if (
        !client.socket ||
        client.socket.destroyed
    ) {
        return null;
    }

    return client;
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

function GetSavedClientByID(clientId) {
    clientId =
        NormalizeID(clientId);

    if (!clientId) {
        return null;
    }

    for (
        const value
        of clientIdentities.values()
    ) {
        if (
            value &&
            value.id === clientId
        ) {
            return value;
        }
    }

    return null;
}

function FindAvailableServer() {
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

function RegisterServer(
    connection,
    deviceKey
) {
    deviceKey =
        deviceKey.trim();

    let serverId =
        serverIdentities.get(
            deviceKey
        );

    if (!serverId) {
        serverId =
            MakeUniqueID();

        serverIdentities.set(
            deviceKey,
            serverId
        );

        SaveIdentities();

        LogEvent(
            'SERVER_CREATE',
            serverId + ' -> ' + deviceKey
        );
    }

    const owner =
        FindServerDeviceByID(
            serverId
        );

    if (
        owner &&
        owner !== deviceKey
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_ID_CONFLICT'
        );

        LogEvent(
            'SERVER_CONFLICT',
            serverId
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

    connection.lastIP =
        SafeIP(
            connection.socket
        );

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
        'REGISTERED|' +
        serverId
    );

    LogEvent(
        'SERVER_ONLINE',
        serverId
    );

    for (
        const client
        of clients.values()
    ) {
        if (
            client.serverId !==
            serverId
        ) {
            continue;
        }

        connection.clients.add(
            client.clientId
        );

        NotifyClientLicenseState(
            client
        );
    }

    return true;
}

function HandleServerLine(
    connection,
    line
) {
    line =
        line.trim();

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

    const saved = {
        id: MakeUniqueID(),
        serverId,
        createdAt: Date.now(),
        lastSeenAt: 0,
        lastAuthAt: 0,
        lastIP: ''
    };

    clientIdentities.set(
        deviceKey,
        saved
    );

    SaveIdentities();

    LogEvent(
        'CLIENT_CREATE',
        saved.id +
        ' -> ' +
        deviceKey
    );

    return saved;
}

function AttachClient(
    connection,
    saved
) {
    const old =
        clients.get(
            saved.id
        );

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

    connection.licenseAuthorized =
        false;

    connection.licenseKey =
        null;

    connection.licenseExpiresAt =
        0;

    connection.lastSeen =
        Date.now();

    saved.lastSeenAt =
        connection.lastSeen;

    saved.lastIP =
        SafeIP(
            connection.socket
        );

    SaveIdentities();

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

    LogEvent(
        'CLIENT_ONLINE',
        saved.id
    );
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
        if (
            !GetOnlineServer(
                saved.serverId
            )
        ) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_OFFLINE'
            );

            return;
        }
    } else {
        const server =
            FindAvailableServer();

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
    }

    AttachClient(
        connection,
        saved
    );
}

function FindLicense(
    licenseKey
) {
    licenseKey =
        NormalizeLicenseKey(
            licenseKey
        );

    if (!licenseKey) {
        return null;
    }

    return licenses.get(
        licenseKey
    ) || null;
}

function GetLicenseStatus(
    license
) {
    if (!license) {
        return 'UNKNOWN';
    }

    if (license.suspended) {
        return 'SUSPENDED';
    }

    if (
        Date.now() >=
        license.expiresAt
    ) {
        return 'EXPIRED';
    }

    if (license.boundClient) {
        return 'BOUND';
    }

    return 'AVAILABLE';
}

function GetClientActiveLicense(
    clientId
) {
    clientId =
        NormalizeID(clientId);

    if (!clientId) {
        return null;
    }

    const now =
        Date.now();

    for (
        const [key, license]
        of licenses.entries()
    ) {
        if (
            !license ||
            !license.boundClient
        ) {
            continue;
        }

        if (
            license.boundClient !==
            clientId
        ) {
            continue;
        }

        if (
            license.suspended
        ) {
            continue;
        }

        if (
            now >=
            license.expiresAt
        ) {
            continue;
        }

        return {
            key,
            license
        };
    }

    return null;
}

function IsClientLicensed(
    clientId
) {
    return !!GetClientActiveLicense(
        clientId
    );
}

function NotifyClientLicenseState(
    connection
) {
    if (
        !connection ||
        !connection.clientId
    ) {
        return;
    }

    const active =
        GetClientActiveLicense(
            connection.clientId
        );

    if (active) {
        connection.licenseAuthorized =
            true;

        connection.licenseKey =
            active.key;

        connection.licenseExpiresAt =
            active.license.expiresAt;

        SendLine(
            connection.socket,
            'LICENSE_OK|' +
            active.key +
            '|' +
            active.license.expiresAt
        );

        NotifyServerAuthorized(
            connection.clientId,
            connection.serverId,
            active.license.expiresAt
        );

        return;
    }

    connection.licenseAuthorized =
        false;

    connection.licenseKey =
        null;

    connection.licenseExpiresAt =
        0;

    const license =
        GetBoundLicense(
            connection.clientId
        );

    if (
        license &&
        license.suspended
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|SUSPENDED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'SUSPENDED'
        );

        return;
    }

    if (
        license &&
        Date.now() >=
        license.expiresAt
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|EXPIRED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'EXPIRED'
        );

        return;
    }

    SendLine(
        connection.socket,
        'LICENSE_ERROR|LICENSE_REQUIRED'
    );

    NotifyServerUnauthorized(
        connection.clientId,
        'LICENSE_REQUIRED'
    );
}

function GetBoundLicense(
    clientId
) {
    clientId =
        NormalizeID(clientId);

    if (!clientId) {
        return null;
    }

    for (
        const license
        of licenses.values()
    ) {
        if (
            license &&
            license.boundClient ===
            clientId
        ) {
            return license;
        }
    }

    return null;
}

function NotifyServerAuthorized(
    clientId,
    serverId,
    expiresAt
) {
    const server =
        GetOnlineServer(
            serverId
        );

    if (!server) {
        return;
    }

    SendLine(
        server.socket,
        'CLIENT_AUTHORIZED|' +
        clientId +
        '|' +
        expiresAt
    );
}

function NotifyServerUnauthorized(
    clientId,
    reason
) {
    const saved =
        GetSavedClientByID(
            clientId
        );

    if (!saved) {
        return;
    }

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (!server) {
        return;
    }

    SendLine(
        server.socket,
        'CLIENT_UNAUTHORIZED|' +
        clientId +
        '|' +
        reason
    );
}

function AuthorizeClientConnection(
    connection,
    licenseKey
) {
    licenseKey =
        NormalizeLicenseKey(
            licenseKey
        );

    if (
        !connection.connected ||
        !connection.clientId
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|CLIENT_NOT_CONNECTED'
        );

        return;
    }

    if (!licenseKey) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|INVALID_KEY'
        );

        return;
    }

    const license =
        FindLicense(
            licenseKey
        );

    if (!license) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|INVALID_KEY'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'INVALID_KEY'
        );

        return;
    }

    if (license.suspended) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|SUSPENDED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'SUSPENDED'
        );

        return;
    }

    if (
        Date.now() >=
        license.expiresAt
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|EXPIRED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'EXPIRED'
        );

        return;
    }

    if (
        license.boundClient &&
        license.boundClient !==
        connection.clientId
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|BOUND_OTHER'
        );

        return;
    }

    if (!license.boundClient) {
        license.boundClient =
            connection.clientId;

        license.boundAt =
            Date.now();

        LogEvent(
            'LICENSE_BOUND',
            licenseKey +
            ' -> ' +
            connection.clientId
        );
    }

    license.lastAuthAt =
        Date.now();

    license.lastSeenAt =
        Date.now();

    license.lastIP =
        SafeIP(
            connection.socket
        );

    connection.licenseAuthorized =
        true;

    connection.licenseKey =
        licenseKey;

    connection.licenseExpiresAt =
        license.expiresAt;

    const saved =
        GetSavedClientByID(
            connection.clientId
        );

    if (saved) {
        saved.lastAuthAt =
            Date.now();

        saved.lastSeenAt =
            Date.now();

        saved.lastIP =
            SafeIP(
                connection.socket
            );
    }

    SaveIdentities();

    SendLine(
        connection.socket,
        'LICENSE_OK|' +
        licenseKey +
        '|' +
        license.expiresAt
    );

    NotifyServerAuthorized(
        connection.clientId,
        connection.serverId,
        license.expiresAt
    );

    LogEvent(
        'LICENSE_AUTH',
        licenseKey +
        ' -> ' +
        connection.clientId
    );
}

function HandleClientSend(
    connection,
    line
) {
    const parts =
        line.split('|');

    let requestId;
    let clientId;
    let number;

    if (parts.length === 4) {
        requestId =
            parts[1].trim();

        clientId =
            NormalizeID(
                parts[2].trim()
            );

        number =
            parts[3].trim();
    } else if (parts.length === 3) {
        requestId =
            crypto.randomBytes(8)
                .toString('hex')
                .toUpperCase();

        clientId =
            NormalizeID(
                parts[1].trim()
            );

        number =
            parts[2].trim();
    } else {
        SendLine(
            connection.socket,
            'ERROR|INVALID_SEND'
        );

        return;
    }

    if (
        !requestId ||
        requestId.length > 64
    ) {
        SendLine(
            connection.socket,
            'ERROR|REQUEST_ID_INVALID'
        );

        return;
    }

    if (!clientId) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_ID_INVALID'
        );

        return;
    }

    if (
        !/^-?\d+$/.test(number)
    ) {
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

    const requestKey =
        clientId +
        ':' +
        requestId;

    const previous =
        requestHistory.get(
            requestKey
        );

    if (previous) {
        SendLine(
            connection.socket,
            'ERROR|DUPLICATE_REQUEST'
        );

        return;
    }

    requestHistory.set(
        requestKey,
        Date.now()
    );

    const active =
        GetClientActiveLicense(
            clientId
        );

    if (!active) {
        connection.licenseAuthorized =
            false;

        connection.licenseKey =
            null;

        connection.licenseExpiresAt =
            0;

        NotifyServerUnauthorized(
            clientId,
            'LICENSE_REQUIRED'
        );

        SendLine(
            connection.socket,
            'ERROR|LICENSE_REQUIRED'
        );

        return;
    }

    connection.licenseAuthorized =
        true;

    connection.licenseKey =
        active.key;

    connection.licenseExpiresAt =
        active.license.expiresAt;

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
            requestId +
            '|' +
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
        'SENT|OK|' +
        requestId
    );

    LogEvent(
        'NUMBER_SEND',
        requestId +
        ' / ' +
        clientId +
        ' / ' +
        number
    );
}

function HandleClientLine(
    connection,
    line
) {
    line =
        line.trim();

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

    if (
        line.startsWith(
            'LICENSE_AUTH|'
        )
    ) {
        const parts =
            line.split('|');

        if (parts.length < 2) {
            SendLine(
                connection.socket,
                'LICENSE_ERROR|INVALID_KEY'
            );

            return;
        }

        const licenseKey =
            parts[1].trim();

        const requestedClientId =
            parts.length >= 3
                ? NormalizeID(
                    parts[2].trim()
                )
                : '';

        if (
            requestedClientId &&
            requestedClientId !==
            connection.clientId
        ) {
            SendLine(
                connection.socket,
                'LICENSE_ERROR|CLIENT_NOT_OWNER'
            );

            return;
        }

        AuthorizeClientConnection(
            connection,
            licenseKey
        );

        return;
    }

    if (line === 'PONG') {
        connection.lastSeen =
            Date.now();

        const saved =
            GetSavedClientByID(
                connection.clientId
            );

        if (saved) {
            saved.lastSeenAt =
                Date.now();

            saved.lastIP =
                SafeIP(
                    connection.socket
                );
        }

        return;
    }

    if (
        line.startsWith(
            'SEND|'
        )
    ) {
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

function CreateLicense(
    days,
    memo
) {
    const now =
        Date.now();

    const expiresAt =
        now +
        days *
        24 *
        60 *
        60 *
        1000;

    let key;

    do {
        key =
            RandomLicenseKey();
    } while (
        licenses.has(key)
    );

    licenses.set(
        key,
        {
            createdAt: now,
            expiresAt,
            boundClient: '',
            memo: SanitizeMemo(memo),
            boundAt: 0,
            lastAuthAt: 0,
            lastSeenAt: 0,
            lastIP: '',
            suspended: false
        }
    );

    SaveIdentities();

    LogEvent(
        'LICENSE_CREATE',
        key
    );

    return {
        key,
        expiresAt
    };
}

function ExtendLicense(
    license,
    days
) {
    const base =
        Math.max(
            Date.now(),
            license.expiresAt
        );

    license.expiresAt =
        base +
        days *
        24 *
        60 *
        60 *
        1000;
}

function HandleAdminAuth(
    connection,
    line
) {
    const parts =
        line.split('|');

    if (parts.length < 4) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FORMAT'
        );

        return false;
    }

    const nonce =
        parts[1];

    const timestampText =
        parts[2];

    const suppliedHmac =
        parts[3].trim().toUpperCase();

    const timestamp =
        Number(
            timestampText
        );

    if (
        !nonce ||
        !Number.isFinite(timestamp)
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FORMAT'
        );

        return false;
    }

    const now =
        Math.floor(
            Date.now() / 1000
        );

    if (
        Math.abs(
            now - timestamp
        ) > ADMIN_AUTH_WINDOW_SECONDS
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_EXPIRED'
        );

        return false;
    }

    const expected =
        MakeAdminHmac(
            nonce,
            timestampText
        );

    if (
        !ConstantTimeEqual(
            expected,
            suppliedHmac
        )
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FAILED'
        );

        LogEvent(
            'ADMIN_AUTH_FAILED',
            SafeIP(connection.socket)
        );

        return false;
    }

    connection.adminAuthenticated =
        true;

    connection.adminAuthenticatedAt =
        Date.now();

    connection.lastSeen =
        Date.now();

    SendLine(
        connection.socket,
        'ADMIN_OK'
    );

    LogEvent(
        'ADMIN_AUTH',
        SafeIP(connection.socket)
    );

    return true;
}

function HandleAdminLine(
    connection,
    line
) {
    line =
        line.trim();

    if (!line) {
        return;
    }

    if (line === 'ADMIN_HELLO') {
        const nonce =
            RandomNonce();

        connection.adminNonce =
            nonce;

        connection.adminNonceCreatedAt =
            Date.now();

        SendLine(
            connection.socket,
            'CHALLENGE|' +
            nonce
        );

        return;
    }

    if (
        line.startsWith(
            'ADMIN_AUTH|'
        )
    ) {
        HandleAdminAuth(
            connection,
            line
        );

        return;
    }

    if (
        !connection.adminAuthenticated
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|NOT_AUTHORIZED'
        );

        return;
    }

    if (
        Date.now() -
        connection.adminAuthenticatedAt >
        ADMIN_SESSION_TIMEOUT
    ) {
        connection.adminAuthenticated =
            false;

        SendLine(
            connection.socket,
            'ADMIN_ERROR|SESSION_EXPIRED'
        );

        return;
    }

    connection.lastSeen =
        Date.now();

    if (
        line.startsWith(
            'LIC_CREATE|'
        )
    ) {
        const parts =
            line.split('|');

        const days =
            Number(parts[1]);

        const memo =
            parts.length >= 3
                ? parts.slice(2).join('|')
                : '';

        if (
            !Number.isInteger(days) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_DAYS'
            );

            return;
        }

        const created =
            CreateLicense(
                days,
                memo
            );

        SendLine(
            connection.socket,
            'LIC_OK|' +
            created.key +
            '|' +
            created.expiresAt
        );

        return;
    }

    if (line === 'LIC_LIST') {
        for (
            const [key, license]
            of licenses.entries()
        ) {
            SendLine(
                connection.socket,
                'LIC_ITEM|' +
                key +
                '|' +
                GetLicenseStatus(license) +
                '|' +
                license.expiresAt +
                '|' +
                (license.boundClient || '') +
                '|' +
                SanitizeMemo(
                    license.memo || ''
                ) +
                '|' +
                license.createdAt +
                '|' +
                license.boundAt +
                '|' +
                license.lastAuthAt +
                '|' +
                license.lastSeenAt +
                '|' +
                (license.lastIP || '')
            );
        }

        SendLine(
            connection.socket,
            'END_LIST'
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_EXTEND|'
        )
    ) {
        const parts =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        const days =
            Number(parts[2]);

        if (
            !key ||
            !Number.isInteger(days) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_REQUEST'
            );

            return;
        }

        const license =
            licenses.get(key);

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        ExtendLicense(
            license,
            days
        );

        SaveIdentities();

        if (license.boundClient) {
            const client =
                GetOnlineClient(
                    license.boundClient
                );

            if (client) {
                NotifyClientLicenseState(
                    client
                );
            }
        }

        SendLine(
            connection.socket,
            'LIC_EXTEND_OK|' +
            key +
            '|' +
            license.expiresAt
        );

        LogEvent(
            'LICENSE_EXTEND',
            key
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_DELETE|'
        )
    ) {
        const parts =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        if (!key) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_KEY'
            );

            return;
        }

        const license =
            licenses.get(key);

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        const boundClient =
            license.boundClient;

        licenses.delete(key);

        SaveIdentities();

        if (boundClient) {
            const client =
                GetOnlineClient(
                    boundClient
                );

            if (client) {
                client.licenseAuthorized =
                    false;

                client.licenseKey =
                    null;

                client.licenseExpiresAt =
                    0;

                SendLine(
                    client.socket,
                    'LICENSE_ERROR|REVOKED'
                );
            }

            NotifyServerUnauthorized(
                boundClient,
                'REVOKED'
            );
        }

        SendLine(
            connection.socket,
            'LIC_DELETE_OK|' +
            key
        );

        LogEvent(
            'LICENSE_DELETE',
            key
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_UNBIND|'
        )
    ) {
        const parts =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        if (!key) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_KEY'
            );

            return;
        }

        const license =
            licenses.get(key);

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        const oldClient =
            license.boundClient;

        license.boundClient =
            '';

        license.boundAt =
            0;

        license.lastAuthAt =
            0;

        license.lastSeenAt =
            0;

        license.lastIP =
            '';

        SaveIdentities();

        if (oldClient) {
            const client =
                GetOnlineClient(
                    oldClient
                );

            if (client) {
                client.licenseAuthorized =
                    false;

                client.licenseKey =
                    null;

                client.licenseExpiresAt =
                    0;

                SendLine(
                    client.socket,
                    'LICENSE_ERROR|UNBOUND'
                );
            }

            NotifyServerUnauthorized(
                oldClient,
                'UNBOUND'
            );
        }

        SendLine(
            connection.socket,
            'LIC_UNBIND_OK|' +
            key
        );

        LogEvent(
            'LICENSE_UNBIND',
            key +
            ' / ' +
            oldClient
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_SUSPEND|'
        )
    ) {
        const parts =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        if (!key) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_KEY'
            );

            return;
        }

        const license =
            licenses.get(key);

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        license.suspended =
            true;

        SaveIdentities();

        if (license.boundClient) {
            const client =
                GetOnlineClient(
                    license.boundClient
                );

            if (client) {
                client.licenseAuthorized =
                    false;

                client.licenseKey =
                    null;

                client.licenseExpiresAt =
                    0;

                SendLine(
                    client.socket,
                    'LICENSE_ERROR|SUSPENDED'
                );
            }

            NotifyServerUnauthorized(
                license.boundClient,
                'SUSPENDED'
            );
        }

        SendLine(
            connection.socket,
            'LIC_SUSPEND_OK|' +
            key
        );

        LogEvent(
            'LICENSE_SUSPEND',
            key
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_RESUME|'
        )
    ) {
        const parts =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        if (!key) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_KEY'
            );

            return;
        }

        const license =
            licenses.get(key);

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        if (
            Date.now() >=
            license.expiresAt
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|EXPIRED'
            );

            return;
        }

        license.suspended =
            false;

        SaveIdentities();

        if (license.boundClient) {
            const client =
                GetOnlineClient(
                    license.boundClient
                );

            if (client) {
                NotifyClientLicenseState(
                    client
                );
            }
        }

        SendLine(
            connection.socket,
            'LIC_RESUME_OK|' +
            key
        );

        LogEvent(
            'LICENSE_RESUME',
            key
        );

        return;
    }

    if (line === 'DASHBOARD') {
        let onlineServers = 0;
        let onlineClients = 0;
        let activeLicenses = 0;
        let boundLicenses = 0;
        let expiredLicenses = 0;
        let suspendedLicenses = 0;

        for (
            const server
            of servers.values()
        ) {
            if (
                server.registered &&
                server.socket &&
                !server.socket.destroyed
            ) {
                onlineServers++;
            }
        }

        for (
            const client
            of clients.values()
        ) {
            if (
                client.socket &&
                !client.socket.destroyed
            ) {
                onlineClients++;
            }
        }

        for (
            const license
            of licenses.values()
        ) {
            const status =
                GetLicenseStatus(
                    license
                );

            if (status === 'SUSPENDED') {
                suspendedLicenses++;
            } else if (status === 'EXPIRED') {
                expiredLicenses++;
            } else if (status === 'BOUND') {
                boundLicenses++;
            } else {
                activeLicenses++;
            }
        }

        SendLine(
            connection.socket,
            'DASH|' +
            'SERVERS=' + servers.size +
            '|ONLINE_SERVERS=' + onlineServers +
            '|CLIENTS=' + clientIdentities.size +
            '|ONLINE_CLIENTS=' + onlineClients +
            '|LICENSES=' + licenses.size +
            '|AVAILABLE=' + activeLicenses +
            '|BOUND=' + boundLicenses +
            '|EXPIRED=' + expiredLicenses +
            '|SUSPENDED=' + suspendedLicenses
        );

        const recent =
            events.slice(
                Math.max(
                    0,
                    events.length - 20
                )
            );

        for (const event of recent) {
            SendLine(
                connection.socket,
                'EVENT|' +
                event.time +
                '|' +
                event.type +
                '|' +
                event.detail
            );
        }

        SendLine(
            connection.socket,
            'END_DASHBOARD'
        );

        return;
    }

    SendLine(
        connection.socket,
        'ADMIN_ERROR|UNKNOWN_COMMAND'
    );
}

function ValidateClientLicenseConnection(
    connection
) {
    if (
        !connection.connected ||
        !connection.clientId
    ) {
        return;
    }

    const active =
        GetClientActiveLicense(
            connection.clientId
        );

    if (!active) {
        if (
            connection.licenseAuthorized
        ) {
            connection.licenseAuthorized =
                false;

            connection.licenseKey =
                null;

            connection.licenseExpiresAt =
                0;

            SendLine(
                connection.socket,
                'LICENSE_ERROR|EXPIRED'
            );

            NotifyServerUnauthorized(
                connection.clientId,
                'EXPIRED'
            );
        }

        return;
    }

    if (
        !connection.licenseAuthorized ||
        connection.licenseKey !==
        active.key
    ) {
        NotifyClientLicenseState(
            connection
        );
    }
}

function CleanupRequestHistory() {
    const cutoff =
        Date.now() -
        REQUEST_HISTORY_TIMEOUT;

    for (
        const [
            key,
            timestamp
        ]
        of requestHistory.entries()
    ) {
        if (timestamp < cutoff) {
            requestHistory.delete(key);
        }
    }
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

        LogEvent(
            'SERVER_OFFLINE',
            connection.serverId || ''
        );

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

        LogEvent(
            'CLIENT_OFFLINE',
            connection.clientId || ''
        );

        return;
    }

    if (
        connection.type === 'admin'
    ) {
        LogEvent(
            'ADMIN_OFFLINE',
            SafeIP(
                connection.socket
            )
        );
    }
}

function CreateConnection(socket) {
    const connection = {
        socket,
        type: null,
        registered: false,
        connected: false,
        adminAuthenticated: false,
        adminNonce: '',
        adminNonceCreatedAt: 0,
        adminAuthenticatedAt: 0,

        identityKey: null,
        serverId: null,
        clientId: null,

        licenseAuthorized: false,
        licenseKey: null,
        licenseExpiresAt: 0,

        lastSeen: Date.now(),
        lastIP: SafeIP(socket),

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
                        connection.type =
                            'server';
                    } else if (
                        line === 'CONNECT' ||
                        line.startsWith('CONNECT|') ||
                        line.startsWith('LICENSE_AUTH|') ||
                        line.startsWith('SEND|')
                    ) {
                        connection.type =
                            'client';
                    } else if (
                        line === 'ADMIN_HELLO' ||
                        line.startsWith('ADMIN_AUTH|')
                    ) {
                        connection.type =
                            'admin';
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
                } else if (
                    connection.type ===
                    'client'
                ) {
                    HandleClientLine(
                        connection,
                        line
                    );
                } else {
                    HandleAdminLine(
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
            'Identity Storage: SERVER'
        );

        console.log(
            'License Storage: SERVER'
        );

        console.log(
            'ID Format: 16 HEX'
        );

        console.log(
            'Request ID: ENABLED'
        );

        console.log(
            'Admin Auth: HMAC-SHA256'
        );

        console.log(
            'License UNBIND: ENABLED'
        );

        console.log(
            'License SUSPEND: ENABLED'
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

        CleanupRequestHistory();

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

            ValidateClientLicenseConnection(
                connection
            );

            SendLine(
                connection.socket,
                'PING'
            );
        }

        for (
            const connection
            of clients.values()
        ) {
            const saved =
                GetSavedClientByID(
                    connection.clientId
                );

            if (saved) {
                saved.lastSeenAt =
                    connection.lastSeen;

                saved.lastIP =
                    connection.lastIP;
            }
        }

        for (
            const [key, license]
            of licenses.entries()
        ) {
            if (
                license.boundClient
            ) {
                const client =
                    GetOnlineClient(
                        license.boundClient
                    );

                if (client) {
                    license.lastSeenAt =
                        client.lastSeen;

                    license.lastIP =
                        client.lastIP;
                }
            }

            if (
                license.suspended
            ) {
                continue;
            }

            if (
                Date.now() >=
                license.expiresAt
            ) {
                const client =
                    GetOnlineClient(
                        license.boundClient
                    );

                if (client) {
                    if (
                        client.licenseAuthorized
                    ) {
                        client.licenseAuthorized =
                            false;

                        client.licenseKey =
                            null;

                        client.licenseExpiresAt =
                            0;

                        SendLine(
                            client.socket,
                            'LICENSE_ERROR|EXPIRED'
                        );
                    }

                    NotifyServerUnauthorized(
                        license.boundClient,
                        'EXPIRED'
                    );
                }
            }
        }
    },
    10000
);

setInterval(
    () => {
        SaveIdentities();
    },
    30000
);
