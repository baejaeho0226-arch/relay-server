'use strict';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 0);

const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : __dirname;
const DB_FILE = path.join(DATA_DIR, 'relay-identities.json');
const DB_BAK_FILE = path.join(DATA_DIR, 'relay-identities.bak.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');

const CURRENT_PROTOCOL_VERSION = 2;
const DEFAULT_MIN_PROTOCOL_VERSION = Number(process.env.MIN_PROTOCOL_VERSION || 1);
const DEFAULT_MIN_SERVER_VERSION = String(process.env.MIN_SERVER_VERSION || '1.0.0');
const DEFAULT_MIN_CLIENT_VERSION = String(process.env.MIN_CLIENT_VERSION || '1.0.0');

const ADMIN_CREDENTIALS = {
    admin: process.env.ADMIN_SECRET || 'ADMIN-SECRET-KEY-1234',
    operator: process.env.OPERATOR_SECRET || '',
    viewer: process.env.VIEWER_SECRET || ''
};

const ADMIN_AUTH_WINDOW_SECONDS = 60;
const ADMIN_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const CONFIRM_TOKEN_TTL_MS = 60 * 1000;

const SERVER_KICK_BLOCK_MS = 60 * 1000;
const CLIENT_KICK_BLOCK_MS = 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const MAX_CLIENTS_PER_SERVER = Math.max(1, Number(process.env.MAX_CLIENTS_PER_SERVER || 100));

const REQUEST_HISTORY_TIMEOUT_MS = 10 * 60 * 1000;
const ACK_RETRY_MS = 3000;
const ACK_TIMEOUT_MS = 10000;
const ACK_MAX_RETRIES = 2;

const MAX_INPUT_BUFFER = 64 * 1024;
const MAX_BULK_KEYS = 500;
const MAX_SEARCH_RESULTS = 500;
const MAX_EVENT_MEMORY = 2000;
const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BACKUPS = 30;

let serviceEnabled = true;
let maintenanceMode = false;
let minProtocolVersion = DEFAULT_MIN_PROTOCOL_VERSION;
let minServerVersion = DEFAULT_MIN_SERVER_VERSION;
let minClientVersion = DEFAULT_MIN_CLIENT_VERSION;
let maintenanceSchedule = null;

const servers = new Map();
const clients = new Map();
const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map();

const disabledServers = new Set();
const drainingServers = new Set();
const disabledClients = new Set();
const kickedServers = new Map();
const kickedClients = new Map();

const requestHistory = new Map();
const pendingRequests = new Map();
const rateLimits = new Map();
const events = [];

const confirmTokens = new Map();
const ipHistory = new Map();

const runtimeStats = {
    startedAt: Date.now(),
    totalConnections: 0,
    serverReconnects: new Map(),
    clientReconnects: new Map(),
    ackOk: 0,
    ackError: 0,
    ackTimeout: 0,
    ackRetries: 0,
    notices: 0
};

function Now() {
    return Date.now();
}

function RandomHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex').toUpperCase();
}

function RandomID() {
    return RandomHex(8);
}

function RandomNonce() {
    return RandomHex(32);
}

function RandomLicenseKey() {
    return 'LICENSE-' + RandomHex(10);
}

function RandomToken() {
    return RandomHex(24);
}

function EnsureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

function NormalizeID(id) {
    if (typeof id !== 'string') return '';

    id = id.trim().toUpperCase();

    if (id.startsWith('SERVER-'))
        id = id.substring(7);

    if (id.startsWith('CLIENT-'))
        id = id.substring(7);

    return /^[0-9A-F]{16}$/.test(id) ? id : '';
}

function NormalizeLicenseKey(key) {
    return typeof key === 'string'
        ? key.trim().toUpperCase()
        : '';
}

function NormalizeVersion(value) {
    const s = String(value || '').trim();

    return /^\d+(\.\d+){0,3}$/.test(s)
        ? s
        : '';
}

function CompareVersions(a, b) {
    a = NormalizeVersion(a);
    b = NormalizeVersion(b);

    if (!a || !b)
        return 0;

    const aa = a.split('.').map(Number);
    const bb = b.split('.').map(Number);
    const count = Math.max(aa.length, bb.length);

    for (let i = 0; i < count; i++) {
        const av = aa[i] || 0;
        const bv = bb[i] || 0;

        if (av < bv)
            return -1;

        if (av > bv)
            return 1;
    }

    return 0;
}

function IsVersionAtLeast(current, required) {
    return CompareVersions(current, required) >= 0;
}

function SafeField(text) {
    return String(text || '')
        .replace(/[\r\n|]/g, ' ')
        .trim();
}

function SafeIP(socket) {
    return socket
        ? String(socket.remoteAddress || '')
        : '';
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed)
        return false;

    try {
        socket.write(String(text) + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function ConstantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return false;

    const aa = Buffer.from(a);
    const bb = Buffer.from(b);

    return aa.length === bb.length &&
        crypto.timingSafeEqual(aa, bb);
}

function AuditFileForTime(ms) {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');

    return path.join(
        AUDIT_DIR,
        `audit-${yyyy}-${mm}-${dd}.jsonl`
    );
}

function LogEvent(type, detail) {
    const event = {
        time: Now(),
        type: SafeField(type),
        detail: SafeField(detail)
    };

    events.push(event);

    while (events.length > MAX_EVENT_MEMORY)
        events.shift();

    console.log(
        '[EVENT]',
        event.type,
        event.detail
    );

    try {
        fs.appendFileSync(
            AuditFileForTime(event.time),
            JSON.stringify(event) + '\n',
            'utf8'
        );
    } catch (error) {
        console.error(
            'AUDIT WRITE ERROR:',
            error.message
        );
    }
}

function LoadRecentAudit() {
    try {
        const files = fs
            .readdirSync(AUDIT_DIR)
            .filter(x =>
                /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)
            )
            .sort()
            .slice(-5);

        const loaded = [];

        for (const file of files) {
            const lines = fs
                .readFileSync(
                    path.join(AUDIT_DIR, file),
                    'utf8'
                )
                .split(/\r?\n/);

            for (const line of lines) {
                if (!line.trim())
                    continue;

                try {
                    const item = JSON.parse(line);

                    loaded.push({
                        time: Number(item.time) || 0,
                        type: SafeField(item.type),
                        detail: SafeField(item.detail)
                    });
                } catch (_) {}
            }
        }

        loaded.sort(
            (a, b) =>
                a.time - b.time
        );

        for (
            const item
            of loaded.slice(-MAX_EVENT_MEMORY)
        ) {
            events.push(item);
        }
    } catch (_) {}
}

function BuildDatabaseObject() {
    return {
        version: 100,
        serviceEnabled,
        maintenanceMode,
        minProtocolVersion,
        minServerVersion,
        minClientVersion,
        maintenanceSchedule,

        disabledServers:
            Array.from(disabledServers),

        drainingServers:
            Array.from(drainingServers),

        disabledClients:
            Array.from(disabledClients),

        servers:
            Object.fromEntries(serverIdentities),

        clients:
            Object.fromEntries(clientIdentities),

        licenses:
            Object.fromEntries(licenses)
    };
}

function SaveDatabase() {
    const tmp = DB_FILE + '.tmp';

    try {
        const text =
            JSON.stringify(
                BuildDatabaseObject(),
                null,
                2
            );

        if (fs.existsSync(DB_FILE)) {
            try {
                fs.copyFileSync(
                    DB_FILE,
                    DB_BAK_FILE
                );
            } catch (_) {}
        }

        fs.writeFileSync(
            tmp,
            text,
            'utf8'
        );

        fs.renameSync(
            tmp,
            DB_FILE
        );

        return true;
    } catch (error) {
        console.error(
            'DATABASE SAVE ERROR:',
            error.message
        );

        try {
            if (fs.existsSync(tmp))
                fs.unlinkSync(tmp);
        } catch (_) {}

        return false;
    }
}

