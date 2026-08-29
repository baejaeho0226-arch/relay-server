const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ADMIN-SECRET-KEY-1234';

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');

const servers = new Map();
const clients = new Map();

const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map();

function RandomID() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function RandomLicenseKey() {
    return 'LICENSE-' +
        crypto.randomBytes(10).toString('hex').toUpperCase();
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
        version: 6,
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

                const key = deviceKey.trim();

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
                        serverId
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

                if (!key) {
                    continue;
                }

                const expiresAt =
                    Number(value.expiresAt);

                const createdAt =
                    Number(value.createdAt);

                if (
                    !Number.isFinite(expiresAt) ||
                    expiresAt <= 0
                ) {
                    continue;
                }

                licenses.set(
                    key,
                    {
                        createdAt:
                            Number.isFinite(createdAt) &&
                            createdAt > 0
                                ? createdAt
                                : Date.now(),
                        expiresAt,
                        boundClient:
                            NormalizeID(
                                value.boundClient || ''
                            ),
                        memo:
                            SanitizeMemo(
                                value.memo || ''
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

        console.log(
            'NEW SERVER ID: ' +
            serverId +
            ' -> ' +
            deviceKey
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

        return false;
    }

    const old =
        servers.get(
            serverId
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
        'REGISTERED|' +
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

        if (
            IsClientLicensed(
                client.clientId
            )
        ) {
            NotifyServerAuthorized(
                client.clientId,
                serverId
            );
        }
    }

    console.log(
        'SERVER ONLINE: ' +
        serverId
    );

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
        serverId
    };

    clientIdentities.set(
        deviceKey,
        saved
    );

    SaveIdentities();

    console.log(
        'NEW CLIENT ID: ' +
        saved.id +
        ' -> ' +
        deviceKey +
        ' -> SERVER ' +
        serverId
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
    }

    AttachClient(
        connection,
        saved
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
        (a, b) =>
            a.clients.size -
            b.clients.size
    );

    return list[0];
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

function NotifyServerAuthorized(
    clientId,
    serverId
) {
    const server =
        GetOnlineServer(
            serverId
        );

    if (!server) {
        return;
    }

    const active =
        GetClientActiveLicense(
            clientId
        );

    if (!active) {
        return;
    }

    SendLine(
        server.socket,
        'CLIENT_AUTHORIZED|' +
        clientId +
        '|' +
        active.license.expiresAt
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
        connection.licenseAuthorized =
            false;

        connection.licenseKey =
            null;

        connection.licenseExpiresAt =
            0;

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

    if (
        Date.now() >=
        license.expiresAt
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

        return;
    }

    if (
        license.boundClient &&
        license.boundClient !==
        connection.clientId
    ) {
        connection.licenseAuthorized =
            false;

        connection.licenseKey =
            null;

        connection.licenseExpiresAt =
            0;

        SendLine(
            connection.socket,
            'LICENSE_ERROR|BOUND_OTHER'
        );

        return;
    }

    if (!license.boundClient) {
        license.boundClient =
            connection.clientId;

        SaveIdentities();

        console.log(
            'LICENSE BOUND: ' +
            licenseKey +
            ' -> CLIENT ' +
            connection.clientId
        );
    }

    connection.licenseAuthorized =
        true;

    connection.licenseKey =
        licenseKey;

    connection.licenseExpiresAt =
        license.expiresAt;

    SendLine(
        connection.socket,
        'LICENSE_OK|' +
        licenseKey +
        '|' +
        license.expiresAt
    );

    NotifyServerAuthorized(
        connection.clientId,
        connection.serverId
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
        connection.clientId !==
        clientId
    ) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_OWNER'
        );

        return;
    }

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

    if (
        !connection.licenseAuthorized ||
        connection.licenseKey !== active.key
    ) {
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
            clientId,
            connection.serverId
        );
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
        line.startsWith('LICENSE_AUTH|')
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

        return;
    }

    if (
        line.startsWith('SEND|')
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
            memo: SanitizeMemo(memo)
        }
    );

    SaveIdentities();

    return {
        key,
        expiresAt
    };
}

function HandleAdminAuth(
    connection,
    line
) {
    const parts =
        line.split('|');

    const secret =
        parts.length >= 2
            ? parts.slice(1).join('|')
            : '';

    if (
        secret !== ADMIN_SECRET
    ) {
        connection.adminAuthenticated =
            false;

        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FAILED'
        );

        return;
    }

    connection.adminAuthenticated =
        true;

    connection.lastSeen =
        Date.now();

    SendLine(
        connection.socket,
        'ADMIN_OK'
    );
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

    if (
        line.startsWith('ADMIN_AUTH|')
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

    connection.lastSeen =
        Date.now();

    if (
        line.startsWith('LIC_CREATE|')
    ) {
        const parts =
            line.split('|');

        const days =
            Number(
                parts[1]
            );

        const memo =
            parts.length >= 3
                ? parts.slice(2).join('|')
                : '';

        if (
            !Number.isInteger(days) ||
            days <= 0
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_DAYS'
            );

            return;
        }

        if (days > 36500) {
            SendLine(
                connection.socket,
                'LIC_ERROR|DAYS_TOO_LARGE'
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
                )
            );
        }

        SendLine(
            connection.socket,
            'END_LIST'
        );

        return;
    }

    if (
        line.startsWith('LIC_EXTEND|')
    ) {
        const parts =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        const days =
            Number(
                parts[2]
            );

        if (!key) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_KEY'
            );

            return;
        }

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

        const license =
            licenses.get(key);

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

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

        SaveIdentities();

        if (
            license.boundClient
        ) {
            const client =
                clients.get(
                    license.boundClient
                );

            if (
                client &&
                client.licenseKey === key
            ) {
                client.licenseAuthorized =
                    true;

                client.licenseExpiresAt =
                    license.expiresAt;

                SendLine(
                    client.socket,
                    'LICENSE_OK|' +
                    key +
                    '|' +
                    license.expiresAt
                );

                NotifyServerAuthorized(
                    client.clientId,
                    client.serverId
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

        return;
    }

    if (
        line.startsWith('LIC_DELETE|')
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
                clients.get(
                    boundClient
                );

            if (
                client &&
                client.licenseKey === key
            ) {
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

                NotifyServerUnauthorized(
                    boundClient,
                    'REVOKED'
                );
            }
        }

        SendLine(
            connection.socket,
            'LIC_DELETE_OK|' +
            key
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
        connection.licenseKey !== active.key
    ) {
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
            connection.serverId
        );
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
        adminAuthenticated: false,
        identityKey: null,
        serverId: null,
        clientId: null,
        licenseAuthorized: false,
        licenseKey: null,
        licenseExpiresAt: 0,
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
            'License Binding: CLIENT'
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

            ValidateClientLicenseConnection(
                connection
            );

            SendLine(
                connection.socket,
                'PING'
            );
        }
    },
    10000
);
