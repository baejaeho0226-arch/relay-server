'use strict';
// Focused regression tests; only Node built-ins, real service/route/storage code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fix10-'));
process.env.DATA_DIR = directory;
process.env.STORAGE_ENGINE = process.env.STORAGE_ENGINE || 'json';
const state = require('../core/state');
const support = require('../services/supportCenter');
const installation = require('../services/clientInstallation');
const handler = require('../relay/clientHandler');
const database = require('../storage/database');
const route = require('../web/routes/supportInstallationRoutes');
require('../core/utils').EnsureDirs();
function connection() {
  const c = { type:'client', connected:false, writes:[] };
  c.socket = { destroyed:false, remoteAddress:'127.0.0.1', write(text) { c.writes.push(text.trim()); return true; }, end() {}, destroy() { this.destroyed = true; } };
  c.socket.__relayConnection = c;
  return c;
}
function fixture(base, suffix, id, token, approved = true) {
  const key = `ANDROID2-${base}-${suffix.repeat(16)}`;
  const saved = { id, serverId:'', installationToken:token, installationAuthorizedAt:approved ? Date.now() : 0 };
  state.clientIdentities.set(key,saved);
  const c = connection(); Object.assign(c,{ clientId:id, installationDeviceKey:key, installationToken:token, connected:true, deviceAuthVerified:true });
  state.clients.set(id,c); installation.Backfill();
  return {key,saved,c};
}
function frames(c,command) { return c.writes.filter(x=>x.startsWith(command+'|')).map(x=>JSON.parse(Buffer.from(x.split('|')[1],'base64'))); }
function disk() { return process.env.STORAGE_ENGINE === 'sqlite' ? require('../storage/sqliteDatabase').LoadSnapshot().data : JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8')); }
async function api(method, pathname, body = {}, role = 'admin') {
  const session = {id:'TEST-ADMIN',role};
  const res = {};
  const Json = (r,status,body)=>Object.assign(r,{status,body});
  const ApiError = (r,status,reason)=>Json(r,status,{ok:false,reason});
  const RequireAdmin = (r,s)=>s.role === 'admin' || (ApiError(r,403,'ADMIN_REQUIRED'),false);
  await route.Handle({method,pathname,body,url:new URL(pathname,'http://localhost'),res,session,RequireAdmin,Json,ApiError});
  return res;
}
(async()=>{
try {
  const a = fixture('1122334455667788','A','A123456789ABCDEF','A'.repeat(32));
  const b = fixture('2233445566778899','B','B123456789ABCDEF','B'.repeat(32));
  for (const {c} of [a,b]) support.Handle(c,`SUPPORT_SYNC|${c.clientId}||0`);
  assert.equal(support.Info().adminOnline,false);
  assert.equal((await api('POST','/api/support/availability',{mode:'ONLINE'})).status,200);
  for (const {c} of [a,b]) assert.equal(frames(c,'SUPPORT_INFO').at(-1).adminOnline,true,'availability broadcast to every room');
  assert.equal(support.Presence({id:'OLD-TAB',role:'admin'},false).adminOnline,true,'old page heartbeat cannot overwrite explicit online');
  const realNow = Date.now; Date.now = ()=>realNow()+120000;
  assert.equal(support.Info().adminOnline,true,'availability survives idle/tab close'); Date.now=realNow;
  support.ImportPersisted(disk());
  assert.equal(support.Info().adminOnline,true,'global state survives persisted import');
  const settings = {hours:'평일 10:00–18:00',greeting:'안녕하세요.',responseGuide:'문의 순서대로 답변합니다.'};
  assert.equal(support.Settings(settings).ok,true);
  assert.equal(support.Info().adminOnline,true,'editing hours does not reset global state');
  assert.equal((await api('POST','/api/support/availability',{mode:'OFFLINE'})).status,200);
  assert.equal(frames(b.c,'SUPPORT_INFO').at(-1).adminOnline,false);
  assert.equal((await api('POST','/api/support/availability',{mode:'INVALID'})).status,409);
  for (const role of ['operator','viewer']) for (const endpoint of ['availability','presence','settings'])
    assert.equal((await api('POST','/api/support/'+endpoint,{mode:'ONLINE'},role)).status,403);
  const text = '문의합니다';
  support.Handle(a.c,`SUPPORT_SEND_V2|CLIENT_MESSAGE_1|1|${Buffer.from(text).toString('base64')}`);
  const room = a.c.supportRoomId;
  assert.equal(support.Read(room).total,1);
  assert.equal((await api('POST',`/api/support/${room}/close`,{revision:1})).status,200);
  let closed = support.Read(room);
  assert.equal(closed.total,2); assert.equal(closed.status,'CLOSED');
  assert.equal(closed.messages.at(-1).role,'SYSTEM');
  assert.match(closed.messages.at(-1).text,/관리자에 의해 상담이 종료되었습니다/);
  assert.equal(frames(a.c,'SUPPORT_MESSAGE').at(-1).role,'SYSTEM','live close message delivered');
  assert.equal(support.Change(room,'close',1).ok,true);
  assert.equal(support.Read(room).total,2,'repeated close cannot duplicate final notice');
  support.ImportPersisted(disk());
  closed = support.Read(room);
  assert.equal(closed.messages.at(-1).role,'SYSTEM','notice survives disk save/import');
  a.c.supportSyncAt=0; a.c.writes=[];
  support.Handle(a.c,`SUPPORT_SYNC|${a.c.clientId}||0`);
  assert.equal(frames(a.c,'SUPPORT_MESSAGE').at(-1).role,'SYSTEM','offline reconnect replays close notice');
  a.c.lastSupportSendAt=0;
  support.Handle(a.c,`SUPPORT_SEND_V2|CLIENT_MESSAGE_2|1|${Buffer.from('추가 문의').toString('base64')}`);
  assert.equal(support.Read(room).status,'OPEN'); assert.equal(support.Read(room).total,3);
  const save = database.SaveDatabase;
  database.SaveDatabase=()=>false;
  try {
    assert.equal(support.Change(room,'close',1).reason,'STORAGE_SAVE_FAILED');
    assert.equal(support.Read(room).status,'OPEN'); assert.equal(support.Read(room).total,3);
    assert.equal(support.Availability({id:'ADMIN',role:'admin'},'ONLINE').reason,'STORAGE_SAVE_FAILED');
    assert.equal(support.Info().adminOnline,false);
  } finally { database.SaveDatabase=save; }
  assert.equal(support.Change(room,'delete',1).ok,true);
  assert.equal(support.Read(room).total,0);
  assert.equal(support.Change(room,'reopen',2).reason,'SUPPORT_DELETED');
  a.c.lastSupportSendAt=0;
  support.Handle(a.c,`SUPPORT_SEND_V2|STALE_MESSAGE|1|${Buffer.from('삭제 전 문의').toString('base64')}`);
  assert.equal(a.c.writes.at(-1),'SUPPORT_ERROR|HISTORY_CHANGED');

  // A restored device key with a new no-backup token must be rejected before
  // disabled/maintenance/PC gates, without replacing the previous live socket.
  for (const gate of ['service','maintenance','client','server']) {
    state.serviceEnabled=true; state.maintenanceMode=false;
    state.disabledClients.clear(); state.disabledServers.clear(); state.clientInstallations.clear();
    const f=fixture('33445566778899AA','C','C123456789ABCDEF','C'.repeat(32));
    if(gate==='service')state.serviceEnabled=false;
    if(gate==='maintenance')state.maintenanceMode=true;
    if(gate==='client')state.disabledClients.add(f.saved.id);
    if(gate==='server'){ f.saved.serverId='E123456789ABCDEF';state.serverIdentities.set('TEST-GATE-PC',f.saved.serverId);state.disabledServers.add(f.saved.serverId); }
    const matching=connection();
    handler.HandleClientLine(matching,`CONNECT_INSTALLATION|2|2.9.9|${f.key}|${'C'.repeat(32)}`);
    assert.equal(installation.List().length,0,'same install is never classified as reinstall by a gate');
    const denied=connection();
    handler.HandleClientLine(denied,`CONNECT_INSTALLATION|2|2.9.9|${f.key}|${'D'.repeat(32)}`);
    assert.equal(denied.reinstallBlocked,true,gate+' gate cannot hide token mismatch');
    assert.ok(denied.writes.includes('ERROR|REINSTALL_NOT_ALLOWED'));
    assert.ok(!denied.writes.some(x=>x.startsWith('CONNECTED|')));
    assert.equal(state.clients.get(f.saved.id),f.c,'reinstall does not attach/replace old socket');
    const list=await api('GET','/api/reinstall-blocks');
    assert.equal(list.body.blocks[0].key,installation.RegistryKey(f.key));
    assert.ok(disk().clientInstallations[installation.RegistryKey(f.key)].blockedAt);
    installation.ImportPersisted(disk());
    assert.equal(installation.List().length,1,'block persists after import');
  }
  state.serviceEnabled=true;state.maintenanceMode=false;state.disabledClients.clear();state.disabledServers.clear();state.clientInstallations.clear();
  const mid=fixture('445566778899AABB','D','D123456789ABCDEF','E'.repeat(32),false);
  delete mid.saved.installationToken;
  // Exercise the actual HMAC verification path, before QR/biometric approval.
  const secret='x'.repeat(43), challengeId='0123456789ABCDEF';
  state.deviceSecrets.set('CLIENT:'+mid.saved.id,secret);
  state.deviceAuthChallenges.set(challengeId,{challengeId,type:'CLIENT',id:mid.saved.id,connection:mid.c,nonce:'0123456789',issuedAt:Date.now(),expiresAt:Date.now()+30000});
  const ch=state.deviceAuthChallenges.get(challengeId);
  const proof=crypto.createHmac('sha256',secret).update(`CLIENT|${mid.saved.id}|${challengeId}|${ch.nonce}|${ch.issuedAt}`).digest('hex').toUpperCase();
  assert.equal(require('../services/deviceAuth').HandleAuth('CLIENT',mid.saved.id,challengeId,proof),true);
  assert.equal(mid.saved.installationToken,'E'.repeat(32));
  assert.ok(mid.saved.installationObservedAt);
  assert.equal(installation.WasAuthorized(mid.saved),false,'observed installation never grants QR/biometric authority');
  const reinstalled=connection();
  handler.HandleClientLine(reinstalled,`CONNECT_INSTALLATION|2|2.9.9|ANDROID2-445566778899AABB-${'E'.repeat(16)}|${'F'.repeat(32)}`);
  assert.equal(reinstalled.reinstallBlocked,true,'reinstall is recorded even before first biometric approval');
  assert.equal(installation.Release(installation.RegistryKey(mid.key),'TEST').ok,true);
  const released=connection();
  handler.HandleClientLine(released,`CONNECT_INSTALLATION|2|2.9.9|ANDROID2-445566778899AABB-${'E'.repeat(16)}|${'F'.repeat(32)}`);
  assert.equal(released.connected,true); assert.equal(released.deviceAuthVerified,false);assert.equal(released.licenseAuthorized,false);assert.equal(released.biometricVerified,false);
  const net=require('node:net');
  const terminal=fixture('5566778899AABBCC','A','F123456789ABCDEF','1'.repeat(32));
  const server=net.createServer(socket=>require('../core/connection').CreateConnection(socket));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const output=await new Promise((resolve,reject)=>{
      const socket=net.connect(server.address().port,'127.0.0.1'); let received='';
      socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('TCP terminal reply timeout'));});
      socket.on('data',data=>{received+=data;});socket.on('error',reject);
      socket.on('end',()=>{socket.end();resolve(received);});
      socket.on('connect',()=>{
        socket.write('CONNECT_INSTALLATION|2|2.9.9|'+terminal.key+'|');
        socket.write('2'.repeat(32)+'\n');
      });
    });
    assert.match(output,/ERROR\|REINSTALL_NOT_ALLOWED/,'TCP close flushes terminal reinstall reason');
    assert.ok(installation.List().some(x=>x.key===installation.RegistryKey(terminal.key)));
  } finally { await new Promise(resolve=>server.close(resolve)); }
  console.log(`FIX10 CORE PASS (${process.env.STORAGE_ENGINE}): global availability, roles, persisted notices, close idempotence, offline replay, delete/stale sends, rollback, four early reinstall gates, HMAC-observed install, release without authorization`);
} finally {
  if(process.env.STORAGE_ENGINE==='sqlite')require('../storage/sqliteDatabase').Close();
  fs.rmSync(directory,{recursive:true,force:true});
}
})().catch(e=>{console.error(e);process.exitCode=1});