function ImportDatabaseObject(data) {
    if (!data || typeof data !== 'object')
        return false;

    const newServers = new Map();
    const newClients = new Map();
    const newLicenses = new Map();
    const used = new Set();

    if (
        data.servers &&
        typeof data.servers === 'object'
    ) {
        for (
            const [deviceKey, rawId]
            of Object.entries(data.servers)
        ) {
            const key =
                String(deviceKey || '').trim();

            const id =
                NormalizeID(rawId);

            if (
                !key ||
                !id ||
                used.has(id)
            ) {
                continue;
            }

            newServers.set(
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

            const key =
                String(deviceKey || '').trim();

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
                !serverId ||
                used.has(id)
            ) {
                continue;
            }

            newClients.set(
                key,
                {
                    id,
                    serverId,

                    createdAt:
                        Number(value.createdAt) ||
                        Now(),

                    lastSeenAt:
                        Number(value.lastSeenAt) ||
                        0,

                    lastAuthAt:
                        Number(value.lastAuthAt) ||
                        0,

                    lastIP:
                        String(value.lastIP || ''),

                    authCount:
                        Number(value.authCount) ||
                        0,

                    sendCount:
                        Number(value.sendCount) ||
                        0,

                    reconnectCount:
                        Number(value.reconnectCount) ||
                        0
                }
            );

            used.add(id);
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
                NormalizeLicenseKey(rawKey);

            const expiresAt =
                Number(value.expiresAt);

            if (
                !key ||
                !Number.isFinite(expiresAt) ||
                expiresAt <= 0
            ) {
                continue;
            }

            newLicenses.set(
                key,
                {
                    createdAt:
                        Number(value.createdAt) ||
                        Now(),

                    expiresAt,

                    boundClient:
                        NormalizeID(
                            value.boundClient ||
                            ''
                        ),

                    boundAt:
                        Number(value.boundAt) ||
                        0,

                    lastAuthAt:
                        Number(value.lastAuthAt) ||
                        0,

                    lastSeenAt:
                        Number(value.lastSeenAt) ||
                        0,

                    lastIP:
                        String(value.lastIP || ''),

                    authCount:
                        Number(value.authCount) ||
                        0,

                    sendCount:
                        Number(value.sendCount) ||
                        0,

                    suspended:
                        Boolean(value.suspended),

                    memo:
                        SafeField(
                            value.memo ||
                            ''
                        )
                }
            );
        }
    }

    serverIdentities.clear();
    clientIdentities.clear();
    licenses.clear();
    disabledServers.clear();
    drainingServers.clear();
    disabledClients.clear();

    for (const [k, v] of newServers)
        serverIdentities.set(k, v);

    for (const [k, v] of newClients)
        clientIdentities.set(k, v);

    for (const [k, v] of newLicenses)
        licenses.set(k, v);

    for (
        const id
        of Array.isArray(data.disabledServers)
            ? data.disabledServers
            : []
    ) {
        const n = NormalizeID(id);

        if (n)
            disabledServers.add(n);
    }

    for (
        const id
        of Array.isArray(data.drainingServers)
            ? data.drainingServers
            : []
    ) {
        const n = NormalizeID(id);

        if (n)
            drainingServers.add(n);
    }

    for (
        const id
        of Array.isArray(data.disabledClients)
            ? data.disabledClients
            : []
    ) {
        const n = NormalizeID(id);

        if (n)
            disabledClients.add(n);
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

    const p =
        Number(
            data.minProtocolVersion
        );

    if (
        Number.isInteger(p) &&
        p >= 1 &&
        p <= CURRENT_PROTOCOL_VERSION
    ) {
        minProtocolVersion = p;
    }

    const sv =
        NormalizeVersion(
            data.minServerVersion
        );

    const cv =
        NormalizeVersion(
            data.minClientVersion
        );

    if (sv)
        minServerVersion = sv;

    if (cv)
        minClientVersion = cv;

    if (
        data.maintenanceSchedule &&
        typeof data.maintenanceSchedule ===
        'object'
    ) {
        const startAt =
            Number(
                data.maintenanceSchedule.startAt
            );

        const endAt =
            Number(
                data.maintenanceSchedule.endAt
            );

        if (
            startAt > 0 &&
            endAt > startAt
        ) {
            maintenanceSchedule = {
                startAt,
                endAt,

                message:
                    SafeField(
                        data.maintenanceSchedule.message ||
                        'Scheduled maintenance'
                    )
            };
        }
    } else {
        maintenanceSchedule = null;
    }

    return true;
}

function LatestBackupFile() {
    try {
        const files =
            fs
                .readdirSync(BACKUP_DIR)
                .filter(
                    x =>
                        x.endsWith('.json')
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

        return files.length
            ? path.join(
                BACKUP_DIR,
                files[0].file
            )
            : '';
    } catch (_) {
        return '';
    }
}

function TryLoadJson(file) {
    try {
        return JSON.parse(
            fs.readFileSync(
                file,
                'utf8'
            )
        );
    } catch (_) {
        return null;
    }
}

function LoadDatabase() {
    EnsureDirs();

    const candidates = [
        DB_FILE,
        DB_BAK_FILE,
        LatestBackupFile()
    ].filter(Boolean);

    for (const file of candidates) {
        if (!fs.existsSync(file))
            continue;

        const data =
            TryLoadJson(file);

        if (
            data &&
            ImportDatabaseObject(data)
        ) {
            if (file !== DB_FILE) {
                LogEvent(
                    'DATABASE_AUTO_RECOVER',
                    path.basename(file)
                );
            }

            SaveDatabase();

            return;
        }
    }

    SaveDatabase();
}

function CleanupBackups() {
    try {
        const files =
            fs
                .readdirSync(BACKUP_DIR)
                .filter(
                    x =>
                        x.endsWith('.json')
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
            let i = MAX_BACKUPS;
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

function CreateBackup(reason) {
    EnsureDirs();

    const stamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                '-'
            );

    const file =
        `relay-${stamp}-${SafeField(reason || 'backup')
            .replace(/[^A-Za-z0-9_-]/g, '_')}.json`;

    try {
        fs.writeFileSync(
            path.join(
                BACKUP_DIR,
                file
            ),
            JSON.stringify(
                BuildDatabaseObject(),
                null,
                2
            ),
            'utf8'
        );

        CleanupBackups();

        LogEvent(
            'BACKUP_CREATE',
            file
        );

        return file;
    } catch (error) {
        console.error(
            'BACKUP ERROR:',
            error.message
        );

        return '';
    }
}

function RestoreBackup(fileName) {
    const safe =
        path.basename(
            String(fileName || '')
        );

    const file =
        path.join(
            BACKUP_DIR,
            safe
        );

    if (!fs.existsSync(file)) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    const data =
        TryLoadJson(file);

    if (!data) {
        return {
            ok: false,
            reason: 'INVALID_DATA'
        };
    }

    const pre =
        CreateBackup(
            'pre_restore'
        );

    if (!ImportDatabaseObject(data)) {
        return {
            ok: false,
            reason: 'INVALID_DATA'
        };
    }

    requestHistory.clear();
    pendingRequests.clear();
    rateLimits.clear();
    kickedServers.clear();
    kickedClients.clear();

    SaveDatabase();

    LogEvent(
        'BACKUP_RESTORE',
        safe
    );

    setTimeout(
        () =>
            ForceReconnectAll(
                'DATABASE_RESTORED'
            ),
        250
    );

    return {
        ok: true,
        fileName: safe,
        preRestore: pre
    };
}

function GetUsedIDs() {
    const set = new Set();

    for (
        const id
        of serverIdentities.values()
    ) {
        if (id)
            set.add(id);
    }

    for (
        const saved
        of clientIdentities.values()
    ) {
        if (
            saved &&
            saved.id
        ) {
            set.add(saved.id);
        }
    }

    return set;
}

function MakeUniqueID() {
    const used = GetUsedIDs();
    let id;

    do {
        id = RandomID();
    } while (
        used.has(id)
    );

    return id;
}

function GetOnlineServer(serverId) {
    const c =
        servers.get(serverId);

    return (
        c &&
        c.registered &&
        c.socket &&
        !c.socket.destroyed
    ) ? c : null;
}

function GetOnlineClient(clientId) {
    const c =
        clients.get(clientId);

    return (
        c &&
        c.connected &&
        c.socket &&
        !c.socket.destroyed
    ) ? c : null;
}

function GetSavedClientByID(clientId) {
    clientId =
        NormalizeID(clientId);

    for (
        const saved
        of clientIdentities.values()
    ) {
        if (
            saved.id ===
            clientId
        ) {
            return saved;
        }
    }

    return null;
}

function FindClientDeviceKey(clientId) {
    clientId =
        NormalizeID(clientId);

    for (
        const [deviceKey, saved]
        of clientIdentities
    ) {
        if (
            saved.id ===
            clientId
        ) {
            return deviceKey;
        }
    }

    return '';
}

function FindServerDeviceKey(serverId) {
    serverId =
        NormalizeID(serverId);

    for (
        const [deviceKey, id]
        of serverIdentities
    ) {
        if (
            id ===
            serverId
        ) {
            return deviceKey;
        }
    }

    return '';
}

function ServerExists(serverId) {
    serverId =
        NormalizeID(serverId);

    return (
        !!serverId &&
        Array.from(
            serverIdentities.values()
        ).includes(serverId)
    );
}

function ClientExists(clientId) {
    return !!GetSavedClientByID(
        clientId
    );
}

function FindLicense(key) {
    return licenses.get(
        NormalizeLicenseKey(key)
    ) || null;
}

function GetBoundLicenseEntry(clientId) {
    clientId =
        NormalizeID(clientId);

    for (
        const [key, license]
        of licenses
    ) {
        if (
            license.boundClient ===
            clientId
        ) {
            return {
                key,
                license
            };
        }
    }

    return null;
}

function GetLicenseStatus(license) {
    if (!license)
        return 'UNKNOWN';

    if (license.suspended)
        return 'SUSPENDED';

    if (
        Now() >=
        license.expiresAt
    ) {
        return 'EXPIRED';
    }

    if (license.boundClient)
        return 'BOUND';

    return 'AVAILABLE';
}

function GetUsableLicenseForConnection(connection) {
    if (
        !connection ||
        !connection.clientId ||
        !connection.licenseAuthorized ||
        !serviceEnabled
    ) {
        return null;
    }

    const license =
        FindLicense(
            connection.licenseKey
        );

    if (!license)
        return null;

    if (
        license.boundClient !==
        connection.clientId ||
        license.suspended ||
        Now() >= license.expiresAt
    ) {
        return null;
    }

    return {
        key:
            connection.licenseKey,

        license
    };
}

function GetKickUntil(map, id) {
    const until =
        Number(
            map.get(id) ||
            0
        );

    if (
        until &&
        Now() >= until
    ) {
        map.delete(id);

        return 0;
    }

    return until;
}

function ServerHealth(connection) {
    if (!connection)
        return 'OFFLINE';

    const age =
        Now() -
        connection.lastSeen;

    if (age > 25000)
        return 'UNSTABLE';

    if (connection.rttMs < 0)
        return 'CONNECTING';

    if (connection.rttMs <= 300)
        return 'GOOD';

    if (connection.rttMs <= 1000)
        return 'SLOW';

    return 'UNSTABLE';
}

function ClientHealth(connection) {
    return ServerHealth(connection);
}

function TrackIP(kind, id, ip) {
    if (!id || !ip)
        return;

    const key =
        `${kind}:${id}`;

    const prev =
        ipHistory.get(key);

    if (
        prev &&
        prev.ip &&
        prev.ip !== ip
    ) {
        LogEvent(
            'IP_CHANGED',
            `${key} ${prev.ip} -> ${ip}`
        );
    }

    ipHistory.set(
        key,
        {
            ip,
            changedAt:
                Now()
        }
    );
}

function GetServerClientCount(serverId) {
    let count = 0;

    for (
        const saved
        of clientIdentities.values()
    ) {
        if (
            saved.serverId ===
            serverId
        ) {
            count++;
        }
    }

    return count;
}

function FindAvailableServer() {
    const list = [];

    for (
        const server
        of servers.values()
    ) {
        if (
            !server.registered ||
            !server.socket ||
            server.socket.destroyed
        ) {
            continue;
        }

        if (
            disabledServers.has(
                server.serverId
            ) ||
            drainingServers.has(
                server.serverId
            )
        ) {
            continue;
        }

        if (
            GetKickUntil(
                kickedServers,
                server.serverId
            ) > Now()
        ) {
            continue;
        }

        if (
            server.clients.size >=
            MAX_CLIENTS_PER_SERVER
        ) {
            continue;
        }

        list.push(server);
    }

    list.sort(
        (a, b) =>
            a.clients.size -
            b.clients.size
    );

    return list[0] || null;
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

    if (!server)
        return;

    const client =
        GetOnlineClient(
            clientId
        );

    const state =
        `AUTHORIZED|${expiresAt}`;

    if (
        client &&
        client.lastServerAuthState ===
        state
    ) {
        return;
    }

    if (client)
        client.lastServerAuthState = state;

    SendLine(
        server.socket,
        `CLIENT_AUTHORIZED|${clientId}|${expiresAt}`
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

    if (!saved)
        return;

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (!server)
        return;

    const client =
        GetOnlineClient(
            clientId
        );

    const state =
        `UNAUTHORIZED|${reason}`;

    if (
        client &&
        client.lastServerAuthState ===
        state
    ) {
        return;
    }

    if (client)
        client.lastServerAuthState = state;

    SendLine(
        server.socket,
        `CLIENT_UNAUTHORIZED|${clientId}|${reason}`
    );
}

function ValidateProtocolAndVersion(
    connection,
    kind,
    protocolVersion,
    appVersion
) {
    if (
        !Number.isInteger(protocolVersion) ||
        protocolVersion <
        minProtocolVersion
    ) {
        SendLine(
            connection.socket,
            `ERROR|PROTOCOL_UPDATE_REQUIRED|${minProtocolVersion}`
        );

        return false;
    }

    const required =
        kind === 'server'
            ? minServerVersion
            : minClientVersion;

    if (
        !NormalizeVersion(appVersion) ||
        !IsVersionAtLeast(
            appVersion,
            required
        )
    ) {
        SendLine(
            connection.socket,
            `ERROR|${
                kind === 'server'
                    ? 'SERVER'
                    : 'CLIENT'
            }_UPDATE_REQUIRED|${required}`
        );

        return false;
    }

    connection.protocolVersion =
        protocolVersion;

    connection.appVersion =
        appVersion;

    return true;
}

function RegisterServer(
    connection,
    deviceKey,
    protocolVersion,
    appVersion
) {
    deviceKey =
        String(
            deviceKey ||
            ''
        ).trim();

    if (!deviceKey) {
        SendLine(
            connection.socket,
            'ERROR|DEVICE_KEY_REQUIRED'
        );

        return false;
    }

    if (
        !ValidateProtocolAndVersion(
            connection,
            'server',
            protocolVersion,
            appVersion
        )
    ) {
        return false;
    }

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

        SaveDatabase();

        LogEvent(
            'SERVER_CREATE',
            `${serverId} -> ${deviceKey}`
        );
    }

    if (
        disabledServers.has(
            serverId
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_DISABLED'
        );

        return false;
    }

    const kickedUntil =
        GetKickUntil(
            kickedServers,
            serverId
        );

    if (
        kickedUntil >
        Now()
    ) {
        SendLine(
            connection.socket,
            `ERROR|SERVER_KICKED|${kickedUntil}`
        );

        return false;
    }

    const old =
        GetOnlineServer(
            serverId
        );

    if (
        old &&
        old !== connection
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

    connection.clients =
        new Set();

    connection.reconnectCount =
        (
            runtimeStats.serverReconnects.get(
                serverId
            ) ||
            0
        ) + 1;

    runtimeStats.serverReconnects.set(
        serverId,
        connection.reconnectCount
    );

    servers.set(
        serverId,
        connection
    );

    TrackIP(
        'SERVER',
        serverId,
        connection.lastIP
    );

    SendLine(
        connection.socket,
        `REGISTERED|${serverId}|${protocolVersion}|${appVersion}`
    );

    LogEvent(
        'SERVER_ONLINE',
        `${serverId} v${appVersion}`
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

        client.lastServerAuthState =
            '';

        if (
            client.licenseAuthorized
        ) {
            const active =
                GetUsableLicenseForConnection(
                    client
                );

            if (active) {
                NotifyServerAuthorized(
                    client.clientId,
                    serverId,
                    active.license.expiresAt
                );
            } else {
                NotifyServerUnauthorized(
                    client.clientId,
                    'LICENSE_REQUIRED'
                );
            }
        } else {
            NotifyServerUnauthorized(
                client.clientId,
                'LICENSE_REQUIRED'
            );
        }
    }

    return true;
}

function SendPing(connection) {
    if (
        !connection ||
        !connection.socket ||
        connection.socket.destroyed
    ) {
        return;
    }

    const token =
        RandomHex(6);

    connection.pendingPingToken =
        token;

    connection.pendingPingAt =
        Now();

    SendLine(
        connection.socket,
        `PING|${token}|${connection.pendingPingAt}`
    );
}

function HandlePong(
    connection,
    parts
) {
    connection.lastSeen =
        Now();

    const token =
        parts[1] ||
        '';

    if (
        token &&
        token === connection.pendingPingToken &&
        connection.pendingPingAt > 0
    ) {
        connection.rttMs =
            Math.max(
                0,
                Now() -
                connection.pendingPingAt
            );

        connection.pendingPingToken =
            '';

        connection.pendingPingAt =
            0;
    }
}

function MakeRequestKey(
    clientId,
    requestId
) {
    return (
        `${NormalizeID(clientId)}|${
            String(requestId || '').trim()
        }`
    );
}

function HandleServerAck(
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
            'ERROR|INVALID_ACK'
        );

        return;
    }

    const requestId =
        String(
            parts[1] ||
            ''
        ).trim();

    const clientId =
        NormalizeID(
            parts[2] ||
            ''
        );

    const result =
        String(
            parts[3] ||
            ''
        )
            .trim()
            .toUpperCase();

    const saved =
        GetSavedClientByID(
            clientId
        );

    if (
        !requestId ||
        !clientId ||
        !saved ||
        saved.serverId !==
        connection.serverId
    ) {
        SendLine(
            connection.socket,
            'ERROR|ACK_NOT_OWNER'
        );

        return;
    }

    const key =
        MakeRequestKey(
            clientId,
            requestId
        );

    const pending =
        pendingRequests.get(
            key
        );

    if (!pending) {
        SendLine(
            connection.socket,
            `ACK_RESULT|UNKNOWN|${requestId}`
        );

        return;
    }

    pendingRequests.delete(
        key
    );

    const client =
        GetOnlineClient(
            clientId
        );

    if (result === 'OK') {
        runtimeStats.ackOk++;

        if (client) {
            SendLine(
                client.socket,
                `ACK|OK|${requestId}`
            );
        }

        SendLine(
            connection.socket,
            `ACK_RESULT|OK|${requestId}`
        );

        LogEvent(
            'ACK_OK',
            `${requestId} / ${clientId}`
        );
    } else {
        runtimeStats.ackError++;

        const reason =
            parts.length >= 5
                ? SafeField(
                    parts
                        .slice(4)
                        .join(' ')
                )
                : 'PROCESS_FAILED';

        if (client) {
            SendLine(
                client.socket,
                `ACK|ERROR|${requestId}|${reason}`
            );
        }

        SendLine(
            connection.socket,
            `ACK_RESULT|ERROR|${requestId}`
        );

        LogEvent(
            'ACK_ERROR',
            `${requestId} / ${clientId} / ${reason}`
        );
    }
}

function HandleServerLine(
    connection,
    line
) {
    line = line.trim();

    if (!line)
        return;

    if (
        line === 'REGISTER' ||
        line.startsWith(
            'REGISTER|'
        )
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

        let protocolVersion = 1;
        let appVersion = '1.0.0';
        let deviceKey = '';

        if (
            parts.length >= 4
        ) {
            protocolVersion =
                Number(parts[1]);

            appVersion =
                String(
                    parts[2] ||
                    ''
                ).trim();

            deviceKey =
                parts
                    .slice(3)
                    .join('|')
                    .trim();
        } else if (
            parts.length >= 2
        ) {
            deviceKey =
                parts[1].trim();
        }

        const ok =
            RegisterServer(
                connection,
                deviceKey,
                protocolVersion,
                appVersion
            );

        if (!ok) {
            setTimeout(
                () => {
                    try {
                        connection.socket.destroy();
                    } catch (_) {}
                },
                150
            );
        }

        return;
    }

    if (
        line === 'PONG' ||
        line.startsWith(
            'PONG|'
        )
    ) {
        HandlePong(
            connection,
            line.split('|')
        );

        return;
    }

    if (
        line.startsWith(
            'ACK|'
        )
    ) {
        HandleServerAck(
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

function CreateClientIdentity(
    deviceKey,
    serverId
) {
    const old =
        clientIdentities.get(
            deviceKey
        );

    if (old)
        return old;

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
            0,

        reconnectCount:
            0
    };

    clientIdentities.set(
        deviceKey,
        saved
    );

    SaveDatabase();

    LogEvent(
        'CLIENT_CREATE',
        `${saved.id} -> ${deviceKey}`
    );

    return saved;
}

function AttachClient(
    connection,
    saved
) {
    const old =
        GetOnlineClient(
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

    connection.lastServerAuthState =
        '';

    connection.lastSeen =
        Now();

    connection.lastIP =
        SafeIP(
            connection.socket
        );

    clients.set(
        saved.id,
        connection
    );

    saved.lastSeenAt =
        Now();

    saved.lastIP =
        connection.lastIP;

    saved.reconnectCount =
        Number(
            saved.reconnectCount ||
            0
        ) + 1;

    runtimeStats.clientReconnects.set(
        saved.id,
        saved.reconnectCount
    );

    TrackIP(
        'CLIENT',
        saved.id,
        saved.lastIP
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
        `CONNECTED|${saved.id}|${saved.serverId}|${connection.protocolVersion}|${connection.appVersion}`
    );

    NotifyServerUnauthorized(
        saved.id,
        'LICENSE_REQUIRED'
    );

    LogEvent(
        'CLIENT_ONLINE',
        `${saved.id} v${connection.appVersion}`
    );
}

function HandleClientConnect(
    connection,
    deviceKey,
    protocolVersion,
    appVersion
) {
    if (
        !ValidateProtocolAndVersion(
            connection,
            'client',
            protocolVersion,
            appVersion
        )
    ) {
        setTimeout(
            () => {
                try {
                    connection.socket.destroy();
                } catch (_) {}
            },
            150
        );

        return;
    }

    if (!serviceEnabled) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|DISABLED'
        );

        return;
    }

    if (maintenanceMode) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|MAINTENANCE'
        );

        return;
    }

    deviceKey =
        String(
            deviceKey ||
            ''
        ).trim();

    if (!deviceKey) {
        SendLine(
            connection.socket,
            'ERROR|DEVICE_KEY_REQUIRED'
        );

        return;
    }

    let saved =
        clientIdentities.get(
            deviceKey
        );

    if (saved) {
        if (
            disabledClients.has(
                saved.id
            )
        ) {
            SendLine(
                connection.socket,
                'ERROR|CLIENT_DISABLED'
            );

            return;
        }

        const kickedUntil =
            GetKickUntil(
                kickedClients,
                saved.id
            );

        if (
            kickedUntil >
            Now()
        ) {
            SendLine(
                connection.socket,
                `ERROR|CLIENT_KICKED|${kickedUntil}`
            );

            return;
        }

        if (
            disabledServers.has(
                saved.serverId
            )
        ) {
            SendLine(
                connection.socket,
                'ERROR|SERVER_DISABLED'
            );

            return;
        }

        if (
            GetKickUntil(
                kickedServers,
                saved.serverId
            ) > Now() ||
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

    AttachClient(
        connection,
        saved
    );
}

function AuthorizeClient(
    connection,
    licenseKey
) {
    if (!serviceEnabled) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|DISABLED'
        );

        return;
    }

    if (
        maintenanceMode &&
        !connection.licenseAuthorized
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|MAINTENANCE'
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

    const license =
        FindLicense(
            licenseKey
        );

    if (
        !licenseKey ||
        !license
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|INVALID_KEY'
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

    const already =
        GetBoundLicenseEntry(
            connection.clientId
        );

    if (
        already &&
        already.key !== licenseKey
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|CLIENT_ALREADY_LICENSED'
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
            `${licenseKey} -> ${connection.clientId}`
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
            license.lastIP;

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

    connection.lastServerAuthState =
        '';

    SaveDatabase();

    SendLine(
        connection.socket,
        `LICENSE_OK|${licenseKey}|${license.expiresAt}`
    );

    NotifyServerAuthorized(
        connection.clientId,
        connection.serverId,
        license.expiresAt
    );

    const remainingDays =
        Math.ceil(
            (
                license.expiresAt -
                Now()
            ) /
            86400000
        );

    if (
        remainingDays <= 7
    ) {
        SendLine(
            connection.socket,
            `LICENSE_WARNING|${remainingDays}|${license.expiresAt}`
        );
    }

    LogEvent(
        'LICENSE_AUTH',
        `${licenseKey} -> ${connection.clientId}`
    );
}

function IsRateLimited(connection) {
    const key =
        connection.clientId ||
        `IP:${SafeIP(connection.socket)}`;

    const now =
        Now();

    let state =
        rateLimits.get(key);

    if (
        !state ||
        now -
        state.startedAt >=
        RATE_LIMIT_WINDOW_MS
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
            'SERVICE_STATE|DISABLED'
        );

        return;
    }

    if (
        maintenanceMode &&
        !connection.licenseAuthorized
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|MAINTENANCE'
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

    if (
        parts.length !== 4
    ) {
        SendLine(
            connection.socket,
            'ERROR|INVALID_SEND'
        );

        return;
    }

    const requestId =
        String(
            parts[1] ||
            ''
        ).trim();

    const clientId =
        NormalizeID(
            parts[2] ||
            ''
        );

    const number =
        String(
            parts[3] ||
            ''
        ).trim();

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

    if (
        !clientId ||
        connection.clientId !==
        clientId
    ) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_OWNER'
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

    const requestKey =
        MakeRequestKey(
            clientId,
            requestId
        );

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

    const active =
        GetUsableLicenseForConnection(
            connection
        );

    if (!active) {
        connection.licenseAuthorized =
            false;

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

    const server =
        saved
            ? GetOnlineServer(
                saved.serverId
            )
            : null;

    if (!saved) {
        SendLine(
            connection.socket,
            'ERROR|CLIENT_NOT_FOUND'
        );

        return;
    }

    if (!server) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_OFFLINE'
        );

        return;
    }

    const payload =
        `NUMBER|${requestId}|${clientId}|${number}`;

    if (
        !SendLine(
            server.socket,
            payload
        )
    ) {
        SendLine(
            connection.socket,
            'ERROR|SERVER_SEND_FAILED'
        );

        return;
    }

    requestHistory.set(
        requestKey,
        Now()
    );

    pendingRequests.set(
        requestKey,
        {
            clientId,
            serverId:
                saved.serverId,

            requestId,
            payload,

            createdAt:
                Now(),

            lastSendAt:
                Now(),

            retries:
                0
        }
    );

    active.license.lastSeenAt =
        Now();

    active.license.lastIP =
        SafeIP(
            connection.socket
        );

    active.license.sendCount =
        Number(
            active.license.sendCount ||
            0
        ) + 1;

    saved.lastSeenAt =
        Now();

    saved.lastIP =
        active.license.lastIP;

    saved.sendCount =
        Number(
            saved.sendCount ||
            0
        ) + 1;

    SaveDatabase();

    SendLine(
        connection.socket,
        `SENT|OK|${requestId}`
    );

    LogEvent(
        'NUMBER_SEND',
        `${requestId} / ${clientId} / ${number}`
    );
}

function HandleClientLine(
    connection,
    line
) {
    line = line.trim();

    if (!line)
        return;

    if (
        line === 'CONNECT' ||
        line.startsWith(
            'CONNECT|'
        )
    ) {
        const parts =
            line.split('|');

        let protocolVersion = 1;
        let appVersion = '1.0.0';
        let deviceKey = '';

        if (
            parts.length >= 4
        ) {
            protocolVersion =
                Number(
                    parts[1]
                );

            appVersion =
                String(
                    parts[2] ||
                    ''
                ).trim();

            deviceKey =
                parts
                    .slice(3)
                    .join('|')
                    .trim();
        } else if (
            parts.length >= 2
        ) {
            deviceKey =
                parts[1].trim();
        }

        HandleClientConnect(
            connection,
            deviceKey,
            protocolVersion,
            appVersion
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

        const requestedClient =
            parts.length >= 3
                ? NormalizeID(
                    parts[2]
                )
                : '';

        if (
            requestedClient &&
            requestedClient !==
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
            parts[1] ||
            ''
        );

        return;
    }

    if (
        line === 'PONG' ||
        line.startsWith(
            'PONG|'
        )
    ) {
        HandlePong(
            connection,
            line.split('|')
        );

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
    let key;

    do {
        key =
            RandomLicenseKey();
    } while (
        licenses.has(key)
    );

    const now =
        Now();

    const license = {
        createdAt:
            now,

        expiresAt:
            now +
            days *
            86400000,

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
            SafeField(memo)
    };

    licenses.set(
        key,
        license
    );

    SaveDatabase();

    LogEvent(
        'LICENSE_CREATE',
        key
    );

    return {
        key,
        expiresAt:
            license.expiresAt
    };
}

function ExtendLicense(
    key,
    days
) {
    const license =
        FindLicense(key);

    if (!license)
        return false;

    license.expiresAt =
        Math.max(
            Now(),
            license.expiresAt
        ) +
        days *
        86400000;

    if (
        license.boundClient
    ) {
        const client =
            GetOnlineClient(
                license.boundClient
            );

        if (
            client &&
            client.licenseAuthorized &&
            client.licenseKey ===
            NormalizeLicenseKey(key)
        ) {
            client.licenseExpiresAt =
                license.expiresAt;

            SendLine(
                client.socket,
                `LICENSE_UPDATED|${license.expiresAt}`
            );

            NotifyServerAuthorized(
                client.clientId,
                client.serverId,
                license.expiresAt
            );
        }
    }

    return true;
}

function RevokeLiveLicense(
    clientId,
    reason
) {
    const client =
        GetOnlineClient(
            clientId
        );

    if (client) {
        client.licenseAuthorized =
            false;

        client.licenseExpiresAt =
            0;

        client.lastServerAuthState =
            '';

        SendLine(
            client.socket,
            `LICENSE_ERROR|${reason}`
        );
    }

    NotifyServerUnauthorized(
        clientId,
        reason
    );
}

function UnbindLicense(key) {
    key =
        NormalizeLicenseKey(key);

    const license =
        FindLicense(key);

    if (!license)
        return false;

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

    if (oldClient) {
        RevokeLiveLicense(
            oldClient,
            'UNBOUND'
        );
    }

    return true;
}

function SuspendLicense(key) {
    const license =
        FindLicense(key);

    if (!license)
        return false;

    license.suspended =
        true;

    if (
        license.boundClient
    ) {
        RevokeLiveLicense(
            license.boundClient,
            'SUSPENDED'
        );
    }

    return true;
}

function ResumeLicense(key) {
    const license =
        FindLicense(key);

    if (
        !license ||
        Now() >=
        license.expiresAt
    ) {
        return false;
    }

    license.suspended =
        false;

    if (
        license.boundClient
    ) {
        const client =
            GetOnlineClient(
                license.boundClient
            );

        if (client) {
            SendLine(
                client.socket,
                `LICENSE_STATE|RESUMED|${license.expiresAt}`
            );
        }
    }

    return true;
}

function DeleteLicense(key) {
    key =
        NormalizeLicenseKey(key);

    const license =
        FindLicense(key);

    if (!license)
        return false;

    const clientId =
        license.boundClient;

    licenses.delete(key);

    if (clientId) {
        RevokeLiveLicense(
            clientId,
            'REVOKED'
        );
    }

    return true;
}

function ReissueLicense(oldKey) {
    oldKey =
        NormalizeLicenseKey(
            oldKey
        );

    const old =
        FindLicense(
            oldKey
        );

    if (
        !old ||
        old.expiresAt <=
        Now()
    ) {
        return null;
    }

    let newKey;

    do {
        newKey =
            RandomLicenseKey();
    } while (
        licenses.has(newKey)
    );

    const copy = {
        ...old,

        createdAt:
            Now(),

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
            false
    };

    const oldClient =
        old.boundClient;

    licenses.set(
        newKey,
        copy
    );

    licenses.delete(
        oldKey
    );

    if (oldClient) {
        RevokeLiveLicense(
            oldClient,
            'REISSUED'
        );
    }

    SaveDatabase();

    LogEvent(
        'LICENSE_REISSUE',
        `${oldKey} -> ${newKey}`
    );

    return {
        oldKey,
        newKey,
        expiresAt:
            copy.expiresAt
    };
}

function TransferLicense(
    key,
    newClientId
) {
    key =
        NormalizeLicenseKey(
            key
        );

    newClientId =
        NormalizeID(
            newClientId
        );

    const license =
        FindLicense(key);

    if (!license) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    if (
        !GetSavedClientByID(
            newClientId
        )
    ) {
        return {
            ok: false,
            reason: 'CLIENT_NOT_FOUND'
        };
    }

    const existing =
        GetBoundLicenseEntry(
            newClientId
        );

    if (
        existing &&
        existing.key !== key
    ) {
        return {
            ok: false,
            reason: 'CLIENT_ALREADY_LICENSED'
        };
    }

    const oldClient =
        license.boundClient;

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

    if (
        oldClient &&
        oldClient !==
        newClientId
    ) {
        RevokeLiveLicense(
            oldClient,
            'TRANSFERRED'
        );
    }

    const target =
        GetOnlineClient(
            newClientId
        );

    if (target) {
        NotifyServerUnauthorized(
            newClientId,
            'LICENSE_REQUIRED'
        );
    }

    SaveDatabase();

    LogEvent(
        'LICENSE_TRANSFER',
        `${key} -> ${newClientId}`
    );

    return {
        ok: true
    };
}

function ClientMove(
    clientId,
    newServerId
) {
    clientId =
        NormalizeID(
            clientId
        );

    newServerId =
        NormalizeID(
            newServerId
        );

    const saved =
        GetSavedClientByID(
            clientId
        );

    if (!saved) {
        return {
            ok: false,
            reason: 'CLIENT_NOT_FOUND'
        };
    }

    if (
        !ServerExists(
            newServerId
        )
    ) {
        return {
            ok: false,
            reason: 'SERVER_NOT_FOUND'
        };
    }

    if (
        disabledServers.has(
            newServerId
        )
    ) {
        return {
            ok: false,
            reason: 'SERVER_DISABLED'
        };
    }

    if (
        GetServerClientCount(
            newServerId
        ) >= MAX_CLIENTS_PER_SERVER &&
        saved.serverId !== newServerId
    ) {
        return {
            ok: false,
            reason: 'SERVER_FULL'
        };
    }

    const oldServer =
        saved.serverId;

    saved.serverId =
        newServerId;

    SaveDatabase();

    const live =
        GetOnlineClient(
            clientId
        );

    if (live) {
        SendLine(
            live.socket,
            `ERROR|CLIENT_MOVED|${newServerId}`
        );

        live.socket.destroy();
    }

    LogEvent(
        'CLIENT_MOVE',
        `${clientId} ${oldServer} -> ${newServerId}`
    );

    return {
        ok: true
    };
}

function SendLicenseItem(
    socket,
    key,
    license
) {
    SendLine(
        socket,
        [
            'LIC_ITEM',
            key,
            GetLicenseStatus(license),
            license.expiresAt,
            license.boundClient || '',
            SafeField(license.memo),
            license.createdAt,
            license.boundAt,
            license.lastAuthAt,
            license.lastSeenAt,
            license.lastIP,
            license.authCount,
            license.sendCount
        ].join('|')
    );
}

function SearchLicenses(
    query,
    status
) {
    query =
        String(
            query ||
            ''
        )
            .trim()
            .toUpperCase();

    status =
        String(
            status ||
            'ALL'
        )
            .trim()
            .toUpperCase();

    const out = [];

    for (
        const [key, license]
        of licenses
    ) {
        const st =
            GetLicenseStatus(
                license
            );

        if (
            status !== 'ALL' &&
            st !== status
        ) {
            continue;
        }

        if (
            query &&
            !`${key}|${license.boundClient}|${license.memo}`
                .toUpperCase()
                .includes(query)
        ) {
            continue;
        }

        out.push({
            key,
            license
        });

        if (
            out.length >=
            MAX_SEARCH_RESULTS
        ) {
            break;
        }
    }

    return out;
}

function ResolveAdminRole(role) {
    const r =
        String(
            role ||
            ''
        )
            .trim()
            .toLowerCase();

    return [
        'admin',
        'operator',
        'viewer'
    ].includes(r)
        ? r
        : '';
}

function RoleConfigured(role) {
    return !!ADMIN_CREDENTIALS[
        role
    ];
}

function AdminAllowed(
    role,
    operation
) {
    if (role === 'admin')
        return true;

    const viewer =
        new Set([
            'WHOAMI',
            'LIST',
            'SEARCH',
            'VIEW',
            'DASHBOARD',
            'SERVER_LIST',
            'CLIENT_LIST',
            'CLIENT_DETAIL',
            'SERVER_TREE',
            'AUDIT',
            'VERSION_STATUS',
            'SCHEDULE_STATUS'
        ]);

    const operator =
        new Set([
            ...viewer,
            'EXTEND',
            'UNBIND',
            'SUSPEND',
            'RESUME',
            'TRANSFER',
            'NOTICE'
        ]);

    return (
        role === 'viewer'
            ? viewer.has(operation)
            : role === 'operator'
                ? operator.has(operation)
                : false
    );
}

function MakeRoleHmac(
    role,
    nonce,
    timestamp
) {
    return crypto
        .createHmac(
            'sha256',
            ADMIN_CREDENTIALS[role]
        )
        .update(
            `${role}|${nonce}|${timestamp}`,
            'utf8'
        )
        .digest('hex')
        .toUpperCase();
}

function HandleAdminHello(
    connection,
    line
) {
    const parts =
        line.split('|');

    const role =
        ResolveAdminRole(
            parts[1] ||
            'admin'
        );

    if (
        !role ||
        !RoleConfigured(role)
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|ROLE_NOT_CONFIGURED'
        );

        return;
    }

    connection.pendingAdminRole =
        role;

    connection.adminNonce =
        RandomNonce();

    connection.adminNonceCreatedAt =
        Now();

    connection.adminAuthenticated =
        false;

    SendLine(
        connection.socket,
        `CHALLENGE|${connection.adminNonce}|${role}`
    );
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

    const role =
        connection.pendingAdminRole;

    const nonce =
        parts[1];

    const timestampText =
        parts[2];

    const supplied =
        String(
            parts[3] ||
            ''
        )
            .trim()
            .toUpperCase();

    const timestamp =
        Number(
            timestampText
        );

    if (
        !role ||
        nonce !==
        connection.adminNonce ||
        !Number.isFinite(timestamp)
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|AUTH_FAILED'
        );

        return;
    }

    if (
        Now() -
        connection.adminNonceCreatedAt >
        60000 ||
        Math.abs(
            Math.floor(
                Now() /
                1000
            ) -
            timestamp
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
        MakeRoleHmac(
            role,
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
            `${role} ${SafeIP(connection.socket)}`
        );

        return;
    }

    connection.adminAuthenticated =
        true;

    connection.adminAuthenticatedAt =
        Now();

    connection.adminRole =
        role;

    connection.adminNonce =
        '';

    connection.pendingAdminRole =
        '';

    SendLine(
        connection.socket,
        `ADMIN_OK|${role}`
    );

    LogEvent(
        'ADMIN_AUTH',
        `${role} / ${SafeIP(connection.socket)}`
    );
}

const DANGEROUS_PREFIXES = [
    'SERVICE_STOP',
    'BACKUP_RESTORE|',
    'LIC_BULK_DELETE|',
    'SERVER_DISABLE|',
    'CLIENT_DISABLE|',
    'VERSION_SET|'
];

function IsDangerousCommand(line) {
    return DANGEROUS_PREFIXES.some(
        prefix =>
            line === prefix ||
            line.startsWith(prefix)
    );
}

function PrepareConfirm(
    connection,
    command
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

    const token =
        RandomToken();

    confirmTokens.set(
        token,
        {
            command,
            expiresAt:
                Now() +
                CONFIRM_TOKEN_TTL_MS,

            role:
                connection.adminRole
        }
    );

    SendLine(
        connection.socket,
        `CONFIRM_TOKEN|${token}|${Now() + CONFIRM_TOKEN_TTL_MS}`
    );
}

function ExecuteConfirmed(
    connection,
    token
) {
    const item =
        confirmTokens.get(
            token
        );

    confirmTokens.delete(
        token
    );

    if (
        !item ||
        item.expiresAt <
        Now() ||
        item.role !==
        connection.adminRole
    ) {
        SendLine(
            connection.socket,
            'CONFIRM_ERROR|INVALID_OR_EXPIRED'
        );

        return;
    }

    ExecuteAdminCommand(
        connection,
        item.command,
        true
    );
}

function ForceReconnectAll(reason) {
    for (
        const c
        of Array.from(
            clients.values()
        )
    ) {
        SendLine(
            c.socket,
            `ERROR|${reason}`
        );

        try {
            c.socket.destroy();
        } catch (_) {}
    }

    for (
        const c
        of Array.from(
            servers.values()
        )
    ) {
        SendLine(
            c.socket,
            `ERROR|${reason}`
        );

        try {
            c.socket.destroy();
        } catch (_) {}
    }
}

function NoticeAll(text) {
    const clean =
        SafeField(text);

    let count = 0;

    for (
        const client
        of clients.values()
    ) {
        if (
            SendLine(
                client.socket,
                `NOTICE|${clean}`
            )
        ) {
            count++;
        }
    }

    runtimeStats.notices +=
        count;

    LogEvent(
        'NOTICE_ALL',
        `${count} / ${clean}`
    );

    return count;
}

function NoticeClient(
    clientId,
    text
) {
    clientId =
        NormalizeID(
            clientId
        );

    const client =
        GetOnlineClient(
            clientId
        );

    if (!client)
        return false;

    const clean =
        SafeField(text);

    const ok =
        SendLine(
            client.socket,
            `NOTICE|${clean}`
        );

    if (ok) {
        runtimeStats.notices++;

        LogEvent(
            'NOTICE_CLIENT',
            `${clientId} / ${clean}`
        );
    }

    return ok;
}

function AuditSearch(
    query,
    type,
    sinceMs
) {
    query =
        String(
            query ||
            ''
        )
            .trim()
            .toUpperCase();

    type =
        String(
            type ||
            ''
        )
            .trim()
            .toUpperCase();

    sinceMs =
        Number(
            sinceMs
        ) ||
        0;

    return events
        .filter(
            e => {
                if (
                    sinceMs &&
                    e.time < sinceMs
                ) {
                    return false;
                }

                if (
                    type &&
                    type !== 'ALL' &&
                    e.type.toUpperCase() !==
                    type
                ) {
                    return false;
                }

                if (
                    query &&
                    !`${e.type}|${e.detail}`
                        .toUpperCase()
                        .includes(query)
                ) {
                    return false;
                }

                return true;
            }
        )
        .slice(
            -MAX_SEARCH_RESULTS
        );
}

function ExecuteAdminCommand(
    connection,
    line,
    confirmed = false
) {
    if (
        IsDangerousCommand(line) &&
        !confirmed
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|CONFIRM_REQUIRED'
        );

        return;
    }

    if (
        line === 'WHOAMI'
    ) {
        SendLine(
            connection.socket,
            `ADMIN_ROLE|${connection.adminRole}`
        );

        return;
    }

    if (
        line === 'VERSION_STATUS'
    ) {
        SendLine(
            connection.socket,
            `VERSION_STATUS|${minProtocolVersion}|${minServerVersion}|${minClientVersion}`
        );

        return;
    }

    if (
        line.startsWith(
            'VERSION_SET|'
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

        const p =
            line.split('|');

        const proto =
            Number(
                p[1]
            );

        const sv =
            NormalizeVersion(
                p[2]
            );

        const cv =
            NormalizeVersion(
                p[3]
            );

        if (
            !Number.isInteger(proto) ||
            proto < 1 ||
            proto >
            CURRENT_PROTOCOL_VERSION ||
            !sv ||
            !cv
        ) {
            SendLine(
                connection.socket,
                'VERSION_ERROR|INVALID'
            );

            return;
        }

        minProtocolVersion =
            proto;

        minServerVersion =
            sv;

        minClientVersion =
            cv;

        SaveDatabase();

        SendLine(
            connection.socket,
            `VERSION_SET_OK|${proto}|${sv}|${cv}`
        );

        LogEvent(
            'VERSION_POLICY_CHANGED',
            `P=${proto} S=${sv} C=${cv}`
        );

        setTimeout(
            EnforceVersionPolicy,
            250
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_CREATE|'
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

        const p =
            line.split('|');

        const days =
            Number(
                p[1]
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

        const created =
            CreateLicense(
                days,
                p
                    .slice(2)
                    .join('|')
            );

        SendLine(
            connection.socket,
            `LIC_OK|${created.key}|${created.expiresAt}`
        );

        return;
    }

    if (
        line === 'LIC_LIST'
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
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
            const [key, license]
            of licenses
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
            !AdminAllowed(
                connection.adminRole,
                'SEARCH'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        for (
            const item
            of SearchLicenses(
                p[1] ||
                '',
                p[2] ||
                'ALL'
            )
        ) {
            SendLicenseItem(
                connection.socket,
                item.key,
                item.license
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
            !AdminAllowed(
                connection.adminRole,
                'EXTEND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const days =
            Number(
                p[2]
            );

        const key =
            NormalizeLicenseKey(
                p[1]
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

        if (
            !ExtendLicense(
                key,
                days
            )
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            `LIC_EXTEND_OK|${key}|${FindLicense(key).expiresAt}`
        );

        LogEvent(
            'LICENSE_EXTEND',
            `${key} +${days}`
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_UNBIND|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
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

        if (
            !UnbindLicense(key)
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            `LIC_UNBIND_OK|${key}`
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
            !AdminAllowed(
                connection.adminRole,
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

        if (
            !SuspendLicense(key)
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            `LIC_SUSPEND_OK|${key}`
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
            !AdminAllowed(
                connection.adminRole,
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

        if (
            !ResumeLicense(key)
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND_OR_EXPIRED'
            );

            return;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            `LIC_RESUME_OK|${key}`
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

        const r =
            ReissueLicense(
                line.split('|')[1] ||
                ''
            );

        if (!r) {
            SendLine(
                connection.socket,
                'LIC_ERROR|REISSUE_FAILED'
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_REISSUE_OK|${r.oldKey}|${r.newKey}|${r.expiresAt}`
        );

        return;
    }

    if (
        line.startsWith(
            'LIC_TRANSFER|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'TRANSFER'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const r =
            TransferLicense(
                p[1] ||
                '',
                p[2] ||
                ''
            );

        if (!r.ok) {
            SendLine(
                connection.socket,
                `LIC_ERROR|${r.reason}`
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_TRANSFER_OK|${NormalizeLicenseKey(p[1])}|${NormalizeID(p[2])}`
        );

        return;
    }

    for (
        const def
        of [
            [
                'LIC_BULK_EXTEND|',
                'EXTEND'
            ],
            [
                'LIC_BULK_UNBIND|',
                'UNBIND'
            ],
            [
                'LIC_BULK_SUSPEND|',
                'SUSPEND'
            ],
            [
                'LIC_BULK_RESUME|',
                'RESUME'
            ],
            [
                'LIC_BULK_DELETE|',
                'DELETE'
            ]
        ]
    ) {
        if (
            !line.startsWith(
                def[0]
            )
        ) {
            continue;
        }

        const op =
            def[1];

        if (
            op === 'DELETE'
                ? connection.adminRole !==
                    'admin'
                : !AdminAllowed(
                    connection.adminRole,
                    op
                )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        let days = 0;
        let keys;

        if (
            op === 'EXTEND'
        ) {
            days =
                Number(
                    p[1]
                );

            keys =
                p.slice(2);

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
        } else {
            keys =
                p.slice(1);
        }

        keys =
            keys
                .map(
                    NormalizeLicenseKey
                )
                .filter(Boolean)
                .slice(
                    0,
                    MAX_BULK_KEYS
                );

        let success = 0;

        for (
            const key
            of keys
        ) {
            if (
                op === 'EXTEND' &&
                ExtendLicense(
                    key,
                    days
                )
            ) {
                success++;
            } else if (
                op === 'UNBIND' &&
                UnbindLicense(key)
            ) {
                success++;
            } else if (
                op === 'SUSPEND' &&
                SuspendLicense(key)
            ) {
                success++;
            } else if (
                op === 'RESUME' &&
                ResumeLicense(key)
            ) {
                success++;
            } else if (
                op === 'DELETE' &&
                DeleteLicense(key)
            ) {
                success++;
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            `${def[0].slice(0, -1)}_OK|${success}|${keys.length}`
        );

        return;
    }

    if (
        line === 'DASHBOARD'
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
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
            const id
            of serverIdentities.values()
        ) {
            if (
                GetOnlineServer(id)
            ) {
                onlineServers++;
            }
        }

        for (
            const saved
            of clientIdentities.values()
        ) {
            if (
                GetOnlineClient(
                    saved.id
                )
            ) {
                onlineClients++;
            }
        }

        for (
            const license
            of licenses.values()
        ) {
            const s =
                GetLicenseStatus(
                    license
                );

            if (
                s === 'AVAILABLE'
            ) {
                available++;
            } else if (
                s === 'BOUND'
            ) {
                bound++;
            } else if (
                s === 'EXPIRED'
            ) {
                expired++;
            } else if (
                s === 'SUSPENDED'
            ) {
                suspended++;
            }
        }

        SendLine(
            connection.socket,
            [
                'DASH',
                `SERVICE=${serviceEnabled ? 'ONLINE' : 'OFFLINE'}`,
                `MAINTENANCE=${maintenanceMode ? 'ON' : 'OFF'}`,
                `SERVERS=${serverIdentities.size}`,
                `ONLINE_SERVERS=${onlineServers}`,
                `DISABLED_SERVERS=${disabledServers.size}`,
                `DRAINING_SERVERS=${drainingServers.size}`,
                `CLIENTS=${clientIdentities.size}`,
                `ONLINE_CLIENTS=${onlineClients}`,
                `DISABLED_CLIENTS=${disabledClients.size}`,
                `LICENSES=${licenses.size}`,
                `AVAILABLE=${available}`,
                `BOUND=${bound}`,
                `EXPIRED=${expired}`,
                `SUSPENDED=${suspended}`,
                `PENDING_ACKS=${pendingRequests.size}`,
                `ACK_OK=${runtimeStats.ackOk}`,
                `ACK_ERROR=${runtimeStats.ackError}`,
                `ACK_TIMEOUT=${runtimeStats.ackTimeout}`,
                `ACK_RETRIES=${runtimeStats.ackRetries}`,
                `MIN_PROTOCOL=${minProtocolVersion}`,
                `MIN_SERVER_VERSION=${minServerVersion}`,
                `MIN_CLIENT_VERSION=${minClientVersion}`,
                `MAX_CLIENTS_PER_SERVER=${MAX_CLIENTS_PER_SERVER}`,
                `RATE_LIMIT=${RATE_LIMIT_MAX}`,
                `UPTIME_MS=${Now() - runtimeStats.startedAt}`
            ].join('|')
        );

        for (
            const event
            of events.slice(-20)
        ) {
            SendLine(
                connection.socket,
                `EVENT|${event.time}|${event.type}|${event.detail}`
            );
        }

        SendLine(
            connection.socket,
            'END_DASHBOARD'
        );

        return;
    }

    if (
        line === 'SERVER_LIST'
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
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
            const [deviceKey, serverId]
            of serverIdentities
        ) {
            const live =
                GetOnlineServer(
                    serverId
                );

            const kickedUntil =
                GetKickUntil(
                    kickedServers,
                    serverId
                );

            let status =
                live
                    ? 'ONLINE'
                    : 'OFFLINE';

            if (
                disabledServers.has(
                    serverId
                )
            ) {
                status =
                    'DISABLED';
            } else if (
                drainingServers.has(
                    serverId
                )
            ) {
                status =
                    'DRAINING';
            } else if (
                kickedUntil >
                Now()
            ) {
                status =
                    'KICKED';
            }

            SendLine(
                connection.socket,
                [
                    'SERVER_ITEM',
                    serverId,
                    status,
                    live
                        ? live.clients.size
                        : 0,
                    deviceKey,
                    live
                        ? live.lastIP
                        : '',
                    live
                        ? live.lastSeen
                        : 0,
                    kickedUntil,
                    live
                        ? live.protocolVersion
                        : 0,
                    live
                        ? live.appVersion
                        : '',
                    live
                        ? live.rttMs
                        : -1,
                    live
                        ? ServerHealth(live)
                        : 'OFFLINE',
                    runtimeStats.serverReconnects.get(
                        serverId
                    ) || 0
                ].join('|')
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_LIST'
        );

        return;
    }

    if (
        line === 'CLIENT_LIST'
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
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
            const [deviceKey, saved]
            of clientIdentities
        ) {
            const live =
                GetOnlineClient(
                    saved.id
                );

            const boundLic =
                GetBoundLicenseEntry(
                    saved.id
                );

            const kickedUntil =
                GetKickUntil(
                    kickedClients,
                    saved.id
                );

            let status =
                live
                    ? 'ONLINE'
                    : 'OFFLINE';

            if (
                disabledClients.has(
                    saved.id
                )
            ) {
                status =
                    'DISABLED';
            } else if (
                kickedUntil >
                Now()
            ) {
                status =
                    'KICKED';
            }

            SendLine(
                connection.socket,
                [
                    'CLIENT_ITEM',
                    saved.id,
                    deviceKey,
                    saved.serverId,
                    status,
                    boundLic
                        ? GetLicenseStatus(
                            boundLic.license
                        )
                        : 'NONE',
                    boundLic
                        ? boundLic.key
                        : '',
                    boundLic
                        ? boundLic.license.expiresAt
                        : 0,
                    saved.lastAuthAt,
                    saved.lastSeenAt,
                    saved.lastIP,
                    saved.authCount,
                    saved.sendCount,
                    saved.reconnectCount,
                    live
                        ? live.protocolVersion
                        : 0,
                    live
                        ? live.appVersion
                        : '',
                    live
                        ? live.rttMs
                        : -1,
                    live
                        ? ClientHealth(live)
                        : 'OFFLINE'
                ].join('|')
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
            !AdminAllowed(
                connection.adminRole,
                'CLIENT_DETAIL'
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

            SendLine(
                connection.socket,
                'END_CLIENT_DETAIL'
            );

            return;
        }

        const live =
            GetOnlineClient(
                clientId
            );

        const lic =
            GetBoundLicenseEntry(
                clientId
            );

        SendLine(
            connection.socket,
            [
                'CLIENT_DETAIL_ITEM',
                clientId,
                live
                    ? 'ONLINE'
                    : 'OFFLINE',
                FindClientDeviceKey(
                    clientId
                ),
                saved.serverId,
                lic
                    ? lic.key
                    : '',
                lic
                    ? GetLicenseStatus(
                        lic.license
                    )
                    : 'NONE',
                lic
                    ? lic.license.expiresAt
                    : 0,
                saved.lastAuthAt,
                saved.lastSeenAt,
                saved.lastIP,
                saved.authCount,
                saved.sendCount,
                saved.reconnectCount,
                live
                    ? live.protocolVersion
                    : 0,
                live
                    ? live.appVersion
                    : '',
                live
                    ? live.rttMs
                    : -1,
                live
                    ? ClientHealth(live)
                    : 'OFFLINE'
            ].join('|')
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
            !AdminAllowed(
                connection.adminRole,
                'SERVER_TREE'
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

        if (
            !ServerExists(
                serverId
            )
        ) {
            SendLine(
                connection.socket,
                'SERVER_TREE_ERROR|NOT_FOUND'
            );

            SendLine(
                connection.socket,
                'END_SERVER_TREE'
            );

            return;
        }

        const live =
            GetOnlineServer(
                serverId
            );

        SendLine(
            connection.socket,
            `SERVER_TREE_SERVER|${serverId}|${FindServerDeviceKey(serverId)}|${live ? 'ONLINE' : 'OFFLINE'}|${live ? ServerHealth(live) : 'OFFLINE'}`
        );

        for (
            const [deviceKey, saved]
            of clientIdentities
        ) {
            if (
                saved.serverId !==
                serverId
            ) {
                continue;
            }

            const lic =
                GetBoundLicenseEntry(
                    saved.id
                );

            SendLine(
                connection.socket,
                `SERVER_TREE_CLIENT|${saved.id}|${deviceKey}|${GetOnlineClient(saved.id) ? 'ONLINE' : 'OFFLINE'}|${lic ? GetLicenseStatus(lic.license) : 'NONE'}`
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_TREE'
        );

        return;
    }

    if (
        line === 'AUDIT_LIST' ||
        line.startsWith(
            'AUDIT_SEARCH|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'AUDIT'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        let result = events;

        if (
            line.startsWith(
                'AUDIT_SEARCH|'
            )
        ) {
            const p =
                line.split('|');

            result =
                AuditSearch(
                    p[1] ||
                    '',
                    p[2] ||
                    'ALL',
                    Number(
                        p[3]
                    ) ||
                    0
                );
        }

        for (
            const e
            of result.slice(
                -MAX_SEARCH_RESULTS
            )
        ) {
            SendLine(
                connection.socket,
                `AUDIT|${e.time}|${e.type}|${e.detail}`
            );
        }

        SendLine(
            connection.socket,
            'END_AUDIT'
        );

        return;
    }

    if (
        line === 'BACKUP_CREATE'
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

        const f =
            CreateBackup(
                'manual'
            );

        SendLine(
            connection.socket,
            f
                ? `BACKUP_OK|${f}`
                : 'BACKUP_ERROR|CREATE_FAILED'
        );

        return;
    }

    if (
        line === 'BACKUP_LIST'
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'VIEW'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        try {
            for (
                const file
                of fs
                    .readdirSync(
                        BACKUP_DIR
                    )
                    .filter(
                        x =>
                            x.endsWith(
                                '.json'
                            )
                    )
                    .sort()
                    .reverse()
            ) {
                const st =
                    fs.statSync(
                        path.join(
                            BACKUP_DIR,
                            file
                        )
                    );

                SendLine(
                    connection.socket,
                    `BACKUP_ITEM|${file}|${st.size}|${st.mtimeMs}`
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

        const r =
            RestoreBackup(
                line.substring(
                    'BACKUP_RESTORE|'.length
                )
            );

        SendLine(
            connection.socket,
            r.ok
                ? `BACKUP_RESTORE_OK|${r.fileName}|${r.preRestore}`
                : `BACKUP_ERROR|${r.reason}`
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

        const fp =
            path.join(
                BACKUP_DIR,
                file
            );

        try {
            if (
                !fs.existsSync(fp)
            ) {
                SendLine(
                    connection.socket,
                    'BACKUP_ERROR|NOT_FOUND'
                );

                return;
            }

            fs.unlinkSync(fp);

            SendLine(
                connection.socket,
                `BACKUP_DELETE_OK|${file}`
            );

            LogEvent(
                'BACKUP_DELETE',
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

        const id =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ServerExists(id)
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVER_NOT_FOUND'
            );

            return;
        }

        const until =
            Now() +
            SERVER_KICK_BLOCK_MS;

        kickedServers.set(
            id,
            until
        );

        const live =
            GetOnlineServer(id);

        if (live) {
            SendLine(
                live.socket,
                `ERROR|ADMIN_KICK|${until}`
            );

            live.socket.destroy();
        }

        SendLine(
            connection.socket,
            `SERVER_KICK_OK|${id}|${until}`
        );

        LogEvent(
            'SERVER_KICK',
            `${id} until ${until}`
        );

        return;
    }

    if (
        line.startsWith(
            'SERVER_DISABLE|'
        ) ||
        line.startsWith(
            'SERVER_ENABLE|'
        ) ||
        line.startsWith(
            'SERVER_DRAIN_ON|'
        ) ||
        line.startsWith(
            'SERVER_DRAIN_OFF|'
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

        const p =
            line.split('|');

        const id =
            NormalizeID(
                p[1] ||
                ''
            );

        if (
            !ServerExists(id)
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVER_NOT_FOUND'
            );

            return;
        }

        if (
            line.startsWith(
                'SERVER_DISABLE|'
            )
        ) {
            disabledServers.add(id);
            drainingServers.delete(id);
            kickedServers.delete(id);

            SaveDatabase();

            const live =
                GetOnlineServer(id);

            if (live) {
                SendLine(
                    live.socket,
                    'ERROR|SERVER_DISABLED'
                );

                live.socket.destroy();
            }

            SendLine(
                connection.socket,
                `SERVER_DISABLE_OK|${id}`
            );

            LogEvent(
                'SERVER_DISABLE',
                id
            );
        } else if (
            line.startsWith(
                'SERVER_ENABLE|'
            )
        ) {
            disabledServers.delete(id);
            kickedServers.delete(id);

            SaveDatabase();

            SendLine(
                connection.socket,
                `SERVER_ENABLE_OK|${id}`
            );

            LogEvent(
                'SERVER_ENABLE',
                id
            );
        } else if (
            line.startsWith(
                'SERVER_DRAIN_ON|'
            )
        ) {
            drainingServers.add(id);

            SaveDatabase();

            SendLine(
                connection.socket,
                `SERVER_DRAIN_ON_OK|${id}`
            );

            LogEvent(
                'SERVER_DRAIN_ON',
                id
            );
        } else {
            drainingServers.delete(id);

            SaveDatabase();

            SendLine(
                connection.socket,
                `SERVER_DRAIN_OFF_OK|${id}`
            );

            LogEvent(
                'SERVER_DRAIN_OFF',
                id
            );
        }

        return;
    }

    if (
        line.startsWith(
            'CLIENT_KICK|'
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

        const id =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ClientExists(id)
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|CLIENT_NOT_FOUND'
            );

            return;
        }

        const until =
            Now() +
            CLIENT_KICK_BLOCK_MS;

        kickedClients.set(
            id,
            until
        );

        NotifyServerUnauthorized(
            id,
            'ADMIN_KICK'
        );

        const live =
            GetOnlineClient(id);

        if (live) {
            SendLine(
                live.socket,
                `ERROR|CLIENT_KICKED|${until}`
            );

            live.socket.destroy();
        }

        SendLine(
            connection.socket,
            `CLIENT_KICK_OK|${id}|${until}`
        );

        LogEvent(
            'CLIENT_KICK',
            `${id} until ${until}`
        );

        return;
    }

    if (
        line.startsWith(
            'CLIENT_DISABLE|'
        ) ||
        line.startsWith(
            'CLIENT_ENABLE|'
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

        const id =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ClientExists(id)
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|CLIENT_NOT_FOUND'
            );

            return;
        }

        if (
            line.startsWith(
                'CLIENT_DISABLE|'
            )
        ) {
            disabledClients.add(id);
            kickedClients.delete(id);

            SaveDatabase();

            NotifyServerUnauthorized(
                id,
                'CLIENT_DISABLED'
            );

            const live =
                GetOnlineClient(id);

            if (live) {
                SendLine(
                    live.socket,
                    'ERROR|CLIENT_DISABLED'
                );

                live.socket.destroy();
            }

            SendLine(
                connection.socket,
                `CLIENT_DISABLE_OK|${id}`
            );

            LogEvent(
                'CLIENT_DISABLE',
                id
            );
        } else {
            disabledClients.delete(id);
            kickedClients.delete(id);

            SaveDatabase();

            SendLine(
                connection.socket,
                `CLIENT_ENABLE_OK|${id}`
            );

            LogEvent(
                'CLIENT_ENABLE',
                id
            );
        }

        return;
    }

    if (
        line.startsWith(
            'CLIENT_MOVE|'
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

        const p =
            line.split('|');

        const r =
            ClientMove(
                p[1] ||
                '',
                p[2] ||
                ''
            );

        SendLine(
            connection.socket,
            r.ok
                ? `CLIENT_MOVE_OK|${NormalizeID(p[1])}|${NormalizeID(p[2])}`
                : `CLIENT_MOVE_ERROR|${r.reason}`
        );

        return;
    }

    if (
        line === 'SERVICE_STOP'
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
            const c
            of clients.values()
        ) {
            c.licenseAuthorized =
                false;

            c.licenseExpiresAt =
                0;

            c.lastServerAuthState =
                '';

            SendLine(
                c.socket,
                'SERVICE_STATE|DISABLED'
            );

            NotifyServerUnauthorized(
                c.clientId,
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
        line === 'SERVICE_START'
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

        maintenanceMode =
            false;

        SaveDatabase();

        for (
            const c
            of clients.values()
        ) {
            SendLine(
                c.socket,
                'SERVICE_STATE|ONLINE'
            );
        }

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

        return;
    }

    if (
        line === 'MAINTENANCE_ON'
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

        if (!serviceEnabled) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVICE_DISABLED'
            );

            return;
        }

        maintenanceMode =
            true;

        SaveDatabase();

        for (
            const c
            of clients.values()
        ) {
            if (
                !c.licenseAuthorized
            ) {
                SendLine(
                    c.socket,
                    'SERVICE_STATE|MAINTENANCE'
                );
            }
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
        line === 'MAINTENANCE_OFF'
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

        for (
            const c
            of clients.values()
        ) {
            SendLine(
                c.socket,
                'SERVICE_STATE|ONLINE'
            );
        }

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

        return;
    }

    if (
        line.startsWith(
            'MAINT_SCHEDULE|'
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

        const p =
            line.split('|');

        const startAt =
            Number(
                p[1]
            );

        const endAt =
            Number(
                p[2]
            );

        const message =
            SafeField(
                p
                    .slice(3)
                    .join('|') ||
                'Scheduled maintenance'
            );

        if (
            !(
                startAt > Now() &&
                endAt > startAt
            )
        ) {
            SendLine(
                connection.socket,
                'MAINT_SCHEDULE_ERROR|INVALID_TIME'
            );

            return;
        }

        maintenanceSchedule = {
            startAt,
            endAt,
            message
        };

        SaveDatabase();

        SendLine(
            connection.socket,
            `MAINT_SCHEDULE_OK|${startAt}|${endAt}|${message}`
        );

        LogEvent(
            'MAINT_SCHEDULE',
            `${startAt}-${endAt} ${message}`
        );

        return;
    }

    if (
        line ===
        'MAINT_SCHEDULE_CLEAR'
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

        maintenanceSchedule =
            null;

        SaveDatabase();

        SendLine(
            connection.socket,
            'MAINT_SCHEDULE_CLEAR_OK'
        );

        LogEvent(
            'MAINT_SCHEDULE_CLEAR',
            ''
        );

        return;
    }

    if (
        line ===
        'MAINT_SCHEDULE_STATUS'
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'SCHEDULE_STATUS'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        if (maintenanceSchedule) {
            SendLine(
                connection.socket,
                `MAINT_SCHEDULE_STATUS|${maintenanceSchedule.startAt}|${maintenanceSchedule.endAt}|${maintenanceSchedule.message}`
            );
        } else {
            SendLine(
                connection.socket,
                'MAINT_SCHEDULE_STATUS|NONE'
            );
        }

        return;
    }

    if (
        line.startsWith(
            'NOTICE_ALL|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'NOTICE'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const count =
            NoticeAll(
                line.substring(
                    'NOTICE_ALL|'.length
                )
            );

        SendLine(
            connection.socket,
            `NOTICE_ALL_OK|${count}`
        );

        return;
    }

    if (
        line.startsWith(
            'NOTICE_CLIENT|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'NOTICE'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const id =
            NormalizeID(
                p[1] ||
                ''
            );

        const ok =
            NoticeClient(
                id,
                p
                    .slice(2)
                    .join('|')
            );

        SendLine(
            connection.socket,
            ok
                ? `NOTICE_CLIENT_OK|${id}`
                : 'NOTICE_CLIENT_ERROR|OFFLINE'
        );

        return;
    }

    SendLine(
        connection.socket,
        'ADMIN_ERROR|UNKNOWN_COMMAND'
    );
}

function HandleAdminLine(
    connection,
    line
) {
    line = line.trim();

    if (!line)
        return;

    if (
        line === 'ADMIN_HELLO' ||
        line.startsWith(
            'ADMIN_HELLO|'
        )
    ) {
        HandleAdminHello(
            connection,
            line
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
        ADMIN_SESSION_TIMEOUT_MS
    ) {
        connection.adminAuthenticated =
            false;

        connection.adminRole =
            '';

        SendLine(
            connection.socket,
            'ADMIN_ERROR|SESSION_EXPIRED'
        );

        return;
    }

    if (
        line.startsWith(
            'CONFIRM_PREPARE|'
        )
    ) {
        let cmd = '';

        try {
            cmd =
                Buffer.from(
                    line.substring(
                        'CONFIRM_PREPARE|'.length
                    ),
                    'base64'
                ).toString(
                    'utf8'
                );
        } catch (_) {}

        if (
            !cmd ||
            !IsDangerousCommand(cmd)
        ) {
            SendLine(
                connection.socket,
                'CONFIRM_ERROR|INVALID_COMMAND'
            );

            return;
        }

        PrepareConfirm(
            connection,
            cmd
        );

        return;
    }

    if (
        line.startsWith(
            'CONFIRM_EXEC|'
        )
    ) {
        ExecuteConfirmed(
            connection,
            line.split('|')[1] ||
            ''
        );

        return;
    }

    ExecuteAdminCommand(
        connection,
        line,
        false
    );
}

function ValidateClientLicense(connection) {
    if (
        !connection ||
        !connection.connected ||
        !connection.clientId ||
        !connection.licenseAuthorized
    ) {
        return;
    }

    if (!serviceEnabled)
        return;

    const active =
        GetUsableLicenseForConnection(
            connection
        );

    if (active) {
        if (
            connection.licenseExpiresAt !==
            active.license.expiresAt
        ) {
            connection.licenseExpiresAt =
                active.license.expiresAt;

            SendLine(
                connection.socket,
                `LICENSE_UPDATED|${active.license.expiresAt}`
            );
        }

        const remainingDays =
            Math.ceil(
                (
                    active.license.expiresAt -
                    Now()
                ) /
                86400000
            );

        if (
            remainingDays <= 7 &&
            connection.lastExpiryWarningDay !==
            remainingDays
        ) {
            connection.lastExpiryWarningDay =
                remainingDays;

            SendLine(
                connection.socket,
                `LICENSE_WARNING|${remainingDays}|${active.license.expiresAt}`
            );
        }

        return;
    }

    const bound =
        GetBoundLicenseEntry(
            connection.clientId
        );

    connection.licenseAuthorized =
        false;

    connection.licenseExpiresAt =
        0;

    connection.lastServerAuthState =
        '';

    if (
        bound &&
        bound.license.suspended
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|SUSPENDED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'SUSPENDED'
        );
    } else if (
        bound &&
        Now() >=
        bound.license.expiresAt
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|EXPIRED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'EXPIRED'
        );
    } else {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|LICENSE_REQUIRED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'LICENSE_REQUIRED'
        );
    }
}

function CleanupRequestHistory() {
    const cutoff =
        Now() -
        REQUEST_HISTORY_TIMEOUT_MS;

    for (
        const [key, ts]
        of requestHistory
    ) {
        if (
            !Number.isFinite(ts) ||
            ts < cutoff
        ) {
            requestHistory.delete(
                key
            );
        }
    }
}

function ProcessPendingRequests() {
    const now =
        Now();

    for (
        const [key, p]
        of Array.from(
            pendingRequests.entries()
        )
    ) {
        if (
            now -
            p.createdAt >=
            ACK_TIMEOUT_MS
        ) {
            pendingRequests.delete(
                key
            );

            runtimeStats.ackTimeout++;

            const c =
                GetOnlineClient(
                    p.clientId
                );

            if (c) {
                SendLine(
                    c.socket,
                    `ACK|TIMEOUT|${p.requestId}`
                );
            }

            LogEvent(
                'ACK_TIMEOUT',
                `${p.requestId} / ${p.clientId}`
            );

            continue;
        }

        if (
            now -
            p.lastSendAt >=
            ACK_RETRY_MS &&
            p.retries <
            ACK_MAX_RETRIES
        ) {
            const s =
                GetOnlineServer(
                    p.serverId
                );

            if (!s)
                continue;

            if (
                SendLine(
                    s.socket,
                    p.payload
                )
            ) {
                p.retries++;
                p.lastSendAt = now;
                runtimeStats.ackRetries++;

                LogEvent(
                    'ACK_RETRY',
                    `${p.requestId} / ${p.clientId} #${p.retries}`
                );
            }
        }
    }
}

function FailPendingRequestsForServer(
    serverId,
    reason
) {
    for (
        const [key, p]
        of Array.from(
            pendingRequests.entries()
        )
    ) {
        if (
            p.serverId !==
            serverId
        ) {
            continue;
        }

        pendingRequests.delete(
            key
        );

        const c =
            GetOnlineClient(
                p.clientId
            );

        if (c) {
            SendLine(
                c.socket,
                `ACK|ERROR|${p.requestId}|${reason}`
            );
        }

        runtimeStats.ackError++;

        LogEvent(
            'ACK_FAILED',
            `${p.requestId} / ${p.clientId} / ${reason}`
        );
    }
}

function CleanupTransient() {
    const now =
        Now();

    for (
        const [key, state]
        of rateLimits
    ) {
        if (
            state.startedAt <
            now -
            RATE_LIMIT_WINDOW_MS *
            5
        ) {
            rateLimits.delete(key);
        }
    }

    for (
        const [id, until]
        of kickedServers
    ) {
        if (
            now >= until
        ) {
            kickedServers.delete(id);

            LogEvent(
                'SERVER_KICK_EXPIRED',
                id
            );
        }
    }

    for (
        const [id, until]
        of kickedClients
    ) {
        if (
            now >= until
        ) {
            kickedClients.delete(id);

            LogEvent(
                'CLIENT_KICK_EXPIRED',
                id
            );
        }
    }

    for (
        const [token, item]
        of confirmTokens
    ) {
        if (
            now >= item.expiresAt
        ) {
            confirmTokens.delete(token);
        }
    }
}

function EnforceVersionPolicy() {
    for (
        const c
        of Array.from(
            servers.values()
        )
    ) {
        if (
            c.protocolVersion <
            minProtocolVersion
        ) {
            SendLine(
                c.socket,
                `ERROR|PROTOCOL_UPDATE_REQUIRED|${minProtocolVersion}`
            );

            c.socket.destroy();

            continue;
        }

        if (
            !IsVersionAtLeast(
                c.appVersion,
                minServerVersion
            )
        ) {
            SendLine(
                c.socket,
                `ERROR|SERVER_UPDATE_REQUIRED|${minServerVersion}`
            );

            c.socket.destroy();
        }
    }

    for (
        const c
        of Array.from(
            clients.values()
        )
    ) {
        if (
            c.protocolVersion <
            minProtocolVersion
        ) {
            SendLine(
                c.socket,
                `ERROR|PROTOCOL_UPDATE_REQUIRED|${minProtocolVersion}`
            );

            c.socket.destroy();

            continue;
        }

        if (
            !IsVersionAtLeast(
                c.appVersion,
                minClientVersion
            )
        ) {
            SendLine(
                c.socket,
                `ERROR|CLIENT_UPDATE_REQUIRED|${minClientVersion}`
            );

            c.socket.destroy();
        }
    }
}

function ApplyMaintenanceSchedule() {
    if (!maintenanceSchedule)
        return;

    const now =
        Now();

    if (
        now >=
        maintenanceSchedule.startAt &&
        now <
        maintenanceSchedule.endAt &&
        !maintenanceMode
    ) {
        maintenanceMode =
            true;

        SaveDatabase();

        NoticeAll(
            maintenanceSchedule.message
        );

        for (
            const c
            of clients.values()
        ) {
            if (
                !c.licenseAuthorized
            ) {
                SendLine(
                    c.socket,
                    'SERVICE_STATE|MAINTENANCE'
                );
            }
        }

        LogEvent(
            'MAINT_SCHEDULE_STARTED',
            maintenanceSchedule.message
        );
    }

    if (
        now >=
        maintenanceSchedule.endAt
    ) {
        if (maintenanceMode) {
            maintenanceMode =
                false;

            for (
                const c
                of clients.values()
            ) {
                SendLine(
                    c.socket,
                    'SERVICE_STATE|ONLINE'
                );
            }

            LogEvent(
                'MAINT_SCHEDULE_ENDED',
                maintenanceSchedule.message
            );
        }

        maintenanceSchedule =
            null;

        SaveDatabase();
    }
}

function DisconnectConnection(connection) {
    if (
        connection.disconnected
    ) {
        return;
    }

    connection.disconnected =
        true;

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

        if (
            connection.serverId
        ) {
            FailPendingRequestsForServer(
                connection.serverId,
                'SERVER_OFFLINE'
            );

            LogEvent(
                'SERVER_OFFLINE',
                connection.serverId
            );
        }
    } else if (
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
            const s =
                GetOnlineServer(
                    connection.serverId
                );

            if (s) {
                s.clients.delete(
                    connection.clientId
                );
            }
        }

        if (
            connection.clientId
        ) {
            LogEvent(
                'CLIENT_OFFLINE',
                connection.clientId
            );
        }
    } else if (
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

function CreateConnection(socket) {
    runtimeStats.totalConnections++;

    const connection = {
        socket,
        type: null,

        registered: false,
        connected: false,

        identityKey: '',
        serverId: '',
        clientId: '',

        protocolVersion: 0,
        appVersion: '',

        licenseAuthorized: false,
        licenseKey: '',
        licenseExpiresAt: 0,
        lastExpiryWarningDay: null,
        lastServerAuthState: '',

        adminAuthenticated: false,
        adminAuthenticatedAt: 0,
        adminNonce: '',
        adminNonceCreatedAt: 0,
        adminRole: '',
        pendingAdminRole: '',

        lastSeen: Now(),
        lastIP: SafeIP(socket),

        clients: new Set(),
        buffer: '',

        pendingPingToken: '',
        pendingPingAt: 0,
        rttMs: -1,

        reconnectCount: 0,
        disconnected: false
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

            if (
                connection.buffer.length >
                MAX_INPUT_BUFFER
            ) {
                SendLine(
                    socket,
                    'ERROR|BUFFER_OVERFLOW'
                );

                socket.destroy();

                return;
            }

            while (true) {
                const pos =
                    connection.buffer.indexOf(
                        '\n'
                    );

                if (
                    pos < 0
                ) {
                    break;
                }

                let line =
                    connection.buffer
                        .substring(
                            0,
                            pos
                        )
                        .replace(
                            /\r$/,
                            ''
                        );

                connection.buffer =
                    connection.buffer.substring(
                        pos + 1
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
                        line === 'ADMIN_HELLO' ||
                        line.startsWith(
                            'ADMIN_HELLO|'
                        ) ||
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
        () =>
            DisconnectConnection(
                connection
            )
    );

    socket.on(
        'error',
        error =>
            console.error(
                '[SOCKET ERROR]',
                error.message
            )
    );
}

function HealthSnapshot() {
    let onlineServers = 0;
    let onlineClients = 0;

    for (
        const id
        of serverIdentities.values()
    ) {
        if (
            GetOnlineServer(id)
        ) {
            onlineServers++;
        }
    }

    for (
        const saved
        of clientIdentities.values()
    ) {
        if (
            GetOnlineClient(
                saved.id
            )
        ) {
            onlineClients++;
        }
    }

    return {
        ok:
            serviceEnabled,

        serviceEnabled,
        maintenanceMode,

        startedAt:
            runtimeStats.startedAt,

        uptimeMs:
            Now() -
            runtimeStats.startedAt,

        servers: {
            total:
                serverIdentities.size,

            online:
                onlineServers,

            disabled:
                disabledServers.size,

            draining:
                drainingServers.size
        },

        clients: {
            total:
                clientIdentities.size,

            online:
                onlineClients,

            disabled:
                disabledClients.size
        },

        licenses:
            licenses.size,

        pendingAcks:
            pendingRequests.size,

        ack: {
            ok:
                runtimeStats.ackOk,

            error:
                runtimeStats.ackError,

            timeout:
                runtimeStats.ackTimeout,

            retries:
                runtimeStats.ackRetries
        },

        versionPolicy: {
            minProtocolVersion,
            minServerVersion,
            minClientVersion
        },

        dataDir:
            DATA_DIR
    };
}

EnsureDirs();
LoadRecentAudit();
LoadDatabase();

const relayServer =
    net.createServer(
        CreateConnection
    );

relayServer.on(
    'error',
    error =>
        console.error(
            'SERVER ERROR:',
            error.message
        )
);

relayServer.listen(
    PORT,
    HOST,
    () => {
        console.log(
            '================================'
        );

        console.log(
            '       PURE TCP RELAY vNext'
        );

        console.log(
            '================================'
        );

        console.log(
            'TCP Port:',
            PORT
        );

        console.log(
            'DATA_DIR:',
            DATA_DIR
        );

        console.log(
            'Protocol current/min:',
            CURRENT_PROTOCOL_VERSION,
            '/',
            minProtocolVersion
        );

        console.log(
            'Min Server:',
            minServerVersion,
            'Min Client:',
            minClientVersion
        );

        console.log(
            'Max clients/server:',
            MAX_CLIENTS_PER_SERVER
        );

        console.log(
            'ACK retry/timeout:',
            ACK_RETRY_MS,
            '/',
            ACK_TIMEOUT_MS
        );

        console.log(
            'Service:',
            serviceEnabled
                ? 'ONLINE'
                : 'OFFLINE',
            'Maintenance:',
            maintenanceMode
                ? 'ON'
                : 'OFF'
        );

        console.log(
            '================================'
        );
    }
);

if (
    HEALTH_PORT > 0
) {
    const health =
        http.createServer(
            (req, res) => {
                if (
                    req.url !==
                    '/health' &&
                    req.url !==
                    '/healthz'
                ) {
                    res.writeHead(
                        404,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            error:
                                'not_found'
                        })
                    );

                    return;
                }

                const body =
                    HealthSnapshot();

                res.writeHead(
                    body.ok
                        ? 200
                        : 503,
                    {
                        'Content-Type':
                            'application/json',

                        'Cache-Control':
                            'no-store'
                    }
                );

                res.end(
                    JSON.stringify(
                        body
                    )
                );
            }
        );

    health.listen(
        HEALTH_PORT,
        HOST,
        () =>
            console.log(
                'Health HTTP Port:',
                HEALTH_PORT
            )
    );
}

setInterval(
    () => {
        CleanupRequestHistory();
        CleanupTransient();
        ProcessPendingRequests();
        ApplyMaintenanceSchedule();
    },
    1000
);

setInterval(
    () => {
        for (
            const c
            of Array.from(
                servers.values()
            )
        ) {
            if (
                !c.socket ||
                c.socket.destroyed
            ) {
                continue;
            }

            if (
                Now() -
                c.lastSeen >
                30000
            ) {
                c.socket.destroy();

                continue;
            }

            SendPing(c);
        }

        for (
            const c
            of Array.from(
                clients.values()
            )
        ) {
            if (
                !c.socket ||
                c.socket.destroyed
            ) {
                continue;
            }

            if (
                Now() -
                c.lastSeen >
                30000
            ) {
                c.socket.destroy();

                continue;
            }

            ValidateClientLicense(c);
            SendPing(c);
        }
    },
    10000
);

setInterval(
    () =>
        SaveDatabase(),
    30000
);

setInterval(
    () =>
        CreateBackup(
            'auto'
        ),
    AUTO_BACKUP_INTERVAL_MS
);

function Shutdown() {
    try {
        CreateBackup(
            'shutdown'
        );

        SaveDatabase();
    } finally {
        process.exit(0);
    }
}

process.on(
    'SIGINT',
    Shutdown
);

process.on(
    'SIGTERM',
    Shutdown
);
