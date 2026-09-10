'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix20-bot-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),store=require('../services/member/store'),db=require('../storage/database');
const closed=[],peers=[];let seq=0;
const server=net.createServer(socket=>{closed.push(new Promise(resolve=>socket.once('close',resolve)));require('../core/connection').CreateConnection(socket);});
function connect(){return new Promise((resolve,reject)=>{
 const socket=net.createConnection({port:server.address().port,host:'127.0.0.1'}),lines=[],waiters=[];let buffer='';
 const peer={socket,send:line=>socket.write(line+'\n'),wait(prefix){const i=lines.findIndex(x=>x.startsWith(prefix));if(i>=0)return Promise.resolve(lines.splice(i,1)[0]);return new Promise((res,rej)=>{const item={prefix,res,rej,timer:setTimeout(()=>rej(Error('Timeout: '+prefix)),4000)};waiters.push(item);});},close(){for(const w of waiters){clearTimeout(w.timer);w.rej(Error('Connection closed'));}waiters.length=0;socket.destroy();}};
 peers.push(peer);socket.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line.startsWith('PING|')){peer.send(line.replace('PING|','PONG|'));continue;}const n=waiters.findIndex(x=>line.startsWith(x.prefix));if(n<0)lines.push(line);else{const w=waiters.splice(n,1)[0];clearTimeout(w.timer);w.res(line);}}});
 socket.once('error',reject);socket.once('connect',()=>resolve(peer));
});}
function mac(p,prefix,fields){return crypto.createHmac('sha256',p.secret).update([prefix,p.c.clientId,p.c.deviceAuthChallengeId,...fields].join('|')).digest('hex').toUpperCase();}
async function login(){const p=await connect();p.send('CONNECT|2|2.19.0|MEMBER-REFRESH-FIX20-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX20-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX20-REQUEST-'+(++seq)){
 const encoded=Buffer.from(JSON.stringify(body)).toString('base64');p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total;
 do{const parts=(await p.wait('HUB_CHUNK|'+id+'|')).split('|');assert.equal(parts[2],action);assert.equal(parts[6],mac(p,'HUB_RESPONSE',parts.slice(1,6)));total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 return JSON.parse(Buffer.from(pieces.join(''),'base64').toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}

const support=require('../services/supportCenter'),knowledge=require('../services/supportKnowledge');
async function supportFrame(peer,command){const line=await peer.wait(command+'|');return JSON.parse(Buffer.from(line.split('|')[1],'base64').toString());}
async function api(role,method,url,body){
 const {Readable}=require('node:stream'),req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
 Object.assign(req,{method,url,headers:{},socket:{remoteAddress:'127.0.0.1'}});
 const response={writeHead(status){this.status=status;},end(text){this.body=JSON.parse(text);}};
 await require('../web/webApi').HandleApiRequest(req,response,{role,ip:'127.0.0.1'});return response;
}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const a=await login(),b=await login();
 a.send('SUPPORT_HELP|'+b.c.clientId);assert.equal(await a.wait('SUPPORT_ERROR|'),'SUPPORT_ERROR|CLIENT_NOT_OWNER');
 a.send('SUPPORT_HELP|'+a.c.clientId);const help=await supportFrame(a,'SUPPORT_HELP_DATA');assert.ok(help.faq.length>=6);assert.equal(state.supportThreads.size,0,'reading FAQ does not start a conversation');assert.ok(help.faq.every(x=>!x.keywords));
 a.send('SUPPORT_BOT_OPEN|'+a.c.clientId);let info=await supportFrame(a,'SUPPORT_INFO');const id=info.roomId;assert.equal(info.mode,'BOT');
 a.send('SUPPORT_SYNC|'+a.c.clientId+'||0');await supportFrame(a,'SUPPORT_INFO');const reset=await supportFrame(a,'SUPPORT_RESET');const welcome=await supportFrame(a,'SUPPORT_MESSAGE');assert.equal(welcome.role,'BOT');assert.equal(welcome.seq,1);await supportFrame(a,'SUPPORT_PAGE');
 const send=(rid,text,revision=info.revision)=>a.send('SUPPORT_SEND_V2|'+rid+'|'+revision+'|'+Buffer.from(text).toString('base64'));
 send('BOT_QUESTION_001','충전은 어떻게 하나요?');let mine=await supportFrame(a,'SUPPORT_MESSAGE'),answer=await supportFrame(a,'SUPPORT_MESSAGE');info=await supportFrame(a,'SUPPORT_INFO');
 assert.equal(mine.role,'CLIENT');assert.equal(answer.role,'BOT');assert.equal(answer.replyTo,mine.id);assert.match(answer.text,/QR 충전/);assert.match(answer.text,/만료 기간이 없/);assert.equal(support.Read(id).total,3);assert.equal(support.Read(id).mode,'BOT');assert.equal(support.List().find(x=>x.clientId===id).unreadAdmin,0);
 send('BOT_QUESTION_001','충전은 어떻게 하나요?');assert.deepEqual(await supportFrame(a,'SUPPORT_MESSAGE'),mine);assert.deepEqual(await supportFrame(a,'SUPPORT_MESSAGE'),answer);await supportFrame(a,'SUPPORT_INFO');assert.equal(support.Read(id).total,3);
 send('BOT_QUESTION_001','다른 본문');assert.equal(await a.wait('SUPPORT_ERROR|'),'SUPPORT_ERROR|MESSAGE_ID_CONFLICT');
 // Failed save rolls back both halves, with the same request available for retry.
 a.c.lastSupportSendAt=0;const before=JSON.stringify(state.supportThreads.get(id)),save=db.SaveDatabase;
 try{db.SaveDatabase=()=>false;send('BOT_ROLLBACK_01','프로필 사진');assert.equal(await a.wait('SUPPORT_ERROR|'),'SUPPORT_ERROR|STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal(JSON.stringify(state.supportThreads.get(id)),before);
 send('BOT_ROLLBACK_01','프로필 사진');await supportFrame(a,'SUPPORT_MESSAGE');assert.match((await supportFrame(a,'SUPPORT_MESSAGE')).text,/프로필 편집/);await supportFrame(a,'SUPPORT_INFO');
 // Public FAQ and the bot share the same admin-managed answers.
 const updated={...knowledge.Admin().items[0],answer:'새 안내: 마이페이지 잔액 안의 QR 충전을 이용해주세요.',keywords:['충전']};
 for(const role of ['viewer','operator'])assert.equal((await api(role,'POST','/api/support/knowledge',{revision:0,entry:updated})).status,403);
 const saved=await api('admin','POST','/api/support/knowledge',{revision:knowledge.Admin().revision,entry:updated});assert.equal(saved.status,200);assert.equal(saved.body.knowledge.items[0].answer,updated.answer);
 assert.equal((await api('admin','POST','/api/support/knowledge',{revision:0,entry:updated})).body.error,'HISTORY_CHANGED');
 a.c.supportHelpAt=0;a.send('SUPPORT_HELP|'+a.c.clientId);assert.equal((await supportFrame(a,'SUPPORT_HELP_DATA')).faq[0].answer,updated.answer);
 a.c.lastSupportSendAt=0;send('BOT_EDITED_FAQ01','충전');await supportFrame(a,'SUPPORT_MESSAGE');assert.equal((await supportFrame(a,'SUPPORT_MESSAGE')).text,updated.answer);await supportFrame(a,'SUPPORT_INFO');
 const hidden=await api('admin','POST','/api/support/knowledge',{revision:knowledge.Admin().revision,entry:{...updated,enabled:false}});assert.equal(hidden.status,200);assert.ok(!knowledge.Public().some(x=>x.id===updated.id));assert.notEqual(knowledge.Answer('충전',{}).text,updated.answer);
 const snapshot=db.BuildDatabaseObject();assert.equal(db.ImportDatabaseObject(snapshot),true);assert.equal(support.Read(id).mode,'BOT');assert.ok(support.Read(id).messages.some(x=>x.role==='BOT'&&x.replyTo==='BOT_EDITED_FAQ01'));assert.equal(knowledge.Admin().items[0].enabled,false);
 // A different installation cannot claim this room through the SUPPORT client ID field.
 b.send('SUPPORT_SYNC|'+a.c.clientId+'|'+reset.epoch+'|0');assert.equal(await b.wait('SUPPORT_ERROR|'),'SUPPORT_ERROR|CLIENT_NOT_OWNER');
 a.c.lastSupportSendAt=0;send('BOT_HANDOFF_001','상담원 연결');await supportFrame(a,'SUPPORT_MESSAGE');assert.match((await supportFrame(a,'SUPPORT_MESSAGE')).text,/오프라인/);info=await supportFrame(a,'SUPPORT_INFO');assert.equal(info.mode,'HUMAN');assert.equal(support.List().find(x=>x.clientId===id).unreadAdmin,1);
 assert.equal(support.Reply(id,'상담원입니다. 확인해드리겠습니다.','BOT_ADMIN_REPLY',info.revision).ok,true);await supportFrame(a,'SUPPORT_INFO');assert.equal((await supportFrame(a,'SUPPORT_MESSAGE')).role,'ADMIN');
 const count=support.Read(id).total;a.c.lastSupportSendAt=0;send('BOT_HUMAN_CHAT1','감사합니다');assert.equal((await supportFrame(a,'SUPPORT_MESSAGE')).role,'CLIENT');await supportFrame(a,'SUPPORT_INFO');assert.equal(support.Read(id).total,count+1,'human conversation must not receive extra automated replies');
 // A retained server history can start after a returning client's cursor.
 const room=state.supportThreads.get(id);room.messages=room.messages.slice(2);a.c.supportSyncAt=0;
 a.send('SUPPORT_SYNC|'+a.c.clientId+'|'+info.epoch+'|0');await supportFrame(a,'SUPPORT_INFO');
 const rebased=await supportFrame(a,'SUPPORT_RESET');assert.equal(rebased.baseSeq,room.messages[0].seq-1);
 for(const expected of room.messages)assert.deepEqual(await supportFrame(a,'SUPPORT_MESSAGE'),{...expected,epoch:room.epoch});
 const rebasedPage=await supportFrame(a,'SUPPORT_PAGE');assert.equal(rebasedPage.lastSeq,room.messages.at(-1).seq);assert.equal(rebasedPage.more,false);
 support.Change(id,'close',info.revision);assert.equal((await supportFrame(a,'SUPPORT_MESSAGE')).role,'SYSTEM');await supportFrame(a,'SUPPORT_INFO');
 a.send('SUPPORT_BOT_OPEN|'+a.c.clientId);info=await supportFrame(a,'SUPPORT_INFO');assert.equal(info.mode,'BOT');assert.ok(support.Read(id).messages.some(x=>x.role==='ADMIN'),'reopening with bot preserves history');
 // Deletion changes revision/epoch; old sends cannot repopulate deleted messages.
 support.Change(id,'delete',info.revision);await supportFrame(a,'SUPPORT_RESET');info=await supportFrame(a,'SUPPORT_INFO');assert.equal(support.Read(id).total,0);
 a.c.lastSupportSendAt=0;send('BOT_OLD_EPOCH01','이전 요청',info.revision-1);assert.equal(await a.wait('SUPPORT_ERROR|'),'SUPPORT_ERROR|HISTORY_CHANGED');assert.equal(support.Read(id).total,0);
 const rev=knowledge.Admin().revision,oldKnowledge=JSON.stringify(knowledge.Admin());let failed;
 try{db.SaveDatabase=()=>false;failed=knowledge.Write({revision:rev,id:updated.id},true);}finally{db.SaveDatabase=save;}
 assert.equal(failed.reason,'STORAGE_SAVE_FAILED');assert.equal(JSON.stringify(knowledge.Admin()),oldKnowledge);
 assert.equal((await api('admin','POST','/api/support/knowledge/delete',{revision:rev,id:updated.id})).status,200);
 assert.ok(!knowledge.Admin().items.some(x=>x.id===updated.id));
 console.log('FIX20 BOT/FAQ PASS: real TCP help-before-chat, bot replies and dedupe, atomic rollback, admin-only FAQ edits/hide/delete, restart persistence, ownership isolation, offline human handoff, history retention and stale requests after deletion');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
