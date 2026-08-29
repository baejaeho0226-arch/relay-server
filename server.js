const net = require('net');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const PORT = process.env.PORT || 33802;
const DB_PATH = path.join(__dirname, 'database.sqlite');

// DB 초기화
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB 연결 실패:', err.message);
  else console.log('SQLite DB 연결 성공');
});

// 테이블 생성
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

// 세션 관리 Map
const clients = new Map(); // ClientKey -> { socket, clientId, serverId }
const servers = new Map(); // ServerKey -> { socket, serverId }

let clientCounter = 1000;
let serverCounter = 5000;

// 라이선스 키 정규화 함수 (하이픈 제거 후 XXXX-XXXX-XXXX-XXXX 형식으로 변환)
function normalizeLicenseKey(key) {
  const clean = key.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (clean.length !== 16) return clean; // 16자리가 아니면 원본 정제값 반환
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}`;
}

const server = net.createServer((socket) => {
  let entityType = null; // 'CLIENT' | 'SERVER'
  let entityKey = null;

  socket.on('data', (chunk) => {
    const lines = chunk.toString('utf8').split('\n');
    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // 1. 하트비트 PING
      if (line === 'PING') {
        socket.write('PONG\n');
        continue;
      }
      if (line === 'PONG') continue;

      // 2. WinSockServer 등록 (REGISTER|SERVERKEY-...)
      if (line.startsWith('REGISTER|')) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          entityKey = parts[1].trim();
          entityType = 'SERVER';
          
          let serverId = `SRV-${++serverCounter}`;
          servers.set(entityKey, { socket, serverId });
          
          socket.write(`REGISTERED|${serverId}\n`);
          console.log(`[SERVER REG] Key: ${entityKey} -> Assigned ID: ${serverId}`);
        }
        continue;
      }

      // 3. ApkWinSock 연결 (CONNECT|CLIENTKEY-...)
      if (line.startsWith('CONNECT|')) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          entityKey = parts[1].trim();
          entityType = 'CLIENT';

          let clientId = `CLI-${++clientCounter}`;
          // 현재 연결된 첫 번째 WinSockServer에 매핑 (단일 서버 구조)
          let assignedServerId = 'NONE';
          if (servers.size > 0) {
            assignedServerId = Array.from(servers.values())[0].serverId;
          }

          clients.set(entityKey, { socket, clientId, serverId: assignedServerId });
          socket.write(`CONNECTED|${clientId}|${assignedServerId}\n`);
          console.log(`[CLIENT CON] Key: ${entityKey} -> ClientID: ${clientId}, ServerID: ${assignedServerId}`);
        }
        continue;
      }

      // 4. 라이선스 검증 (VERIFY_LICENSE|ClientID|LicenseKey)
      if (line.startsWith('VERIFY_LICENSE|')) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const clientId = parts[1].trim();
          const inputKey = parts[2].trim();
          const formattedKey = normalizeLicenseKey(inputKey);

          // 하이픈 포함 또는 미포함 키 모두 DB에서 검색 가능하도록 처리
          const rawCleanKey = inputKey.replace(/[^A-Z0-9]/gi, '').toUpperCase();

          const sql = `
            SELECT * FROM licenses 
            WHERE (UPPER(REPLACE(license_key, '-', '')) = ? OR UPPER(license_key) = ?)
              AND status IN ('UNUSED', 'ACTIVE')
          `;

          db.get(sql, [rawCleanKey, formattedKey], (err, row) => {
            if (err) {
              socket.write(`ERROR|DB_ERROR|${err.message}\n`);
              return;
            }

            if (!row) {
              socket.write(`ERROR|LICENSE_NOT_FOUND\n`);
              console.log(`[LICENSE FAIL] Invalid Key: ${inputKey} (Clean: ${rawCleanKey})`);
              return;
            }

            // 만료일 체크 (YYYY-MM-DD)
            const today = new Date().toISOString().split('T')[0];
            if (row.expires_at < today) {
              socket.write(`ERROR|LICENSE_EXPIRED|${row.expires_at}\n`);
              return;
            }

            // 미사용 키일 경우 ACTIVE 처리
            if (row.status === 'UNUSED') {
              const updateSql = `UPDATE licenses SET status = 'ACTIVE', client_id = ?, used_at = DATETIME('now') WHERE id = ?`;
              db.run(updateSql, [clientId, row.id]);
            }

            socket.write(`LICENSE_OK|${row.expires_at}\n`);
            console.log(`[LICENSE SUCCESS] Key: ${row.license_key} -> Client: ${clientId}`);
          });
        }
        continue;
      }

      // 5. 데이터 전송 (SEND|ClientID|Number)
      if (line.startsWith('SEND|')) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const clientId = parts[1].trim();
          const numberVal = parts[2].trim();

          // 연결된 WinSockServer로 전송
          let targetServer = Array.from(servers.values())[0];
          if (targetServer && targetServer.socket) {
            targetServer.socket.write(`NUMBER|${clientId}|${numberVal}\n`);
            socket.write(`SENT|OK\n`);
            console.log(`[DATA RELAY] Client ${clientId} -> Server ${targetServer.serverId}: ${numberVal}`);
          } else {
            socket.write(`ERROR|NO_SERVER_AVAILABLE\n`);
          }
        }
        continue;
      }
    }
  });

  socket.on('close', () => {
    if (entityType === 'CLIENT' && entityKey) clients.delete(entityKey);
    if (entityType === 'SERVER' && entityKey) servers.delete(entityKey);
  });

  socket.on('error', (err) => {
    console.error(`[SOCKET ERROR] ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`Relay Server running on port ${PORT}`);
});
