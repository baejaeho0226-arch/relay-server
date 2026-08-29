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

const ADMIN_AUTH_WINDOW =
    60;

const ADMIN_SESSION_TIMEOUT =
    10 * 60 * 1000;

const REQUEST_HISTORY_TIMEOUT =
    10 * 60 * 1000;

const RATE_LIMIT_WINDOW =
    1000;

const RATE_LIMIT_MAX =
    Number(
        process.env.RATE_LIMIT_MAX || 30
    );

const AUTO_BACKUP_INTERVAL =
    6 * 60 * 60 * 1000;

const MAX_BACKUPS =
    30;

const MAX_EVENTS =
    2000;

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

function NormalizeID(
    id
) {
    if (
        typeof id !==
        'string'
    ) {
        return '';
    }

    id =
        id
            .trim()
            .toUpperCase();

    if (
        id.startsWith(
            'SERVER-'
        )
    ) {
        id =
            id.substring(7);
    }

    if (
        id.startsWith(
            'CLIENT-'
        )
    ) {
        id =
            id.substring(7);
    }

    if (
        !/^[0-9A-F]{16}$/.test(
            id
        )
    ) {
        return '';
    }

    return id;
}

function NormalizeLicenseKey(
    key
) {
    if (
        typeof key !==
        'string'
    ) {
        return '';
    }

    return key
        .trim()
        .toUpperCase();
}

function SanitizeMemo(
    memo
) {
    if (
        typeof memo !==
        'string'
    ) {
        return '';
    }

    return memo
        .replace(
            /\r/g,
            ' '
        )
        .replace(
            /\n/g,
            ' '
        )
        .replace(
            /\|/g,
            ' '
        )
        .trim();
}

function SafeIP(
    socket
) {
    if (!socket) {
        return '';
    }

    return String(
        socket.remoteAddress || ''
    );
}

function SendLine(
    socket,
    text
) {
    if (
        !socket ||
        socket.destroyed
    ) {
        return false;
    }

    try {
        socket.write(
            String(text) +
            '\n'
        );

        return true;
    } catch (_) {
        return false;
    }
}

function LogEvent(
    type,
    detail
) {
    events.push({
        time: Now(),
        type,
        detail:
            String(
                detail || ''
            )
    });

    while (
        events.length >
        MAX_EVENTS
    ) {
        events.shift();
    }

    console.log(
        '[EVENT]',
        type,
        detail || ''
    );
}

function ConstantTimeEqual(
    a,
    b
) {
    if (
        typeof a !==
        'string' ||
        typeof b !==
        'string'
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

function GetUsedIDs() {
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
            used.add(
                value.id
            );
        }
    }

    return used;
}

function MakeUniqueID() {
    const used =
        GetUsedIDs();

    let id;

    do {
        id =
            RandomID();
    } while (
        used.has(id)
    );

    return id;
}

function EnsureBackupDir() {
    try {
        fs.mkdirSync(
            BACKUP_DIR,
            {
                recursive: true
            }
        );
    } catch (_) {}
}

