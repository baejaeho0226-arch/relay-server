const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 33802);
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB 버퍼 제한 (메모리 폭주 방지)

const SERVER_ID_PREFIX = 'SERVER-';
const CLIENT_ID_PREFIX = 'CLIENT-';
const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');
const DB_FILE = path.join(__dirname, 'relay-logs.db');

// SQLite DB 초기화
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) console.error('DB Open Error:', err.message);
    else console.log('[DB] SQLite 데이터베이스 연결 성공:', DB_FILE);
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS transmission_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            event_type TEXT NOT NULL,
            server_id TEXT,
            client_id TEXT,
            client_alias TEXT,
            encrypted_payload TEXT,
            decrypted_payload TEXT,
            status TEXT,
            client_ip TEXT
        )
    `);
});

function LogToDB(eventType, serverId, clientId, clientAlias, encPayload, decPayload, status, clientIp) {
    const query = `
        INSERT INTO transmission_logs 
        (event_type, server_id, client_id, client_alias, encrypted_payload, decrypted_payload, status, client_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.run(query, [eventType, serverId, clientId, clientAlias, encPayload, decPayload, status, clientIp], (err) => {
        if (err) console.error('[DB INSERT ERROR]', err.message);
    });
}

// 암복호화 헬퍼 (XOR + Base64 - 플랫폼 종속성 없음)
function DecryptXOR(base64Str, key) {
    try {
        const buf = Buffer.from(base64Str, 'base64');
        const keyBuf = Buffer.from(key, 'utf8');
        const result = Buffer.alloc(buf.length);
        for (let i = 0; i < buf.length; i++) {
            result[i] = buf[i] ^ keyBuf[i % keyBuf.length];
        }
        return result.toString('utf8');
    } catch (_) {
        return '[DECRYPTION_FAILED]';
    }
}

const servers = new Map();
const clients = new Map();
const serverIdentities = new Map();
const clientIdentities = new Map();

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
    } while ([...identityMap.values()].some(v => (v.serverId || v.clientId) === id));
    return id;
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed) return false;
    try {
        socket.write(text + '\n');
        return true;
    } catch (err) {
        console.error('[SOCKET WRITE ERROR]', err.message);
        return false;
    }
}

function LoadIdentities() {
    try {
        if (!fs.existsSync(IDENTITY_FILE)) return;
        const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));

        if (data.servers) {
            for (const [k, v] of Object.entries(data.servers)) {
                serverIdentities.set(k, typeof v === 'string' ? { serverId: v, licenseKey: GenerateLicenseKey() } : v);
            }
        }
        if (data.clients) {
            for (const [k, v] of Object.entries(data.clients)) {
                if (v && v.clientId) clientIdentities.set(k, v);
            }
        }
    } catch (e) {
        console.error('IDENTITY LOAD ERROR:', e.message);
    }
}

