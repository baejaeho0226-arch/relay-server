const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ADMIN-SECRET-KEY-1234';

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

const ADMIN_AUTH_WINDOW_SECONDS = 60;
const ADMIN_SESSION_TIMEOUT = 10 * 60 * 1000;

const REQUEST_HISTORY_TIMEOUT = 10 * 60 * 1000;

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);

const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BACKUPS = 30;
const MAX_EVENTS = 2000;
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
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function RandomNonce() {
    return crypto.randomBytes(32).toString('hex').toUpperCase();
}

function RandomLicenseKey() {
    return 'LICENSE-' + crypto.randomBytes(10).toString('hex').toUpperCase();
}

function NormalizeID(id) {
    if (typeof id !== 'string') return '';

    id = id.trim().toUpperCase();

    if (id.startsWith('SERVER-')) id = id.substring(7);
    if (id.startsWith('CLIENT-')) id = id.substring(7);

    if (!/^[0-9A-F]{16}$/.test(id)) return '';

    return id;
}

function NormalizeLicenseKey(key) {
    if (typeof key !== 'string') return '';
    return key.trim().toUpperCase();
}

function SanitizeMemo(memo) {
    if (typeof memo !== 'string') return '';

    return memo
        .replace(/\r/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\|/g, ' ')
        .trim();
}

function SafeIP(socket) {
    if (!socket) return '';
    return String(socket.remoteAddress || '');
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed) return false;

    try {
        socket.write(String(text) + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function LogEvent(type, detail) {
    const event = {
        time: Now(),
        type: String(type || ''),
        detail: String(detail || '')
    };

    events.push(event);

    while (events.length > MAX_EVENTS) {
        events.shift();
    }

    console.log('[EVENT]', event.type, event.detail);
}

function ConstantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;

    const aa = Buffer.from(a);
    const bb = Buffer.from(b);

    if (aa.length !== bb.length) return false;

    return crypto.timingSafeEqual(aa, bb);
}

function MakeAdminHmac(nonce, timestamp) {
    return crypto
        .createHmac('sha256', ADMIN_SECRET)
        .update(nonce + '|' + timestamp, 'utf8')
        .digest('hex')
        .toUpperCase();
}

function GetUsedIDs() {
    const result = new Set();

    for (const id of serverIdentities.values()) {
        if (id) result.add(id);
    }

    for (const saved of clientIdentities.values()) {
        if (saved && saved.id) result.add(saved.id);
    }

    return result;
}

function MakeUniqueID() {
    const used = GetUsedIDs();
    let id;

    do {
        id = RandomID();
    } while (used.has(id));

    return id;
}

function BuildDatabaseObject() {
    return {
        version: 40,
        serviceEnabled,
        maintenanceMode,
        servers: Object.fromEntries(serverIdentities),
        clients: Object.fromEntries(clientIdentities),
        licenses: Object.fromEntries(licenses)
    };
}

function SaveDatabase() {
    const temp = IDENTITY_FILE + '.tmp';

    try {
        fs.writeFileSync(temp, JSON.stringify(BuildDatabaseObject(), null, 2), 'utf8');
        fs.renameSync(temp, IDENTITY_FILE);
    } catch (error) {
        console.error('DATABASE SAVE ERROR:', error.message);

        try {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        } catch (_) {}
    }
}

function EnsureBackupDir() {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    } catch (error) {
        console.error('BACKUP DIRECTORY ERROR:', error.message);
    }
}

function CleanupBackups() {
    EnsureBackupDir();

    try {
        const files = fs
            .readdirSync(BACKUP_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => ({
                file,
                time: fs.statSync(path.join(BACKUP_DIR, file)).mtimeMs
            }))
            .sort((a, b) => b.time - a.time);

        for (let i = MAX_BACKUPS; i < files.length; i++) {
            try {
                fs.unlinkSync(path.join(BACKUP_DIR, files[i].file));
            } catch (_) {}
        }
    } catch (error) {
        console.error('BACKUP CLEANUP ERROR:', error.message);
    }
}

function CreateBackup(reason) {
    EnsureBackupDir();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const cleanReason = String(reason || 'backup').replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = 'relay-' + stamp + '-' + cleanReason + '.json';
    const filePath = path.join(BACKUP_DIR, fileName);

    try {
        fs.writeFileSync(filePath, JSON.stringify(BuildDatabaseObject(), null, 2), 'utf8');
        CleanupBackups();
        LogEvent('BACKUP_CREATE', fileName);
        return fileName;
    } catch (error) {
        console.error('BACKUP CREATE ERROR:', error.message);
        return '';
    }
}

function ImportDatabaseObject(data) {
    if (!data || typeof data !== 'object') return false;

    const newServers = new Map();
    const newClients = new Map();
    const newLicenses = new Map();
    const usedIDs = new Set();

    if (data.servers && typeof data.servers === 'object') {
        for (const [deviceKey, rawId] of Object.entries(data.servers)) {
            const key = String(deviceKey || '').trim();
            const id = NormalizeID(rawId);

            if (!key || !id || usedIDs.has(id)) continue;

            newServers.set(key, id);
            usedIDs.add(id);
        }
    }

    if (data.clients && typeof data.clients === 'object') {
        for (const [deviceKey, value] of Object.entries(data.clients)) {
            if (!value || typeof value !== 'object') continue;

            const key = String(deviceKey || '').trim();
            const id = NormalizeID(value.id || value.clientId);
            const serverId = NormalizeID(value.serverId);

            if (!key || !id || !serverId || usedIDs.has(id)) continue;

            newClients.set(key, {
                id,
                serverId,
                createdAt: Number(value.createdAt) || Now(),
                lastSeenAt: Number(value.lastSeenAt) || 0,
                lastAuthAt: Number(value.lastAuthAt) || 0,
                lastIP: String(value.lastIP || ''),
                authCount: Number(value.authCount) || 0,
                sendCount: Number(value.sendCount) || 0
            });

            usedIDs.add(id);
        }
    }

    if (data.licenses && typeof data.licenses === 'object') {
        for (const [rawKey, value] of Object.entries(data.licenses)) {
            if (!value || typeof value !== 'object') continue;

            const key = NormalizeLicenseKey(rawKey);
            const expiresAt = Number(value.expiresAt);

            if (!key || !Number.isFinite(expiresAt) || expiresAt <= 0) continue;

            newLicenses.set(key, {
                createdAt: Number(value.createdAt) || Now(),
                expiresAt,
                boundClient: NormalizeID(value.boundClient || ''),
                boundAt: Number(value.boundAt) || 0,
                lastAuthAt: Number(value.lastAuthAt) || 0,
                lastSeenAt: Number(value.lastSeenAt) || 0,
                lastIP: String(value.lastIP || ''),
                authCount: Number(value.authCount) || 0,
                sendCount: Number(value.sendCount) || 0,
                suspended: Boolean(value.suspended),
                memo: SanitizeMemo(value.memo || '')
            });
        }
    }

    serverIdentities.clear();
    clientIdentities.clear();
    licenses.clear();

    for (const [key, value] of newServers.entries()) {
        serverIdentities.set(key, value);
    }

    for (const [key, value] of newClients.entries()) {
        clientIdentities.set(key, value);
    }

    for (const [key, value] of newLicenses.entries()) {
        licenses.set(key, value);
    }

    if (typeof data.serviceEnabled === 'boolean') {
        serviceEnabled = data.serviceEnabled;
    }

    if (typeof data.maintenanceMode === 'boolean') {
        maintenanceMode = data.maintenanceMode;
    }

    return true;
}

