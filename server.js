const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const ADMIN_SECRET =
    process.env.ADMIN_SECRET ||
    'ADMIN-SECRET-KEY-1234';

const IDENTITY_FILE =
    path.join(
        __dirname,
        'relay-identities.json'
    );

const BACKUP_DIR =
    path.join(
        __dirname,
        'backups'
    );

const ADMIN_AUTH_WINDOW_SECONDS = 60;

const ADMIN_SESSION_TIMEOUT =
    10 * 60 * 1000;

const REQUEST_HISTORY_TIMEOUT =
    10 * 60 * 1000;

const MAX_EVENT_LOG = 2000;

const AUTO_BACKUP_INTERVAL =
    6 * 60 * 60 * 1000;

const BACKUP_RETENTION = 30;

const RATE_LIMIT_WINDOW =
    1000;

const RATE_LIMIT_MAX =
    Number(
        process.env.RATE_LIMIT_MAX || 30
    );

const MAX_SEARCH_RESULTS = 500;

let serviceEnabled = true;
let maintenanceMode = false;

const servers = new Map();
const clients = new Map();

const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map();

const requestHistory = new Map();
const rateLimits = new Map();

const events = [];

function Now() {
    return Date.now();
}

function RandomID() {
    return crypto
        .randomBytes(8)
        .toString('hex')
        .toUpperCase();
}

function RandomNonce() {
    return crypto
        .randomBytes(32)
        .toString('hex')
        .toUpperCase();
}

function RandomLicenseKey() {
    return (
        'LICENSE-' +
        crypto
            .randomBytes(10)
            .toString('hex')
            .toUpperCase()
    );
}

function NormalizeID(id) {
    if (typeof id !== 'string') {
        return '';
    }

    id =
        id
            .trim()
            .toUpperCase();

    if (
        id.startsWith('SERVER-')
    ) {
        id =
            id.substring(7);
    }

    if (
        id.startsWith('CLIENT-')
    ) {
        id =
            id.substring(7);
    }

    if (
        !/^[0-9A-F]{16}$/.test(id)
    ) {
        return '';
    }

    return id;
}

function NormalizeLicenseKey(key) {
    if (typeof key !== 'string') {
        return '';
    }

    return key
        .trim()
        .toUpperCase();
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

    return String(
        socket.remoteAddress || ''
    );
}

function LogEvent(type, detail) {
    events.push({
        time: Now(),
        type,
        detail: String(detail || '')
    });

    while (
        events.length >
        MAX_EVENT_LOG
    ) {
        events.shift();
    }
}

function SendLine(socket, text) {
    if (
        !socket ||
        socket.destroyed
    ) {
        return false;
    }

    try {
        socket.write(
            text + '\n'
        );

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

    const aa =
        Buffer.from(a);

    const bb =
        Buffer.from(b);

    if (
        aa.length !==
        bb.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        aa,
        bb
    );
}

function MakeAdminHmac(
    nonce,
    timestamp
) {
    return crypto
        .createHmac(
            'sha256',
            ADMIN_SECRET
        )
        .update(
            nonce +
            '|' +
            timestamp,
            'utf8'
        )
        .digest('hex')
        .toUpperCase();
}

function GetAllUsedIDs() {
    const used =
        new Set();

    for (
        const id
        of serverIdentities.values()
    ) {
        if (id) {
            used.add(id);
        }
    }

    for (
        const value
        of clientIdentities.values()
    ) {
        if (
            value &&
            value.id
        ) {
            used.add(value.id);
        }
    }

    return used;
}

function MakeUniqueID() {
    const used =
        GetAllUsedIDs();

    let id;

    do {
        id =
            RandomID();
    } while (
        used.has(id)
    );

    return id;
}

function EnsureBackupDirectory() {
    try {
        fs.mkdirSync(
            BACKUP_DIR,
            {
                recursive: true
            }
        );
    } catch (error) {
        console.error(
            'BACKUP DIRECTORY ERROR:',
            error.message
        );
    }
}

function BuildDatabaseObject() {
    return {
        version: 20,

        serviceEnabled,

        maintenanceMode,

        servers:
            Object.fromEntries(
                serverIdentities
            ),

        clients:
            Object.fromEntries(
                clientIdentities
            ),

        licenses:
            Object.fromEntries(
                licenses
            )
    };
}

function SaveIdentities() {
    const data =
        BuildDatabaseObject();

    const temp =
        IDENTITY_FILE +
        '.tmp';

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
            if (
                fs.existsSync(temp)
            ) {
                fs.unlinkSync(temp);
            }
        } catch (_) {}
    }
}

function SaveBackup(
    reason
) {
    EnsureBackupDirectory();

    const stamp =
        new Date(
            Now()
        )
            .toISOString()
            .replace(
                /[:.]/g,
                '-'
            );

    const fileName =
        'relay-' +
        stamp +
        '-' +
        String(
            reason || 'backup'
        )
            .replace(
                /[^A-Za-z0-9_-]/g,
                '_'
            ) +
        '.json';

    const filePath =
        path.join(
            BACKUP_DIR,
            fileName
        );

    try {
        fs.writeFileSync(
            filePath,
            JSON.stringify(
                BuildDatabaseObject(),
                null,
                2
            ),
            'utf8'
        );

        LogEvent(
            'BACKUP_CREATE',
            fileName
        );

        return filePath;
    } catch (error) {
        console.error(
            'BACKUP SAVE ERROR:',
            error.message
        );

        return '';
    }
}

function CleanupBackups() {
    EnsureBackupDirectory();

    try {
        const files =
            fs.readdirSync(
                BACKUP_DIR
            )
                .filter(
                    file =>
                        file.endsWith('.json')
                )
                .map(
                    file => ({
                        file,
                        time:
                            fs.statSync(
                                path.join(
                                    BACKUP_DIR,
                                    file
                                )
                            ).mtimeMs
                    })
                )
                .sort(
                    (a, b) =>
                        b.time -
                        a.time
                );

        for (
            let i = BACKUP_RETENTION;
            i < files.length;
            i++
        ) {
            try {
                fs.unlinkSync(
                    path.join(
                        BACKUP_DIR,
                        files[i].file
                    )
                );
            } catch (_) {}
        }
    } catch (error) {
        console.error(
            'BACKUP CLEANUP ERROR:',
            error.message
        );
    }
}

function CreateAutoBackup() {
    const file =
        SaveBackup(
            'auto'
        );

    CleanupBackups();

    if (file) {
        console.log(
            'AUTO BACKUP:',
            file
        );
    }
}

