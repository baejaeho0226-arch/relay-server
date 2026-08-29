const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 33802);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234'; // 관리자 암호
const MAX_BUFFER_SIZE = 1024 * 1024;

const CLIENT_ID_PREFIX = 'CLIENT-';
const IDENTITY_FILE = path.join(__dirname, 'relay-identities.json');
const DB_FILE = path.join(__dirname, 'relay-logs.db');

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) console.error('DB Open Error:', err.message);
    else console.log('[DB] SQLite 데이터베이스 연결 성공:', DB_FILE);
});

db.serialize(() => {
    // 라이선스 관리 테이블
    db.run(`
        CREATE TABLE IF NOT EXISTS licenses (
            license_key TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            memo TEXT,
            is_active INTEGER DEFAULT 1
        )
    `);

    // 전송 로그 테이블
    db.run(`
        CREATE TABLE IF NOT EXISTS transmission_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            event_type TEXT NOT NULL,
            server_id TEXT,
            client_id TEXT,
            encrypted_payload TEXT,
            decrypted_payload TEXT,
            status TEXT,
            client_ip TEXT
        )
    `);
});

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

function GenerateLicenseKey() {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `LIC-${raw.substring(0, 4)}-${raw.substring(4, 8)}`;
}

function SendLine(socket, text) {
    if (!socket || socket.destroyed) return false;
    try {
        socket.write(text + '\n');
        return true;
    } catch (err) {
        return false;
    }
}

function LoadIdentities() {
    try {
        if (!fs.existsSync(IDENTITY_FILE)) return;
        const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
        if (data.servers) {
            for (const [k, v] of Object.entries(data.servers)) {
                serverIdentities.set(k, v);
            }
        }
    } catch (e) {}
}

function SaveIdentities() {
    try {
        const data = { servers: Object.fromEntries(serverIdentities) };
        fs.writeFileSync(IDENTITY_FILE + '.tmp', JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(IDENTITY_FILE + '.tmp', IDENTITY_FILE);
    } catch (e) {}
}

function GetOnlineServer() {
    for (const s of servers.values()) {
        if (s.registered && s.socket && !s.socket.destroyed) return s;
    }
    return null;
}

// 라이선스 검증 함수 (만료 여부 및 활성 상태 체크)
function ValidateLicense(licenseKey, callback) {
    const query = `SELECT * FROM licenses WHERE license_key = ? AND is_active = 1`;
    db.get(query, [licenseKey], (err, row) => {
        if (err || !row) return callback(false, 'INVALID_LICENSE');
        const now = new Date();
        const expireDate = new Date(row.expires_at);
        if (now > expireDate) return callback(false, 'EXPIRED_LICENSE');
        return callback(true, 'OK', row);
    });
}

// 관리자 명령어 처리
function HandleAdminLine(connection, line) {
    if (line.startsWith('ADMIN_LOGIN|')) {
        const pass = line.split('|')[1];
        if (pass === ADMIN_PASSWORD) {
            connection.isAdmin = true;
            SendLine(connection.socket, 'ADMIN_LOGIN_OK');
        } else {
            SendLine(connection.socket, 'ERROR|INVALID_ADMIN_PASSWORD');
        }
        return;
    }

    if (!connection.isAdmin) {
        SendLine(connection.socket, 'ERROR|UNAUTHORIZED');
        return;
    }

    // 라이선스 신규 발급 (일수, 메모)
    if (line.startsWith('ADMIN_GENERATE|')) {
        const parts = line.split('|');
        const days = parseInt(parts[1] || '30', 10);
        const memo = parts[2] || '일반고객';

        const newKey = GenerateLicenseKey();
        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + days);
        const expireStr = expireDate.toISOString().replace('T', ' ').substring(0, 19);

        db.run(`INSERT INTO licenses (license_key, expires_at, memo) VALUES (?, ?, ?)`, [newKey, expireStr, memo], (err) => {
            if (err) SendLine(connection.socket, 'ERROR|GENERATE_FAILED');
            else SendLine(connection.socket, `ADMIN_GEN_OK|${newKey}|${expireStr}`);
        });
        return;
    }

    // 라이선스 삭제/폐기
    if (line.startsWith('ADMIN_DELETE|')) {
        const key = line.split('|')[1];
        db.run(`UPDATE licenses SET is_active = 0 WHERE license_key = ?`, [key], (err) => {
            if (err) SendLine(connection.socket, 'ERROR|DELETE_FAILED');
            else SendLine(connection.socket, `ADMIN_DEL_OK|${key}`);
        });
        return;
    }

    // 전체 라이선스 목록 및 접속 상태 조회
    if (line === 'ADMIN_LIST') {
        db.all(`SELECT * FROM licenses ORDER BY created_at DESC`, [], (err, rows) => {
            if (err) {
                SendLine(connection.socket, 'ERROR|DB_ERROR');
                return;
            }

            const now = new Date();
            const result = rows.map(r => {
                const exp = new Date(r.expires_at);
                let status = '정상';
                if (r.is_active === 0) status = '폐기됨';
                else if (now > exp) status = '만료됨';

                // 해당 라이선스로 현재 접속 중인 클라이언트 수 계산
                let activeClients = 0;
                for (const c of clients.values()) {
                    if (c.licenseKey === r.license_key && c.connected) activeClients++;
                }

                return {
                    key: r.license_key,
                    memo: r.memo,
                    created_at: r.created_at,
                    expires_at: r.expires_at,
                    status: status,
                    active_clients: activeClients
                };
            });

            SendLine(connection.socket, 'ADMIN_LIST_DATA|' + JSON.stringify(result));
        });
        return;
    }
}

