'use strict';
const assert = require('node:assert/strict');
const net = require('node:net'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fix13-tcp-'));
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
 const apk=await connect(server.address().port);apk.send('CONNECT|2|2.12.0|MEMBER-TCP-FIX13');
 const id=(await apk.wait('CONNECTED|')).split('|')[1],c=state.clients.get(id);
 // Existing installation/HMAC/biometric suites test their challenges. This
 // socket fixture represents their completed authorization for hub traffic.
 Object.assign(c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX13-SESSION-1'});
 state.deviceSecrets.set('CLIENT:'+id,secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});
 state.deviceCapabilities.set('CLIENT:'+id,new Set(['BIOMETRIC_AUTH','DEVICE_HMAC']));
 apk.send(request(c,'TCPME0001','me'));let result=await reply(apk,c,'TCPME0001','me');assert.equal(result.body.ok,true);assert.equal(result.body.data.profile.balance,0);
 const profile=result.body.data.profile;
 hub.AdminWrite('settings.save',{topupEnabled:true,topupInstructions:'확인 후 승인'},'TEST');
 const item=hub.AdminWrite('product.save',{title:'로스트사가 이용권',accessType:'TYPE3',description:'실제 통신 검증',price:5000,days:30,stock:3,published:true},'TEST');
 apk.send(request(c,'TCPTOP001','topup.create',{amount:10000,depositor:'통신 테스트'}));result=await reply(apk,c,'TCPTOP001','topup.create');assert.equal(result.body.ok,true);assert.equal(result.body.data.balance,0);
 hub.AdminWrite('topup.decide',{id:result.body.data.topup.id,approve:true},'TEST');
 const purchase={productId:item.id,expectedPrice:5000};
 const valid=request(c,'TCPBUY001','purchase',purchase),fields=valid.split('|');
 apk.send(fields.slice(0,4).join('|')); // unsigned cannot execute
 const altered=fields.slice();altered[3]=Buffer.from(JSON.stringify({...purchase,expectedPrice:4999})).toString('base64');apk.send(altered.join('|'));
 const otherId=fields.slice();otherId[1]='TCPBUYBAD';apk.send(otherId.join('|'));
 const stale=request(c,'TCPOLD001','purchase',purchase);c.deviceAuthChallengeId='AUTH-FIX13-SESSION-2';apk.send(stale);
 // A signed read acts as a stream barrier after all rejected commands.
 apk.send(request(c,'TCPME0002','me'));result=await reply(apk,c,'TCPME0002','me');assert.equal(result.body.data.profile.balance,10000);assert.equal(result.body.data.orders.total,0);
 apk.send(request(c,'TCPBUY001','purchase',purchase));result=await reply(apk,c,'TCPBUY001','purchase');assert.equal(result.body.ok,true);const bought=result.body.data;assert.equal(bought.balance,5000);
 apk.send(request(c,'TCPBUY001','purchase',purchase));assert.deepEqual((await reply(apk,c,'TCPBUY001','purchase')).body.data,bought);
 for(let n=0;n<12;n++)hub.AdminWrite('news.save',{title:'소식 '+n,category:'UPDATE',body:'가'.repeat(4500),published:true},'TEST');
 apk.send(request(c,'TCPNEWS01','news'));result=await reply(apk,c,'TCPNEWS01','news');assert.equal(result.body.data.total,12);assert.equal(result.body.data.items[0].body.length,4500);assert.ok(result.chunks>1);
 const sqlite=require('../storage/sqliteDatabase');sqlite.Close();const persisted=sqlite.LoadSnapshot().data.memberHub;
 assert.equal(Object.values(persisted.profiles).find(p=>p.id===profile.id).balance,5000);assert.equal(Object.keys(persisted.orders).length,1);assert.equal(Object.keys(persisted.operations).length,2);
 apk.send(request(c,'TCPACT001','order.activate',{orderId:bought.order.id}));result=await reply(apk,c,'TCPACT001','order.activate');assert.equal(result.body.ok,true);assert.equal(result.body.data.order.status,'ACTIVE');assert.equal(c.biometricVerified,false);assert.equal(c.buildCompleted,false);
 await apk.wait('QR_AUTH_OK|');await apk.wait('BIOMETRIC_CHALLENGE|');
 console.log('FIX13 TCP PASS: actual sockets, session HMAC requests and chunk responses, tampering/unsigned/stale rejection, topup approval, purchase retry, multi-chunk Korean news, SQLite reopen, pass activation and biometric reauthentication');
}finally{
 for(const socket of sockets)socket.destroy();
 await new Promise(resolve=>server.close(resolve));await Promise.all(acceptedClosed);
 require('../storage/sqliteDatabase').Close();fs.rmSync(temp,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1;});
