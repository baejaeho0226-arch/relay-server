'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-support-fix10-'));
process.env.DATA_DIR = dir;
process.env.STORAGE_ENGINE = process.env.STORAGE_ENGINE || 'json';
const state = require('../core/state');
const support = require('../services/supportCenter');
const installation = require('../services/clientInstallation');
const db = require('../storage/database');
const handler = require('../relay/clientHandler');
const auth = require('../web/webAuth');
const { Readable } = require('stream');
const id1 = 'AAAAAAAAAAAAAAAA', id2 = 'BBBBBBBBBBBBBBBB', id3 = 'CCCCCCCCCCCCCCCC';
const base = '0011223344556677';
const key1 = `ANDROID2-${base}-${'1'.repeat(16)}`, key2 = `ANDROID2-${base}-${'2'.repeat(16)}`;
const token1 = '1'.repeat(32), token2 = '2'.repeat(32);
function connection(key, id, token, approved = false) {
    state.clientIdentities.set(key, { id, serverId: '', installationToken: token, installationAuthorizedAt: approved ? Date.now() : 0 });
    const c = { clientId: id, type: 'client', connected: true, permissionsGranted: true, deviceAuthVerified: true,
        installationToken: token, installationDeviceKey: key, writes: [] };
    c.socket = { destroyed: false, write: t => { c.writes.push(t.trim()); return true; }, end() {}, destroy() { this.destroyed = true; } };
    c.socket.__relayConnection = c; state.clients.set(id, c); installation.Backfill(); return c;
}
function send(c, line) { handler.HandleClientLine(c, line); }
function frames(c, command) { return c.writes.filter(x => x.startsWith(command + '|')).map(x => JSON.parse(Buffer.from(x.split('|')[1], 'base64'))); }
async function api(role, method, url, body, session) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await require('../web/webApi').HandleApiRequest(req, res, session || { role, ip: '127.0.0.1' }); return res;
}
(async () => {
try {
    require('../core/utils').EnsureDirs();
    const c1 = connection(key1, id1, token1, true);
    // Import the released FIX8 format, preserving the original public room ID.
    support.ImportPersisted({ supportThreads: { [id1]: { clientId: id1, messages: [{seq:1,id:'LEGACY001',role:'CLIENT',text:'이전 버전 문의',at:Date.now()}], updatedAt:Date.now(),unreadAdmin:1 } } });
    assert.equal(state.supportThreads.get(id1).tokenHashes.length, 1);
    send(c1, `SUPPORT_SYNC|${id1}||0`);
    assert.equal(frames(c1,'SUPPORT_INFO').at(-1).roomId, id1);
    for (let n=2;n<=305;n++) assert.equal(support.Reply(id1,`보관 답변 ${n}`,`ADMIN${String(n).padStart(4,'0')}`).ok,true);
    assert.equal(state.supportThreads.get(id1).messages.length,305);
    let rows=[], before=0, page;
    do { page=support.Read(id1,before); rows.unshift(...page.messages); before=page.messages[0]?.seq; } while(page.hasMore);
    assert.equal(rows.length,305); assert.equal(rows[0].text,'이전 버전 문의');
    const snapshot = process.env.STORAGE_ENGINE === 'sqlite' ? require('../storage/sqliteDatabase').LoadSnapshot().data : JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));
    db.ImportDatabaseObject(snapshot);
    assert.equal(state.supportThreads.get(id1).messages.length,305,'all messages survive restart');
    // Same install, new routing CLIENT ID: old room ID and messages remain.
    state.clients.delete(id1);
    const c2 = connection(key1,id2,token1,true);
    send(c2,`SUPPORT_SYNC|${id2}||0`);
    assert.equal(frames(c2,'SUPPORT_INFO').at(-1).roomId,id1);
    assert.equal(frames(c2,'SUPPORT_MESSAGE').length,100,'bounded first page');
    const epoch=support.Read(id1).epoch;
    c2.supportSyncAt=0; send(c2,`SUPPORT_SYNC|${id2}|${epoch}|100`);
    assert.equal(frames(c2,'SUPPORT_MESSAGE').at(-1).seq,200);
    c2.writes=[]; assert.equal(support.Reply(id1,'새 CLIENT로 전달','ADMIN_NEW_ID').ok,true);
    assert.equal(frames(c2,'SUPPORT_MESSAGE').at(-1).text,'새 CLIENT로 전달');
    // Wrong CLIENT claims and superseded/unauthenticated sockets never read rooms.
    c2.writes=[]; send(c2,`SUPPORT_SYNC|${id1}|${epoch}|0`); assert.equal(c2.writes.at(-1),'SUPPORT_ERROR|CLIENT_NOT_OWNER');
    c2.deviceAuthVerified=false; send(c2,`SUPPORT_SYNC|${id2}||0`); assert.equal(c2.writes.at(-1),'SUPPORT_ERROR|AUTH_REQUIRED'); c2.permissionsGranted = true; c2.deviceAuthVerified = true;
    // Real registry release deletes routing identities, but not chat ownership.
    installation.Reject(c2);
    assert.equal(installation.Release(installation.RegistryKey(key1),'TEST_ADMIN').ok,true);
    assert.equal(support.Read(id1).total,306);
    const c3=connection(key2,id3,token2);
    send(c3,`SUPPORT_SYNC|${id3}||0`);
    assert.equal(frames(c3,'SUPPORT_INFO').at(-1).roomId,id3,'new install cannot see old messages before approval');
    assert.equal(frames(c3,'SUPPORT_MESSAGE').length,0);
    send(c3,`SUPPORT_SEND_V2|NEW_QUERY_01|1|${Buffer.from('새 설치의 문의').toString('base64')}`);
    c3.biometricVerified=true; c3.licenseAuthorized=true;
    assert.equal(installation.MarkAuthorized(c3),true);
    c3.supportSyncAt=0;send(c3,`SUPPORT_SYNC|${id3}||0`);
    assert.equal(frames(c3,'SUPPORT_INFO').at(-1).roomId,id1,'approved new install restores permanent room');
    assert.equal(support.Read(id1).total,307,'provisional inquiry merged without losing older messages');
    assert.equal(support.Read(id1).currentClientId,id3);
    assert.equal(support.List().length,1);
    // Phone metadata is admin display only, never an identity claim.
    send(c3,`SUPPORT_DEVICE|${Buffer.from(JSON.stringify({model:'SM-A245N',product:'a24',phone:'010-0000-0000',imeiStatus:'Android 접근 제한'})).toString('base64')}`);
    assert.equal(support.Read(id1).device.model,'SM-A245N');
    const csrfSession=auth.CreateSession({headers:{},socket:{remoteAddress:'127.0.0.1'}},'admin');
    assert.equal((await api('admin','POST','/api/support/availability',{mode:'ONLINE'},csrfSession)).status,200);
    assert.equal(support.Info().adminOnline,true);
    const realNow=Date.now;Date.now=()=>realNow()+46000;
    assert.equal(support.Info().adminOnline,true,'explicit online status persists');Date.now=realNow;
    support.Presence(csrfSession,false);auth.RevokeSession(csrfSession.id);
    assert.equal(support.Info().adminOnline,true,'navigation/logout does not overwrite global selection');
    const nextSession=auth.CreateSession({headers:{},socket:{remoteAddress:'127.0.0.1'}},'admin');
    assert.equal((await api('admin','POST','/api/support/availability',{mode:'OFFLINE'},nextSession)).status,200);
    assert.equal(support.Info().adminOnline,false);
    const settings={hours:'평일 10:00–18:00 (한국 시간)',greeting:'안녕하세요.',responseGuide:'순서대로 답변합니다.'};
    assert.equal((await api('admin','POST','/api/support/settings',settings)).status,200);
    assert.equal(support.Info().hours,settings.hours);
    assert.equal((await api('admin','POST','/api/support/settings',{...settings,hours:'x'.repeat(161)})).status,409);
    for(const action of ['close','reopen','delete','reply','read']) for(const role of ['viewer','operator'])
        assert.equal((await api(role,'POST',`/api/support/${id1}/${action}`,{revision:1,text:'forbidden'})).status,403);
    for(const endpoint of ['settings','presence','availability']) for(const role of ['viewer','operator'])
        assert.equal((await api(role,'POST',`/api/support/${endpoint}`,settings)).status,403);
    assert.equal((await api('admin','POST',`/api/support/${id1}/close`,{revision:1})).status,200);
    assert.equal(support.Read(id1).status,'CLOSED');
    assert.equal(support.Reply(id1,'closed','CLOSED_REPLY',1).reason,'SUPPORT_CLOSED');
    assert.equal((await api('admin','POST',`/api/support/${id1}/reopen`,{revision:1})).status,200);
    const oldEpoch=support.Read(id1).epoch;
    assert.equal((await api('admin','POST',`/api/support/${id1}/delete`,{revision:1})).status,200);
    assert.equal(support.List().length,0,'deleted room removed from admin list');
    assert.equal(support.Read(id1).total,0,'content actually erased');
    assert.notEqual(support.Read(id1).epoch,oldEpoch);
    assert.equal(frames(c3,'SUPPORT_RESET').at(-1).status,'DELETED','APK receives reset');
    const deleted=db.BuildDatabaseObject();db.ImportDatabaseObject(deleted);
    assert.equal(support.Read(id1).total,0,'restart does not resurrect deleted history');
    assert.equal(support.Info().hours,settings.hours,'hours survive restart');
    c3.lastSupportSendAt=0;
    send(c3,`SUPPORT_SEND_V2|STALE_RETRY|1|${Buffer.from('삭제 전 보류된 전송').toString('base64')}`);
    assert.equal(c3.writes.at(-1),'SUPPORT_ERROR|HISTORY_CHANGED');
    assert.equal(support.Reply(id1,'stale web reply','STALE_ADMIN',1).reason,'HISTORY_CHANGED');
    assert.equal(support.MarkRead(id1,999,1).reason,'HISTORY_CHANGED');
    assert.equal(support.Read(id1).total,0);
    const revision=support.Read(id1).revision;
    send(c3,`SUPPORT_SEND_V2|FRESH_QUERY|${revision}|${Buffer.from('새로 접수한 문의').toString('base64')}`);
    assert.equal(support.Read(id1).total,1);assert.equal(support.Read(id1).status,'OPEN');
    assert.equal(support.List()[0].clientId,id1,'stable identity survives explicit history deletion');
    assert.equal(support.Change(id1,'close',revision).ok,true);
    c3.lastSupportSendAt=0;
    send(c3,`SUPPORT_SEND_V2|AFTER_CLOSE|${revision}|${Buffer.from('다시 문의').toString('base64')}`);
    assert.equal(support.Read(id1).status,'OPEN','a new user message really reopens a closed room');
    // Failed persistence must not erase messages or falsely report a change.
    const save=db.SaveDatabase; db.SaveDatabase=()=>false;
    assert.equal(support.Change(id1,'delete',revision).reason,'STORAGE_SAVE_FAILED');
    assert.equal(support.Read(id1).total,3);
    assert.equal(support.Reply(id1,'storage failure','FAIL_REPLY',revision).reason,'STORAGE_SAVE_FAILED');
    assert.equal(support.Read(id1).total,3);db.SaveDatabase=save;
    // FIX8 kept only the last 200 rows, whose first sequence need not be 1.
    // Communicate the retained base cursor so the APK can replay those rows.
    const retainedSnapshot = db.BuildDatabaseObject();
    support.ImportPersisted({supportThreads:{[id1]:{messages:Array.from({length:200},(_,i)=>({seq:i+201,id:'OLD'+String(i).padStart(5,'0'),role:'CLIENT',text:'이전 보관 기록',at:Date.now()})),updatedAt:Date.now()}}});
    c3.supportRoomId='';c3.supportSyncAt=0;c3.writes=[];
    // Legacy room belongs to its current known routing address during import.
    state.supportThreads.get(id1).currentClientId=id3;
    support.Backfill();
    send(c3,`SUPPORT_SYNC|${id3}||0`);
    assert.equal(frames(c3,'SUPPORT_RESET').at(-1).baseSeq,200);
    assert.equal(frames(c3,'SUPPORT_MESSAGE')[0].seq,201);
    db.ImportDatabaseObject(retainedSnapshot);
    console.log('FIX9 SUPPORT PERSISTENCE PASS: migration, 305+ messages, paging, ID change, release/reapproval, isolated ownership, device info, global availability, settings, real close/delete, stale retry rejection, storage rollback, admin-only APIs');
} finally { if(process.env.STORAGE_ENGINE==='sqlite')require('../storage/sqliteDatabase').Close();fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
