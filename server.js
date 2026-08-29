const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const SERVER_ID_PREFIX = 'SERVER-';
const CLIENT_ID_PREFIX = 'CLIENT-';

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');
const LICENSE_FILE = path.join(__dirname, 'licenses.json');

const servers = new Map();
const clients = new Map();
const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map(); // Key -> { deviceId: string|null, createdAt: string, status: string }

// ---------------------------------------------------------
// 라이선스 키 생성기 (XXXX-XXXX-XXXX-XXXX)
// ---------------------------------------------------------
function GenerateLicenseKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const chunk = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${chunk()}-${chunk()}-${chunk()}-${chunk()}`;
}

function LoadLicenses() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) {
            console.log('[LICENSE] 라이선스 파일이 없습니다. 기본 라이선스 5개를 신규 생성합니다.');
            for (let i = 0; i < 5; i++) {
                const key = GenerateLicenseKey();
                licenses.set(key, { deviceId: null, createdAt: new Date().toISOString(), status: 'active' });
            }
            SaveLicenses();
            return;
        }

        const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        if (data.licenses && typeof data.licenses === 'object') {
            for (const [key, item] of Object.entries(data.licenses)) {
                licenses.set(key, item);
            }
        }
    } catch (error) {
        console.error('LICENSE LOAD ERROR:', error.message);
    }
}

function SaveLicenses() {
    const data = {
        version: 1,
        licenses: Object.fromEntries(licenses)
    };
    const temp = LICENSE_FILE + '.tmp';
    try {
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(temp, LICENSE_FILE);
    } catch (error) {
        console.error('LICENSE SAVE ERROR:', error.message);
    }
}

function VerifyAndBindLicense(licenseKey, deviceId) {
    const lic = licenses.get(licenseKey);
    if (!lic) {
        return { success: false, error: 'INVALID_LICENSE' };
    }
    if (lic.status !== 'active') {
        return { success: false, error: 'LICENSE_EXPIRED_OR_DISABLED' };
    }
    if (!lic.deviceId) {
        // 첫 연결 시 기기 바인딩
        lic.deviceId = deviceId;
        licenses.set(licenseKey, lic);
        SaveLicenses();
        console.log(`[LICENSE BIND] 키: ${licenseKey} -> 기기: ${deviceId}`);
        return { success: true };
    }
    if (lic.deviceId !== deviceId) {
        return { success: false, error: 'DEVICE_MISMATCH' };
    }
    return { success: true };
}

// ---------------------------------------------------------
// ID 및 식별자 관리
// ---------------------------------------------------------
function RandomID(prefix) {
    return prefix + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function MakeUniqueID(prefix, identityMap) {
    let id;
    do {
        id = RandomID(prefix);
    } while ([...identityMap.values()].some(value => {
        if (typeof value === 'string') return value === id;
        return value && value.clientId === id;
    }));
    return id;
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed) return false;
    try {
        socket.write(text + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function LoadIdentities() {
    try {
        if (!fs.existsSync(IDENTITY_FILE)) return;
        const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));

        if (data.servers && typeof data.servers === 'object') {
            for (const [key, id] of Object.entries(data.servers)) {
                if (typeof key === 'string' && typeof id === 'string') {
                    serverIdentities.set(key, id);
                }
            }
        }

        if (data.clients && typeof data.clients === 'object') {
            for (const [key, value] of Object.entries(data.clients)) {
                if (!value || typeof value !== 'object') continue;
                if (typeof value.clientId !== 'string') continue;
                if (typeof value.serverId !== 'string') continue;
                clientIdentities.set(key, {
                    clientId: value.clientId,
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
        version: 1,
        servers: Object.fromEntries(serverIdentities),
        clients: Object.fromEntries(clientIdentities)
    };
    const temp = IDENTITY_FILE + '.tmp';
    try {
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(temp, IDENTITY_FILE);
    } catch (error) {
        console.error('IDENTITY SAVE ERROR:', error.message);
    }
}

function GetOnlineServer(serverId) {
    const server = servers.get(serverId);
    if (!server || !server.registered || !server.socket || server.socket.destroyed) return null;
    return server;
}

function GetAvailableServer() {
    const list = [];
    for (const server of servers.values()) {
        if (!server.registered || !server.socket || server.socket.destroyed) continue;
        list.push(server);
    }
    if (list.length === 0) return null;
    list.sort((a, b) => a.clients.size - b.clients.size);
    return list[0];
}

function RegisterServer(connection, identityKey) {
    let serverId = serverIdentities.get(identityKey);
    if (!serverId) {
        serverId = MakeUniqueID(SERVER_ID_PREFIX, serverIdentities);
        serverIdentities.set(identityKey, serverId);
        SaveIdentities();
    }

    const old = servers.get(serverId);
    if (old && old !== connection && old.socket && !old.socket.destroyed) {
        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.identityKey = identityKey;
    connection.serverId = serverId;
    connection.registered = true;
    connection.lastSeen = Date.now();
    connection.clients = connection.clients || new Set();

    servers.set(serverId, connection);
    SendLine(connection.socket, 'REGISTERED|' + serverId);
}

function HandleServerLine(connection, line) {
    line = line.trim();
    if (line === '') return;

    if (line === 'REGISTER' || line.startsWith('REGISTER|')) {
        if (connection.registered) {
            SendLine(connection.socket, 'ERROR|ALREADY_REGISTERED');
            return;
        }
        const parts = line.split('|');
        const identityKey = parts.length >= 2 ? parts[1].trim() : '';

        if (!identityKey) {
            SendLine(connection.socket, 'ERROR|SERVER_KEY_REQUIRED');
            return;
        }

        RegisterServer(connection, identityKey);
        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Date.now();
        return;
    }

    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

function AttachClient(connection, saved) {
    const old = clients.get(saved.clientId);
    if (old && old !== connection && old.socket && !old.socket.destroyed) {
        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.clientId = saved.clientId;
    connection.serverId = saved.serverId;
    connection.connected = true;
    connection.lastSeen = Date.now();

    clients.set(saved.clientId, connection);

    const server = GetOnlineServer(saved.serverId);
    if (server) server.clients.add(saved.clientId);

    SendLine(connection.socket, 'CONNECTED|' + saved.clientId + '|' + saved.serverId);
}

function HandleClientLine(connection, line) {
    line = line.trim();
    if (line === '') return;

    if (line === 'CONNECT' || line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const identityKey = parts.length >= 2 ? parts[1].trim() : '';

        if (!identityKey) {
            SendLine(connection.socket, 'ERROR|CLIENT_KEY_REQUIRED');
            return;
        }

        let saved = clientIdentities.get(identityKey);
        if (saved) {
            if (!GetOnlineServer(saved.serverId)) {
                SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
                return;
            }
        } else {
            const server = GetAvailableServer();
            if (!server) {
                SendLine(connection.socket, 'ERROR|NO_SERVER');
                return;
            }
            saved = {
                clientId: MakeUniqueID(CLIENT_ID_PREFIX, clientIdentities),
                serverId: server.serverId
            };
            clientIdentities.set(identityKey, saved);
            SaveIdentities();
        }

        AttachClient(connection, saved);
        return;
    }

    // 라이선스 인증 처리 (AUTH|LICENSE_KEY|DEVICE_ID)
    if (line.startsWith('AUTH|')) {
        const parts = line.split('|');
        if (parts.length < 3) {
            SendLine(connection.socket, 'ERROR|AUTH_FORMAT_INVALID');
            return;
        }

        const licenseKey = parts[1].trim().toUpperCase();
        const deviceId = parts[2].trim();

        const result = VerifyAndBindLicense(licenseKey, deviceId);
        if (result.success) {
            connection.authenticated = true;
            connection.licenseKey = licenseKey;
            SendLine(connection.socket, 'AUTH_OK|' + licenseKey);
        } else {
            connection.authenticated = false;
            SendLine(connection.socket, 'ERROR|' + result.error);
        }
        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Date.now();
        return;
    }

    if (line.startsWith('SEND|')) {
        // 미인증 클라이언트 거부
        if (!connection.authenticated) {
            SendLine(connection.socket, 'ERROR|NOT_AUTHENTICATED');
            return;
        }

        const parts = line.split('|');
        if (parts.length !== 3) {
            SendLine(connection.socket, 'ERROR|INVALID_SEND');
            return;
        }

        const clientId = parts[1].trim();
        const number = parts[2].trim();

        if (connection.clientId !== clientId) {
            SendLine(connection.socket, 'ERROR|CLIENT_NOT_OWNER');
            return;
        }

        if (!/^-?\d+$/.test(number)) {
            SendLine(connection.socket, 'ERROR|NUMBER_ONLY');
            return;
        }

        const saved = clientIdentities.get(connection.identityKey);
        if (!saved) {
            SendLine(connection.socket, 'ERROR|CLIENT_NOT_FOUND');
            return;
        }

        const server = GetOnlineServer(saved.serverId);
        if (!server) {
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
            return;
        }

        if (!SendLine(server.socket, 'NUMBER|' + clientId + '|' + number)) {
            SendLine(connection.socket, 'ERROR|SERVER_SEND_FAILED');
            return;
        }

        SendLine(connection.socket, 'SENT|OK');
        return;
    }

    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

function DisconnectConnection(connection) {
    if (connection.type === 'server') {
        if (connection.serverId && servers.get(connection.serverId) === connection) {
            servers.delete(connection.serverId);
        }
        return;
    }

    if (connection.type === 'client') {
        if (connection.clientId && clients.get(connection.clientId) === connection) {
            clients.delete(connection.clientId);
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
        licenseKey: null,
        identityKey: null,
        serverId: null,
        clientId: null,
        lastSeen: Date.now(),
        clients: new Set(),
        buffer: ''
    };

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    socket.on('data', data => {
        connection.buffer += data.toString('utf8');

        while (true) {
            const pos = connection.buffer.indexOf('\n');
            if (pos < 0) break;

            let line = connection.buffer.substring(0, pos);
            connection.buffer = connection.buffer.substring(pos + 1);
            line = line.replace(/\r$/, '');

            if (!connection.type) {
                if (line === 'REGISTER' || line.startsWith('REGISTER|')) {
                    connection.type = 'server';
                } else if (
                    line === 'CONNECT' ||
                    line.startsWith('CONNECT|') ||
                    line.startsWith('AUTH|') ||
                    line.startsWith('SEND|')
                ) {
                    connection.type = 'client';
                } else {
                    SendLine(socket, 'ERROR|UNKNOWN_COMMAND');
                    continue;
                }
            }

            if (connection.type === 'server') {
                HandleServerLine(connection, line);
            } else {
                HandleClientLine(connection, line);
            }
        }
    });

    socket.on('close', () => DisconnectConnection(connection));
    socket.on('error', () => {});
}

// ---------------------------------------------------------
// 서버 시작
// ---------------------------------------------------------
LoadIdentities();
LoadLicenses();

const server = net.createServer(socket => CreateConnection(socket));

server.on('error', error => console.error('SERVER ERROR:', error.message));

server.listen(PORT, HOST, () => {
    console.log('================================');
    console.log('       PURE TCP RELAY & AUTH    ');
    console.log('================================');
    console.log('Port: ' + PORT);
    console.log('Protocol: RAW TCP');
    console.log('================================');
    console.log('[현재 생성되어 있는 활성 라이선스 목록]');
    for (const [key, val] of licenses.entries()) {
        console.log(`  - 키: ${key} | 바인딩 기기: ${val.deviceId || '미등록(첫 연결 시 등록됨)'}`);
    }
    console.log('================================');
});

setInterval(() => {
    const now = Date.now();
    const all = [...servers.values(), ...clients.values()];
    for (const conn of all) {
        if (!conn.socket || conn.socket.destroyed) {
            DisconnectConnection(conn);
            continue;
        }
        if (now - conn.lastSeen > 30000) {
            conn.socket.destroy();
            DisconnectConnection(conn);
            continue;
        }
        SendLine(conn.socket, 'PING');
    }
}, 10000);
