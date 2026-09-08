'use strict';
const assert = require('node:assert/strict');
const net = require('node:net'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fix18-tcp-'));
process.env.DATA_DIR = temp; process.env.STORAGE_ENGINE = 'sqlite';
const state = require('../core/state'), database = require('../storage/database');
const installation = require('../services/clientInstallation');
const lifecycle = require('../services/serviceLifecycle');
require('../core/utils').EnsureDirs();
const acceptedClosed = [];
const server = net.createServer(socket => {
 acceptedClosed.push(new Promise(resolve => socket.once('close',resolve)));
 require('../core/connection').CreateConnection(socket);
});
const sockets = [];
const key = 'ANDROID2-1234567890ABCDEF-1234567890ABCDEF', token = 'A'.repeat(32);
function connect(port) {
 return new Promise((resolve,reject)=>{
  const socket = net.createConnection({port,host:'127.0.0.1'}); sockets.push(socket);
  const lines=[], waiters=[]; let buffer='';
  const peer={socket,lines,send:line=>socket.write(line+'\n'),wait(prefix){
   const i=lines.findIndex(x=>x.startsWith(prefix)); if(i>=0)return Promise.resolve(lines.splice(i,1)[0]);
   return new Promise((res,rej)=>{const item={prefix,res,timer:setTimeout(()=>rej(Error('TCP timeout '+prefix+' '+JSON.stringify(lines))),3000)};waiters.push(item);});
  }};
  socket.on('data',data=>{buffer+=data.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);
   if(line.startsWith('PING|')){peer.send(line.replace('PING|','PONG|'));continue;}
   const index=waiters.findIndex(w=>line.startsWith(w.prefix));if(index<0)lines.push(line);else{const w=waiters.splice(index,1)[0];clearTimeout(w.timer);w.res(line);}
  }});
  socket.once('error',reject);socket.once('connect',()=>resolve(peer));
 });
}
const crypto=require('node:crypto'),hub=require('../services/member/service'),store=require('../services/member/store');
const secret='FIX13-test-only-'+crypto.randomBytes(32).toString('hex');
function mac(c,prefix,fields){return crypto.createHmac('sha256',secret).update([prefix,c.clientId,c.deviceAuthChallengeId,...fields].join('|')).digest('hex').toUpperCase();}
function request(c,id,action,body={}){const encoded=Buffer.from(JSON.stringify(body)).toString('base64');return ['HUB',id,action,encoded,mac(c,'HUB',[id,action,encoded])].join('|');}
async function reply(peer,c,id,action){
 const chunks=[];let count=0;
 do{const p=(await peer.wait('HUB_CHUNK|'+id+'|')).split('|');assert.equal(p.length,7);assert.equal(p[2],action);assert.equal(p[6],mac(c,'HUB_RESPONSE',p.slice(1,6)));count=Number(p[4]);chunks[Number(p[3])]=p[5];}while(chunks.filter(Boolean).length<count);
 return {chunks:count,body:JSON.parse(Buffer.from(chunks.join(''),'base64').toString())};
}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const apk=await connect(server.address().port);apk.send('CONNECT|2|2.17.0|MEMBER-TCP-FIX18');
 const id=(await apk.wait('CONNECTED|')).split('|')[1],c=state.clients.get(id);
 Object.assign(c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX18-SESSION-1'});
 state.deviceSecrets.set('CLIENT:'+id,secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});
 const {PNG}=require('pngjs'),png=new PNG({width:256,height:256});crypto.randomFillSync(png.data);for(let i=3;i<png.data.length;i+=4)png.data[i]=255;
 const avatar='data:image/png;base64,'+PNG.sync.write(png).toString('base64'),body={nickname:'고화질 프로필',bio:'정상 저장',avatar};
 function fragments(requestId,value=body){const encoded=Buffer.from(JSON.stringify(value)).toString('base64'),total=Math.ceil(encoded.length/12000);return Array.from({length:total},(_,index)=>{const fields=[requestId,'profile.save',index,total,encoded.slice(index*12000,(index+1)*12000)];return ['HUB_UPLOAD',...fields,mac(c,'HUB_UPLOAD',fields)].join('|');});}
 const first=fragments('AVATAR-FIX18-001');assert.ok(first.join('\n').length>65536);assert.ok(first.length<50);
 // Coalesced TCP data is many bounded lines, not one oversized command.
 apk.socket.write(first.join('\n')+'\n');let response=await reply(apk,c,'AVATAR-FIX18-001','profile.save');assert.equal(response.body.ok,true);assert.ok(response.chunks>1);
 const saved=response.body.data.profile;assert.deepEqual(PNG.sync.read(Buffer.from(saved.avatar.split(',')[1],'base64')).data,png.data);assert.equal(c.hubUpload,null);
 apk.socket.write(first.join('\n')+'\n');assert.deepEqual((await reply(apk,c,'AVATAR-FIX18-001','profile.save')).body.data.profile,saved,'upload replay is idempotent');
 apk.socket.write(fragments('AVATAR-FIX18-001',{...body,nickname:'중복 번호 변조'}).join('\n')+'\n');assert.equal((await reply(apk,c,'AVATAR-FIX18-001','profile.save')).body.reason,'REQUEST_REUSED');
 async function unchanged(requestId){apk.send(request(c,requestId,'me'));const r=await reply(apk,c,requestId,'me');assert.equal(r.body.data.profile.nickname,'고화질 프로필');}
 const corrupt=fragments('AVATAR-TAMPER-18');const fields=corrupt[1].split('|');fields[5]='A'+fields[5].slice(1);corrupt[1]=fields.join('|');apk.socket.write(corrupt.join('\n')+'\n');await unchanged('BARRIER-TAMPER-18');
 const stale=fragments('AVATAR-STALE-18');c.deviceAuthChallengeId='AUTH-FIX18-SESSION-2';apk.socket.write(stale.join('\n')+'\n');await unchanged('BARRIER-STALE-18');assert.equal(c.hubUpload,null);
 const missing=fragments('AVATAR-MISSING-18');apk.socket.write([missing[0],...missing.slice(2)].join('\n')+'\n');await unchanged('BARRIER-MISSING-18');assert.equal(c.hubUpload,null);
 const expired=fragments('AVATAR-EXPIRED-18');apk.send(expired[0]);await unchanged('BARRIER-START-18');assert.ok(c.hubUpload);c.hubUpload.at-=16000;apk.socket.write(expired.slice(1).join('\n')+'\n');await unchanged('BARRIER-EXPIRED-18');assert.equal(c.hubUpload,null);
 c.biometricVerified=false;apk.send(fragments('AVATAR-UNAUTH-18')[0]);apk.send(request(c,'BARRIER-UNAUTH-18','me'));assert.equal((await reply(apk,c,'BARRIER-UNAUTH-18','me')).body.reason,'MEMBER_AUTH_REQUIRED');assert.equal(c.hubUpload,null);c.biometricVerified=true;
 const restored=require('../storage/sqliteDatabase').LoadSnapshot().data.memberHub;assert.equal(Object.values(restored.profiles).find(p=>p.id===saved.id).avatar,saved.avatar);
 // A genuinely oversized individual line is still rejected.
 apk.send('HUB|'+ 'X'.repeat(70000));await apk.wait('ERROR|BUFFER_OVERFLOW');
 console.log('FIX18 TCP PASS: full 256px photo upload/reply, coalesced line framing, HMAC tampering and stale session rejection, replay safety, interrupted/expired/unauthorized uploads, SQLite persistence, oversized line rejection');
}finally{
 for(const socket of sockets)socket.destroy();await Promise.all(acceptedClosed);await new Promise(resolve=>server.close(resolve));require('../storage/sqliteDatabase').Close();fs.rmSync(temp,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1;});