function RestoreBackupFile(
    fileName
) {
    EnsureBackupDirectory();

    const safeName =
        path.basename(
            fileName
        );

    const filePath =
        path.join(
            BACKUP_DIR,
            safeName
        );

    if (
        !fs.existsSync(
            filePath
        )
    ) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    try {
        const data =
            JSON.parse(
                fs.readFileSync(
                    filePath,
                    'utf8'
                )
            );

        if (
            !data ||
            typeof data !== 'object'
        ) {
            return {
                ok: false,
                reason: 'INVALID_DATA'
            };
        }

        const preRestoreBackup =
            SaveBackup(
                'pre_restore'
            );

        serverIdentities.clear();
        clientIdentities.clear();
        licenses.clear();

        if (
            data.servers &&
            typeof data.servers ===
            'object'
        ) {
            for (
                const [
                    key,
                    value
                ]
                of Object.entries(
                    data.servers
                )
            ) {
                const id =
                    NormalizeID(
                        value
                    );

                if (
                    key &&
                    id
                ) {
                    serverIdentities.set(
                        key,
                        id
                    );
                }
            }
        }

        if (
            data.clients &&
            typeof data.clients ===
            'object'
        ) {
            for (
                const [
                    key,
                    value
                ]
                of Object.entries(
                    data.clients
                )
            ) {
                if (
                    !value ||
                    typeof value !==
                    'object'
                ) {
                    continue;
                }

                const id =
                    NormalizeID(
                        value.id ||
                        value.clientId
                    );

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

                clientIdentities.set(
                    key,
                    {
                        id,
                        serverId,
                        createdAt:
                            Number(
                                value.createdAt
                            ) || Now(),
                        lastSeenAt:
                            Number(
                                value.lastSeenAt
                            ) || 0,
                        lastAuthAt:
                            Number(
                                value.lastAuthAt
                            ) || 0,
                        lastIP:
                            String(
                                value.lastIP ||
                                ''
                            ),
                        authCount:
                            Number(
                                value.authCount
                            ) || 0,
                        sendCount:
                            Number(
                                value.sendCount
                            ) || 0
                    }
                );
            }
        }

        if (
            data.licenses &&
            typeof data.licenses ===
            'object'
        ) {
            for (
                const [
                    rawKey,
                    value
                ]
                of Object.entries(
                    data.licenses
                )
            ) {
                if (
                    !value ||
                    typeof value !==
                    'object'
                ) {
                    continue;
                }

                const key =
                    NormalizeLicenseKey(
                        rawKey
                    );

                const expiresAt =
                    Number(
                        value.expiresAt
                    );

                if (
                    !key ||
                    !Number.isFinite(
                        expiresAt
                    )
                ) {
                    continue;
                }

                licenses.set(
                    key,
                    {
                        createdAt:
                            Number(
                                value.createdAt
                            ) || Now(),

                        expiresAt,

                        boundClient:
                            NormalizeID(
                                value.boundClient ||
                                ''
                            ),

                        boundAt:
                            Number(
                                value.boundAt
                            ) || 0,

                        lastAuthAt:
                            Number(
                                value.lastAuthAt
                            ) || 0,

                        lastSeenAt:
                            Number(
                                value.lastSeenAt
                            ) || 0,

                        lastIP:
                            String(
                                value.lastIP ||
                                ''
                            ),

                        authCount:
                            Number(
                                value.authCount
                            ) || 0,

                        sendCount:
                            Number(
                                value.sendCount
                            ) || 0,

                        suspended:
                            Boolean(
                                value.suspended
                            ),

                        memo:
                            SanitizeMemo(
                                value.memo ||
                                ''
                            )
                    }
                );
            }
        }

        if (
            typeof data.serviceEnabled ===
            'boolean'
        ) {
            serviceEnabled =
                data.serviceEnabled;
        }

        if (
            typeof data.maintenanceMode ===
            'boolean'
        ) {
            maintenanceMode =
                data.maintenanceMode;
        }

        SaveIdentities();

        LogEvent(
            'BACKUP_RESTORE',
            safeName
        );

        return {
            ok: true,
            reason: 'OK',
            preRestoreBackup:
                path.basename(
                    preRestoreBackup
                )
        };
    } catch (error) {
        console.error(
            'BACKUP RESTORE ERROR:',
            error.message
        );

        return {
            ok: false,
            reason: 'RESTORE_FAILED'
        };
    }
}

