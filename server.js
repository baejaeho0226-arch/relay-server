const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 33802);

const SERVER_ID_PREFIX = 'SERVER-';
const CLIENT_ID_PREFIX = 'CLIENT-';

const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');

const servers = new Map();
const clients = new Map();
const serverIdentities = new Map(); // key -> { serverId, licenseKey }
const clientIdentities = new Map(); // key -> { clientId, serverId }

function RandomID(prefix) {
    return prefix + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function GenerateLicenseKey() {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `LIC-${raw.substring(0, 4)}-${raw.substring(4, 8)}`;
}

function MakeUniqueID(prefix, identityMap) {
    let id;
    do {
        id = RandomID(prefix);
    } while ([...identityMap.values()].some(value => {
        if (typeof value === 'string') return value === id;
        if (value && typeof value === 'object') {
            return value.serverId === id || value.clientId === id;
        }
        return false;
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
            for (const [key, value] of Object.entries(data.servers)) {
                if (typeof value === 'string') {
                    serverIdentities.set(key, { serverId: value, licenseKey: GenerateLicenseKey() });
                } else if (value && typeof value === 'object' && value.serverId) {
                    serverIdentities.set(key, {
                        serverId: value.serverId,
                        licenseKey: value.licenseKey || GenerateLicenseKey()
                    });
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
        try {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        } catch (_) {}
    }
}

function GetOnlineServer(serverId) {
    const server = servers.get(serverId);
    if (!server) return null;
    if (!server.registered) return null;
    if (!server.socket || server.socket.destroyed) return null;
    return server;
}

function FindServerByLicense(licenseKey) {
    for (const [_, info] of serverIdentities.entries()) {
        if (info.licenseKey === licenseKey) {
            return info.serverId;
        }
    }
    return null;
}

function RegisterServer(connection, identityKey) {
    let serverInfo = serverIdentities.get(identityKey);

    if (!serverInfo) {
        const serverId = MakeUniqueID(SERVER_ID_PREFIX, serverIdentities);
        const licenseKey = GenerateLicenseKey();
        serverInfo = { serverId, licenseKey };
        serverIdentities.set(identityKey, serverInfo);
        SaveIdentities();
    }

    const old = servers.get(serverInfo.serverId);
    if (old && old !== connection && old.socket && !old.socket.destroyed) {
        SendLine(old.socket, 'ERROR|REPLACED');
        old.socket.destroy();
    }

    connection.identityKey = identityKey;
    connection.serverId = serverInfo.serverId;
    connection.licenseKey = serverInfo.licenseKey;
    connection.registered = true;
    connection.lastSeen = Date.now();
    connection.clients = connection.clients || new Set();

    servers.set(serverInfo.serverId, connection);

    console.log(`========================================`);
    console.log(`[SERVER REGISTERED] ID: ${serverInfo.serverId}`);
    console.log(`[LICENSE ISSUED] 발급 라이선스: ${serverInfo.licenseKey}`);
    console.log(`========================================`);

    // WinSockServer로 등록 완료 및 발급된 라이선스 전송
    SendLine(connection.socket, 'REGISTERED|' + serverInfo.serverId + '|' + serverInfo.licenseKey);
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

    SendLine(
        connection.socket,
        'CONNECTED|' + saved.clientId + '|' + saved.serverId
    );
}

function HandleClientLine(connection, line) {
    line = line.trim();
    if (line === '') return;

    if (line === 'CONNECT' || line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const identityKey = parts.length >= 2 ? parts[1].trim() : '';
        const licenseKey = parts.length >= 3 ? parts[2].trim() : '';

        if (!identityKey) {
            SendLine(connection.socket, 'ERROR|CLIENT_KEY_REQUIRED');
            return;
        }

        if (!licenseKey) {
            SendLine(connection.socket, 'ERROR|LICENSE_REQUIRED');
            return;
        }

        // 1. 서버 라이선스 검증
        const targetServerId = FindServerByLicense(licenseKey);
        if (!targetServerId) {
            console.log(`[AUTH FAILED] 유효하지 않은 라이선스: ${licenseKey}`);
            SendLine(connection.socket, 'ERROR|INVALID_LICENSE');
            return;
        }

        // 2. 해당 서버의 온라인 여부 확인
        if (!GetOnlineServer(targetServerId)) {
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
            return;
        }

        let saved = clientIdentities.get(identityKey);

        if (!saved) {
            saved = {
                clientId: MakeUniqueID(CLIENT_ID_PREFIX, clientIdentities),
                serverId: targetServerId
            };
            clientIdentities.set(identityKey, saved);
            SaveIdentities();
        } else {
            saved.serverId = targetServerId;
            SaveIdentities();
        }

        console.log(`[AUTH SUCCESS] Client(${saved.clientId}) -> Target Server(${targetServerId})`);
        AttachClient(connection, saved);
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

        if (!clientId) {
            SendLine(connection.socket, 'ERROR|CLIENT_ID_EMPTY');
            return;
        }

        if (!/^-?\d+$/.test(number)) {
            SendLine(connection.socket, 'ERROR|NUMBER_ONLY');
            return;
        }

        const saved = GetSavedClientByID(clientId);

        if (!saved) {
            SendLine(connection.socket, 'ERROR|CLIENT_NOT_FOUND');
            return;
        }

        if (connection.clientId !== clientId) {
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
        identityKey: null,
        serverId: null,
        licenseKey: null,
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

    socket.on('close', () => {
        DisconnectConnection(connection);
    });

    socket.on('error', () => {});
}

LoadIdentities();

const server = net.createServer(socket => {
    CreateConnection(socket);
});

server.on('error', error => {
    console.error('SERVER ERROR:', error.message);
});

server.listen(PORT, HOST, () => {
    console.log('================================');
    console.log('       PURE TCP RELAY');
    console.log('================================');
    console.log('Port: ' + PORT);
    console.log('Protocol: RAW TCP');
    console.log('Identity Storage: SERVER');
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
