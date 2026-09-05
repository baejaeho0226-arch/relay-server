'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-support-test-'));
process.env.DATA_DIR = dir;
process.env.STORAGE_ENGINE = process.env.STORAGE_ENGINE || 'json';
process.env.ADMIN_SECRET = 'test-support-admin';
const state = require('../core/state');
const handler = require('../relay/clientHandler');
const support = require('../services/supportCenter');
const database = require('../storage/database');
const id = 'A123456789ABCDEF';
const other = 'B123456789ABCDEF';
const writes = [];
const socket = { destroyed: false, write: text => { writes.push(text.trim()); return true; }, destroy() { this.destroyed = true; } };
const c = { clientId: id, connected: true, socket, type: 'client', deviceAuthVerified: false };
socket.__relayConnection = c;
const send = (rid, text) => handler.HandleClientLine(c, `SUPPORT_SEND|${rid}|${Buffer.from(text).toString('base64')}`);
async function run() {
try {
  require('../core/utils').EnsureDirs();
  state.clientIdentities.set('TEST-SUPPORT', { id, serverId: '', installationAuthorizedAt: 0 });
  state.clients.set(id, c);
  send('REQUEST01', '안녕하세요');
  assert.strictEqual(state.supportThreads.size, 0);
  assert.strictEqual(writes.pop(), 'SUPPORT_ERROR|AUTH_REQUIRED');
  c.deviceAuthVerified = true;
  handler.HandleClientLine(c, `SUPPORT_OPEN|${other}`);
  assert.strictEqual(writes.pop(), 'SUPPORT_ERROR|CLIENT_NOT_OWNER');
  send('REQUEST01', '문의 | 한글\n둘째 줄 😀 <script>');
  assert.strictEqual(support.Read(id).messages[0].text, '문의 | 한글\n둘째 줄 😀 <script>');
  send('REQUEST01', '문의 | 한글\n둘째 줄 😀 <script>');
  assert.strictEqual(support.Read(id).messages.length, 1, 'retry is idempotent');
  send('REQUEST01', 'changed');
  assert.strictEqual(writes.pop(), 'SUPPORT_ERROR|MESSAGE_ID_CONFLICT');
  send('REQUEST02', 'rate limit');
  assert.strictEqual(writes.pop(), 'SUPPORT_ERROR|RATE_LIMIT');
  c.lastSupportSendAt = 0;
  send('REQUEST03', 'x'.repeat(1001));
  assert.strictEqual(writes.pop(), 'SUPPORT_ERROR|INVALID_MESSAGE');
  assert.strictEqual(support.Read(id).messages.length, 1);
  const reply = support.Reply(id, '관리자 답변\n확인했습니다.', 'ADMINREQ01');
  assert.strictEqual(reply.ok, true);
  const frame = writes.pop();
  const decoded = JSON.parse(Buffer.from(frame.split('|')[1], 'base64').toString('utf8'));
  assert.strictEqual(decoded.role, 'ADMIN');
  assert.strictEqual(decoded.text, '관리자 답변\n확인했습니다.');
  c.connected = false;
  const before = writes.length;
  assert.strictEqual(support.Reply(id, '미접속 보관 답변', 'ADMINREQ02').ok, true);
  assert.strictEqual(writes.length, before);
  const snapshot = process.env.STORAGE_ENGINE === 'sqlite'
      ? require('../storage/sqliteDatabase').LoadSnapshot().data
      : JSON.parse(fs.readFileSync(require('../config/config').DB_FILE, 'utf8'));
  database.ImportDatabaseObject(snapshot);
  c.connected = true;
  handler.HandleClientLine(c, `SUPPORT_OPEN|${id}`);
  assert.strictEqual(writes.at(-1), 'SUPPORT_HISTORY_END');
  assert.strictEqual(support.Read(id).messages.length, 3);
  assert.strictEqual(support.MarkRead(id, 1).ok, true);
  assert.strictEqual(support.List()[0].unreadAdmin, 0);
  c.reinstallBlocked = true;
  send('REQUEST04', 'blocked');
  assert.strictEqual(support.Read(id).messages.length, 3);

  // Real Web API authorization, including operators/viewers on both GET/POST.
  const { Readable } = require('stream');
  const { HandleApiRequest } = require('../web/webApi');
  async function api(role, method, url, body) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    const response = { status: 0, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await HandleApiRequest(req, response, { role, ip: '127.0.0.1' });
    return response;
  }
  for (const role of ['viewer', 'operator']) {
    for (const [method, url, body] of [['GET', '/api/support'], ['GET', '/api/reinstall-blocks'], ['POST', `/api/support/${id}/reply`, { text: 'forbidden' }], ['POST', `/api/reinstall-blocks/${'A'.repeat(64)}/release`, {}]]) {
      const result = await api(role, method, url, body);
      assert.strictEqual(result.status, 403, `${role} ${url}`);
    }
  }
  assert.strictEqual((await api('admin', 'GET', '/api/support')).status, 200);
  assert.strictEqual((await api('admin', 'POST', `/api/support/${id}/reply`, { text: '웹 답변', requestId: 'ADMINREQ03' })).status, 200);
  assert.strictEqual(support.Read(id).messages.at(-1).text, '웹 답변');
  console.log('SUPPORT CENTER PASS: UTF-8, ownership, HMAC, limits, retry dedupe, live/offline replies, persistence, admin-only routes');
} finally { if (process.env.STORAGE_ENGINE === 'sqlite') require('../storage/sqliteDatabase').Close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