function LoadDatabase() {
    EnsureBackupDir();

    if (!fs.existsSync(IDENTITY_FILE)) {
        SaveDatabase();
        return;
    }

    try {
        const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));

        if (!ImportDatabaseObject(data)) {
            console.error('DATABASE LOAD ERROR: INVALID DATA');
            return;
        }

        SaveDatabase();

        console.log('DATABASE LOADED');
        console.log('Servers:', serverIdentities.size);
        console.log('Clients:', clientIdentities.size);
        console.log('Licenses:', licenses.size);
    } catch (error) {
        console.error('DATABASE LOAD ERROR:', error.message);
    }
}

function RestoreBackup(fileName) {
    EnsureBackupDir();

    const safeName = path.basename(fileName);
    const filePath = path.join(BACKUP_DIR, safeName);

    if (!fs.existsSync(filePath)) {
        return { ok: false, reason: 'NOT_FOUND' };
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const preRestore = CreateBackup('pre_restore');

        if (!ImportDatabaseObject(data)) {
            return { ok: false, reason: 'INVALID_DATA' };
        }

        SaveDatabase();

        LogEvent('BACKUP_RESTORE', safeName);

        return {
            ok: true,
            fileName: safeName,
            preRestore
        };
    } catch (error) {
        console.error('BACKUP RESTORE ERROR:', error.message);

        return {
            ok: false,
            reason: 'RESTORE_FAILED'
        };
    }
}

function GetOnlineServer(serverId) {
    const server = servers.get(serverId);

    if (!server) return null;
    if (!server.registered) return null;
    if (!server.socket || server.socket.destroyed) return null;

    return server;
}

function GetOnlineClient(clientId) {
    const client = clients.get(clientId);

    if (!client) return null;
    if (!client.socket || client.socket.destroyed) return null;

    return client;
}

function GetSavedClientByID(clientId) {
    clientId = NormalizeID(clientId);

    if (!clientId) return null;

    for (const saved of clientIdentities.values()) {
        if (saved && saved.id === clientId) {
            return saved;
        }
    }

    return null;
}

function FindClientDeviceKey(clientId) {
    clientId = NormalizeID(clientId);

    if (!clientId) return '';

    for (const [deviceKey, saved] of clientIdentities.entries()) {
        if (saved.id === clientId) return deviceKey;
    }

    return '';
}

function FindServerDeviceKey(serverId) {
    serverId = NormalizeID(serverId);

    if (!serverId) return '';

    for (const [deviceKey, id] of serverIdentities.entries()) {
        if (id === serverId) return deviceKey;
    }

    return '';
}

function FindLicense(key) {
    key = NormalizeLicenseKey(key);

    if (!key) return null;

    return licenses.get(key) || null;
}

function GetBoundLicense(clientId) {
    clientId = NormalizeID(clientId);

    if (!clientId) return null;

    for (const [key, license] of licenses.entries()) {
        if (license.boundClient === clientId) {
            return {
                key,
                license
            };
        }
    }

    return null;
}

function GetLicenseStatus(license) {
    if (!license) return 'UNKNOWN';
    if (license.suspended) return 'SUSPENDED';
    if (Now() >= license.expiresAt) return 'EXPIRED';
    if (license.boundClient) return 'BOUND';

    return 'AVAILABLE';
}

function GetActiveLicense(clientId) {
    clientId = NormalizeID(clientId);

    if (!clientId) return null;
    if (!serviceEnabled) return null;
    if (maintenanceMode) return null;

    for (const [key, license] of licenses.entries()) {
        if (license.boundClient !== clientId) continue;
        if (license.suspended) continue;
        if (Now() >= license.expiresAt) continue;

        return {
            key,
            license
        };
    }

    return null;
}

function FindAvailableServer() {
    const list = [];

    for (const server of servers.values()) {
        if (!server.registered) continue;
        if (!server.socket || server.socket.destroyed) continue;

        list.push(server);
    }

    if (list.length === 0) return null;

    list.sort((a, b) => a.clients.size - b.clients.size);

    return list[0];
}

function NotifyServerAuthorized(clientId, serverId, expiresAt) {
    const server = GetOnlineServer(serverId);

    if (!server) return;

    const state = 'AUTHORIZED|' + expiresAt;

    const client = GetOnlineClient(clientId);

    if (client && client.lastServerAuthState === state) {
        return;
    }

    if (client) {
        client.lastServerAuthState = state;
    }

    SendLine(
        server.socket,
        'CLIENT_AUTHORIZED|' +
        clientId +
        '|' +
        expiresAt
    );
}

function NotifyServerUnauthorized(clientId, reason) {
    const saved = GetSavedClientByID(clientId);

    if (!saved) return;

    const server = GetOnlineServer(saved.serverId);

    if (!server) return;

    const state = 'UNAUTHORIZED|' + reason;
    const client = GetOnlineClient(clientId);

    if (client && client.lastServerAuthState === state) {
        return;
    }

    if (client) {
        client.lastServerAuthState = state;
    }

    SendLine(
        server.socket,
        'CLIENT_UNAUTHORIZED|' +
        clientId +
        '|' +
        reason
    );
}

function NotifyServerCurrentState(client, server) {
    if (!client || !client.clientId || !server) return;

    if (!serviceEnabled) {
        const state = 'UNAUTHORIZED|SERVICE_DISABLED';

        if (client.lastServerAuthState !== state) {
            client.lastServerAuthState = state;

            SendLine(
                server.socket,
                'CLIENT_UNAUTHORIZED|' +
                client.clientId +
                '|SERVICE_DISABLED'
            );
        }

        return;
    }

    if (maintenanceMode) {
        const state = 'UNAUTHORIZED|MAINTENANCE';

        if (client.lastServerAuthState !== state) {
            client.lastServerAuthState = state;

            SendLine(
                server.socket,
                'CLIENT_UNAUTHORIZED|' +
                client.clientId +
                '|MAINTENANCE'
            );
        }

        return;
    }

    const active = GetActiveLicense(client.clientId);

    if (active) {
        const state = 'AUTHORIZED|' + active.license.expiresAt;

        if (client.lastServerAuthState !== state) {
            client.lastServerAuthState = state;

            SendLine(
                server.socket,
                'CLIENT_AUTHORIZED|' +
                client.clientId +
                '|' +
                active.license.expiresAt
            );
        }

        return;
    }

    const state = 'UNAUTHORIZED|LICENSE_REQUIRED';

    if (client.lastServerAuthState !== state) {
        client.lastServerAuthState = state;

        SendLine(
            server.socket,
            'CLIENT_UNAUTHORIZED|' +
            client.clientId +
            '|LICENSE_REQUIRED'
        );
    }
}