function LoadIdentities() {
    try {
        if (
            !fs.existsSync(
                IDENTITY_FILE
            )
        ) {
            EnsureBackupDirectory();
            return;
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    IDENTITY_FILE,
                    'utf8'
                )
            );

        if (
            typeof data.serviceEnabled ===
            'boolean'
        ) {
            serviceEnabled =
                data.serviceEnabled;
        }

        if (
            typeof data.maintenanceMode ===
            'boolean'
        ) {
            maintenanceMode =
                data.maintenanceMode;
        }

        const usedIDs =
            new Set();

        if (
            data.servers &&
            typeof data.servers ===
            'object'
        ) {
            for (
                const [
                    deviceKey,
                    rawId
                ]
                of Object.entries(
                    data.servers
                )
            ) {
                const key =
                    String(
                        deviceKey
                    ).trim();

                const id =
                    NormalizeID(
                        rawId
                    );

                if (
                    !key ||
                    !id
                ) {
                    continue;
                }

                if (
                    usedIDs.has(id)
                ) {
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
            typeof data.clients ===
            'object'
        ) {
            for (
                const [
                    deviceKey,
                    value
                ]
                of Object.entries(
                    data.clients
                )
            ) {
                if (
                    !value ||
                    typeof value !==
                    'object'
                ) {
                    continue;
                }

                const id =
                    NormalizeID(
                        value.id ||
                        value.clientId
                    );

                const serverId =
                    NormalizeID(
                        value.serverId
                    );

                if (
                    !deviceKey ||
                    !id ||
                    !serverId
                ) {
                    continue;
                }

                if (
                    usedIDs.has(id)
                ) {
                    continue;
                }

                clientIdentities.set(
                    deviceKey,
                    {
                        id,
                        serverId,
                        createdAt:
                            Number(
                                value.createdAt
                            ) || Now(),
                        lastSeenAt:
                            Number(
                                value.lastSeenAt
                            ) || 0,
                        lastAuthAt:
                            Number(
                                value.lastAuthAt
                            ) || 0,
                        lastIP:
                            String(
                                value.lastIP ||
                                ''
                            ),
                        authCount:
                            Number(
                                value.authCount
                            ) || 0,
                        sendCount:
                            Number(
                                value.sendCount
                            ) || 0
                    }
                );

                usedIDs.add(id);
            }
        }

        if (
            data.licenses &&
            typeof data.licenses ===
            'object'
        ) {
            for (
                const [
                    rawKey,
                    value
                ]
                of Object.entries(
                    data.licenses
                )
            ) {
                if (
                    !value ||
                    typeof value !==
                    'object'
                ) {
                    continue;
                }

                const key =
                    NormalizeLicenseKey(
                        rawKey
                    );

                const expiresAt =
                    Number(
                        value.expiresAt
                    );

                if (
                    !key ||
                    !Number.isFinite(
                        expiresAt
                    ) ||
                    expiresAt <= 0
                ) {
                    continue;
                }

                licenses.set(
                    key,
                    {
                        createdAt:
                            Number(
                                value.createdAt
                            ) || Now(),

                        expiresAt,

                        boundClient:
                            NormalizeID(
                                value.boundClient ||
                                ''
                            ),

                        boundAt:
                            Number(
                                value.boundAt
                            ) || 0,

                        lastAuthAt:
                            Number(
                                value.lastAuthAt
                            ) || 0,

                        lastSeenAt:
                            Number(
                                value.lastSeenAt
                            ) || 0,

                        lastIP:
                            String(
                                value.lastIP ||
                                ''
                            ),

                        authCount:
                            Number(
                                value.authCount
                            ) || 0,

                        sendCount:
                            Number(
                                value.sendCount
                            ) || 0,

                        suspended:
                            Boolean(
                                value.suspended
                            ),

                        memo:
                            SanitizeMemo(
                                value.memo ||
                                ''
                            )
                    }
                );
            }
        }

        EnsureBackupDirectory();
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

        EnsureBackupDirectory();
    }
}

function GetOnlineServer(
    serverId
) {
    const server =
        servers.get(
            serverId
        );

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

function GetOnlineClient(
    clientId
) {
    const client =
        clients.get(
            clientId
        );

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

function GetSavedClientByID(
    clientId
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return null;
    }

    for (
        const value
        of clientIdentities.values()
    ) {
        if (
            value &&
            value.id ===
            clientId
        ) {
            return value;
        }
    }

    return null;
}

function GetBoundLicense(
    clientId
) {
    clientId =
        NormalizeID(
            clientId
        );

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

function GetLicenseStatus(
    license
) {
    if (!license) {
        return 'UNKNOWN';
    }

    if (
        license.suspended
    ) {
        return 'SUSPENDED';
    }

    if (
        Now() >=
        license.expiresAt
    ) {
        return 'EXPIRED';
    }

    if (
        license.boundClient
    ) {
        return 'BOUND';
    }

    return 'AVAILABLE';
}

function GetClientActiveLicense(
    clientId
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return null;
    }

    if (
        !serviceEnabled ||
        maintenanceMode
    ) {
        return null;
    }

    for (
        const [
            key,
            license
        ]
        of licenses.entries()
    ) {
        if (
            !license ||
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
            Now() >=
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

function FindAvailableServer() {
    const list = [];

    for (
        const server
        of servers.values()
    ) {
        if (
            !server.registered
        ) {
            continue;
        }

        if (
            !server.socket ||
            server.socket.destroyed
        ) {
            continue;
        }

        list.push(
            server
        );
    }

    if (
        list.length === 0
    ) {
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
            serverId
        );
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
        Now();

    connection.lastIP =
        SafeIP(
            connection.socket
        );

    if (
        !connection.clients
    ) {
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

        NotifyServerCurrentLicenseState(
            client,
            connection
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
        if (
            connection.registered
        ) {
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

    if (
        line === 'PONG'
    ) {
        connection.lastSeen =
            Now();

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
        id:
            MakeUniqueID(),

        serverId,

        createdAt:
            Now(),

        lastSeenAt: 0,

        lastAuthAt: 0,

        lastIP: '',

        authCount: 0,

        sendCount: 0
    };

    clientIdentities.set(
        deviceKey,
        saved
    );

    SaveIdentities();

    LogEvent(
        'CLIENT_CREATE',
        saved.id
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
        Now();

    clients.set(
        saved.id,
        connection
    );

    saved.lastSeenAt =
        Now();

    saved.lastIP =
        SafeIP(
            connection.socket
        );

    SaveIdentities();

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
    if (!serviceEnabled) {
        SendLine(
            connection.socket,
            'SERVICE_ERROR|DISABLED'
        );

        return;
    }

    if (maintenanceMode) {
        SendLine(
            connection.socket,
            'SERVICE_ERROR|MAINTENANCE'
        );

        return;
    }

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

function NotifyServerCurrentLicenseState(
    client,
    server
) {
    if (
        !client ||
        !client.clientId ||
        !server
    ) {
        return;
    }

    if (
        !serviceEnabled
    ) {
        SendLine(
            server.socket,
            'CLIENT_UNAUTHORIZED|' +
            client.clientId +
            '|SERVICE_DISABLED'
        );

        return;
    }

    if (
        maintenanceMode
    ) {
        SendLine(
            server.socket,
            'CLIENT_UNAUTHORIZED|' +
            client.clientId +
            '|MAINTENANCE'
        );

        return;
    }

    const active =
        GetClientActiveLicense(
            client.clientId
        );

    if (active) {
        SendLine(
            server.socket,
            'CLIENT_AUTHORIZED|' +
            client.clientId +
            '|' +
            active.license.expiresAt
        );
    } else {
        SendLine(
            server.socket,
            'CLIENT_UNAUTHORIZED|' +
            client.clientId +
            '|LICENSE_REQUIRED'
        );
    }
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

    if (!serviceEnabled) {
        connection.licenseAuthorized =
            false;

        connection.licenseKey =
            null;

        connection.licenseExpiresAt =
            0;

        SendLine(
            connection.socket,
            'SERVICE_ERROR|DISABLED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'SERVICE_DISABLED'
        );

        return;
    }

    if (maintenanceMode) {
        connection.licenseAuthorized =
            false;

        connection.licenseKey =
            null;

        connection.licenseExpiresAt =
            0;

        SendLine(
            connection.socket,
            'SERVICE_ERROR|MAINTENANCE'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'MAINTENANCE'
        );

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

    const bound =
        GetBoundLicense(
            connection.clientId
        );

    if (
        bound &&
        bound.suspended
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
        bound &&
        Now() >=
        bound.expiresAt
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

function AuthorizeClientConnection(
    connection,
    licenseKey
) {
    if (!serviceEnabled) {
        SendLine(
            connection.socket,
            'SERVICE_ERROR|DISABLED'
        );

        return;
    }

    if (maintenanceMode) {
        SendLine(
            connection.socket,
            'SERVICE_ERROR|MAINTENANCE'
        );

        return;
    }

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

    if (
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
        Now() >=
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
            Now();

        LogEvent(
            'LICENSE_BOUND',
            licenseKey +
            ' -> ' +
            connection.clientId
        );
    }

    license.lastAuthAt =
        Now();

    license.lastSeenAt =
        Now();

    license.lastIP =
        SafeIP(
            connection.socket
        );

    license.authCount =
        Number(
            license.authCount ||
            0
        ) + 1;

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
            Now();

        saved.lastSeenAt =
            Now();

        saved.lastIP =
            SafeIP(
                connection.socket
            );

        saved.authCount =
            Number(
                saved.authCount ||
                0
            ) + 1;
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

function IsRateLimited(
    connection
) {
    const clientId =
        connection.clientId ||
        'IP:' +
        SafeIP(
            connection.socket
        );

    const now =
        Now();

    let state =
        rateLimits.get(
            clientId
        );

    if (
        !state ||
        now -
        state.startedAt >=
        RATE_LIMIT_WINDOW
    ) {
        state = {
            startedAt: now,
            count: 0
        };

        rateLimits.set(
            clientId,
            state
        );
    }

    state.count++;

    if (
        state.count >
        RATE_LIMIT_MAX
    ) {
        return true;
    }

    return false;
}

function HandleClientSend(
    connection,
    line
) {
    if (
        !serviceEnabled
    ) {
        SendLine(
            connection.socket,
            'SERVICE_ERROR|DISABLED'
        );

        return;
    }

    if (
        maintenanceMode
    ) {
        SendLine(
            connection.socket,
            'SERVICE_ERROR|MAINTENANCE'
        );

        return;
    }

    if (
        IsRateLimited(
            connection
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|RATE_LIMIT'
        );

        return;
    }

    const parts =
        line.split('|');

    let requestId;
    let clientId;
    let number;

    if (
        parts.length === 4
    ) {
        requestId =
            parts[1].trim();

        clientId =
            NormalizeID(
                parts[2].trim()
            );

        number =
            parts[3].trim();
    } else if (
        parts.length === 3
    ) {
        requestId =
            crypto
                .randomBytes(8)
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

    if (
        requestHistory.has(
            requestKey
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|DUPLICATE_REQUEST'
        );

        return;
    }

    requestHistory.set(
        requestKey,
        Now()
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

    active.license.sendCount =
        Number(
            active.license.sendCount ||
            0
        ) + 1;

    active.license.lastSeenAt =
        Now();

    active.license.lastIP =
        SafeIP(
            connection.socket
        );

    saved.sendCount =
        Number(
            saved.sendCount ||
            0
        ) + 1;

    saved.lastSeenAt =
        Now();

    saved.lastIP =
        SafeIP(
            connection.socket
        );

    SaveIdentities();

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
        line.startsWith(
            'CONNECT|'
        )
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

        if (
            parts.length < 2
        ) {
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

    if (
        line === 'PONG'
    ) {
        connection.lastSeen =
            Now();

        const saved =
            GetSavedClientByID(
                connection.clientId
            );

        if (saved) {
            saved.lastSeenAt =
                Now();

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

    return (
        licenses.get(
            licenseKey
        ) ||
        null
    );
}

function CreateLicense(
    days,
    memo
) {
    const now =
        Now();

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

            boundAt: 0,

            lastAuthAt: 0,

            lastSeenAt: 0,

            lastIP: '',

            authCount: 0,

            sendCount: 0,

            suspended: false,

            memo:
                SanitizeMemo(
                    memo
                )
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
            Now(),
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

function ReissueLicense(
    oldKey
) {
    const oldLicense =
        FindLicense(
            oldKey
        );

    if (!oldLicense) {
        return null;
    }

    const remaining =
        Math.max(
            0,
            oldLicense.expiresAt -
            Now()
        );

    if (
        remaining <= 0
    ) {
        return null;
    }

    let newKey;

    do {
        newKey =
            RandomLicenseKey();
    } while (
        licenses.has(
            newKey
        )
    );

    const newLicense = {
        createdAt: Now(),

        expiresAt:
            Now() +
            remaining,

        boundClient:
            oldLicense.boundClient,

        boundAt:
            oldLicense.boundAt,

        lastAuthAt: 0,

        lastSeenAt: 0,

        lastIP: '',

        authCount: 0,

        sendCount: 0,

        suspended: false,

        memo:
            oldLicense.memo
    };

    licenses.set(
        newKey,
        newLicense
    );

    const oldClient =
        oldLicense.boundClient;

    licenses.delete(
        oldKey
    );

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
                'LICENSE_ERROR|REISSUED'
            );
        }

        NotifyServerUnauthorized(
            oldClient,
            'REISSUED'
        );
    }

    LogEvent(
        'LICENSE_REISSUE',
        oldKey +
        ' -> ' +
        newKey
    );

    return {
        oldKey,
        newKey,
        expiresAt:
            newLicense.expiresAt
    };
}

function TransferLicense(
    key,
    newClientId
) {
    const license =
        FindLicense(
            key
        );

    if (!license) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    newClientId =
        NormalizeID(
            newClientId
        );

    if (!newClientId) {
        return {
            ok: false,
            reason: 'INVALID_CLIENT'
        };
    }

    const savedClient =
        GetSavedClientByID(
            newClientId
        );

    if (!savedClient) {
        return {
            ok: false,
            reason: 'CLIENT_NOT_FOUND'
        };
    }

    const oldClient =
        license.boundClient;

    if (
        oldClient ===
        newClientId
    ) {
        return {
            ok: true,
            reason: 'SAME_CLIENT'
        };
    }

    license.boundClient =
        newClientId;

    license.boundAt =
        Now();

    license.lastAuthAt =
        0;

    license.lastSeenAt =
        0;

    license.lastIP =
        '';

    license.authCount =
        0;

    license.sendCount =
        0;

    SaveIdentities();

    if (oldClient) {
        const oldConnection =
            GetOnlineClient(
                oldClient
            );

        if (oldConnection) {
            oldConnection.licenseAuthorized =
                false;

            oldConnection.licenseKey =
                null;

            oldConnection.licenseExpiresAt =
                0;

            SendLine(
                oldConnection.socket,
                'LICENSE_ERROR|TRANSFERRED'
            );
        }

        NotifyServerUnauthorized(
            oldClient,
            'TRANSFERRED'
        );
    }

    const newConnection =
        GetOnlineClient(
            newClientId
        );

    if (newConnection) {
        NotifyClientLicenseState(
            newConnection
        );
    }

    LogEvent(
        'LICENSE_TRANSFER',
        key +
        ' -> ' +
        newClientId
    );

    return {
        ok: true,
        reason: 'OK'
    };
}

function IsAdminAllowed(
    connection,
    action
) {
    const role =
        connection.adminRole ||
        'admin';

    if (role === 'admin') {
        return true;
    }

    if (role === 'operator') {
        return [
            'LIST',
            'VIEW',
            'EXTEND',
            'UNBIND',
            'SUSPEND',
            'RESUME',
            'TRANSFER',
            'DASHBOARD',
            'SERVER_LIST',
            'CLIENT_LIST',
            'AUDIT_LIST'
        ].includes(
            action
        );
    }

    if (role === 'viewer') {
        return [
            'LIST',
            'VIEW',
            'DASHBOARD',
            'SERVER_LIST',
            'CLIENT_LIST',
            'AUDIT_LIST'
        ].includes(
            action
        );
    }

    return false;
}

function ResolveAdminRole(
    suppliedRole
) {
    const role =
        String(
            suppliedRole ||
            'admin'
        ).toLowerCase();

    if (
        role === 'admin' ||
        role === 'operator' ||
        role === 'viewer'
    ) {
        return role;
    }

    return 'admin';
}

function HandleAdminAuth(
    connection,
    line
) {
    const parts =
        line.split('|');

    if (
        parts.length < 4
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FORMAT'
        );

        return;
    }

    const nonce =
        parts[1];

    const timestampText =
        parts[2];

    const suppliedHmac =
        parts[3]
            .trim()
            .toUpperCase();

    const requestedRole =
        parts.length >= 5
            ? parts[4]
            : 'admin';

    const timestamp =
        Number(
            timestampText
        );

    if (
        !nonce ||
        !Number.isFinite(
            timestamp
        )
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FORMAT'
        );

        return;
    }

    if (
        nonce !==
        connection.adminNonce
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|BAD_NONCE'
        );

        return;
    }

    if (
        Now() -
        connection.adminNonceCreatedAt >
        60000
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_EXPIRED'
        );

        return;
    }

    const now =
        Math.floor(
            Now() / 1000
        );

    if (
        Math.abs(
            now - timestamp
        ) >
        ADMIN_AUTH_WINDOW_SECONDS
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_EXPIRED'
        );

        return;
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
            SafeIP(
                connection.socket
            )
        );

        return;
    }

    connection.adminAuthenticated =
        true;

    connection.adminAuthenticatedAt =
        Now();

    connection.lastSeen =
        Now();

    connection.adminNonce =
        '';

    connection.adminRole =
        ResolveAdminRole(
            requestedRole
        );

    SendLine(
        connection.socket,
        'ADMIN_OK|' +
        connection.adminRole
    );

    LogEvent(
        'ADMIN_AUTH',
        connection.adminRole +
        ' / ' +
        SafeIP(
            connection.socket
        )
    );
}

function SearchLicenses(
    query,
    status,
    boundClient
) {
    const results = [];

    query =
        String(
            query || ''
        )
            .trim()
            .toUpperCase();

    status =
        String(
            status || ''
        )
            .trim()
            .toUpperCase();

    boundClient =
        NormalizeID(
            boundClient ||
            ''
        );

    for (
        const [
            key,
            license
        ]
        of licenses.entries()
    ) {
        const licenseStatus =
            GetLicenseStatus(
                license
            );

        if (
            status &&
            status !== 'ALL' &&
            licenseStatus !==
            status
        ) {
            continue;
        }

        if (
            boundClient &&
            NormalizeID(
                license.boundClient ||
                ''
            ) !==
            boundClient
        ) {
            continue;
        }

        if (query) {
            const haystack =
                (
                    key +
                    '|' +
                    license.memo +
                    '|' +
                    license.boundClient
                )
                    .toUpperCase();

            if (
                !haystack.includes(
                    query
                )
            ) {
                continue;
            }
        }

        results.push({
            key,
            license
        });

        if (
            results.length >=
            MAX_SEARCH_RESULTS
        ) {
            break;
        }
    }

    return results;
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
        line ===
        'ADMIN_HELLO'
    ) {
        const nonce =
            RandomNonce();

        connection.adminNonce =
            nonce;

        connection.adminNonceCreatedAt =
            Now();

        connection.adminAuthenticated =
            false;

        connection.adminRole =
            null;

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
        Now() -
        connection.adminAuthenticatedAt >
        ADMIN_SESSION_TIMEOUT
    ) {
        connection.adminAuthenticated =
            false;

        connection.adminRole =
            null;

        SendLine(
            connection.socket,
            'ADMIN_ERROR|SESSION_EXPIRED'
        );

        return;
    }

    connection.lastSeen =
        Now();

    if (
        line ===
        'WHOAMI'
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ROLE|' +
            connection.adminRole
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_SEARCH|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const parts =
            line.split('|');

        const query =
            parts[1] || '';

        const status =
            parts[2] || '';

        const boundClient =
            parts[3] || '';

        const results =
            SearchLicenses(
                query,
                status,
                boundClient
            );

        for (
            const item
            of results
        ) {
            const license =
                item.license;

            SendLine(
                connection.socket,
                'LIC_ITEM|' +
                item.key +
                '|' +
                GetLicenseStatus(
                    license
                ) +
                '|' +
                license.expiresAt +
                '|' +
                (
                    license.boundClient ||
                    ''
                ) +
                '|' +
                SanitizeMemo(
                    license.memo ||
                    ''
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
                license.lastIP +
                '|' +
                license.authCount +
                '|' +
                license.sendCount
            );
        }

        SendLine(
            connection.socket,
            'END_SEARCH'
        );

        return;
    }

    if (
        line ===
        'LIC_LIST'
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const [
                key,
                license
            ]
            of licenses.entries()
        ) {
            SendLine(
                connection.socket,
                'LIC_ITEM|' +
                key +
                '|' +
                GetLicenseStatus(
                    license
                ) +
                '|' +
                license.expiresAt +
                '|' +
                (
                    license.boundClient ||
                    ''
                ) +
                '|' +
                SanitizeMemo(
                    license.memo ||
                    ''
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
                license.lastIP +
                '|' +
                license.authCount +
                '|' +
                license.sendCount
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
            'LIC_CREATE|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'EXTEND'
            ) ||
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const parts =
            line.split('|');

        const days =
            Number(
                parts[1]
            );

        const memo =
            parts.length >= 3
                ? parts
                    .slice(2)
                    .join('|')
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

    if (
        line.startsWith(
            'LIC_EXTEND|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'EXTEND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

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

        const license =
            FindLicense(
                key
            );

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
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

        ExtendLicense(
            license,
            days
        );

        SaveIdentities();

        if (
            license.boundClient
        ) {
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
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        const license =
            FindLicense(
                key
            );

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        const boundClient =
            license.boundClient;

        licenses.delete(
            key
        );

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
        if (
            !IsAdminAllowed(
                connection,
                'UNBIND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        const license =
            FindLicense(
                key
            );

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

        license.authCount =
            0;

        license.sendCount =
            0;

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
            key
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_SUSPEND|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'SUSPEND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        const license =
            FindLicense(
                key
            );

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

        if (
            license.boundClient
        ) {
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
        if (
            !IsAdminAllowed(
                connection,
                'RESUME'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        const license =
            FindLicense(
                key
            );

        if (!license) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        if (
            Now() >=
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

        if (
            license.boundClient
        ) {
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

    if (
        line.startsWith(
            'LIC_REISSUE|'
        )
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        const result =
            ReissueLicense(
                key
            );

        if (!result) {
            SendLine(
                connection.socket,
                'LIC_ERROR|REISSUE_FAILED'
            );

            return;
        }

        SendLine(
            connection.socket,
            'LIC_REISSUE_OK|' +
            result.oldKey +
            '|' +
            result.newKey +
            '|' +
            result.expiresAt
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_TRANSFER|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'TRANSFER'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const parts =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        const newClientId =
            NormalizeID(
                parts[2] || ''
            );

        const result =
            TransferLicense(
                key,
                newClientId
            );

        if (!result.ok) {
            SendLine(
                connection.socket,
                'LIC_ERROR|' +
                result.reason
            );

            return;
        }

        SendLine(
            connection.socket,
            'LIC_TRANSFER_OK|' +
            key +
            '|' +
            newClientId
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_BULK_EXTEND|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'EXTEND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const parts =
            line.split('|');

        const days =
            Number(
                parts[1]
            );

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

        let success =
            0;

        const keys =
            parts
                .slice(2)
                .map(
                    NormalizeLicenseKey
                )
                .filter(
                    Boolean
                );

        for (
            const key
            of keys
        ) {
            const license =
                FindLicense(
                    key
                );

            if (!license) {
                continue;
            }

            ExtendLicense(
                license,
                days
            );

            success++;

            if (
                license.boundClient
            ) {
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
        }

        SaveIdentities();

        SendLine(
            connection.socket,
            'LIC_BULK_EXTEND_OK|' +
            success +
            '|' +
            keys.length
        );

        LogEvent(
            'LICENSE_BULK_EXTEND',
            String(success)
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_BULK_UNBIND|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'UNBIND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(
                    NormalizeLicenseKey
                )
                .filter(
                    Boolean
                );

        let success =
            0;

        for (
            const key
            of keys
        ) {
            const license =
                FindLicense(
                    key
                );

            if (!license) {
                continue;
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

            license.authCount =
                0;

            license.sendCount =
                0;

            success++;

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
        }

        SaveIdentities();

        SendLine(
            connection.socket,
            'LIC_BULK_UNBIND_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_BULK_SUSPEND|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'SUSPEND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(
                    NormalizeLicenseKey
                )
                .filter(
                    Boolean
                );

        let success =
            0;

        for (
            const key
            of keys
        ) {
            const license =
                FindLicense(
                    key
                );

            if (!license) {
                continue;
            }

            license.suspended =
                true;

            success++;

            if (
                license.boundClient
            ) {
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
        }

        SaveIdentities();

        SendLine(
            connection.socket,
            'LIC_BULK_SUSPEND_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_BULK_RESUME|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'RESUME'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(
                    NormalizeLicenseKey
                )
                .filter(
                    Boolean
                );

        let success =
            0;

        for (
            const key
            of keys
        ) {
            const license =
                FindLicense(
                    key
                );

            if (!license) {
                continue;
            }

            if (
                Now() >=
                license.expiresAt
            ) {
                continue;
            }

            license.suspended =
                false;

            success++;

            if (
                license.boundClient
            ) {
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
        }

        SaveIdentities();

        SendLine(
            connection.socket,
            'LIC_BULK_RESUME_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_BULK_DELETE|'
        )
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(
                    NormalizeLicenseKey
                )
                .filter(
                    Boolean
                );

        let success =
            0;

        for (
            const key
            of keys
        ) {
            const license =
                FindLicense(
                    key
                );

            if (!license) {
                continue;
            }

            const boundClient =
                license.boundClient;

            licenses.delete(
                key
            );

            success++;

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
        }

        SaveIdentities();

        SendLine(
            connection.socket,
            'LIC_BULK_DELETE_OK|' +
            success +
            '|' +
            keys.length
        );

        LogEvent(
            'LICENSE_BULK_DELETE',
            String(success)
        );

        return;
    }

    if (
        line ===
        'DASHBOARD'
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'DASHBOARD'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        let onlineServers = 0;
        let onlineClients = 0;
        let availableLicenses = 0;
        let boundLicenses = 0;
        let expiredLicenses = 0;
        let suspendedLicenses = 0;

        for (
            const server
            of servers.values()
        ) {
            if (
                GetOnlineServer(
                    server.serverId
                )
            ) {
                onlineServers++;
            }
        }

        for (
            const client
            of clients.values()
        ) {
            if (
                GetOnlineClient(
                    client.clientId
                )
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

            if (
                status ===
                'AVAILABLE'
            ) {
                availableLicenses++;
            } else if (
                status ===
                'BOUND'
            ) {
                boundLicenses++;
            } else if (
                status ===
                'EXPIRED'
            ) {
                expiredLicenses++;
            } else if (
                status ===
                'SUSPENDED'
            ) {
                suspendedLicenses++;
            }
        }

        SendLine(
            connection.socket,
            'DASH|' +
            'SERVICE=' +
            (
                serviceEnabled
                    ? 'ONLINE'
                    : 'OFFLINE'
            ) +
            '|MAINTENANCE=' +
            (
                maintenanceMode
                    ? 'ON'
                    : 'OFF'
            ) +
            '|SERVERS=' +
            serverIdentities.size +
            '|ONLINE_SERVERS=' +
            onlineServers +
            '|CLIENTS=' +
            clientIdentities.size +
            '|ONLINE_CLIENTS=' +
            onlineClients +
            '|LICENSES=' +
            licenses.size +
            '|AVAILABLE=' +
            availableLicenses +
            '|BOUND=' +
            boundLicenses +
            '|EXPIRED=' +
            expiredLicenses +
            '|SUSPENDED=' +
            suspendedLicenses +
            '|RATE_LIMIT=' +
            RATE_LIMIT_MAX
        );

        const recent =
            events.slice(
                Math.max(
                    0,
                    events.length - 20
                )
            );

        for (
            const event
            of recent
        ) {
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

    if (
        line ===
        'SERVER_LIST'
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'SERVER_LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const [
                serverId,
                identityKey
            ]
            of serverIdentities.entries()
        ) {
            const live =
                servers.get(
                    serverId
                );

            SendLine(
                connection.socket,
                'SERVER_ITEM|' +
                serverId +
                '|' +
                (
                    live &&
                    live.socket &&
                    !live.socket.destroyed
                        ? 'ONLINE'
                        : 'OFFLINE'
                ) +
                '|' +
                (
                    live
                        ? live.clients.size
                        : 0
                ) +
                '|' +
                identityKey +
                '|' +
                (
                    live
                        ? live.lastIP
                        : ''
                ) +
                '|' +
                (
                    live
                        ? live.lastSeen
                        : 0
                )
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_LIST'
        );

        return;
    }

    if (
        line ===
        'CLIENT_LIST'
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'CLIENT_LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const [
                deviceKey,
                saved
            ]
            of clientIdentities.entries()
        ) {
            const online =
                !!GetOnlineClient(
                    saved.id
                );

            const license =
                GetBoundLicense(
                    saved.id
                );

            SendLine(
                connection.socket,
                'CLIENT_ITEM|' +
                saved.id +
                '|' +
                deviceKey +
                '|' +
                saved.serverId +
                '|' +
                (
                    online
                        ? 'ONLINE'
                        : 'OFFLINE'
                ) +
                '|' +
                (
                    license
                        ? GetLicenseStatus(
                            license
                        )
                        : 'NONE'
                ) +
                '|' +
                (
                    license
                        ? license.expiresAt
                        : 0
                ) +
                '|' +
                saved.lastAuthAt +
                '|' +
                saved.lastSeenAt +
                '|' +
                saved.lastIP +
                '|' +
                saved.authCount +
                '|' +
                saved.sendCount
            );
        }

        SendLine(
            connection.socket,
            'END_CLIENT_LIST'
        );

        return;
    }

    if (
        line.startsWith(
            'CLIENT_DETAIL|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'VIEW'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const clientId =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        const saved =
            GetSavedClientByID(
                clientId
            );

        if (!saved) {
            SendLine(
                connection.socket,
                'CLIENT_ERROR|NOT_FOUND'
            );

            return;
        }

        const license =
            GetBoundLicense(
                clientId
            );

        const online =
            !!GetOnlineClient(
                clientId
            );

        SendLine(
            connection.socket,
            'CLIENT_DETAIL_ITEM|' +
            saved.id +
            '|' +
            (
                online
                    ? 'ONLINE'
                    : 'OFFLINE'
            ) +
            '|' +
            saved.serverId +
            '|' +
            (
                license
                    ? GetLicenseStatus(
                        license
                    )
                    : 'NONE'
            ) +
            '|' +
            (
                license
                    ? license.expiresAt
                    : 0
            ) +
            '|' +
            saved.lastAuthAt +
            '|' +
            saved.lastSeenAt +
            '|' +
            saved.lastIP +
            '|' +
            saved.authCount +
            '|' +
            saved.sendCount
        );

        SendLine(
            connection.socket,
            'END_CLIENT_DETAIL'
        );

        return;
    }

    if (
        line.startsWith(
            'SERVER_TREE|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'VIEW'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const serverId =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        const server =
            GetOnlineServer(
                serverId
            );

        if (!server) {
            SendLine(
                connection.socket,
                'SERVER_TREE_ERROR|OFFLINE'
            );

            return;
        }

        for (
            const clientId
            of server.clients
        ) {
            const client =
                GetOnlineClient(
                    clientId
                );

            const license =
                GetBoundLicense(
                    clientId
                );

            SendLine(
                connection.socket,
                'SERVER_TREE_CLIENT|' +
                clientId +
                '|' +
                (
                    client
                        ? 'ONLINE'
                        : 'OFFLINE'
                ) +
                '|' +
                (
                    license
                        ? GetLicenseStatus(
                            license
                        )
                        : 'NONE'
                )
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_TREE'
        );

        return;
    }

    if (
        line ===
        'AUDIT_LIST'
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'AUDIT_LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const event
            of events
        ) {
            SendLine(
                connection.socket,
                'AUDIT|' +
                event.time +
                '|' +
                event.type +
                '|' +
                event.detail
            );
        }

        SendLine(
            connection.socket,
            'END_AUDIT'
        );

        return;
    }

    if (
        line ===
        'BACKUP_CREATE'
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const file =
            SaveBackup(
                'manual'
            );

        CleanupBackups();

        if (!file) {
            SendLine(
                connection.socket,
                'BACKUP_ERROR|CREATE_FAILED'
            );

            return;
        }

        SendLine(
            connection.socket,
            'BACKUP_OK|' +
            path.basename(
                file
            )
        );

        return;
    }

    if (
        line ===
        'BACKUP_LIST'
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'VIEW'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        EnsureBackupDirectory();

        try {
            const files =
                fs.readdirSync(
                    BACKUP_DIR
                )
                    .filter(
                        file =>
                            file.endsWith(
                                '.json'
                            )
                    )
                    .sort()
                    .reverse();

            for (
                const file
                of files
            ) {
                const fullPath =
                    path.join(
                        BACKUP_DIR,
                        file
                    );

                const stat =
                    fs.statSync(
                        fullPath
                    );

                SendLine(
                    connection.socket,
                    'BACKUP_ITEM|' +
                    file +
                    '|' +
                    stat.size +
                    '|' +
                    stat.mtimeMs
                );
            }
        } catch (_) {}

        SendLine(
            connection.socket,
            'END_BACKUP_LIST'
        );

        return;
    }

    if (
        line.startsWith(
            'BACKUP_RESTORE|'
        )
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const fileName =
            line.substring(
                'BACKUP_RESTORE|'.length
            );

        const result =
            RestoreBackupFile(
                fileName
            );

        if (!result.ok) {
            SendLine(
                connection.socket,
                'BACKUP_ERROR|' +
                result.reason
            );

            return;
        }

        SendLine(
            connection.socket,
            'BACKUP_RESTORE_OK|' +
            fileName +
            '|' +
            result.preRestoreBackup
        );

        return;
    }

    if (
        line.startsWith(
            'BACKUP_DELETE|'
        )
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const fileName =
            path.basename(
                line.substring(
                    'BACKUP_DELETE|'.length
                )
            );

        const fullPath =
            path.join(
                BACKUP_DIR,
                fileName
            );

        try {
            if (
                fs.existsSync(
                    fullPath
                )
            ) {
                fs.unlinkSync(
                    fullPath
                );

                SendLine(
                    connection.socket,
                    'BACKUP_DELETE_OK|' +
                    fileName
                );
            } else {
                SendLine(
                    connection.socket,
                    'BACKUP_ERROR|NOT_FOUND'
                );
            }
        } catch (_) {
            SendLine(
                connection.socket,
                'BACKUP_ERROR|DELETE_FAILED'
            );
        }

        return;
    }

    if (
        line ===
        'SERVICE_STOP'
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        serviceEnabled =
            false;

        maintenanceMode =
            false;

        SaveIdentities();

        for (
            const client
            of clients.values()
        ) {
            client.licenseAuthorized =
                false;

            client.licenseKey =
                null;

            client.licenseExpiresAt =
                0;

            SendLine(
                client.socket,
                'SERVICE_ERROR|DISABLED'
            );

            NotifyServerUnauthorized(
                client.clientId,
                'SERVICE_DISABLED'
            );
        }

        SendLine(
            connection.socket,
            'SERVICE_STOP_OK'
        );

        LogEvent(
            'SERVICE_STOP',
            SafeIP(
                connection.socket
            )
        );

        return;
    }

    if (
        line ===
        'SERVICE_START'
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        serviceEnabled =
            true;

        SaveIdentities();

        SendLine(
            connection.socket,
            'SERVICE_START_OK'
        );

        LogEvent(
            'SERVICE_START',
            SafeIP(
                connection.socket
            )
        );

        for (
            const client
            of clients.values()
        ) {
            NotifyClientLicenseState(
                client
            );
        }

        return;
    }

    if (
        line ===
        'MAINTENANCE_ON'
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        maintenanceMode =
            true;

        SaveIdentities();

        for (
            const client
            of clients.values()
        ) {
            client.licenseAuthorized =
                false;

            client.licenseKey =
                null;

            client.licenseExpiresAt =
                0;

            SendLine(
                client.socket,
                'SERVICE_ERROR|MAINTENANCE'
            );

            NotifyServerUnauthorized(
                client.clientId,
                'MAINTENANCE'
            );
        }

        SendLine(
            connection.socket,
            'MAINTENANCE_ON_OK'
        );

        LogEvent(
            'MAINTENANCE_ON',
            SafeIP(
                connection.socket
            )
        );

        return;
    }

    if (
        line ===
        'MAINTENANCE_OFF'
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        maintenanceMode =
            false;

        SaveIdentities();

        SendLine(
            connection.socket,
            'MAINTENANCE_OFF_OK'
        );

        LogEvent(
            'MAINTENANCE_OFF',
            SafeIP(
                connection.socket
            )
        );

        for (
            const client
            of clients.values()
        ) {
            NotifyClientLicenseState(
                client
            );
        }

        return;
    }

    if (
        line.startsWith(
            'SERVER_KICK|'
        )
    ) {
        if (
            connection.adminRole !==
            'admin'
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const serverId =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        const target =
            GetOnlineServer(
                serverId
            );

        if (!target) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVER_NOT_ONLINE'
            );

            return;
        }

        SendLine(
            target.socket,
            'ERROR|ADMIN_KICK'
        );

        target.socket.destroy();

        SendLine(
            connection.socket,
            'SERVER_KICK_OK|' +
            serverId
        );

        LogEvent(
            'SERVER_KICK',
            serverId
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

    if (
        !serviceEnabled
    ) {
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
                'SERVICE_ERROR|DISABLED'
            );

            NotifyServerUnauthorized(
                connection.clientId,
                'SERVICE_DISABLED'
            );
        }

        return;
    }

    if (
        maintenanceMode
    ) {
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
                'SERVICE_ERROR|MAINTENANCE'
            );

            NotifyServerUnauthorized(
                connection.clientId,
                'MAINTENANCE'
            );
        }

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
            NotifyClientLicenseState(
                connection
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

function DisconnectConnection(
    connection
) {
    if (
        connection.type ===
        'server'
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
            connection.serverId ||
            ''
        );

        return;
    }

    if (
        connection.type ===
        'client'
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
            connection.clientId ||
            ''
        );

        return;
    }

    if (
        connection.type ===
        'admin'
    ) {
        LogEvent(
            'ADMIN_OFFLINE',
            SafeIP(
                connection.socket
            )
        );
    }
}

function CreateConnection(
    socket
) {
    const connection = {
        socket,

        type: null,

        registered: false,

        connected: false,

        adminAuthenticated:
            false,

        adminRole:
            null,

        adminNonce:
            '',

        adminNonceCreatedAt:
            0,

        adminAuthenticatedAt:
            0,

        identityKey:
            null,

        serverId:
            null,

        clientId:
            null,

        licenseAuthorized:
            false,

        licenseKey:
            null,

        licenseExpiresAt:
            0,

        lastSeen:
            Now(),

        lastIP:
            SafeIP(
                socket
            ),

        clients:
            new Set(),

        buffer:
            ''
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

                if (
                    !connection.type
                ) {
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
                            'LICENSE_AUTH|'
                        ) ||
                        line.startsWith(
                            'SEND|'
                        )
                    ) {
                        connection.type =
                            'client';
                    } else if (
                        line ===
                        'ADMIN_HELLO' ||
                        line.startsWith(
                            'ADMIN_AUTH|'
                        )
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

EnsureBackupDirectory();

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
            'License Storage: SERVER'
        );

        console.log(
            'ID Format: 16 HEX'
        );

        console.log(
            'License Management: ENABLED'
        );

        console.log(
            'Search / Filter: ENABLED'
        );

        console.log(
            'Bulk Operations: ENABLED'
        );

        console.log(
            'Backup / Restore: ENABLED'
        );

        console.log(
            'Auto Backup: ENABLED'
        );

        console.log(
            'Client Details: ENABLED'
        );

        console.log(
            'Server Tree: ENABLED'
        );

        console.log(
            'Audit Log: ENABLED'
        );

        console.log(
            'Admin Roles: ENABLED'
        );

        console.log(
            'Maintenance Mode: ENABLED'
        );

        console.log(
            'Kill Switch: ENABLED'
        );

        console.log(
            'Rate Limit: ' +
            RATE_LIMIT_MAX +
            '/sec'
        );

        console.log(
            'Admin Auth: HMAC-SHA256'
        );

        console.log(
            'Service: ' +
            (
                serviceEnabled
                    ? 'ONLINE'
                    : 'OFFLINE'
            )
        );

        console.log(
            'Maintenance: ' +
            (
                maintenanceMode
                    ? 'ON'
                    : 'OFF'
            )
        );

        console.log(
            '================================'
        );
    }
);

setInterval(
    () => {
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
                Now() -
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
                Now() -
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
            const [
                key,
                license
            ]
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
                Now() >=
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

                        NotifyServerUnauthorized(
                            client.clientId,
                            'EXPIRED'
                        );
                    }
                }
            }
        }

        for (
            const [
                key,
                state
            ]
            of rateLimits.entries()
        ) {
            if (
                Now() -
                state.startedAt >
                RATE_LIMIT_WINDOW * 5
            ) {
                rateLimits.delete(
                    key
                );
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

setInterval(
    () => {
        CreateAutoBackup();
    },
    AUTO_BACKUP_INTERVAL
);

process.on(
    'SIGINT',
    () => {
        console.log(
            'Creating final backup...'
        );

        SaveBackup(
            'shutdown'
        );

        SaveIdentities();

        process.exit(
            0
        );
    }
);

process.on(
    'SIGTERM',
    () => {
        console.log(
            'Creating final backup...'
        );

        SaveBackup(
            'shutdown'
        );

        SaveIdentities();

        process.exit(
            0
        );
    }
);