function SaveIdentities() {
    const data = {
        servers: Object.fromEntries(serverIdentities),
        clients: Object.fromEntries(clientIdentities)
    };
    try {
        fs.writeFileSync(IDENTITY_FILE + '.tmp', JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(IDENTITY_FILE + '.tmp', IDENTITY_FILE);
    } catch (e) {
        console.error('IDENTITY SAVE ERROR:', e.message);
    }
}

function GetOnlineServer(serverId) {
    const server = servers.get(serverId);
    if (!server || !server.registered || !server.socket || server.socket.destroyed) return null;
    return server;
}

function FindServerByLicense(licenseKey) {
    for (const [_, info] of serverIdentities.entries()) {
        if (info.licenseKey === licenseKey) return info.serverId;
    }
    return null;
}

function RegisterServer(connection, identityKey) {
    let serverInfo = serverIdentities.get(identityKey);
    if (!serverInfo) {
        serverInfo = { serverId: MakeUniqueID(SERVER_ID_PREFIX, serverIdentities), licenseKey: GenerateLicenseKey() };
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

    console.log(`[SERVER REG] ID: ${serverInfo.serverId} | License: ${serverInfo.licenseKey} | IP: ${connection.remoteIp}`);
    LogToDB('SERVER_REGISTER', serverInfo.serverId, null, null, null, null, 'SUCCESS', connection.remoteIp);

    SendLine(connection.socket, `REGISTERED|${serverInfo.serverId}|${serverInfo.licenseKey}`);
}

function HandleClientLine(connection, line) {
    line = line.trim();
    if (!line) return;

    if (line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const identityKey = parts[1] ? parts[1].trim() : '';
        const licenseKey = parts[2] ? parts[2].trim() : '';
        const clientAlias = parts[3] ? parts[3].trim() : 'MobileClient';

        if (!identityKey || !licenseKey) {
            SendLine(connection.socket, 'ERROR|INVALID_PARAMS');
            return;
        }

        const targetServerId = FindServerByLicense(licenseKey);
        if (!targetServerId) {
            LogToDB('AUTH_ATTEMPT', null, null, clientAlias, null, null, 'INVALID_LICENSE', connection.remoteIp);
            SendLine(connection.socket, 'ERROR|INVALID_LICENSE');
            return;
        }

        if (!GetOnlineServer(targetServerId)) {
            LogToDB('AUTH_ATTEMPT', targetServerId, null, clientAlias, null, null, 'SERVER_OFFLINE', connection.remoteIp);
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
            return;
        }

        let saved = clientIdentities.get(identityKey) || { clientId: MakeUniqueID(CLIENT_ID_PREFIX, clientIdentities), serverId: targetServerId };
        saved.serverId = targetServerId;
        saved.alias = clientAlias;
        clientIdentities.set(identityKey, saved);
        SaveIdentities();

        connection.clientId = saved.clientId;
        connection.serverId = targetServerId;
        connection.clientAlias = clientAlias;
        connection.connected = true;
        clients.set(saved.clientId, connection);

        const server = GetOnlineServer(targetServerId);
        if (server) server.clients.add(saved.clientId);

        console.log(`[CLIENT AUTH] ID: ${saved.clientId} (${clientAlias}) -> Server: ${targetServerId}`);
        LogToDB('CLIENT_AUTH', targetServerId, saved.clientId, clientAlias, null, null, 'SUCCESS', connection.remoteIp);

        SendLine(connection.socket, `CONNECTED|${saved.clientId}|${targetServerId}`);
        return;
    }

    if (line.startsWith('SEND|')) {
        // 형식: SEND|<clientId>|<encPayload>
        const parts = line.split('|');
        if (parts.length < 3) {
            SendLine(connection.socket, 'ERROR|INVALID_SEND');
            return;
        }

        const clientId = parts[1].trim();
        const encPayload = parts[2].trim();

        if (connection.clientId !== clientId) {
            SendLine(connection.socket, 'ERROR|UNAUTHORIZED_CLIENT');
            return;
        }

        const server = GetOnlineServer(connection.serverId);
        if (!server) {
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
            return;
        }

        // 복호화 로그 기록 (라이선스 키를 비밀키로 사용)
        const decPayload = DecryptXOR(encPayload, server.licenseKey);

        // 중계서버 -> WinSockServer로 전송 (SEND 패킷: NUMBER|<clientId>|<alias>|<encPayload>)
        const relayMsg = `NUMBER|${clientId}|${connection.clientAlias}|${encPayload}`;
        if (SendLine(server.socket, relayMsg)) {
            LogToDB('DATA_TRANSMISSION', connection.serverId, clientId, connection.clientAlias, encPayload, decPayload, 'DELIVERED', connection.remoteIp);
            SendLine(connection.socket, 'SENT|OK');
        } else {
            LogToDB('DATA_TRANSMISSION', connection.serverId, clientId, connection.clientAlias, encPayload, decPayload, 'FAILED', connection.remoteIp);
            SendLine(connection.socket, 'ERROR|RELAY_FAILED');
        }
        return;
    }

    if (line === 'PONG') {
        connection.lastSeen = Date.now();
        return;
    }
}

LoadIdentities();

const server = net.createServer(socket => {
    const connection = {
        socket,
        type: null,
        remoteIp: socket.remoteAddress,
        lastSeen: Date.now(),
        buffer: ''
    };

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    socket.on('data', data => {
        connection.buffer += data.toString('utf8');

        // 버퍼 폭주 공격 방지
        if (connection.buffer.length > MAX_BUFFER_SIZE) {
            console.error('[SECURITY] Buffer overflow detected from IP:', connection.remoteIp);
            socket.destroy();
            return;
        }

        while (true) {
            const pos = connection.buffer.indexOf('\n');
            if (pos < 0) break;

            let line = connection.buffer.substring(0, pos).replace(/\r$/, '');
            connection.buffer = connection.buffer.substring(pos + 1);

            try {
                if (!connection.type) {
                    if (line.startsWith('REGISTER')) connection.type = 'server';
                    else if (line.startsWith('CONNECT') || line.startsWith('SEND')) connection.type = 'client';
                }

                if (connection.type === 'server') {
                    if (line.startsWith('REGISTER|')) RegisterServer(connection, line.split('|')[1]);
                    else if (line === 'PONG') connection.lastSeen = Date.now();
                } else if (connection.type === 'client') {
                    HandleClientLine(connection, line);
                }
            } catch (err) {
                console.error('[PROTOCOL ERROR]', err.message);
                LogToDB('ERROR', connection.serverId, connection.clientId, null, line, null, err.message, connection.remoteIp);
            }
        }
    });

    socket.on('close', () => {
        if (connection.serverId && servers.get(connection.serverId) === connection) servers.delete(connection.serverId);
        if (connection.clientId && clients.get(connection.clientId) === connection) clients.delete(connection.clientId);
    });

    socket.on('error', err => {
        console.error(`[SOCKET ERROR] ${connection.remoteIp}:`, err.message);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`========================================`);
    console.log(` PURE TCP RELAY v3.0 (Multi-Client & DB)`);
    console.log(` Listening on ${HOST}:${PORT}`);
    console.log(`========================================`);
});

// 하트비트 타임아웃 감시
setInterval(() => {
    const now = Date.now();
    [...servers.values(), ...clients.values()].forEach(conn => {
        if (!conn.socket || conn.socket.destroyed) return;
        if (now - conn.lastSeen > 35000) {
            conn.socket.destroy();
        } else {
            SendLine(conn.socket, 'PING');
        }
    });
}, 10000);