function HandleClientLine(connection, line) {
    line = line.trim();
    if (!line) return;

    if (line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const identityKey = parts[1] ? parts[1].trim() : '';
        const licenseKey = parts[2] ? parts[2].trim() : '';

        ValidateLicense(licenseKey, (isValid, reason, licenseData) => {
            if (!isValid) {
                SendLine(connection.socket, `ERROR|${reason}`);
                return;
            }

            const server = GetOnlineServer();
            if (!server) {
                SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
                return;
            }

            const clientId = CLIENT_ID_PREFIX + crypto.randomBytes(4).toString('hex').toUpperCase();
            connection.clientId = clientId;
            connection.licenseKey = licenseKey;
            connection.connected = true;
            clients.set(clientId, connection);

            SendLine(connection.socket, `CONNECTED|${clientId}|${server.serverId}`);
        });
        return;
    }

    if (line.startsWith('SEND|')) {
        const parts = line.split('|');
        if (parts.length < 3) return;

        const clientId = parts[1].trim();
        const encPayload = parts[2].trim();

        const server = GetOnlineServer();
        if (!server) {
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
            return;
        }

        const decPayload = DecryptXOR(encPayload, connection.licenseKey);
        const relayMsg = `NUMBER|${clientId}|${encPayload}`;

        if (SendLine(server.socket, relayMsg)) {
            SendLine(connection.socket, 'SENT|OK');
        } else {
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

        while (true) {
            const pos = connection.buffer.indexOf('\n');
            if (pos < 0) break;

            let line = connection.buffer.substring(0, pos).replace(/\r$/, '');
            connection.buffer = connection.buffer.substring(pos + 1);

            if (!connection.type) {
                if (line.startsWith('ADMIN_')) connection.type = 'admin';
                else if (line.startsWith('REGISTER')) connection.type = 'server';
                else if (line.startsWith('CONNECT') || line.startsWith('SEND')) connection.type = 'client';
            }

            if (connection.type === 'admin') {
                HandleAdminLine(connection, line);
            } else if (connection.type === 'server') {
                if (line.startsWith('REGISTER|')) {
                    connection.serverId = 'SERVER-MASTER';
                    connection.registered = true;
                    servers.set('SERVER-MASTER', connection);
                    SendLine(socket, 'REGISTERED|SERVER-MASTER|OK');
                }
            } else if (connection.type === 'client') {
                HandleClientLine(connection, line);
            }
        }
    });

    socket.on('close', () => {
        if (connection.clientId) clients.delete(connection.clientId);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`========================================`);
    console.log(` PURE TCP RELAY v4.0 (License Admin Enabled)`);
    console.log(` Listening on ${HOST}:${PORT}`);
    console.log(`========================================`);
});
