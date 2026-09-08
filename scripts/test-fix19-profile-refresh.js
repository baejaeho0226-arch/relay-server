'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix19-refresh-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.18.0|MEMBER-REFRESH-FIX19-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX19-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX19-REQUEST-'+(++seq)){
 const encoded=Buffer.from(JSON.stringify(body)).toString('base64');p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total;
 do{const parts=(await p.wait('HUB_CHUNK|'+id+'|')).split('|');assert.equal(parts[2],action);assert.equal(parts[6],mac(p,'HUB_RESPONSE',parts.slice(1,6)));total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 return JSON.parse(Buffer.from(pieces.join(''),'base64').toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const author=await login(),viewer=await login();
 const a=(await run(author,'me')).profile,b=(await run(viewer,'me')).profile;
 const post=(await run(author,'post.create',{body:'사진 변경 전에 작성한 글'})).post;
 const comment=(await run(author,'comment.create',{postId:post.id,body:'  사진 변경 전에 작성한 댓글  '})).comment;
 assert.equal(comment.body,'사진 변경 전에 작성한 댓글');
 await run(viewer,'follow.set',{id:a.id,following:true});await run(author,'follow.set',{id:b.id,following:true});
 const cachedFeed=await run(viewer,'feed');assert.equal(cachedFeed.items[0].author.avatar,'');
 async function publicAppearances(expected){
  const feed=await run(viewer,'feed'),thread=await run(viewer,'thread',{postId:post.id});
  const following=await run(viewer,'follows',{mode:'following'}),followers=await run(viewer,'follows',{mode:'followers'});
  for(const profile of [feed.items.find(x=>x.id===post.id).author,thread.post.author,thread.comments.items.find(x=>x.id===comment.id).author,following.items.find(x=>x.id===a.id),followers.items.find(x=>x.id===a.id)]){
   for(const key of ['nickname','avatar','avatarRevision','profileRevision'])assert.equal(profile[key],expected[key],key);
   for(const privateKey of ['balance','subject','createdAt'])assert.equal(profile[privateKey],undefined,privateKey);
  }
  assert.equal(feed.items[0].following,true);assert.equal((await run(viewer,'me')).profile.following,1);
 }
 const firstBody={nickname:'첫 사진',bio:'소개',avatar:avatar(40)};
 const first=await run(author,'profile.save',firstBody,'FIX19-PHOTO-FIRST');await changed(viewer,store.DB().revision);
 assert.ok(first.profile.avatar.startsWith('data:image/png;'));assert.ok(first.publicProfile.avatar.startsWith('data:image/jpeg;'));
 assert.equal(first.publicProfile.balance,undefined);await publicAppearances(first.publicProfile);
 const second=await run(author,'profile.save',{nickname:'바뀐 사진',bio:'소개',avatar:avatar(210)});await changed(viewer,store.DB().revision);
 assert.ok(second.profile.profileRevision>first.profile.profileRevision);assert.ok(second.profile.avatarRevision>first.profile.avatarRevision);assert.notEqual(second.publicProfile.avatar,first.publicProfile.avatar);await publicAppearances(second.publicProfile);
 assert.equal(cachedFeed.items[0].author.avatar,'','an already delivered response cannot mutate itself');
 // A retry of the older save returns its original result without reverting current profile state.
 const replay=await run(author,'profile.save',firstBody,'FIX19-PHOTO-FIRST');assert.deepEqual(replay,first);await publicAppearances(second.publicProfile);
 const nickname=await run(author,'profile.save',{nickname:'이름만 변경',bio:'변경된 소개'});assert.ok(nickname.profile.profileRevision>second.profile.profileRevision);assert.equal(nickname.profile.avatarRevision,second.profile.avatarRevision);assert.equal(nickname.publicProfile.avatar,second.publicProfile.avatar);await publicAppearances(nickname.publicProfile);
 const before=JSON.stringify(store.DB()),save=db.SaveDatabase;let failed;
 try{db.SaveDatabase=()=>false;failed=await request(author,'profile.save',{nickname:'저장 실패',bio:'',avatar:avatar(80)});}finally{db.SaveDatabase=save;}
 assert.equal(failed.reason,'STORAGE_SAVE_FAILED');assert.equal(JSON.stringify(store.DB()),before);await publicAppearances(nickname.publicProfile);
 const removed=await run(author,'profile.save',{nickname:'사진 삭제',bio:'',avatar:''});await changed(viewer,store.DB().revision);assert.equal(removed.publicProfile.avatar,'');await publicAppearances(removed.publicProfile);
 // Valid Korean text is accepted immediately; failed blank text does not consume the rate limit.
 assert.equal((await request(viewer,'comment.create',{postId:post.id,body:'   '})).reason,'INPUT_INVALID');
 const sent=await run(viewer,'comment.create',{postId:post.id,body:'한글 입력 후 바로 전송'});assert.equal(sent.comment.body,'한글 입력 후 바로 전송');
 console.log('FIX19 PROFILE REFRESH PASS: two live TCP clients, signed invalidations, changed/removed images and nickname across feed/thread/follow lists, private-field exclusion, old save replay, persistence rollback and immediate Korean comment acceptance');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
