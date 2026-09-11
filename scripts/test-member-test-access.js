'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix33-test-access-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),store=require('../services/member/store'),db=require('../storage/database');
const closed=[],peers=[];let seq=0;
const server=net.createServer(socket=>{closed.push(new Promise(resolve=>socket.once('close',resolve)));require('../core/connection').CreateConnection(socket);});
function matches(line,prefix){return prefix.startsWith('RESPONSE|')?/^HUB_(?:Z)?CHUNK\|/.test(line)&&line.split('|')[1]===prefix.slice(9):line.startsWith(prefix);}
function connect(){return new Promise((resolve,reject)=>{
 const socket=net.createConnection({port:server.address().port,host:'127.0.0.1'}),lines=[],waiters=[];let buffer='';
 const peer={socket,send:line=>socket.write(line+'\n'),wait(prefix){const i=lines.findIndex(x=>matches(x,prefix));if(i>=0)return Promise.resolve(lines.splice(i,1)[0]);return new Promise((res,rej)=>{const item={prefix,res,rej,timer:setTimeout(()=>rej(Error('Timeout: '+prefix)),4000)};waiters.push(item);});},close(){for(const w of waiters){clearTimeout(w.timer);w.rej(Error('Connection closed'));}waiters.length=0;socket.destroy();}};
 peers.push(peer);socket.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line.startsWith('PING|')){peer.send(line.replace('PING|','PONG|'));continue;}const n=waiters.findIndex(x=>matches(line,x.prefix));if(n<0)lines.push(line);else{const w=waiters.splice(n,1)[0];clearTimeout(w.timer);w.res(line);}}});
 socket.once('error',reject);socket.once('connect',()=>resolve(peer));
});}
function mac(p,prefix,fields){return crypto.createHmac('sha256',p.secret).update([prefix,p.c.clientId,p.c.deviceAuthChallengeId,...fields].join('|')).digest('hex').toUpperCase();}
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX33-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX33-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX33-REQUEST-'+(++seq)){
 p.c.hubRate=null;const plain=Buffer.from(JSON.stringify(body)),packed=body._wire==='zlib'&&plain.length>24000?zlib.deflateSync(plain,{level:1}):null;
 const compressed=packed&&packed.length<plain.length*.95,encoded=(compressed?packed:plain).toString('base64');
 if(encoded.length>40000||compressed){const total=Math.ceil(encoded.length/12000),prefix=compressed?'HUB_ZUPLOAD':'HUB_UPLOAD';for(let i=0;i<total;i++){const fields=[id,action,String(i),String(total),encoded.slice(i*12000,(i+1)*12000)];p.send([prefix,...fields,mac(p,prefix,fields)].join('|'));}}
 else p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total,responseCompressed;
 do{const parts=(await p.wait('RESPONSE|'+id)).split('|');assert.equal(parts[2],action);const zipped=parts[0]==='HUB_ZCHUNK';assert.equal(parts[6],mac(p,zipped?'HUB_ZRESPONSE':'HUB_RESPONSE',parts.slice(1,6)));if(responseCompressed!==undefined)assert.equal(zipped,responseCompressed);responseCompressed=zipped;total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 const result=Buffer.from(pieces.join(''),'base64');p.lastWire={uploadBytes:encoded.length,uploadPlain:plain.length,downloadBytes:pieces.join('').length,compressed:responseCompressed};
 return JSON.parse((responseCompressed?zlib.inflateSync(result,{maxOutputLength:8000000}):result).toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const peer=await login(),service=require('../services/member/service'),access=require('../services/member/testAccess');
 const c=peer.c;c.biometricVerified=false;
 const before=JSON.stringify([...state.clientBiometricProfiles]);
 assert.equal(service.Allowed(c),false);
 assert.equal((await request(peer,'feed',{testAccess:true})).reason,'MEMBER_AUTH_REQUIRED');
 // An unsigned forged request must never create a test grant.
 service.Handle(c,'HUB|FIX33-FORGED|test.enter|e30=|'+'0'.repeat(64));
 assert.equal(access.Valid(c),false);
 process.env.MEMBER_BIOMETRIC_TEST_MODE='0';
 assert.equal((await request(peer,'test.enter')).reason,'MEMBER_AUTH_REQUIRED');
 process.env.MEMBER_BIOMETRIC_TEST_MODE='1';
 c.licenseAuthorized=false;assert.equal((await request(peer,'test.enter')).reason,'MEMBER_AUTH_REQUIRED');
 c.licenseAuthorized=true;c.permissionsGranted=false;
 assert.equal((await request(peer,'test.enter')).reason,'MEMBER_AUTH_REQUIRED');c.permissionsGranted=true;
 const grant=await run(peer,'test.enter');assert.equal(grant.testAccess,true);assert.equal(service.Allowed(c),true);
 assert.equal(c.biometricVerified,false);assert.equal(JSON.stringify([...state.clientBiometricProfiles]),before);
 const profile=(await run(peer,'me')).profile;await run(peer,'home');await run(peer,'feed');await run(peer,'catalog');
 const post=(await run(peer,'post.create',{body:'인증 생략 테스트 게시글',_delta:true})).post;
 assert.equal((await run(peer,'thread',{postId:post.id})).post.body,'인증 생략 테스트 게시글');
 await run(peer,'post.delete',{id:post.id});
 // Main UI access does not manufacture a WinSock Build/biometric authorization.
 state.pendingBuildGrants.set(c.clientId,{clientId:c.clientId,requestId:'FIX33-BUILD',expiresAt:Date.now()+60000});
 assert.equal(require('../services/buildGate').TryDispatchClient(c.clientId).reason,'BIOMETRIC_AUTH_REQUIRED');
 state.pendingBuildGrants.delete(c.clientId);
 assert.equal(c.buildCompleted,false);assert.equal(JSON.stringify([...state.clientBiometricProfiles]),before);
 const challenge=c.deviceAuthChallengeId;c.deviceAuthChallengeId+='-ROTATED';
 assert.equal(service.Allowed(c),false);c.deviceAuthChallengeId=challenge;assert.equal(service.Allowed(c),false);
 await run(peer,'test.enter');c.licenseAuthorized=false;assert.equal(service.Allowed(c),false);
 c.licenseAuthorized=true;assert.equal(service.Allowed(c),false);await run(peer,'test.enter');
 state.serviceEnabled=false;assert.equal(service.Allowed(c),false);
 assert.throws(()=>service.Execute(c,'FIX33-STOPPED','test.enter',{}),/SERVICE_DISABLED/);state.serviceEnabled=true;
 assert.equal(service.Allowed(c),false);await run(peer,'test.enter');
 const account=store.ProfileById(profile.id);account.blocked=true;
 assert.equal((await request(peer,'test.enter')).reason,'ACCOUNT_BLOCKED');
 assert.equal((await request(peer,'feed')).reason,'ACCOUNT_BLOCKED');account.blocked=false;
 // A new connection object cannot inherit the old ephemeral grant.
 assert.equal(access.Valid({...c}),false);
 require('../services/clientBiometric').Reset(c.clientId,'FIX33_TEST');
 assert.equal(service.Allowed(c),false);await run(peer,'test.enter');
 process.env.MEMBER_BIOMETRIC_TEST_MODE='0';assert.equal(service.Allowed(c),false);
 assert.equal((await request(peer,'feed')).reason,'MEMBER_AUTH_REQUIRED');
 c.biometricVerified=true;assert.equal(service.Allowed(c),true);await run(peer,'feed');
 const snapshot=JSON.stringify(db.BuildDatabaseObject());assert.ok(!snapshot.includes('memberTestAccess'));
 console.log('FIX33 PASS: signed test entry, live member operations, missing/forged grants, QR/permissions/service/account gates, challenge and connection scope, admin reset, Build isolation and restored biometric gate.');
}finally{delete process.env.MEMBER_BIOMETRIC_TEST_MODE;for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
