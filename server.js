const net = require('net');
const crypto = require('crypto');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 33802);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const DB_FILE = path.join(__dirname, 'relay-logs.db');

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) console.error('DB Open Error:', err.message);
    else console.log('[DB] SQLite 데이터베이스 연결 성공');
});

// DB 테이블 생성 (HWID 기반 고정 ID 매핑 포함)
db.serialize(() => {
    // 1. 라이선스 관리
    db.run(`
        CREATE TABLE IF NOT EXISTS licenses (
            license_key TEXT PRIMARY KEY,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            memo TEXT,
            is_active INTEGER DEFAULT 1
        )
    `);

    // 2. 기기 HWID 매핑 (고정 ID 보장)
    db.run(`
        CREATE TABLE IF NOT EXISTS device_mappings (
            hwid TEXT PRIMARY KEY,
            assigned_id TEXT NOT NULL,
            device_type TEXT NOT NULL
        )
    `);
});

const servers = new Map();
const clients = new Map();

function SendLine(socket, text) {
    if (!socket || socket.destroyed) return false;
    try {
        socket.write(text + '\n');
        return true;
    } catch (_) {
        return false;
    }
}

function GenerateLicenseKey() {
    return 'LIC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// HWID에 해당하는 고정 ID를 DB에서 조회하거나 새로 생성
function GetOrCreateAssignedID(hwid, type, callback) {
    db.get(`SELECT assigned_id FROM device_mappings WHERE hwid = ?`, [hwid], (err, row) => {
        if (err) return callback(err, null);
        if (row) return callback(null, row.assigned_id);

        const prefix = type === 'SERVER' ? 'SERVER-' : 'CLIENT-';
        const newId = prefix + crypto.randomBytes(4).toString('hex').toUpperCase();

        db.run(`INSERT INTO device_mappings (hwid, assigned_id, device_type) VALUES (?, ?, ?)`, [hwid, newId, type], (err2) => {
            if (err2) return callback(err2, null);
            return callback(null, newId);
        });
    });
}

function ValidateLicense(licenseKey, callback) {
    db.get(`SELECT * FROM licenses WHERE license_key = ? AND is_active = 1`, [licenseKey], (err, row) => {
        if (err || !row) return callback(false, 'INVALID_LICENSE');
        if (new Date() > new Date(row.expires_at)) return callback(false, 'EXPIRED_LICENSE');
        return callback(true, 'OK', row);
    });
}

function GetOnlineServer() {
    for (const s of servers.values()) {
        if (s.registered && s.socket && !s.socket.destroyed) return s;
    }
    return null;
}

// 관리자 패킷 처리
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

    if (line.startsWith('ADMIN_DELETE|')) {
        const key = line.split('|')[1];
        db.run(`UPDATE licenses SET is_active = 0 WHERE license_key = ?`, [key], (err) => {
            if (err) SendLine(connection.socket, 'ERROR|DELETE_FAILED');
            else SendLine(connection.socket, `ADMIN_DEL_OK|${key}`);
        });
        return;
    }

    if (line === 'ADMIN_LIST') {
        db.all(`SELECT * FROM licenses ORDER BY created_at DESC`, [], (err, rows) => {
            if (err) return SendLine(connection.socket, 'ERROR|DB_ERROR');
            const now = new Date();
            const result = rows.map(r => {
                let status = '정상';
                if (r.is_active === 0) status = '폐기됨';
                else if (now > new Date(r.expires_at)) status = '만료됨';

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

// 클라이언트 패킷 처리
function HandleClientLine(connection, line) {
    if (line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const hwid = parts[1] ? parts[1].trim() : '';
        const licenseKey = parts[2] ? parts[2].trim() : '';

        ValidateLicense(licenseKey, (isValid, reason) => {
            if (!isValid) {
                SendLine(connection.socket, `ERROR|${reason}`);
                return;
            }

            const targetServer = GetOnlineServer();
            if (!targetServer) {
                SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
                return;
            }

            GetOrCreateAssignedID(hwid, 'CLIENT', (err, clientId) => {
                if (err || !clientId) {
                    SendLine(connection.socket, 'ERROR|ID_ASSIGN_FAILED');
                    return;
                }

                connection.clientId = clientId;
                connection.licenseKey = licenseKey;
                connection.connected = true;
                clients.set(clientId, connection);

                SendLine(connection.socket, `CONNECTED|${clientId}|${targetServer.serverId}`);
            });
        });
        return;
    }

    if (line.startsWith('SEND|')) {
        const parts = line.split('|');
        if (parts.length < 3) return;

        const clientId = parts[1].trim();
        const encPayload = parts[2].trim();
        const targetServer = GetOnlineServer();

        if (!targetServer) {
            SendLine(connection.socket, 'ERROR|SERVER_OFFLINE');
            return;
        }

        if (SendLine(targetServer.socket, `NUMBER|${clientId}|${encPayload}`)) {
            SendLine(connection.socket, 'SENT|OK');
        } else {
            SendLine(connection.socket, 'ERROR|RELAY_FAILED');
        }
        return;
    }
}

const server = net.createServer(socket => {
    const connection = { socket, type: null, buffer: '' };

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
                    const hwid = line.split('|')[1];
                    GetOrCreateAssignedID(hwid, 'SERVER', (err, serverId) => {
                        if (!err && serverId) {
                            connection.serverId = serverId;
                            connection.registered = true;
                            servers.set(serverId, connection);
                            SendLine(socket, `REGISTERED|${serverId}|OK`);
                        }
                    });
                }
            } else if (connection.type === 'client') {
                HandleClientLine(connection, line);
            }
        }
    });

    socket.on('close', () => {
        if (connection.clientId) clients.delete(connection.clientId);
        if (connection.serverId) servers.delete(connection.serverId);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`[Relay Server] Started on ${HOST}:${PORT}`);
});