function BuildDatabase() {
    return {
        version: 40,

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

function SaveDatabase() {
    const temp =
        IDENTITY_FILE +
        '.tmp';

    try {
        fs.writeFileSync(
            temp,
            JSON.stringify(
                BuildDatabase(),
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
            'DATABASE SAVE ERROR:',
            error.message
        );

        try {
            if (
                fs.existsSync(temp)
            ) {
                fs.unlinkSync(
                    temp
                );
            }
        } catch (_) {}
    }
}

function CleanupBackups() {
    EnsureBackupDir();

    try {
        const files =
            fs
                .readdirSync(
                    BACKUP_DIR
                )
                .filter(
                    file =>
                        file.endsWith(
                            '.json'
                        )
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
            let i =
                MAX_BACKUPS;
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
    } catch (_) {}
}

function CreateBackup(
    reason
) {
    EnsureBackupDir();

    const stamp =
        new Date(
            Now()
        )
            .toISOString()
            .replace(
                /[:.]/g,
                '-'
            );

    const cleanReason =
        String(
            reason ||
            'backup'
        )
            .replace(
                /[^A-Za-z0-9_-]/g,
                '_'
            );

    const fileName =
        'relay-' +
        stamp +
        '-' +
        cleanReason +
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
                BuildDatabase(),
                null,
                2
            ),
            'utf8'
        );

        CleanupBackups();

        LogEvent(
            'BACKUP_CREATE',
            fileName
        );

        return fileName;
    } catch (error) {
        console.error(
            'BACKUP ERROR:',
            error.message
        );

        return '';
    }
}

function LoadDatabase() {
    if (
        !fs.existsSync(
            IDENTITY_FILE
        )
    ) {
        return;
    }

    try {
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

        const used =
            new Set();

        if (
            data.servers &&
            typeof data.servers ===
            'object'
        ) {
            for (
                const [
                    deviceKey,
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

                const key =
                    String(
                        deviceKey
                    ).trim();

                if (
                    !key ||
                    !id ||
                    used.has(id)
                ) {
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

                const key =
                    String(
                        deviceKey
                    ).trim();

                if (
                    !key ||
                    !id ||
                    !serverId ||
                    used.has(id)
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
                            ) ||
                            Now(),
                        lastSeenAt:
                            Number(
                                value.lastSeenAt
                            ) ||
                            0,
                        lastAuthAt:
                            Number(
                                value.lastAuthAt
                            ) ||
                            0,
                        lastIP:
                            String(
                                value.lastIP ||
                                ''
                            ),
                        authCount:
                            Number(
                                value.authCount
                            ) ||
                            0,
                        sendCount:
                            Number(
                                value.sendCount
                            ) ||
                            0
                    }
                );

                used.add(id);
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
                            ) ||
                            Now(),

                        expiresAt,

                        boundClient:
                            NormalizeID(
                                value.boundClient ||
                                ''
                            ),

                        boundAt:
                            Number(
                                value.boundAt
                            ) ||
                            0,

                        lastAuthAt:
                            Number(
                                value.lastAuthAt
                            ) ||
                            0,

                        lastSeenAt:
                            Number(
                                value.lastSeenAt
                            ) ||
                            0,

                        lastIP:
                            String(
                                value.lastIP ||
                                ''
                            ),

                        authCount:
                            Number(
                                value.authCount
                            ) ||
                            0,

                        sendCount:
                            Number(
                                value.sendCount
                            ) ||
                            0,

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

        console.log(
            'DATABASE LOADED'
        );

        console.log(
            'Servers:',
            serverIdentities.size
        );

        console.log(
            'Clients:',
            clientIdentities.size
        );

        console.log(
            'Licenses:',
            licenses.size
        );
    } catch (error) {
        console.error(
            'DATABASE LOAD ERROR:',
            error.message
        );
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
            value.id ===
            clientId
        ) {
            return value;
        }
    }

    return null;
}

function FindLicense(
    key
) {
    key =
        NormalizeLicenseKey(
            key
        );

    if (!key) {
        return null;
    }

    return (
        licenses.get(
            key
        ) ||
        null
    );
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

function GetActiveLicense(
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

    if (!list.length) {
        return null;
    }

    list.sort(
        (a, b) =>
            a.clients.size -
            b.clients.size
    );

    return list[0];
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

function PushLicenseState(
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
            '';

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
            '';

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
        GetActiveLicense(
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
        '';

    connection.licenseExpiresAt =
        0;

    NotifyServerUnauthorized(
        connection.clientId,
        'LICENSE_REQUIRED'
    );
}

function CreateClientIdentity(
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

        lastSeenAt:
            0,

        lastAuthAt:
            0,

        lastIP:
            '',

        authCount:
            0,

        sendCount:
            0
    };

    clientIdentities.set(
        deviceKey,
        saved
    );

    SaveDatabase();

    LogEvent(
        'CLIENT_CREATE',
        saved.id
    );

    return saved;
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
            CreateClientIdentity(
                deviceKey,
                server.serverId
            );
    }

    const old =
        clients.get(
            saved.id
        );

    if (
        old &&
        old !== connection
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
        '';

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

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (server) {
        server.clients.add(
            saved.id
        );
    }

    SaveDatabase();

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

    /*
      중요:
      여기서는 LICENSE_REQUIRED를
      Client에게 즉시 보내지 않는다.
      사용자가 실제로 LICENSE_AUTH를
      보냈을 때만 검사한다.
    */
}

function AuthorizeClient(
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

    licenseKey =
        NormalizeLicenseKey(
            licenseKey
        );

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

    connection.licenseAuthorized =
        true;

    connection.licenseKey =
        licenseKey;

    connection.licenseExpiresAt =
        license.expiresAt;

    SaveDatabase();

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
    const key =
        connection.clientId ||
        'IP:' +
        SafeIP(
            connection.socket
        );

    const now =
        Now();

    let state =
        rateLimits.get(
            key
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
            key,
            state
        );
    }

    state.count++;

    return (
        state.count >
        RATE_LIMIT_MAX
    );
}

function HandleClientSend(
    connection,
    line
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

    if (
        !connection.connected ||
        !connection.clientId
    ) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_CONNECTED'
        );

        return;
    }

    if (
        !IsRateLimited(
            connection
        )
    ) {
        // normal
    } else {
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
        !/^-?\d+$/.test(
            number
        )
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
        GetActiveLicense(
            clientId
        );

    if (!active) {
        connection.licenseAuthorized =
            false;

        connection.licenseKey =
            '';

        connection.licenseExpiresAt =
            0;

        SendLine(
            connection.socket,
            'ERROR|LICENSE_REQUIRED'
        );

        NotifyServerUnauthorized(
            clientId,
            'LICENSE_REQUIRED'
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

    if (!SendLine(
        server.socket,
        'NUMBER|' +
        requestId +
        '|' +
        clientId +
        '|' +
        number
    )) {
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

    SaveDatabase();

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

        const requestedClientID =
            parts.length >= 3
                ? NormalizeID(
                    parts[2]
                )
                : '';

        if (
            requestedClientID &&
            requestedClientID !==
            connection.clientId
        ) {
            SendLine(
                connection.socket,
                'LICENSE_ERROR|CLIENT_NOT_OWNER'
            );

            return;
        }

        AuthorizeClient(
            connection,
            parts[1]
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
        licenses.has(
            key
        )
    );

    licenses.set(
        key,
        {
            createdAt:
                now,

            expiresAt,

            boundClient:
                '',

            boundAt:
                0,

            lastAuthAt:
                0,

            lastSeenAt:
                0,

            lastIP:
                '',

            authCount:
                0,

            sendCount:
                0,

            suspended:
                false,

            memo:
                SanitizeMemo(
                    memo
                )
        }
    );

    SaveDatabase();

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
        oldLicense.expiresAt -
        Now();

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

    licenses.set(
        newKey,
        {
            createdAt:
                Now(),

            expiresAt:
                Now() +
                remaining,

            boundClient:
                oldLicense.boundClient,

            boundAt:
                oldLicense.boundAt,

            lastAuthAt:
                0,

            lastSeenAt:
                0,

            lastIP:
                '',

            authCount:
                0,

            sendCount:
                0,

            suspended:
                false,

            memo:
                oldLicense.memo
        }
    );

    const oldClient =
        oldLicense.boundClient;

    licenses.delete(
        oldKey
    );

    SaveDatabase();

    if (oldClient) {
        const client =
            GetOnlineClient(
                oldClient
            );

        if (client) {
            client.licenseAuthorized =
                false;

            client.licenseKey =
                '';

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

    return {
        oldKey,
        newKey,
        expiresAt:
            licenses.get(
                newKey
            ).expiresAt
    };
}

function TransferLicense(
    key,
    newClientID
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

    newClientID =
        NormalizeID(
            newClientID
        );

    if (!newClientID) {
        return {
            ok: false,
            reason: 'INVALID_CLIENT'
        };
    }

    const saved =
        GetSavedClientByID(
            newClientID
        );

    if (!saved) {
        return {
            ok: false,
            reason: 'CLIENT_NOT_FOUND'
        };
    }

    const oldClient =
        license.boundClient;

    license.boundClient =
        newClientID;

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

    SaveDatabase();

    if (oldClient) {
        const old =
            GetOnlineClient(
                oldClient
            );

        if (old) {
            old.licenseAuthorized =
                false;

            old.licenseKey =
                '';

            old.licenseExpiresAt =
                0;

            SendLine(
                old.socket,
                'LICENSE_ERROR|TRANSFERRED'
            );
        }

        NotifyServerUnauthorized(
            oldClient,
            'TRANSFERRED'
        );
    }

    const target =
        GetOnlineClient(
            newClientID
        );

    if (target) {
        PushLicenseState(
            target
        );
    }

    LogEvent(
        'LICENSE_TRANSFER',
        key +
        ' -> ' +
        newClientID
    );

    return {
        ok: true,
        reason: 'OK'
    };
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

    const supplied =
        parts[3]
            .trim()
            .toUpperCase();

    const requestedRole =
        parts.length >= 5
            ? String(
                parts[4]
              ).toLowerCase()
            : 'admin';

    const timestamp =
        Number(
            timestampText
        );

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
        !Number.isFinite(
            timestamp
        ) ||
        Math.abs(
            now -
            timestamp
        ) >
        ADMIN_AUTH_WINDOW
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
            supplied
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

    if (
        requestedRole !== 'admin' &&
        requestedRole !== 'operator' &&
        requestedRole !== 'viewer'
    ) {
        connection.adminRole =
            'admin';
    } else {
        connection.adminRole =
            requestedRole;
    }

    connection.adminAuthenticated =
        true;

    connection.adminAuthenticatedAt =
        Now();

    connection.adminNonce =
        '';

    connection.lastSeen =
        Now();

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

function IsAdminAllowed(
    connection,
    operation
) {
    if (
        connection.adminRole ===
        'admin'
    ) {
        return true;
    }

    if (
        connection.adminRole ===
        'operator'
    ) {
        return [
            'LIST',
            'SEARCH',
            'VIEW',
            'EXTEND',
            'UNBIND',
            'SUSPEND',
            'RESUME',
            'TRANSFER',
            'DASHBOARD',
            'SERVER_LIST',
            'CLIENT_LIST',
            'CLIENT_DETAIL',
            'SERVER_TREE',
            'AUDIT'
        ].includes(
            operation
        );
    }

    if (
        connection.adminRole ===
        'viewer'
    ) {
        return [
            'LIST',
            'SEARCH',
            'VIEW',
            'DASHBOARD',
            'SERVER_LIST',
            'CLIENT_LIST',
            'CLIENT_DETAIL',
            'SERVER_TREE',
            'AUDIT'
        ].includes(
            operation
        );
    }

    return false;
}

function SendLicenseItem(
    socket,
    key,
    license
) {
    SendLine(
        socket,
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
            !Number.isInteger(
                days
            ) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_DAYS'
            );

            return;
        }

        const result =
            CreateLicense(
                days,
                memo
            );

        SendLine(
            connection.socket,
            'LIC_OK|' +
            result.key +
            '|' +
            result.expiresAt
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
            SendLicenseItem(
                connection.socket,
                key,
                license
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
            'LIC_SEARCH|'
        )
    ) {
        if (
            !IsAdminAllowed(
                connection,
                'SEARCH'
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
            String(
                parts[1] || ''
            )
                .trim()
                .toUpperCase();

        const status =
            String(
                parts[2] || ''
            )
                .trim()
                .toUpperCase();

        const clientID =
            NormalizeID(
                parts[3] || ''
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
                status !== licenseStatus
            ) {
                continue;
            }

            if (
                clientID &&
                NormalizeID(
                    license.boundClient ||
                    ''
                ) !== clientID
            ) {
                continue;
            }

            if (query) {
                const text =
                    (
                        key +
                        '|' +
                        license.memo +
                        '|' +
                        license.boundClient
                    ).toUpperCase();

                if (
                    !text.includes(
                        query
                    )
                ) {
                    continue;
                }
            }

            SendLicenseItem(
                connection.socket,
                key,
                license
            );
        }

        SendLine(
            connection.socket,
            'END_SEARCH'
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
            !Number.isInteger(
                days
            ) ||
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

        SaveDatabase();

        if (
            license.boundClient
        ) {
            const client =
                GetOnlineClient(
                    license.boundClient
                );

            if (client) {
                PushLicenseState(
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
                line.split('|')[1] || ''
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

        const clientID =
            license.boundClient;

        licenses.delete(
            key
        );

        SaveDatabase();

        if (clientID) {
            const client =
                GetOnlineClient(
                    clientID
                );

            if (client) {
                client.licenseAuthorized =
                    false;

                client.licenseKey =
                    '';

                client.licenseExpiresAt =
                    0;

                SendLine(
                    client.socket,
                    'LICENSE_ERROR|REVOKED'
                );
            }

            NotifyServerUnauthorized(
                clientID,
                'REVOKED'
            );
        }

        SendLine(
            connection.socket,
            'LIC_DELETE_OK|' +
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
                line.split('|')[1] || ''
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

        const clientID =
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

        SaveDatabase();

        if (clientID) {
            const client =
                GetOnlineClient(
                    clientID
                );

            if (client) {
                client.licenseAuthorized =
                    false;

                client.licenseKey =
                    '';

                client.licenseExpiresAt =
                    0;

                SendLine(
                    client.socket,
                    'LICENSE_ERROR|UNBOUND'
                );
            }

            NotifyServerUnauthorized(
                clientID,
                'UNBOUND'
            );
        }

        SendLine(
            connection.socket,
            'LIC_UNBIND_OK|' +
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
                line.split('|')[1] || ''
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

        SaveDatabase();

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
                    '';

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
                line.split('|')[1] || ''
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

        SaveDatabase();

        if (
            license.boundClient
        ) {
            const client =
                GetOnlineClient(
                    license.boundClient
                );

            if (client) {
                PushLicenseState(
                    client
                );
            }
        }

        SendLine(
            connection.socket,
            'LIC_RESUME_OK|' +
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

        const result =
            ReissueLicense(
                line.split('|')[1] || ''
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

        const result =
            TransferLicense(
                parts[1] || '',
                parts[2] || ''
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
            NormalizeLicenseKey(
                parts[1] || ''
            ) +
            '|' +
            NormalizeID(
                parts[2] || ''
            )
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
            !Number.isInteger(
                days
            ) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_DAYS'
            );

            return;
        }

        let success = 0;

        for (
            const rawKey
            of parts.slice(2)
        ) {
            const key =
                NormalizeLicenseKey(
                    rawKey
                );

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
                    PushLicenseState(
                        client
                    );
                }
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_EXTEND_OK|' +
            success +
            '|' +
            Math.max(
                0,
                parts.length - 2
            )
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

        const parts =
            line.split('|');

        let success = 0;

        for (
            const rawKey
            of parts.slice(1)
        ) {
            const key =
                NormalizeLicenseKey(
                    rawKey
                );

            const license =
                FindLicense(
                    key
                );

            if (!license) {
                continue;
            }

            const clientID =
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

            if (clientID) {
                const client =
                    GetOnlineClient(
                        clientID
                    );

                if (client) {
                    client.licenseAuthorized =
                        false;

                    client.licenseKey =
                        '';

                    client.licenseExpiresAt =
                        0;

                    SendLine(
                        client.socket,
                        'LICENSE_ERROR|UNBOUND'
                    );
                }

                NotifyServerUnauthorized(
                    clientID,
                    'UNBOUND'
                );
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_UNBIND_OK|' +
            success
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

        const parts =
            line.split('|');

        let success = 0;

        for (
            const rawKey
            of parts.slice(1)
        ) {
            const key =
                NormalizeLicenseKey(
                    rawKey
                );

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
                        '';

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

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_SUSPEND_OK|' +
            success
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

        const parts =
            line.split('|');

        let success = 0;

        for (
            const rawKey
            of parts.slice(1)
        ) {
            const key =
                NormalizeLicenseKey(
                    rawKey
                );

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
                    PushLicenseState(
                        client
                    );
                }
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_RESUME_OK|' +
            success
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

        const parts =
            line.split('|');

        let success = 0;

        for (
            const rawKey
            of parts.slice(1)
        ) {
            const key =
                NormalizeLicenseKey(
                    rawKey
                );

            const license =
                FindLicense(
                    key
                );

            if (!license) {
                continue;
            }

            const clientID =
                license.boundClient;

            licenses.delete(
                key
            );

            success++;

            if (clientID) {
                const client =
                    GetOnlineClient(
                        clientID
                    );

                if (client) {
                    client.licenseAuthorized =
                        false;

                    client.licenseKey =
                        '';

                    client.licenseExpiresAt =
                        0;

                    SendLine(
                        client.socket,
                        'LICENSE_ERROR|REVOKED'
                    );
                }

                NotifyServerUnauthorized(
                    clientID,
                    'REVOKED'
                );
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_DELETE_OK|' +
            success
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
        let available = 0;
        let bound = 0;
        let expired = 0;
        let suspended = 0;

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
            switch (
                GetLicenseStatus(
                    license
                )
            ) {
                case 'AVAILABLE':
                    available++;
                    break;

                case 'BOUND':
                    bound++;
                    break;

                case 'EXPIRED':
                    expired++;
                    break;

                case 'SUSPENDED':
                    suspended++;
                    break;
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
            available +
            '|BOUND=' +
            bound +
            '|EXPIRED=' +
            expired +
            '|SUSPENDED=' +
            suspended +
            '|RATE_LIMIT=' +
            RATE_LIMIT_MAX
        );

        for (
            const event
            of events.slice(
                Math.max(
                    0,
                    events.length - 20
                )
            )
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
                deviceKey
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
                deviceKey +
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
                'CLIENT_DETAIL'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const clientID =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        const saved =
            GetSavedClientByID(
                clientID
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
                clientID
            );

        const online =
            !!GetOnlineClient(
                clientID
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
                'SERVER_TREE'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const serverID =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        const server =
            GetOnlineServer(
                serverID
            );

        if (!server) {
            SendLine(
                connection.socket,
                'SERVER_TREE_ERROR|OFFLINE'
            );

            return;
        }

        for (
            const clientID
            of server.clients
        ) {
            const client =
                GetOnlineClient(
                    clientID
                );

            const license =
                GetBoundLicense(
                    clientID
                );

            SendLine(
                connection.socket,
                'SERVER_TREE_CLIENT|' +
                clientID +
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
                'AUDIT'
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
            CreateBackup(
                'manual'
            );

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
            file
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

        EnsureBackupDir();

        let files = [];

        try {
            files =
                fs
                    .readdirSync(
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
        } catch (_) {}

        for (
            const file
            of files
        ) {
            try {
                const stat =
                    fs.statSync(
                        path.join(
                            BACKUP_DIR,
                            file
                        )
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
            } catch (_) {}
        }

        SendLine(
            connection.socket,
            'END_BACKUP_LIST'
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

        const file =
            path.basename(
                line.substring(
                    'BACKUP_DELETE|'.length
                )
            );

        const filePath =
            path.join(
                BACKUP_DIR,
                file
            );

        try {
            if (
                !fs.existsSync(
                    filePath
                )
            ) {
                SendLine(
                    connection.socket,
                    'BACKUP_ERROR|NOT_FOUND'
                );

                return;
            }

            fs.unlinkSync(
                filePath
            );

            SendLine(
                connection.socket,
                'BACKUP_DELETE_OK|' +
                file
            );
        } catch (_) {
            SendLine(
                connection.socket,
                'BACKUP_ERROR|DELETE_FAILED'
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

        const serverID =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        const server =
            GetOnlineServer(
                serverID
            );

        if (!server) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVER_NOT_ONLINE'
            );

            return;
        }

        SendLine(
            server.socket,
            'ERROR|ADMIN_KICK'
        );

        server.socket.destroy();

        SendLine(
            connection.socket,
            'SERVER_KICK_OK|' +
            serverID
        );

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

        SaveDatabase();

        for (
            const client
            of clients.values()
        ) {
            client.licenseAuthorized =
                false;

            client.licenseKey =
                '';

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

        SaveDatabase();

        SendLine(
            connection.socket,
            'SERVICE_START_OK'
        );

        for (
            const client
            of clients.values()
        ) {
            PushLicenseState(
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

        SaveDatabase();

        for (
            const client
            of clients.values()
        ) {
            client.licenseAuthorized =
                false;

            client.licenseKey =
                '';

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

        SaveDatabase();

        SendLine(
            connection.socket,
            'MAINTENANCE_OFF_OK'
        );

        for (
            const client
            of clients.values()
        ) {
            PushLicenseState(
                client
            );
        }

        return;
    }

    SendLine(
        connection.socket,
        'ADMIN_ERROR|UNKNOWN_COMMAND'
    );
}

function CleanupRequestHistory() {
    const cutoff =
        Now() -
        REQUEST_HISTORY_TIMEOUT;

    for (
        const [
            key,
            timestamp
        ]
        of requestHistory.entries()
    ) {
        if (
            timestamp <
            cutoff
        ) {
            requestHistory.delete(
                key
            );
        }
    }
}

function CleanupRateLimits() {
    const cutoff =
        Now() -
        RATE_LIMIT_WINDOW * 5;

    for (
        const [
            key,
            state
        ]
        of rateLimits.entries()
    ) {
        if (
            state.startedAt <
            cutoff
        ) {
            rateLimits.delete(
                key
            );
        }
    }
}

function ValidateClientLicense(
    connection
) {
    if (
        !connection.connected ||
        !connection.clientId
    ) {
        return;
    }

    if (!serviceEnabled) {
        if (
            connection.licenseAuthorized
        ) {
            connection.licenseAuthorized =
                false;

            connection.licenseKey =
                '';

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

    if (maintenanceMode) {
        if (
            connection.licenseAuthorized
        ) {
            connection.licenseAuthorized =
                false;

            connection.licenseKey =
                '';

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
        GetActiveLicense(
            connection.clientId
        );

    if (!active) {
        if (
            connection.licenseAuthorized
        ) {
            PushLicenseState(
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
        /*
          이미 라이선스를 직접 입력하지 않은
          신규 Client에게는 LICENSE_REQUIRED를
          먼저 보내지 않는다.
        */
        if (
            connection.licenseKey
        ) {
            PushLicenseState(
                connection
            );
        }
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

function HandleServer(
    socket
) {
    const connection = {
        socket,
        type: 'server',
        registered: false,
        connected: false,
        serverId: null,
        identityKey: null,
        lastSeen: Now(),
        lastIP:
            SafeIP(socket),
        clients:
            new Set(),
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

                HandleServerLine(
                    connection,
                    line
                );
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
        error => {
            console.error(
                '[SERVER SOCKET ERROR]',
                error.message
            );
        }
    );
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
        line.startsWith(
            'REGISTER|'
        )
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

        let serverID =
            serverIdentities.get(
                deviceKey
            );

        if (!serverID) {
            serverID =
                MakeUniqueID();

            serverIdentities.set(
                deviceKey,
                serverID
            );

            SaveDatabase();

            LogEvent(
                'SERVER_CREATE',
                serverID
            );
        }

        const old =
            servers.get(
                serverID
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
            serverID;

        connection.registered =
            true;

        connection.lastSeen =
            Now();

        connection.lastIP =
            SafeIP(
                connection.socket
            );

        servers.set(
            serverID,
            connection
        );

        SendLine(
            connection.socket,
            'REGISTERED|' +
            serverID
        );

        LogEvent(
            'SERVER_ONLINE',
            serverID
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

function CreateClientConnection(
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
            '',

        licenseExpiresAt:
            0,

        lastSeen:
            Now(),

        lastIP:
            SafeIP(socket),

        clients:
            new Set(),

        buffer:
            ''
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
                        line === 'CONNECT' ||
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
        error => {
            console.error(
                '[CLIENT SOCKET ERROR]',
                error.message
            );
        }
    );
}

LoadDatabase();

EnsureBackupDir();

const server =
    net.createServer(
        socket => {
            /*
              분류는 첫 줄을 보고 한다.
              그래서 기존 REGISTER / CONNECT
              프로토콜은 그대로 유지된다.
            */
            const firstBuffer = {
                socket,
                type: null
            };

            CreateClientConnection(
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
            'License: ENABLED'
        );

        console.log(
            'Bulk: ENABLED'
        );

        console.log(
            'Backup: ENABLED'
        );

        console.log(
            'Dashboard: ENABLED'
        );

        console.log(
            'Audit: ENABLED'
        );

        console.log(
            'Maintenance: ENABLED'
        );

        console.log(
            'Rate Limit: ' +
            RATE_LIMIT_MAX +
            '/sec'
        );

        console.log(
            '================================'
        );
    }
);

setInterval(
    () => {
        CleanupRequestHistory();
        CleanupRateLimits();

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

            SendLine(
                connection.socket,
                'PING'
            );

            ValidateClientLicense(
                connection
            );
        }

        for (
            const license
            of licenses.values()
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

                if (
                    client &&
                    client.licenseAuthorized
                ) {
                    client.licenseAuthorized =
                        false;

                    client.licenseKey =
                        '';

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
    },
    10000
);

setInterval(
    () => {
        SaveDatabase();
    },
    30000
);

setInterval(
    () => {
        CreateBackup(
            'auto'
        );
    },
    AUTO_BACKUP_INTERVAL
);

process.on(
    'SIGINT',
    () => {
        CreateBackup(
            'shutdown'
        );

        SaveDatabase();

        process.exit(
            0
        );
    }
);

process.on(
    'SIGTERM',
    () => {
        CreateBackup(
            'shutdown'
        );

        SaveDatabase();

        process.exit(
            0
        );
    }
);
