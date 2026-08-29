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
const admins = new Set();

const serverIdentities = new Map();
const clientIdentities = new Map();
const licenses = new Map(); // Key: LicenseKey -> Value: { key, serverId, clientId, expireDate, status }

function RandomID(prefix) {
    return prefix + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function GenerateLicenseKey(length = 16) {
    const Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Chars.charAt(Math.floor(Math.random() * Chars.length));
    }
    return result;
}

function AddDays(dateStr, days) {
    const date = dateStr ? new Date(dateStr) : new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
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

function BroadcastLog(source, message) {
    const timestamp = new Date().toISOString();
    const logText = `LOG|${timestamp}|${source}|${message}`;
    console.log(`[${source}] ${message}`);

    for (const adminSocket of admins) {
        if (!adminSocket.destroyed) {
            SendLine(adminSocket, logText);
        }
    }
}

function LoadData() {
    try {
        if (fs.existsSync(IDENTITY_FILE)) {
            const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
            if (data.servers) {
                for (const [key, id] of Object.entries(data.servers)) {
                    serverIdentities.set(key, id);
                }
            }
            if (data.clients) {
                for (const [key, value] of Object.entries(data.clients)) {
                    if (value && value.clientId && value.serverId) {
                        clientIdentities.set(key, value);
                    }
                }
            }
        }
    } catch (error) {
        console.error('IDENTITY LOAD ERROR:', error.message);
    }

    try {
        if (fs.existsSync(LICENSE_FILE)) {
            const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            if (Array.isArray(data)) {
                for (const lic of data) {
                    licenses.set(lic.key, lic);
                }
            }
        }
    } catch (error) {
        console.error('LICENSE LOAD ERROR:', error.message);
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

function SaveLicenses() {
    const data = Array.from(licenses.values());
    const temp = LICENSE_FILE + '.tmp';
    try {
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(temp, LICENSE_FILE);
    } catch (error) {
        console.error('LICENSE SAVE ERROR:', error.message);
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
        if (server.registered && server.socket && !server.socket.destroyed) {
            list.push(server);
        }
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
    BroadcastLog('SERVER', `Server Registered: ${serverId} (Key: ${identityKey})`);
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

function GetSavedClientByID(clientId) {
    for (const saved of clientIdentities.values()) {
        if (saved.clientId === clientId) return saved;
    }
    return null;
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
    BroadcastLog('CLIENT', `Client Connected: ${saved.clientId} -> Server: ${saved.serverId}`);
}

function VerifyLicense(licenseKey, clientId) {
    const lic = licenses.get(licenseKey);
    if (!lic) return { valid: false, reason: 'LICENSE_NOT_FOUND' };
    if (lic.status !== 'ACTIVE' && lic.status !== 'UNUSED') return { valid: false, reason: 'LICENSE_INACTIVE' };

    const now = new Date();
    const expire = new Date(lic.expireDate);
    if (now > expire) return { valid: false, reason: 'LICENSE_EXPIRED' };

    if (!lic.clientId) {
        lic.clientId = clientId;
        lic.status = 'USED';
        const saved = GetSavedClientByID(clientId);
        if (saved) lic.serverId = saved.serverId;
        SaveLicenses();
    } else if (lic.clientId !== clientId) {
        return { valid: false, reason: 'LICENSE_BOUND_TO_OTHER_CLIENT' };
    }

    return { valid: true, license: lic };
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

    if (line.startsWith('VERIFY_LICENSE|')) {
        const parts = line.split('|');
        if (parts.length < 3) {
            SendLine(connection.socket, 'ERROR|INVALID_LICENSE_FORMAT');
            return;
        }
        const clientId = parts[1].trim();
        const licenseKey = parts[2].trim();

        const result = VerifyLicense(licenseKey, clientId);
        if (result.valid) {
            connection.licenseVerified = true;
            connection.licenseKey = licenseKey;
            SendLine(connection.socket, 'LICENSE_OK|' + result.license.expireDate);
            BroadcastLog('LICENSE', `License Verified: ${licenseKey} for Client: ${clientId}`);
        } else {
            SendLine(connection.socket, 'ERROR|' + result.reason);
            BroadcastLog('LICENSE', `License Verification Failed: ${licenseKey} (${result.reason})`);
        }
        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Date.now();
        return;
    }

    if (line.startsWith('SEND|')) {
        const parts = line.split('|');
        if (parts.length !== 3) {
            SendLine(connection.socket, 'ERROR|INVALID_SEND');
            return;
        }

        const clientId = parts[1].trim();
        const number = parts[2].trim();

        if (!connection.licenseVerified) {
            SendLine(connection.socket, 'ERROR|LICENSE_NOT_VERIFIED');
            BroadcastLog('CLIENT', `Blocked Unverified Send Attempt from ${clientId}`);
            return;
        }

        if (!/^-?\d+$/.test(number)) {
            SendLine(connection.socket, 'ERROR|NUMBER_ONLY');
            return;
        }

        const saved = GetSavedClientByID(clientId);
        if (!saved || connection.clientId !== clientId) {
            SendLine(connection.socket, 'ERROR|CLIENT_NOT_OWNER');
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
        BroadcastLog('DATA', `Client ${clientId} -> Server ${saved.serverId}: Number (${number})`);
        return;
    }

    SendLine(connection.socket, 'ERROR|UNKNOWN_COMMAND');
}

// Delphi uAdminManager 프로토콜과 일치하도록 처리하는 핸들러
function HandleAdminLine(connection, line) {
    line = line.trim();
    if (line === '') return;

    const parts = line.split('|');
    const cmd = parts[0];

    // 1. ADMIN_CREATE_LICENSE|개수|기간일수
    if (cmd === 'ADMIN_CREATE_LICENSE') {
        const count = parts.length >= 2 ? parseInt(parts[1], 10) || 1 : 1;
        const days = parts.length >= 3 ? parseInt(parts[2], 10) || 30 : 30;

        let responseText = `ADMIN_OK|CREATED|${count}\n`;

        for (let i = 0; i < count; i++) {
            const key = GenerateLicenseKey(16);
            const expireDate = AddDays(null, days);
            const licenseItem = {
                key,
                serverId: null,
                clientId: null,
                expireDate,
                status: 'UNUSED'
            };
            licenses.set(key, licenseItem);
            responseText += `${key}|${expireDate}|UNUSED` + (i < count - 1 ? '\n' : '');
            BroadcastLog('ADMIN', `License Created: ${key} (Expires: ${expireDate})`);
        }
        SaveLicenses();
        SendLine(connection.socket, responseText);
        return;
    }

    // 2. ADMIN_REVOKE_LICENSE|키
    if (cmd === 'ADMIN_REVOKE_LICENSE') {
        const key = parts[1] ? parts[1].trim() : '';
        if (licenses.has(key)) {
            licenses.delete(key);
            SaveLicenses();
            SendLine(connection.socket, 'ADMIN_OK|REVOKED|' + key);
            BroadcastLog('ADMIN', `License Revoked: ${key}`);
        } else {
            SendLine(connection.socket, 'ERROR|KEY_NOT_FOUND');
        }
        return;
    }

    // 3. ADMIN_EXTEND_LICENSE|키|연장일수
    if (cmd === 'ADMIN_EXTEND_LICENSE') {
        const key = parts[1] ? parts[1].trim() : '';
        const days = parts.length >= 3 ? parseInt(parts[2], 10) || 30 : 30;

        const lic = licenses.get(key);
        if (lic) {
            lic.expireDate = AddDays(lic.expireDate, days);
            SaveLicenses();
            SendLine(connection.socket, `ADMIN_OK|EXTENDED|${key}|${lic.expireDate}`);
            BroadcastLog('ADMIN', `License Extended: ${key} -> ${lic.expireDate}`);
        } else {
            SendLine(connection.socket, 'ERROR|KEY_NOT_FOUND');
        }
        return;
    }

    // 4. ADMIN_LIST_LICENSES
    if (cmd === 'ADMIN_LIST_LICENSES') {
        const list = Array.from(licenses.values());
        let responseText = `ADMIN_OK|LIST_COUNT|${list.length}\n`;
        list.forEach((lic, idx) => {
            const statusStr = (lic.status === 'USED' || lic.clientId) ? 'USED' : 'UNUSED';
            responseText += `${lic.key}|${lic.expireDate}|${statusStr}` + (idx < list.length - 1 ? '\n' : '');
        });
        SendLine(connection.socket, responseText);
        return;
    }

    SendLine(connection.socket, 'ERROR|UNKNOWN_ADMIN_COMMAND');
}

function DisconnectConnection(connection) {
    if (connection.type === 'admin') {
        admins.delete(connection.socket);
        BroadcastLog('ADMIN', 'Admin Disconnected');
        return;
    }

    if (connection.type === 'server') {
        if (connection.serverId && servers.get(connection.serverId) === connection) {
            servers.delete(connection.serverId);
            BroadcastLog('SERVER', `Server Disconnected: ${connection.serverId}`);
        }
        return;
    }

    if (connection.type === 'client') {
        if (connection.clientId && clients.get(connection.clientId) === connection) {
            clients.delete(connection.clientId);
            BroadcastLog('CLIENT', `Client Disconnected: ${connection.clientId}`);
        }
    }
}

function CreateConnection(socket) {
    const connection = {
        socket,
        type: null,
        registered: false,
        connected: false,
        licenseVerified: false,
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
                } else if (line === 'ADMIN_AUTH' || line.startsWith('ADMIN_')) {
                    connection.type = 'admin';
                    admins.add(socket);
                    if (line === 'ADMIN_AUTH') {
                        SendLine(socket, 'ADMIN_OK|AUTHENTICATED');
                        BroadcastLog('ADMIN', 'Admin Connected');
                        continue;
                    }
                } else if (line === 'CONNECT' || line.startsWith('CONNECT|') || line.startsWith('SEND|') || line.startsWith('VERIFY_LICENSE|')) {
                    connection.type = 'client';
                } else {
                    SendLine(socket, 'ERROR|UNKNOWN_COMMAND');
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

    socket.on('error', () => {});
}

LoadData();

const server = net.createServer(socket => {
    CreateConnection(socket);
});

server.on('error', error => {
    console.error('SERVER ERROR:', error.message);
});

server.listen(PORT, HOST, () => {
    console.log('================================');
    console.log('    PURE TCP RELAY WITH ADMIN    ');
    console.log('================================');
    console.log('Port: ' + PORT);
    console.log('Protocol: RAW TCP');
    console.log('================================');
});

setInterval(() => {
    const now = Date.now();
    for (const connection of servers.values()) {
        if (!connection.socket || connection.socket.destroyed) {
            DisconnectConnection(connection);
            continue;
        }
        if (now - connection.lastSeen > 30000) {
            connection.socket.destroy();
            DisconnectConnection(connection);
            continue;
        }
        SendLine(connection.socket, 'PING');
    }

    for (const connection of clients.values()) {
        if (!connection.socket || connection.socket.destroyed) {
            DisconnectConnection(connection);
            continue;
        }
        if (now - connection.lastSeen > 30000) {
            connection.socket.destroy();
            DisconnectConnection(connection);
            continue;
        }
        SendLine(connection.socket, 'PING');
    }
}, 10000);
