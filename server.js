const net = require('net');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const PORT = process.env.PORT || 33802;
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// DB 초기화
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT DEFAULT 'UNUSED',
      client_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    )
  `);
});

// 하이픈 포맷 정규화 함수 (XXXX-XXXX-XXXX-XXXX)
function normalizeLicenseKey(key) {
  if (!key) return '';
  const clean = key.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length !== 16) return clean; // 16자리가 아니면 원본 반환
  return `${clean.substr(0,4)}-${clean.substr(4,4)}-${clean.substr(8,4)}-${clean.substr(12,4)}`;
}

const servers = new Map(); // serverId -> socket
const clients = new Map(); // clientId -> socket
const clientToServerMap = new Map(); // clientId -> serverId

let nextServerNum = 1;
let nextClientNum = 1;

const server = net.createServer((socket) => {
  let role = null; // 'SERVER' | 'CLIENT'
  let id = null;
  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString('utf8');

    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;

      const line = buffer.substring(0, idx).replace(/\r/g, '').trim();
      buffer = buffer.substring(idx + 1);

      if (!line) continue;

      if (line === 'PONG') continue;

      // 1. 서버 등록
      if (line.startsWith('REGISTER|')) {
        const parts = line.split('|');
        const serverKey = parts[1] || '';
        
        role = 'SERVER';
        id = `SERVER-${nextServerNum++}`;
        servers.set(id, socket);

        socket.write(`REGISTERED|${id}\n`);
        console.log(`[SERVER REG] ID: ${id}, Key: ${serverKey}`);
        continue;
      }

      // 2. 클라이언트 연결
      if (line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        const clientKey = parts[1] || '';

        role = 'CLIENT';
        id = `CLIENT-${nextClientNum++}`;
        clients.set(id, socket);

        // 사용 가능한 서버 매핑
        let assignedServerId = '';
        if (servers.size > 0) {
          assignedServerId = Array.from(servers.keys())[0];
          clientToServerMap.set(id, assignedServerId);
        }

        socket.write(`CONNECTED|${id}|${assignedServerId}\n`);
        console.log(`[CLIENT CONNECT] ID: ${id}, Assigned Server: ${assignedServerId}`);
        continue;
      }

      // 3. 라이선스 검증 (XXXX-XXXX-XXXX-XXXX 규격 처리)
      if (line.startsWith('VERIFY_LICENSE|')) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const reqClientId = parts[1].trim();
          const rawKey = parts[2].trim();
          const formattedKey = normalizeLicenseKey(rawKey);

          const sql = `SELECT * FROM licenses WHERE UPPER(TRIM(license_key)) = ? OR UPPER(TRIM(license_key)) = ?`;
          db.get(sql, [formattedKey, rawKey.toUpperCase()], (err, row) => {
            if (err) {
              socket.write(`ERROR|DB_ERROR|${err.message}\n`);
              return;
            }

            if (!row) {
              socket.write(`ERROR|LICENSE_NOT_FOUND|${formattedKey}\n`);
              return;
            }

            const today = new Date().toISOString().split('T')[0];
            if (row.expires_at < today) {
              socket.write(`ERROR|LICENSE_EXPIRED|${row.expires_at}\n`);
              return;
            }

            if (row.status === 'EXPIRED' || row.status === 'DISABLED') {
              socket.write(`ERROR|LICENSE_INACTIVE|${row.status}\n`);
              return;
            }

            if (row.status === 'UNUSED') {
              db.run(
                `UPDATE licenses SET status = 'ACTIVE', client_id = ?, used_at = DATETIME('now') WHERE id = ?`,
                [reqClientId, row.id]
              );
            }

            socket.write(`LICENSE_OK|${row.expires_at}\n`);
            console.log(`[LICENSE OK] Client: ${reqClientId}, Key: ${formattedKey}`);
          });
        }
        continue;
      }

      // 4. 데이터 전송 (SEND)
      if (line.startsWith('SEND|')) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const senderClientId = parts[1];
          const payloadNumber = parts[2];

          const targetServerId = clientToServerMap.get(senderClientId);
          const targetSocket = servers.get(targetServerId);

          if (targetSocket) {
            targetSocket.write(`NUMBER|${senderClientId}|${payloadNumber}\n`);
            socket.write(`SENT|OK\n`);
            console.log(`[DATA RELAY] ${senderClientId} -> ${targetServerId} : ${payloadNumber}`);
          } else {
            socket.write(`ERROR|NO_TARGET_SERVER\n`);
          }
        }
        continue;
      }
    }
  });

  // 하트비트 PING (30초)
  const pingInterval = setInterval(() => {
    if (socket.writable) socket.write('PING\n');
  }, 30000);

  socket.on('close', () => {
    clearInterval(pingInterval);
    if (role === 'SERVER' && id) servers.delete(id);
    if (role === 'CLIENT' && id) {
      clients.delete(id);
      clientToServerMap.delete(id);
    }
  });

  socket.on('error', () => {
    socket.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`Relay Server running on port ${PORT}`);
});
