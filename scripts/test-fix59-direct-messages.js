'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const restart=process.env.FIX59_DM_RESTART,dir=restart||fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix59-dm-'));
process.env.DATA_DIR=dir;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),dm=require('../services/member/direct-messages'),database=require('../storage/database');
let serial=0;
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX59-DM-REQUEST-'+(++serial),action,body),own=c=>s.Account(c),snapshot=()=>JSON.stringify(s.DB());
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX59-DM-DEVICE-'+n,lines=[];
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,lines,socket:{destroyed:false,write(line){lines.push(line);return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 const lm=require('../license/licenseManager');c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
function unchanged(fn,error){const before=snapshot();assert.throws(fn,error);assert.equal(snapshot(),before,'rejected request cannot change messages, cursor, pair or operation receipt');}
function failedSave(fn){const save=database.SaveDatabase;try{database.SaveDatabase=()=>false;unchanged(fn,/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}}
if(restart){
 database.LoadDatabase();const expected=JSON.parse(fs.readFileSync(path.join(dir,'fix59-dm-expected.json'),'utf8')),p=s.ProfileById(expected.a),peer=s.ProfileById(expected.b);
 assert.ok(p&&peer);assert.equal(dm.Thread(p,{id:expected.oldId}).thread.deleted,true);assert.equal(dm.Thread(peer,{id:expected.oldId}).messages.length,0);
 const before=snapshot(),receipt=s.Operation(p,'DM-SECRET-SEND','dm.send',{id:expected.oldId,text:'shared deletion secret'},()=>{throw Error('duplicate mutation ran');});
 assert.equal(dm.Project(p,'dm.send',receipt).thread.deleted,true);assert.equal(snapshot(),before);assert.equal(snapshot().includes('shared deletion secret'),false);
 const live=dm.Thread(peer,{id:expected.newId});assert.equal(live.messages.at(-1).text,'new conversation after restart');assert.equal(dm.List(p).total,1);assert.equal(dm.List(peer).total,1);
 console.log('FIX59 DM FRESH-PROCESS RESTART PASS');
}else try{
 const a=client(59001),b=client(59002),outsider=client(59003);for(const c of [a,b,outsider])run(c,'me');
 s.Atomic(()=>{own(a).nickname='대화 회원 A';own(b).nickname='대화 회원 B';own(a).balance=912345;own(b).points=765432;});
 let before=snapshot();assert.equal(run(a,'dm').total,0);assert.equal(snapshot(),before,'conversation list reads have no cursor or wallet side effects');
 unchanged(()=>run(a,'dm.open',{memberId:own(a).id}),/DM_SELF/);unchanged(()=>run(a,'dm.open',{memberId:'missing'}),/DM_UNAVAILABLE/);
 failedSave(()=>run(a,'dm.open',{memberId:own(b).id},'DM-OPEN-A'));
 const first=run(a,'dm.open',{memberId:own(b).id},'DM-OPEN-A'),id=first.thread.id;
 assert.equal(first.thread.peer.id,own(b).id);assert.equal(first.thread.canSend,true);assert.deepEqual(first.messages,[]);assert.equal(first.beforeSeq,0);
 assert.equal(run(b,'dm.open',{memberId:own(a).id}).thread.id,id,'reverse pair resolves the same conversation');
 assert.equal(run(a,'dm.open',{memberId:'@'+s.Handle(own(b))}).thread.id,id,'handle resolution never creates a second pair');
 assert.equal(Object.keys(s.DB().directThreads).length,1);assert.equal(Object.keys(s.DB().directPairs).length,1);
 const view=run(a,'dm').items[0];assert.equal(view.peer.nickname,'대화 회원 B');
 for(const key of ['subject','balance','points','inventory','preferences','pronouns','bio','createdAt','readSeq','received'])assert.equal(view.peer[key],undefined,'public chat peer omits '+key);
 unchanged(()=>run(outsider,'dmthread',{id}),/DM_NOT_FOUND/);unchanged(()=>run(outsider,'dm.send',{id,text:'forged'}),/DM_NOT_FOUND/);
 unchanged(()=>run(outsider,'dm.read',{id,throughSeq:0}),/DM_NOT_FOUND/);unchanged(()=>run(outsider,'dm.delete',{id,confirmed:true}),/DM_NOT_FOUND/);
 assert.equal(run(outsider,'dm',{memberId:own(a).id,accountId:own(a).id}).total,0);
 for(const text of ['',null,[],{},' '.repeat(5),'a'.repeat(dm.MAX_TEXT+1)])unchanged(()=>run(a,'dm.send',{id,text}),/DM_TEXT_INVALID/);
 failedSave(()=>run(a,'dm.send',{id,text:'shared deletion secret'},'DM-SECRET-SEND'));
 const sent=run(a,'dm.send',{id,text:'shared deletion secret'},'DM-SECRET-SEND');assert.equal(sent.messages.length,1);assert.equal(sent.messages[0].own,true);assert.ok(sent.sentMessageId);
 const replayBefore=snapshot();const replay=run(a,'dm.send',{id,text:'shared deletion secret'},'DM-SECRET-SEND');assert.equal(replay.sentMessageId,sent.sentMessageId);assert.equal(snapshot(),replayBefore);
 unchanged(()=>run(a,'dm.send',{id,text:'different text'},'DM-SECRET-SEND'),/REQUEST_REUSED/);
 assert.equal(run(b,'dm').unreadCount,1);const incoming=run(b,'dmthread',{id});assert.equal(incoming.messages[0].own,false);assert.equal(incoming.thread.unreadCount,1);assert.equal(incoming.thread.readSeq,0,'opening a read projection does not acknowledge unseen arrivals');
 before=snapshot();run(b,'dmthread',{id});run(b,'dm');assert.equal(snapshot(),before);
 for(const throughSeq of [-1,1.5,2,'1',undefined])unchanged(()=>run(b,'dm.read',{id,throughSeq}),/INPUT_INVALID/);
 failedSave(()=>run(b,'dm.read',{id,throughSeq:1},'DM-READ-FIRST'));
 assert.equal(run(b,'dm.read',{id,throughSeq:1},'DM-READ-FIRST').thread.unreadCount,0);assert.equal(run(a,'dmthread',{id}).thread.peerReadSeq,1);
 run(a,'dm.send',{id,text:'새 메시지'});assert.equal(run(b,'dm.read',{id,throughSeq:1}).thread.unreadCount,1,'acknowledgement of an old rendered cursor leaves new arrival unread');
 run(b,'dm.send',{id,text:'답장\n두 번째 줄'});assert.equal(run(b,'dmthread',{id}).thread.unreadCount,1,'sending a reply cannot mark unrendered incoming messages read');
 assert.equal(run(a,'dm').unreadCount,1);assert.equal(run(a,'dm.read',{id,throughSeq:3}).thread.unreadCount,0);
 for(let i=4;i<=35;i++)run(a,'dm.send',{id,text:'페이지 메시지 '+i});
 let latest=run(b,'dmthread',{id});assert.equal(latest.total,35);assert.equal(latest.messages.length,30);assert.equal(latest.messages[0].seq,6);assert.equal(latest.messages.at(-1).seq,35);assert.equal(latest.nextBeforeSeq,6);
 const older=run(b,'dmthread',{id,beforeSeq:latest.nextBeforeSeq});assert.equal(older.beforeSeq,6);assert.deepEqual(older.messages.map(x=>x.seq),[1,2,3,4,5]);assert.equal(older.nextBeforeSeq,null);
 assert.equal(new Set([...older.messages,...latest.messages].map(x=>x.id)).size,35,'cursor pages contain no duplicate or missing message');
 assert.equal(run(b,'dmthread',{id,beforeSeq:1}).messages.length,0);
 for(const body of [{id,beforeSeq:-1},{id,beforeSeq:1.2},{id,limit:31},{id,limit:0}])unchanged(()=>run(b,'dmthread',body),/INPUT_INVALID/);
 for(const body of [{offset:-1},{offset:1.2},{limit:31},{limit:0}])unchanged(()=>run(b,'dm',body),/INPUT_INVALID/);
 // Blocking is checked on every projection and mutation, including operation replay.
 run(b,'block.set',{id:own(a).id,blocked:true});assert.equal(run(a,'dm').total,0);assert.equal(run(b,'dm').total,0);
 const blocked=run(a,'dmthread',{id});assert.equal(blocked.thread.canSend,false);assert.equal(blocked.thread.unavailable,true);assert.deepEqual(blocked.messages,[]);assert.equal(blocked.thread.peer,null);
 assert.deepEqual(run(a,'dm.send',{id,text:'shared deletion secret'},'DM-SECRET-SEND').messages,[],'old successful receipt cannot bypass a later block');
 unchanged(()=>run(a,'dm.send',{id,text:'blocked message'}),/DM_UNAVAILABLE/);unchanged(()=>run(a,'dm.open',{memberId:own(b).id}),/DM_UNAVAILABLE/);
 run(b,'block.set',{id:own(a).id,blocked:false});assert.equal(run(a,'dm').total,1);assert.equal(run(a,'dmthread',{id}).total,35);
 s.Atomic(()=>{own(b).blocked=true;});assert.equal(run(a,'dm').total,0);unchanged(()=>run(a,'dm.send',{id,text:'disabled account'}),/DM_UNAVAILABLE/);s.Atomic(()=>{own(b).blocked=false;});
 a.biometricVerified=false;unchanged(()=>run(a,'dm'),/MEMBER_AUTH_REQUIRED/);unchanged(()=>run(a,'dm.send',{id,text:'unauthorized'}),/MEMBER_AUTH_REQUIRED/);a.biometricVerified=true;
 state.serviceEnabled=false;unchanged(()=>run(a,'dm'),/SERVICE_DISABLED/);state.serviceEnabled=true;
 unchanged(()=>run(a,'dm.delete',{id}),/DM_DELETE_CONFIRM/);failedSave(()=>run(a,'dm.delete',{id,confirmed:true},'DM-DELETE-BOTH'));
 const deleted=run(a,'dm.delete',{id,confirmed:true},'DM-DELETE-BOTH');assert.equal(deleted.deleted,true);assert.equal(deleted.total,0);assert.equal(run(b,'dm').total,0);
 for(const c of [a,b]){const closed=run(c,'dmthread',{id});assert.equal(closed.thread.deleted,true);assert.equal(closed.thread.canSend,false);assert.equal(closed.messages.length,0);assert.equal(closed.thread.unreadCount,0);}
 assert.equal(snapshot().includes('shared deletion secret'),false,'shared deletion removes text from authoritative data and operation receipts');
 unchanged(()=>run(b,'dm.send',{id,text:'late queued send'}),/DM_DELETED/);unchanged(()=>run(b,'dm.read',{id,throughSeq:35}),/DM_DELETED/);
 const oldSend=run(a,'dm.send',{id,text:'shared deletion secret'},'DM-SECRET-SEND');assert.equal(oldSend.thread.deleted,true);assert.equal(oldSend.sentMessageId,undefined);assert.equal(oldSend.messages.length,0);
 assert.equal(run(a,'dm.open',{memberId:own(b).id},'DM-OPEN-A').thread.deleted,true,'old opening request cannot silently resurrect a deleted thread');
 const next=run(b,'dm.open',{memberId:own(a).id},'DM-NEW-PAIR'),newId=next.thread.id;assert.notEqual(newId,id);assert.equal(run(a,'dm').total,1);
 run(a,'dm.delete',{id,confirmed:true},'DM-DELETE-BOTH');assert.equal(run(a,'dm').items[0].id,newId,'old deletion replay does not remove an explicitly restarted conversation');
 unchanged(()=>run(a,'dm.send',{id,text:'late send after explicit reopen'}),/DM_DELETED/);
 run(a,'dm.send',{id:newId,text:'new conversation after restart'},'DM-NEW-SEND');assert.equal(run(b,'dmthread',{id:newId}).thread.unreadCount,1);
 const data=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(data),true);assert.equal(run(b,'dmthread',{id:newId}).messages.at(-1).text,'new conversation after restart');
 const legacy=structuredClone(s.DB());delete legacy.directThreads;delete legacy.directPairs;s.Import({memberHub:legacy});assert.deepEqual(s.DB().directThreads,{});assert.deepEqual(s.DB().directPairs,{});database.ImportDatabaseObject(data);
 // Existing authenticated realtime channel invalidates the other participant
 // after a committed send, and never includes private text in the event packet.
 for(const c of [a,b,outsider])c.lines.length=0;
 const body={id:newId,text:'서명된 실시간 메시지'},encoded=Buffer.from(JSON.stringify(body)).toString('base64'),requestId='DM-SIGNED-SEND',signature=require('../services/member/protocol').Sign(a,'HUB',[requestId,'dm.send',encoded]);
 assert.equal(hub.Handle(a,['HUB',requestId,'dm.send',encoded,signature].join('|')),true);assert.ok(b.lines.some(line=>line.startsWith('HUB_EVENT|')));assert.ok(a.lines.some(line=>line.startsWith('HUB_CHUNK|')));
 assert.ok(b.lines.every(line=>!line.includes(body.text)),'realtime event is an invalidation, never message content broadcast');
 // Restart expectation retains one live conversation; restore final expected text.
 run(a,'dm.send',{id:newId,text:'new conversation after restart'});
 fs.writeFileSync(path.join(dir,'fix59-dm-expected.json'),JSON.stringify({a:own(a).id,b:own(b).id,oldId:id,newId}));assert.equal(database.SaveDatabase(),true);
 const child=require('node:child_process').spawnSync(process.execPath,[__filename],{env:{...process.env,FIX59_DM_RESTART:dir},encoding:'utf8',timeout:20000});assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
 console.log('FIX59 DIRECT MESSAGES PASS: authenticated pair identity, privacy/block checks, cursor paging, unread/read acknowledgement, live signed invalidation, shared deletion/tombstones, late writes, replay, atomic rollback and fresh-process persistence.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