function RegisterServer(connection, deviceKey) {
    deviceKey = String(deviceKey || '').trim();

    if (!deviceKey) {
        SendLine(connection.socket, 'ERROR|DEVICE_KEY_REQUIRED');
        return false;
    }

    let serverId = serverIdentities.get(deviceKey);

    if (!serverId) {
        serverId = MakeUniqueID();

        serverIdentities.set(deviceKey, serverId);

        SaveDatabase();

        LogEvent('SERVER_CREATE', serverId + ' -> ' + deviceKey);
    }

    const old = servers.get(serverId);

    if (old && old !== connection && old.socket && !old.socket.destroyed) {
        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.identityKey = deviceKey;
    connection.serverId = serverId;
    connection.registered = true;
    connection.lastSeen = Now();
    connection.lastIP = SafeIP(connection.socket);
    connection.clients = new Set();

    servers.set(serverId, connection);

    SendLine(
        connection.socket,
        'REGISTERED|' +
        serverId
    );

    LogEvent('SERVER_ONLINE', serverId);

    for (const client of clients.values()) {
        if (client.serverId !== serverId) continue;

        connection.clients.add(client.clientId);
        client.lastServerAuthState = '';

        NotifyServerCurrentState(client, connection);
    }

    return true;
}

function HandleServerLine(connection, line) {
    line = line.trim();

    if (!line) return;

    if (line === 'REGISTER' || line.startsWith('REGISTER|')) {
        if (connection.registered) {
            SendLine(connection.socket, 'ERROR|ALREADY_REGISTERED');
            return;
        }

        const parts = line.split('|');
        const deviceKey = parts.length >= 2 ? parts[1].trim() : '';

        RegisterServer(connection, deviceKey);
        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Now();
        return;
    }

    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

function CreateClientIdentity(deviceKey, serverId) {
    const existing = clientIdentities.get(deviceKey);

    if (existing) return existing;

    const saved = {
        id: MakeUniqueID(),
        serverId,
        createdAt: Now(),
        lastSeenAt: 0,
        lastAuthAt: 0,
        lastIP: '',
        authCount: 0,
        sendCount: 0
    };

    clientIdentities.set(deviceKey, saved);

    SaveDatabase();

    LogEvent('CLIENT_CREATE', saved.id + ' -> ' + deviceKey);

    return saved;
}

function AttachClient(connection, saved) {
    const old = clients.get(saved.id);

    if (old && old !== connection && old.socket && !old.socket.destroyed) {
        const oldServer = GetOnlineServer(old.serverId);

        if (oldServer) {
            oldServer.clients.delete(saved.id);
        }

        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.clientId = saved.id;
    connection.serverId = saved.serverId;
    connection.connected = true;
    connection.licenseAuthorized = false;
    connection.licenseKey = '';
    connection.licenseExpiresAt = 0;
    connection.lastServerAuthState = '';
    connection.lastSeen = Now();
    connection.lastIP = SafeIP(connection.socket);

    clients.set(saved.id, connection);

    saved.lastSeenAt = Now();
    saved.lastIP = SafeIP(connection.socket);

    const server = GetOnlineServer(saved.serverId);

    if (server) {
        server.clients.add(saved.id);
    }

    SaveDatabase();

    SendLine(
        connection.socket,
        'CONNECTED|' +
        saved.id +
        '|' +
        saved.serverId
    );

    LogEvent('CLIENT_ONLINE', saved.id);

    /*
        중요:
        여기에서 LICENSE_ERROR|LICENSE_REQUIRED 를
        Android로 보내지 않는다.

        LICENSE_AUTH 요청이 실제로 들어왔을 때만
        라이선스 성공/실패를 응답한다.
    */

    NotifyServerUnauthorized(
        saved.id,
        'LICENSE_REQUIRED'
    );
}

function HandleClientConnect(connection, deviceKey) {
    if (!serviceEnabled) {
        SendLine(connection.socket, 'SERVICE_ERROR|DISABLED');
        return;
    }

    if (maintenanceMode) {
        SendLine(connection.socket, 'SERVICE_ERROR|MAINTENANCE');
        return;
    }

    deviceKey = String(deviceKey || '').trim();

    if (!deviceKey) {
        SendLine(connection.socket, 'ERROR|DEVICE_KEY_REQUIRED');
        return;
    }

    let saved = clientIdentities.get(deviceKey);

    if (saved) {
        if (!GetOnlineServer(saved.serverId)) {
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
            return;
        }
    } else {
        const server = FindAvailableServer();

        if (!server) {
            SendLine(connection.socket, 'ERROR|NO_SERVER');
            return;
        }

        saved = CreateClientIdentity(deviceKey, server.serverId);
    }

    AttachClient(connection, saved);
}

function AuthorizeClient(connection, licenseKey) {
    if (!serviceEnabled) {
        SendLine(connection.socket, 'SERVICE_ERROR|DISABLED');
        return;
    }

    if (maintenanceMode) {
        SendLine(connection.socket, 'SERVICE_ERROR|MAINTENANCE');
        return;
    }

    if (!connection.connected || !connection.clientId) {
        SendLine(connection.socket, 'LICENSE_ERROR|CLIENT_NOT_CONNECTED');
        return;
    }

    licenseKey = NormalizeLicenseKey(licenseKey);

    if (!licenseKey) {
        SendLine(connection.socket, 'LICENSE_ERROR|INVALID_KEY');
        return;
    }

    const license = FindLicense(licenseKey);

    if (!license) {
        SendLine(connection.socket, 'LICENSE_ERROR|INVALID_KEY');
        NotifyServerUnauthorized(connection.clientId, 'INVALID_KEY');
        return;
    }

    if (license.suspended) {
        SendLine(connection.socket, 'LICENSE_ERROR|SUSPENDED');
        NotifyServerUnauthorized(connection.clientId, 'SUSPENDED');
        return;
    }

    if (Now() >= license.expiresAt) {
        SendLine(connection.socket, 'LICENSE_ERROR|EXPIRED');
        NotifyServerUnauthorized(connection.clientId, 'EXPIRED');
        return;
    }

    if (
        license.boundClient &&
        license.boundClient !== connection.clientId
    ) {
        SendLine(connection.socket, 'LICENSE_ERROR|BOUND_OTHER');
        return;
    }

    if (!license.boundClient) {
        license.boundClient = connection.clientId;
        license.boundAt = Now();

        LogEvent(
            'LICENSE_BOUND',
            licenseKey +
            ' -> ' +
            connection.clientId
        );
    }

    license.lastAuthAt = Now();
    license.lastSeenAt = Now();
    license.lastIP = SafeIP(connection.socket);
    license.authCount = Number(license.authCount || 0) + 1;

    const saved = GetSavedClientByID(connection.clientId);

    if (saved) {
        saved.lastAuthAt = Now();
        saved.lastSeenAt = Now();
        saved.lastIP = SafeIP(connection.socket);
        saved.authCount = Number(saved.authCount || 0) + 1;
    }

    connection.licenseAuthorized = true;
    connection.licenseKey = licenseKey;
    connection.licenseExpiresAt = license.expiresAt;
    connection.lastServerAuthState = '';

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

function IsRateLimited(connection) {
    const key =
        connection.clientId ||
        'IP:' +
        SafeIP(connection.socket);

    const now = Now();
    let state = rateLimits.get(key);

    if (
        !state ||
        now - state.startedAt >= RATE_LIMIT_WINDOW_MS
    ) {
        state = {
            startedAt: now,
            count: 0
        };

        rateLimits.set(key, state);
    }

    state.count++;

    return state.count > RATE_LIMIT_MAX;
}

function HandleClientSend(connection, line) {
    if (!serviceEnabled) {
        SendLine(connection.socket, 'SERVICE_ERROR|DISABLED');
        return;
    }

    if (maintenanceMode) {
        SendLine(connection.socket, 'SERVICE_ERROR|MAINTENANCE');
        return;
    }

    if (IsRateLimited(connection)) {
        SendLine(connection.socket, 'ERROR|RATE_LIMIT');
        return;
    }

    const parts = line.split('|');

    let requestId = '';
    let clientId = '';
    let number = '';

    if (parts.length === 4) {
        requestId = parts[1].trim();
        clientId = NormalizeID(parts[2]);
        number = parts[3].trim();
    } else if (parts.length === 3) {
        requestId = RandomID();
        clientId = NormalizeID(parts[1]);
        number = parts[2].trim();
    } else {
        SendLine(connection.socket, 'ERROR|INVALID_SEND');
        return;
    }

    if (!requestId || requestId.length > 64) {
        SendLine(connection.socket, 'ERROR|REQUEST_ID_INVALID');
        return;
    }

    if (!clientId) {
        SendLine(connection.socket, 'ERROR|CLIENT_ID_INVALID');
        return;
    }

    if (!/^-?\d+$/.test(number)) {
        SendLine(connection.socket, 'ERROR|NUMBER_ONLY');
        return;
    }

    if (connection.clientId !== clientId) {
        SendLine(connection.socket, 'ERROR|CLIENT_NOT_OWNER');
        return;
    }

    const requestKey =
        clientId +
        ':' +
        requestId;

    if (requestHistory.has(requestKey)) {
        SendLine(connection.socket, 'ERROR|DUPLICATE_REQUEST');
        return;
    }

    const active = GetActiveLicense(clientId);

    if (!active) {
        connection.licenseAuthorized = false;
        connection.licenseKey = '';
        connection.licenseExpiresAt = 0;
        connection.lastServerAuthState = '';

        SendLine(connection.socket, 'ERROR|LICENSE_REQUIRED');

        NotifyServerUnauthorized(
            clientId,
            'LICENSE_REQUIRED'
        );

        return;
    }

    requestHistory.set(requestKey, Now());

    const saved = GetSavedClientByID(clientId);

    if (!saved) {
        SendLine(connection.socket, 'ERROR|CLIENT_NOT_FOUND');
        return;
    }

    const server = GetOnlineServer(saved.serverId);

    if (!server) {
        SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
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
        SendLine(connection.socket, 'ERROR|SERVER_SEND_FAILED');
        return;
    }

    connection.licenseAuthorized = true;
    connection.licenseKey = active.key;
    connection.licenseExpiresAt = active.license.expiresAt;

    active.license.lastSeenAt = Now();
    active.license.lastIP = SafeIP(connection.socket);
    active.license.sendCount = Number(active.license.sendCount || 0) + 1;

    saved.lastSeenAt = Now();
    saved.lastIP = SafeIP(connection.socket);
    saved.sendCount = Number(saved.sendCount || 0) + 1;

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

function HandleClientLine(connection, line) {
    line = line.trim();

    if (!line) return;

    if (line === 'CONNECT' || line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const deviceKey = parts.length >= 2 ? parts[1].trim() : '';

        HandleClientConnect(connection, deviceKey);
        return;
    }

    if (line.startsWith('LICENSE_AUTH|')) {
        const parts = line.split('|');

        if (parts.length < 2) {
            SendLine(connection.socket, 'LICENSE_ERROR|INVALID_KEY');
            return;
        }

        const licenseKey = parts[1].trim();

        if (parts.length >= 3) {
            const requestedClientId = NormalizeID(parts[2]);

            if (
                requestedClientId &&
                requestedClientId !== connection.clientId
            ) {
                SendLine(connection.socket, 'LICENSE_ERROR|CLIENT_NOT_OWNER');
                return;
            }
        }

        AuthorizeClient(connection, licenseKey);
        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Now();

        const saved = GetSavedClientByID(connection.clientId);

        if (saved) {
            saved.lastSeenAt = Now();
            saved.lastIP = SafeIP(connection.socket);
        }

        return;
    }

    if (line.startsWith('SEND|')) {
        HandleClientSend(connection, line);
        return;
    }

    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

function CreateLicense(days, memo) {
    const now = Now();

    let key;

    do {
        key = RandomLicenseKey();
    } while (licenses.has(key));

    const license = {
        createdAt: now,
        expiresAt:
            now +
            days *
            24 *
            60 *
            60 *
            1000,

        boundClient: '',
        boundAt: 0,

        lastAuthAt: 0,
        lastSeenAt: 0,
        lastIP: '',

        authCount: 0,
        sendCount: 0,

        suspended: false,

        memo:
            SanitizeMemo(memo)
    };

    licenses.set(key, license);

    SaveDatabase();

    LogEvent('LICENSE_CREATE', key);

    return {
        key,
        expiresAt:
            license.expiresAt
    };
}

function ExtendLicense(license, days) {
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

function ReissueLicense(oldKey) {
    oldKey = NormalizeLicenseKey(oldKey);

    const oldLicense = FindLicense(oldKey);

    if (!oldLicense) return null;

    const remaining =
        oldLicense.expiresAt -
        Now();

    if (remaining <= 0) return null;

    let newKey;

    do {
        newKey = RandomLicenseKey();
    } while (licenses.has(newKey));

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

    const oldClient =
        oldLicense.boundClient;

    licenses.set(newKey, newLicense);
    licenses.delete(oldKey);

    SaveDatabase();

    if (oldClient) {
        const connection =
            GetOnlineClient(oldClient);

        if (connection) {
            connection.licenseAuthorized = false;
            connection.licenseKey = '';
            connection.licenseExpiresAt = 0;
            connection.lastServerAuthState = '';

            SendLine(
                connection.socket,
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

function TransferLicense(key, newClientId) {
    key = NormalizeLicenseKey(key);
    newClientId = NormalizeID(newClientId);

    const license = FindLicense(key);

    if (!license) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    if (!newClientId) {
        return {
            ok: false,
            reason: 'INVALID_CLIENT'
        };
    }

    if (!GetSavedClientByID(newClientId)) {
        return {
            ok: false,
            reason: 'CLIENT_NOT_FOUND'
        };
    }

    const oldClient =
        license.boundClient;

    license.boundClient = newClientId;
    license.boundAt = Now();

    license.lastAuthAt = 0;
    license.lastSeenAt = 0;
    license.lastIP = '';

    license.authCount = 0;
    license.sendCount = 0;

    SaveDatabase();

    if (oldClient && oldClient !== newClientId) {
        const oldConnection =
            GetOnlineClient(oldClient);

        if (oldConnection) {
            oldConnection.licenseAuthorized = false;
            oldConnection.licenseKey = '';
            oldConnection.licenseExpiresAt = 0;
            oldConnection.lastServerAuthState = '';

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
        GetOnlineClient(newClientId);

    if (newConnection) {
        newConnection.licenseAuthorized = true;
        newConnection.licenseKey = key;
        newConnection.licenseExpiresAt = license.expiresAt;
        newConnection.lastServerAuthState = '';

        SendLine(
            newConnection.socket,
            'LICENSE_OK|' +
            key +
            '|' +
            license.expiresAt
        );

        NotifyServerAuthorized(
            newClientId,
            newConnection.serverId,
            license.expiresAt
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

function ResolveAdminRole(role) {
    role =
        String(
            role ||
            'admin'
        )
            .trim()
            .toLowerCase();

    if (
        role === 'admin' ||
        role === 'operator' ||
        role === 'viewer'
    ) {
        return role;
    }

    return 'admin';
}

function IsAdminAllowed(connection, operation) {
    const role =
        connection.adminRole ||
        'admin';

    if (role === 'admin') return true;

    if (role === 'operator') {
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
        ].includes(operation);
    }

    if (role === 'viewer') {
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
        ].includes(operation);
    }

    return false;
}

function HandleAdminAuth(connection, line) {
    const parts = line.split('|');

    if (parts.length < 4) {
        SendLine(connection.socket, 'ADMIN_ERROR|AUTH_FORMAT');
        return;
    }

    const nonce = parts[1];
    const timestampText = parts[2];
    const suppliedHmac = parts[3].trim().toUpperCase();
    const requestedRole = parts.length >= 5 ? parts[4] : 'admin';

    const timestamp = Number(timestampText);

    if (!nonce || !Number.isFinite(timestamp)) {
        SendLine(connection.socket, 'ADMIN_ERROR|AUTH_FORMAT');
        return;
    }

    if (nonce !== connection.adminNonce) {
        SendLine(connection.socket, 'ADMIN_ERROR|BAD_NONCE');
        return;
    }

    if (
        Now() -
        connection.adminNonceCreatedAt >
        60000
    ) {
        SendLine(connection.socket, 'ADMIN_ERROR|AUTH_EXPIRED');
        return;
    }

    const nowSeconds =
        Math.floor(
            Now() /
            1000
        );

    if (
        Math.abs(
            nowSeconds -
            timestamp
        ) >
        ADMIN_AUTH_WINDOW_SECONDS
    ) {
        SendLine(connection.socket, 'ADMIN_ERROR|AUTH_EXPIRED');
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
        SendLine(connection.socket, 'ADMIN_ERROR|AUTH_FAILED');

        LogEvent(
            'ADMIN_AUTH_FAILED',
            SafeIP(connection.socket)
        );

        return;
    }

    connection.adminAuthenticated = true;
    connection.adminAuthenticatedAt = Now();
    connection.adminRole = ResolveAdminRole(requestedRole);
    connection.adminNonce = '';
    connection.lastSeen = Now();

    SendLine(
        connection.socket,
        'ADMIN_OK|' +
        connection.adminRole
    );

    LogEvent(
        'ADMIN_AUTH',
        connection.adminRole +
        ' / ' +
        SafeIP(connection.socket)
    );
}

function SendLicenseItem(socket, key, license) {
    SendLine(
        socket,
        'LIC_ITEM|' +
        key +
        '|' +
        GetLicenseStatus(license) +
        '|' +
        license.expiresAt +
        '|' +
        (license.boundClient || '') +
        '|' +
        SanitizeMemo(license.memo || '') +
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

function SearchLicenses(query, status, clientId) {
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
            ''
        )
            .trim()
            .toUpperCase();

    clientId =
        NormalizeID(
            clientId ||
            ''
        );

    const result = [];

    for (const [key, license] of licenses.entries()) {
        const currentStatus =
            GetLicenseStatus(
                license
            );

        if (
            status &&
            status !== 'ALL' &&
            currentStatus !== status
        ) {
            continue;
        }

        if (
            clientId &&
            license.boundClient !== clientId
        ) {
            continue;
        }

        if (query) {
            const haystack =
                (
                    key +
                    '|' +
                    license.boundClient +
                    '|' +
                    license.memo
                )
                    .toUpperCase();

            if (!haystack.includes(query)) {
                continue;
            }
        }

        result.push({
            key,
            license
        });

        if (
            result.length >=
            MAX_SEARCH_RESULTS
        ) {
            break;
        }
    }

    return result;
}

function UnbindLicense(key) {
    key = NormalizeLicenseKey(key);

    const license = FindLicense(key);

    if (!license) return false;

    const oldClient =
        license.boundClient;

    license.boundClient = '';
    license.boundAt = 0;

    license.lastAuthAt = 0;
    license.lastSeenAt = 0;
    license.lastIP = '';

    license.authCount = 0;
    license.sendCount = 0;

    if (oldClient) {
        const client =
            GetOnlineClient(
                oldClient
            );

        if (client) {
            client.licenseAuthorized = false;
            client.licenseKey = '';
            client.licenseExpiresAt = 0;
            client.lastServerAuthState = '';

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

    return true;
}

function SuspendLicense(key) {
    key = NormalizeLicenseKey(key);

    const license = FindLicense(key);

    if (!license) return false;

    license.suspended = true;

    if (license.boundClient) {
        const client =
            GetOnlineClient(
                license.boundClient
            );

        if (client) {
            client.licenseAuthorized = false;
            client.licenseKey = '';
            client.licenseExpiresAt = 0;
            client.lastServerAuthState = '';

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

    return true;
}

function ResumeLicense(key) {
    key = NormalizeLicenseKey(key);

    const license = FindLicense(key);

    if (!license) return false;
    if (Now() >= license.expiresAt) return false;

    license.suspended = false;

    return true;
}

function DeleteLicense(key) {
    key = NormalizeLicenseKey(key);

    const license = FindLicense(key);

    if (!license) return false;

    const oldClient =
        license.boundClient;

    licenses.delete(key);

    if (oldClient) {
        const client =
            GetOnlineClient(
                oldClient
            );

        if (client) {
            client.licenseAuthorized = false;
            client.licenseKey = '';
            client.licenseExpiresAt = 0;
            client.lastServerAuthState = '';

            SendLine(
                client.socket,
                'LICENSE_ERROR|REVOKED'
            );
        }

        NotifyServerUnauthorized(
            oldClient,
            'REVOKED'
        );
    }

    return true;
}

function HandleAdminLine(connection, line) {
    line = line.trim();

    if (!line) return;

    if (line === 'ADMIN_HELLO') {
        connection.adminNonce =
            RandomNonce();

        connection.adminNonceCreatedAt =
            Now();

        connection.adminAuthenticated =
            false;

        connection.adminRole =
            null;

        SendLine(
            connection.socket,
            'CHALLENGE|' +
            connection.adminNonce
        );

        return;
    }

    if (line.startsWith('ADMIN_AUTH|')) {
        HandleAdminAuth(connection, line);
        return;
    }

    if (!connection.adminAuthenticated) {
        SendLine(connection.socket, 'ADMIN_ERROR|NOT_AUTHORIZED');
        return;
    }

    if (
        Now() -
        connection.adminAuthenticatedAt >
        ADMIN_SESSION_TIMEOUT
    ) {
        connection.adminAuthenticated = false;
        connection.adminRole = null;

        SendLine(connection.socket, 'ADMIN_ERROR|SESSION_EXPIRED');
        return;
    }

    connection.lastSeen = Now();

    if (line === 'WHOAMI') {
        SendLine(
            connection.socket,
            'ADMIN_ROLE|' +
            connection.adminRole
        );

        return;
    }

    if (line.startsWith('LIC_CREATE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const parts = line.split('|');
        const days = Number(parts[1]);

        const memo =
            parts.length >= 3
                ? parts.slice(2).join('|')
                : '';

        if (
            !Number.isInteger(days) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(connection.socket, 'LIC_ERROR|INVALID_DAYS');
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
        if (!IsAdminAllowed(connection, 'LIST')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        for (const [key, license] of licenses.entries()) {
            SendLicenseItem(
                connection.socket,
                key,
                license
            );
        }

        SendLine(connection.socket, 'END_LIST');
        return;
    }

    if (line.startsWith('LIC_SEARCH|')) {
        if (!IsAdminAllowed(connection, 'SEARCH')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const parts = line.split('|');

        const result =
            SearchLicenses(
                parts[1] || '',
                parts[2] || '',
                parts[3] || ''
            );

        for (const item of result) {
            SendLicenseItem(
                connection.socket,
                item.key,
                item.license
            );
        }

        SendLine(connection.socket, 'END_SEARCH');
        return;
    }

    if (line.startsWith('LIC_EXTEND|')) {
        if (!IsAdminAllowed(connection, 'EXTEND')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const parts = line.split('|');

        const key =
            NormalizeLicenseKey(
                parts[1] || ''
            );

        const days =
            Number(
                parts[2]
            );

        const license =
            FindLicense(key);

        if (!license) {
            SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND');
            return;
        }

        if (
            !Number.isInteger(days) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(connection.socket, 'LIC_ERROR|INVALID_DAYS');
            return;
        }

        ExtendLicense(
            license,
            days
        );

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_EXTEND_OK|' +
            key +
            '|' +
            license.expiresAt
        );

        LogEvent(
            'LICENSE_EXTEND',
            key +
            ' +' +
            days
        );

        return;
    }

    if (line.startsWith('LIC_DELETE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        if (!DeleteLicense(key)) {
            SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND');
            return;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_DELETE_OK|' +
            key
        );

        LogEvent('LICENSE_DELETE', key);

        return;
    }

    if (line.startsWith('LIC_UNBIND|')) {
        if (!IsAdminAllowed(connection, 'UNBIND')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        if (!UnbindLicense(key)) {
            SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND');
            return;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_UNBIND_OK|' +
            key
        );

        LogEvent('LICENSE_UNBIND', key);

        return;
    }

    if (line.startsWith('LIC_SUSPEND|')) {
        if (!IsAdminAllowed(connection, 'SUSPEND')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        if (!SuspendLicense(key)) {
            SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND');
            return;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_SUSPEND_OK|' +
            key
        );

        LogEvent('LICENSE_SUSPEND', key);

        return;
    }

    if (line.startsWith('LIC_RESUME|')) {
        if (!IsAdminAllowed(connection, 'RESUME')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        const license =
            FindLicense(key);

        if (!license) {
            SendLine(connection.socket, 'LIC_ERROR|NOT_FOUND');
            return;
        }

        if (Now() >= license.expiresAt) {
            SendLine(connection.socket, 'LIC_ERROR|EXPIRED');
            return;
        }

        ResumeLicense(key);
        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_RESUME_OK|' +
            key
        );

        LogEvent('LICENSE_RESUME', key);

        return;
    }

    if (line.startsWith('LIC_REISSUE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const oldKey =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        const result =
            ReissueLicense(oldKey);

        if (!result) {
            SendLine(connection.socket, 'LIC_ERROR|REISSUE_FAILED');
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

    if (line.startsWith('LIC_TRANSFER|')) {
        if (!IsAdminAllowed(connection, 'TRANSFER')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
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
            NormalizeLicenseKey(parts[1]) +
            '|' +
            NormalizeID(parts[2])
        );

        return;
    }

    if (line.startsWith('LIC_BULK_EXTEND|')) {
        if (!IsAdminAllowed(connection, 'EXTEND')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const parts = line.split('|');
        const days = Number(parts[1]);

        if (
            !Number.isInteger(days) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(connection.socket, 'LIC_ERROR|INVALID_DAYS');
            return;
        }

        const keys =
            parts
                .slice(2)
                .map(NormalizeLicenseKey)
                .filter(Boolean);

        let success = 0;

        for (const key of keys) {
            const license =
                FindLicense(key);

            if (!license) continue;

            ExtendLicense(
                license,
                days
            );

            success++;
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_EXTEND_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (line.startsWith('LIC_BULK_UNBIND|')) {
        if (!IsAdminAllowed(connection, 'UNBIND')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(NormalizeLicenseKey)
                .filter(Boolean);

        let success = 0;

        for (const key of keys) {
            if (UnbindLicense(key)) {
                success++;
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_UNBIND_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (line.startsWith('LIC_BULK_SUSPEND|')) {
        if (!IsAdminAllowed(connection, 'SUSPEND')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(NormalizeLicenseKey)
                .filter(Boolean);

        let success = 0;

        for (const key of keys) {
            if (SuspendLicense(key)) {
                success++;
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_SUSPEND_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (line.startsWith('LIC_BULK_RESUME|')) {
        if (!IsAdminAllowed(connection, 'RESUME')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(NormalizeLicenseKey)
                .filter(Boolean);

        let success = 0;

        for (const key of keys) {
            if (ResumeLicense(key)) {
                success++;
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_RESUME_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (line.startsWith('LIC_BULK_DELETE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const keys =
            line
                .split('|')
                .slice(1)
                .map(NormalizeLicenseKey)
                .filter(Boolean);

        let success = 0;

        for (const key of keys) {
            if (DeleteLicense(key)) {
                success++;
            }
        }

        SaveDatabase();

        SendLine(
            connection.socket,
            'LIC_BULK_DELETE_OK|' +
            success +
            '|' +
            keys.length
        );

        return;
    }

    if (line === 'SERVER_LIST') {
        if (!IsAdminAllowed(connection, 'SERVER_LIST')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        /*
            serverIdentities:
            deviceKey -> serverId
        */

        for (const [deviceKey, serverId] of serverIdentities.entries()) {
            const live =
                GetOnlineServer(
                    serverId
                );

            SendLine(
                connection.socket,
                'SERVER_ITEM|' +
                serverId +
                '|' +
                (live ? 'ONLINE' : 'OFFLINE') +
                '|' +
                (live ? live.clients.size : 0) +
                '|' +
                deviceKey +
                '|' +
                (live ? live.lastIP : '') +
                '|' +
                (live ? live.lastSeen : 0)
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_LIST'
        );

        return;
    }

    if (line === 'CLIENT_LIST') {
        if (!IsAdminAllowed(connection, 'CLIENT_LIST')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        for (const [deviceKey, saved] of clientIdentities.entries()) {
            const online =
                !!GetOnlineClient(
                    saved.id
                );

            const bound =
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
                (online ? 'ONLINE' : 'OFFLINE') +
                '|' +
                (bound ? GetLicenseStatus(bound.license) : 'NONE') +
                '|' +
                (bound ? bound.license.expiresAt : 0) +
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

    if (line.startsWith('CLIENT_DETAIL|')) {
        if (!IsAdminAllowed(connection, 'CLIENT_DETAIL')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
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
            SendLine(connection.socket, 'CLIENT_ERROR|NOT_FOUND');
            return;
        }

        const live =
            GetOnlineClient(
                clientId
            );

        const bound =
            GetBoundLicense(
                clientId
            );

        SendLine(
            connection.socket,
            'CLIENT_DETAIL_ITEM|' +
            clientId +
            '|' +
            (live ? 'ONLINE' : 'OFFLINE') +
            '|' +
            FindClientDeviceKey(clientId) +
            '|' +
            saved.serverId +
            '|' +
            (bound ? bound.key : '') +
            '|' +
            (bound ? GetLicenseStatus(bound.license) : 'NONE') +
            '|' +
            (bound ? bound.license.expiresAt : 0) +
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

    if (line.startsWith('SERVER_TREE|')) {
        if (!IsAdminAllowed(connection, 'SERVER_TREE')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const serverId =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (!serverId) {
            SendLine(connection.socket, 'SERVER_TREE_ERROR|INVALID_SERVER');
            return;
        }

        SendLine(
            connection.socket,
            'SERVER_TREE_SERVER|' +
            serverId +
            '|' +
            FindServerDeviceKey(serverId) +
            '|' +
            (GetOnlineServer(serverId) ? 'ONLINE' : 'OFFLINE')
        );

        for (const [deviceKey, saved] of clientIdentities.entries()) {
            if (saved.serverId !== serverId) continue;

            const bound =
                GetBoundLicense(
                    saved.id
                );

            SendLine(
                connection.socket,
                'SERVER_TREE_CLIENT|' +
                saved.id +
                '|' +
                deviceKey +
                '|' +
                (GetOnlineClient(saved.id) ? 'ONLINE' : 'OFFLINE') +
                '|' +
                (bound ? GetLicenseStatus(bound.license) : 'NONE')
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_TREE'
        );

        return;
    }

    if (line === 'DASHBOARD') {
        if (!IsAdminAllowed(connection, 'DASHBOARD')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        let onlineServers = 0;
        let onlineClients = 0;

        let available = 0;
        let bound = 0;
        let expired = 0;
        let suspended = 0;

        for (const serverId of serverIdentities.values()) {
            if (GetOnlineServer(serverId)) {
                onlineServers++;
            }
        }

        for (const saved of clientIdentities.values()) {
            if (GetOnlineClient(saved.id)) {
                onlineClients++;
            }
        }

        for (const license of licenses.values()) {
            const status =
                GetLicenseStatus(
                    license
                );

            if (status === 'AVAILABLE') available++;
            else if (status === 'BOUND') bound++;
            else if (status === 'EXPIRED') expired++;
            else if (status === 'SUSPENDED') suspended++;
        }

        SendLine(
            connection.socket,
            'DASH|' +
            'SERVICE=' +
            (serviceEnabled ? 'ONLINE' : 'OFFLINE') +
            '|MAINTENANCE=' +
            (maintenanceMode ? 'ON' : 'OFF') +
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

        const recent =
            events.slice(
                Math.max(
                    0,
                    events.length -
                    20
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

    if (line === 'AUDIT_LIST') {
        if (!IsAdminAllowed(connection, 'AUDIT')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        for (const event of events) {
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

    if (line === 'BACKUP_CREATE') {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const fileName =
            CreateBackup(
                'manual'
            );

        if (!fileName) {
            SendLine(connection.socket, 'BACKUP_ERROR|CREATE_FAILED');
            return;
        }

        SendLine(
            connection.socket,
            'BACKUP_OK|' +
            fileName
        );

        return;
    }

    if (line === 'BACKUP_LIST') {
        if (!IsAdminAllowed(connection, 'VIEW')) {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        EnsureBackupDir();

        try {
            const files =
                fs
                    .readdirSync(BACKUP_DIR)
                    .filter(file => file.endsWith('.json'))
                    .map(file => ({
                        file,
                        stat:
                            fs.statSync(
                                path.join(
                                    BACKUP_DIR,
                                    file
                                )
                            )
                    }))
                    .sort(
                        (a, b) =>
                            b.stat.mtimeMs -
                            a.stat.mtimeMs
                    );

            for (const item of files) {
                SendLine(
                    connection.socket,
                    'BACKUP_ITEM|' +
                    item.file +
                    '|' +
                    item.stat.size +
                    '|' +
                    item.stat.mtimeMs
                );
            }
        } catch (_) {}

        SendLine(
            connection.socket,
            'END_BACKUP_LIST'
        );

        return;
    }

    if (line.startsWith('BACKUP_RESTORE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const fileName =
            line.substring(
                'BACKUP_RESTORE|'.length
            );

        const result =
            RestoreBackup(
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
            result.fileName +
            '|' +
            result.preRestore
        );

        return;
    }

    if (line.startsWith('BACKUP_DELETE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        const fileName =
            path.basename(
                line.substring(
                    'BACKUP_DELETE|'.length
                )
            );

        const filePath =
            path.join(
                BACKUP_DIR,
                fileName
            );

        try {
            if (!fs.existsSync(filePath)) {
                SendLine(connection.socket, 'BACKUP_ERROR|NOT_FOUND');
                return;
            }

            fs.unlinkSync(filePath);

            SendLine(
                connection.socket,
                'BACKUP_DELETE_OK|' +
                fileName
            );
        } catch (_) {
            SendLine(connection.socket, 'BACKUP_ERROR|DELETE_FAILED');
        }

        return;
    }

    if (line.startsWith('SERVER_KICK|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
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
            SendLine(connection.socket, 'ADMIN_ERROR|SERVER_NOT_ONLINE');
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

    if (line === 'SERVICE_STOP') {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        serviceEnabled = false;
        maintenanceMode = false;

        SaveDatabase();

        for (const client of clients.values()) {
            client.licenseAuthorized = false;
            client.licenseKey = '';
            client.licenseExpiresAt = 0;
            client.lastServerAuthState = '';

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
            SafeIP(connection.socket)
        );

        return;
    }

    if (line === 'SERVICE_START') {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        serviceEnabled = true;

        SaveDatabase();

        SendLine(
            connection.socket,
            'SERVICE_START_OK'
        );

        LogEvent(
            'SERVICE_START',
            SafeIP(connection.socket)
        );

        return;
    }

    if (line === 'MAINTENANCE_ON') {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        maintenanceMode = true;

        SaveDatabase();

        for (const client of clients.values()) {
            client.licenseAuthorized = false;
            client.licenseKey = '';
            client.licenseExpiresAt = 0;
            client.lastServerAuthState = '';

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
            SafeIP(connection.socket)
        );

        return;
    }

    if (line === 'MAINTENANCE_OFF') {
        if (connection.adminRole !== 'admin') {
            SendLine(connection.socket, 'ADMIN_ERROR|FORBIDDEN');
            return;
        }

        maintenanceMode = false;

        SaveDatabase();

        SendLine(
            connection.socket,
            'MAINTENANCE_OFF_OK'
        );

        LogEvent(
            'MAINTENANCE_OFF',
            SafeIP(connection.socket)
        );

        return;
    }

    SendLine(
        connection.socket,
        'ADMIN_ERROR|UNKNOWN_COMMAND'
    );
}

function ValidateClientLicense(connection) {
    if (
        !connection ||
        !connection.connected ||
        !connection.clientId
    ) {
        return;
    }

    if (!serviceEnabled) {
        if (connection.licenseAuthorized) {
            connection.licenseAuthorized = false;
            connection.licenseKey = '';
            connection.licenseExpiresAt = 0;
            connection.lastServerAuthState = '';

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
        if (connection.licenseAuthorized) {
            connection.licenseAuthorized = false;
            connection.licenseKey = '';
            connection.licenseExpiresAt = 0;
            connection.lastServerAuthState = '';

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

    /*
        아직 LICENSE_AUTH를 한번도 성공하지 않은
        단순 CONNECT 상태에는 Android로
        LICENSE_REQUIRED를 밀어 넣지 않는다.
    */

    if (!connection.licenseAuthorized) {
        return;
    }

    const active =
        GetActiveLicense(
            connection.clientId
        );

    if (!active) {
        connection.licenseAuthorized = false;
        connection.licenseKey = '';
        connection.licenseExpiresAt = 0;
        connection.lastServerAuthState = '';

        const bound =
            GetBoundLicense(
                connection.clientId
            );

        if (bound && bound.license.suspended) {
            SendLine(connection.socket, 'LICENSE_ERROR|SUSPENDED');
            NotifyServerUnauthorized(connection.clientId, 'SUSPENDED');
            return;
        }

        if (
            bound &&
            Now() >=
            bound.license.expiresAt
        ) {
            SendLine(connection.socket, 'LICENSE_ERROR|EXPIRED');
            NotifyServerUnauthorized(connection.clientId, 'EXPIRED');
            return;
        }

        SendLine(connection.socket, 'LICENSE_ERROR|LICENSE_REQUIRED');
        NotifyServerUnauthorized(connection.clientId, 'LICENSE_REQUIRED');

        return;
    }

    if (
        connection.licenseKey !==
        active.key
    ) {
        connection.licenseKey = active.key;
        connection.licenseExpiresAt = active.license.expiresAt;
        connection.lastServerAuthState = '';

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
    }
}

function CleanupRequestHistory() {
    const cutoff =
        Now() -
        REQUEST_HISTORY_TIMEOUT;

    for (const [key, timestamp] of requestHistory.entries()) {
        if (timestamp < cutoff) {
            requestHistory.delete(key);
        }
    }
}

function CleanupRateLimits() {
    const cutoff =
        Now() -
        RATE_LIMIT_WINDOW_MS *
        5;

    for (const [key, state] of rateLimits.entries()) {
        if (state.startedAt < cutoff) {
            rateLimits.delete(key);
        }
    }
}

function DisconnectConnection(connection) {
    if (connection.type === 'server') {
        if (
            connection.serverId &&
            servers.get(connection.serverId) === connection
        ) {
            servers.delete(connection.serverId);
        }

        LogEvent(
            'SERVER_OFFLINE',
            connection.serverId ||
            ''
        );

        return;
    }

    if (connection.type === 'client') {
        if (
            connection.clientId &&
            clients.get(connection.clientId) === connection
        ) {
            clients.delete(connection.clientId);
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

    if (connection.type === 'admin') {
        LogEvent(
            'ADMIN_OFFLINE',
            SafeIP(connection.socket)
        );
    }
}

function CreateConnection(socket) {
    const connection = {
        socket,

        type: null,

        registered: false,
        connected: false,

        identityKey: '',
        serverId: '',
        clientId: '',

        licenseAuthorized: false,
        licenseKey: '',
        licenseExpiresAt: 0,

        lastServerAuthState: '',

        adminAuthenticated: false,
        adminAuthenticatedAt: 0,
        adminNonce: '',
        adminNonceCreatedAt: 0,
        adminRole: null,

        lastSeen: Now(),
        lastIP: SafeIP(socket),

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
                connection.buffer.indexOf('\n');

            if (pos < 0) break;

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
                    console.log('[CONNECT] SERVER');
                } else if (
                    line === 'CONNECT' ||
                    line.startsWith('CONNECT|') ||
                    line.startsWith('LICENSE_AUTH|') ||
                    line.startsWith('SEND|')
                ) {
                    connection.type = 'client';
                    console.log('[CONNECT] CLIENT');
                } else if (
                    line === 'ADMIN_HELLO' ||
                    line.startsWith('ADMIN_AUTH|')
                ) {
                    connection.type = 'admin';
                    console.log('[CONNECT] ADMIN');
                } else {
                    SendLine(
                        socket,
                        'ERROR|UNKNOWN_COMMAND'
                    );

                    continue;
                }
            }

            if (connection.type === 'server') {
                HandleServerLine(connection, line);
            } else if (connection.type === 'client') {
                HandleClientLine(connection, line);
            } else if (connection.type === 'admin') {
                HandleAdminLine(connection, line);
            }
        }
    });

    socket.on('close', () => {
        DisconnectConnection(connection);
    });

    socket.on('error', error => {
        console.error(
            '[SOCKET ERROR]',
            error.message
        );
    });
}

LoadDatabase();
EnsureBackupDir();

const relayServer =
    net.createServer(socket => {
        CreateConnection(socket);
    });

relayServer.on('error', error => {
    console.error(
        'SERVER ERROR:',
        error.message
    );
});

relayServer.listen(PORT, HOST, () => {
    console.log('================================');
    console.log('       PURE TCP RELAY');
    console.log('================================');
    console.log('Port: ' + PORT);
    console.log('Protocol: RAW TCP');
    console.log('Identity Storage: SERVER');
    console.log('License Storage: SERVER');
    console.log('ID Format: 16 HEX');
    console.log('Admin Auth: HMAC-SHA256');
    console.log('License Management: ENABLED');
    console.log('Search / Filter: ENABLED');
    console.log('Bulk Operations: ENABLED');
    console.log('Backup / Restore: ENABLED');
    console.log('Auto Backup: ENABLED');
    console.log('Dashboard: ENABLED');
    console.log('Client Detail: ENABLED');
    console.log('Server Tree: ENABLED');
    console.log('Audit Log: ENABLED');
    console.log('Maintenance: ENABLED');
    console.log('Rate Limit: ' + RATE_LIMIT_MAX + '/sec');
    console.log('Service: ' + (serviceEnabled ? 'ONLINE' : 'OFFLINE'));
    console.log('Maintenance: ' + (maintenanceMode ? 'ON' : 'OFF'));
    console.log('================================');
});

setInterval(() => {
    CleanupRequestHistory();
    CleanupRateLimits();

    for (const connection of Array.from(servers.values())) {
        if (
            !connection.socket ||
            connection.socket.destroyed
        ) {
            DisconnectConnection(connection);
            continue;
        }

        if (
            Now() -
            connection.lastSeen >
            30000
        ) {
            connection.socket.destroy();
            continue;
        }

        SendLine(
            connection.socket,
            'PING'
        );
    }

    for (const connection of Array.from(clients.values())) {
        if (
            !connection.socket ||
            connection.socket.destroyed
        ) {
            DisconnectConnection(connection);
            continue;
        }

        if (
            Now() -
            connection.lastSeen >
            30000
        ) {
            connection.socket.destroy();
            continue;
        }

        ValidateClientLicense(
            connection
        );

        SendLine(
            connection.socket,
            'PING'
        );
    }
}, 10000);

setInterval(() => {
    SaveDatabase();
}, 30000);

setInterval(() => {
    CreateBackup('auto');
}, AUTO_BACKUP_INTERVAL_MS);

process.on('SIGINT', () => {
    CreateBackup('shutdown');
    SaveDatabase();
    process.exit(0);
});

process.on('SIGTERM', () => {
    CreateBackup('shutdown');
    SaveDatabase();
    process.exit(0);
});
