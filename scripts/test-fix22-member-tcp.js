'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix22-refresh-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.21.0|MEMBER-REFRESH-FIX22-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX22-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX22-REQUEST-'+(++seq)){
 const encoded=Buffer.from(JSON.stringify(body)).toString('base64');if(encoded.length>40000){const total=Math.ceil(encoded.length/12000);for(let i=0;i<total;i++){const fields=[id,action,i,total,encoded.slice(i*12000,(i+1)*12000)];p.send(['HUB_UPLOAD',...fields,mac(p,'HUB_UPLOAD',fields)].join('|'));}}else p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total;
 do{const parts=(await p.wait('HUB_CHUNK|'+id+'|')).split('|');assert.equal(parts[2],action);assert.equal(parts[6],mac(p,'HUB_RESPONSE',parts.slice(1,6)));total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 return JSON.parse(Buffer.from(pieces.join(''),'base64').toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}

async function web(role,url,body){const req=require('node:stream').Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url,method:body?'POST':'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}});let status,payload;await require('../web/webApi').HandleApiRequest(req,{writeHead(n){status=n;},end(data){payload=JSON.parse(data);}},{role,id:'FIX22'});return {status,payload};}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const author=await login(),viewer=await login();
 const a=(await run(author,'me')).profile,b=(await run(viewer,'me')).profile;
 const firstBody={handle:'@Round.Member',nickname:'이름 최초 변경',bio:'소개'};
 const first=await run(author,'profile.save',firstBody,'FIX22-HANDLE-FIRST');
 assert.equal(first.profile.handle,'round.member');assert.equal(first.profile.handleEditable,false);assert.ok(first.profile.nicknameChangeAt>Date.now());
 assert.deepEqual(await run(author,'profile.save',firstBody,'FIX22-HANDLE-FIRST'),first);
 const snapshot=JSON.stringify(store.DB());
 assert.equal((await request(author,'profile.save',{...firstBody,handle:'another_id'})).reason,'HANDLE_LOCKED');
 assert.equal((await request(viewer,'profile.save',{nickname:b.nickname,handle:'ROUND.MEMBER'})).reason,'HANDLE_TAKEN');
 assert.equal((await request(viewer,'profile.save',{nickname:b.nickname,handle:a.handle})).reason,'HANDLE_TAKEN','original generated handle stays reserved');
 assert.equal((await request(author,'profile.save',{...firstBody,nickname:'너무 이른 변경'})).reason,'NICKNAME_COOLDOWN');assert.equal(JSON.stringify(store.DB()),snapshot);
 assert.equal((await run(viewer,'member',{handle:'@ROUND.MEMBER'})).profile.id,a.id);
 await run(viewer,'follow.set',{handle:'@round.member',following:true});assert.equal((await run(viewer,'follows',{handle:'@round.member',mode:'followers'})).items[0].id,b.id);
 assert.equal((await request(viewer,'records',{handle:'@round.member'})).reason,'NOT_OWNER');
 store.ProfileById(a.id).nicknameChangedAt=Date.now()-30*86400000+60000;
 assert.equal((await request(author,'profile.save',{...firstBody,nickname:'경계 전'})).reason,'NICKNAME_COOLDOWN');
 store.ProfileById(a.id).nicknameChangedAt=Date.now()-30*86400000;
 const next=await run(author,'profile.save',{...firstBody,nickname:'30일 뒤 변경'});assert.equal(next.profile.nickname,'30일 뒤 변경');
 const old=JSON.stringify(store.DB()),save=db.SaveDatabase;try{db.SaveDatabase=()=>false;assert.equal((await request(viewer,'profile.save',{nickname:b.nickname,handle:'rollback_member'})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal(JSON.stringify(store.DB()),old);assert.equal(store.Resolve('rollback_member'),undefined);
 const account=store.ProfileById(a.id),clientID=author.c.clientId;
 state.supportThreads.set(clientID,{clientId:clientID,currentClientId:clientID,deviceKey:account.subject,tokenHashes:['PRIVATE_TOKEN_HASH'],clientAliases:[clientID],revision:1,epoch:'FIX22-EPOCH',status:'OPEN',mode:'BOT',createdAt:Date.now(),updatedAt:Date.now(),nextSeq:1,unreadAdmin:0,messages:[],device:{manufacturer:'테스트',model:'Round Phone',phone:'010-1234-5678',phoneStatus:'AVAILABLE',os:'Android'}});
 state.clientBiometricProfiles.set(clientID,{enrolledAt:Date.now(),verifiedAt:Date.now(),verificationCount:2});
 const qr=await run(author,'charge');assert.equal(require('../services/qrCenter').List().find(x=>x.requestId===qr.request.id).memberHandle,'@round.member');
 const own=await run(author,'records',{handle:'@round.member'});assert.equal(own.devices[0].device.phone,'010-1234-5678');assert.equal(own.devices[0].biometric.enrolled,true);
 const other=await run(viewer,'records');assert.ok(!JSON.stringify(other).includes('010-1234-5678'));
 const admin=await web('admin','/api/member?view=lookup&handle=%40ROUND.MEMBER');assert.equal(admin.status,200);assert.equal(admin.payload.devices[0].device.phone,'010-1234-5678');assert.equal(admin.payload.profile.id,a.id);
 for(const secret of ['PRIVATE_TOKEN_HASH',author.secret,account.subject])assert.ok(!JSON.stringify(admin.payload).includes(secret));
 assert.equal((await web('operator','/api/member?view=lookup&handle=%40round.member')).status,403);
 const alias=await web('admin','/api/clients/%40round.member');assert.equal(alias.status,200);assert.equal(alias.payload.client.id,clientID);
 assert.equal((await web('operator','/api/clients/%40round.member')).status,403);
 assert.equal((await web('admin','/api/clients/%40round.member/note',{note:'@아이디에서 관리'})).status,200);assert.equal(state.clientNotes.get(clientID),'@아이디에서 관리');
 // 960px JPEG upload is split across signed chunks; feed responses stay bounded.
 const pixels=crypto.randomBytes(640*480*4);for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
 const photo='data:image/jpeg;base64,'+require('jpeg-js').encode({width:640,height:480,data:pixels},38).data.toString('base64');assert.ok(photo.length>40000);
 const posted=await run(author,'post.create',{body:'사진 게시글',image:photo},'FIX22-PHOTO-POST');assert.ok(posted.post.image.startsWith('data:image/jpeg;'));
 assert.deepEqual(await run(author,'post.create',{body:'사진 게시글',image:photo},'FIX22-PHOTO-POST'),posted);
 const thread=await run(viewer,'thread',{postId:posted.post.id});assert.ok(thread.post.image.length>=posted.post.image.length);assert.equal((await run(author,'me')).posts.items[0].imageThumb.startsWith('data:image/jpeg;'),true);
 assert.equal((await request(viewer,'post.edit',{id:posted.post.id,revision:0,body:'침범',image:photo})).reason,'NOT_OWNER');
 const edited=await run(author,'post.edit',{id:posted.post.id,revision:0,body:'내용만 수정'});assert.ok(edited.post.image);
 assert.equal((await request(author,'post.edit',{id:posted.post.id,revision:0,body:'오래된 화면'})).reason,'CONTENT_CHANGED');
 const beforePhoto=JSON.stringify(store.DB());assert.equal((await request(author,'post.edit',{id:posted.post.id,revision:1,body:'잘못된 사진',image:'data:image/svg+xml;base64,AAAA'})).reason,'CONTENT_IMAGE_INVALID');assert.equal(JSON.stringify(store.DB()),beforePhoto);
 for(let i=0;i<7;i++){store.ProfileById(a.id).last_post=0;await run(author,'post.create',{body:'사진 '+i,image:photo});}
 author.c.hubRate=null;viewer.c.hubRate=null;
 const feed=await run(viewer,'feed');assert.equal(feed.items.length,8);assert.ok(Buffer.from(JSON.stringify({ok:true,data:feed})).toString('base64').length<900000);assert.ok(feed.items.every(x=>x.image.startsWith('data:image/jpeg;')));
 const removed=await run(author,'post.edit',{id:posted.post.id,revision:1,body:'사진 삭제',image:''});assert.equal(removed.post.image,'');
 const home=await run(author,'home');assert.equal(home.profile.id,a.id);assert.equal(home.summary.posts,8);
 const records=await web('admin','/api/member?view=lookup&handle=%40round.member&section=posts&limit=3');assert.equal(records.payload.items.length,3);assert.equal(records.payload.total,8);assert.equal(records.payload.nextOffset,3);
 const persistent=db.BuildDatabaseObject();assert.equal(db.ImportDatabaseObject(persistent),true);assert.equal(store.Resolve('@ROUND.MEMBER').id,a.id);assert.ok(store.ProfileById(a.id).handleChangedAt);assert.ok(Object.values(store.DB().posts).some(x=>x.imageFeed));
 author.c.biometricVerified=false;assert.equal((await request(author,'records',{handle:'@round.member'})).reason,'MEMBER_AUTH_REQUIRED');
 console.log('FIX22 TCP/API PASS: one-time unique handle, 30-day nickname gate, reserved legacy handle, signed photo upload/edit/delete/replay, response bound, privacy-scoped records, registered phone/biometric links, admin role and alias operations, home summary and durable import');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
