'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix37-profiles-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX37-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX37-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX37-REQUEST-'+(++seq)){
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
 const [a,b,c]=[await login(),await login(),await login()],fast={_wire:'zlib',_delta:true};
 const pa=(await run(a,'me')).profile,pb=(await run(b,'me')).profile;
 let profile=(await run(a,'profile.save',{...fast,nickname:'테스트 회원',handle:'profile_once',bio:'짧은 소개',pronouns:'그 / 그를',gender:'MALE'})).profile;
 assert.equal(profile.pronouns,'그 / 그를');assert.equal(profile.gender,'MALE');assert.equal(profile.handleEditable,false);
 assert.equal((await request(a,'profile.save',{...fast,nickname:'다시 이름',bio:'소개'})).reason,'NICKNAME_COOLDOWN');
 assert.equal((await request(a,'profile.save',{...fast,nickname:profile.nickname,handle:'another_handle',bio:'소개'})).reason,'HANDLE_LOCKED');
 assert.equal((await request(a,'profile.save',{...fast,nickname:profile.nickname,bio:'변경되면 안 됨',gender:'INVALID'})).reason,'INPUT_INVALID');
 assert.equal((await run(a,'me')).profile.bio,'짧은 소개','invalid gender rolls back all profile fields');
 profile=(await run(a,'profile.save',{...fast,nickname:profile.nickname,handle:profile.handle,bio:'수정 소개',pronouns:'',gender:'UNDISCLOSED'})).profile;
 assert.equal(profile.pronouns,'');assert.equal(profile.gender,'UNDISCLOSED');
 const post=(await run(a,'post.create',{...fast,body:'전체 피드에 그대로 공개'})).post;
 let view=await run(b,'member',{...fast,id:pa.id,postCards:true});assert.equal(view.posts.items.length,1);
 const initialRevision=view.profile.profileRevision;
 const prefs=await run(a,'preferences.save',{...fast,profilePostsPrivate:true});
 assert.equal(prefs.preferences.profilePostsPrivate,true);assert.ok(prefs.profile.profileRevision>initialRevision);
 assert.equal('preferences' in prefs.publicProfile,false);assert.equal('gender' in prefs.publicProfile,false);
 for(const viewer of [b,c]){
  view=await run(viewer,'member',{...fast,id:'@profile_once',postCards:true});
  assert.equal(view.profilePostsHidden,true);assert.equal(view.posts.total,0);assert.deepEqual(view.posts.items,[]);
  assert.deepEqual((await run(viewer,'live',{...fast,posts:[post.id],profiles:[pa.id],scope:'member',query:{id:pa.id,postCards:true}})).scope,[]);
  assert.ok((await run(viewer,'feed',fast)).items.some(x=>x.id===post.id),'feed stays public');
  assert.equal((await run(viewer,'thread',{...fast,postId:post.id})).post.id,post.id);
  assert.equal('gender' in view.profile,false);
 }
 assert.equal((await run(a,'member',{...fast,id:pa.id,postCards:true})).posts.items.length,1);
 assert.equal((await run(a,'me',{...fast,postCards:true})).posts.items.length,1);
 assert.equal((await run(b,'preferences')).preferences.profilePostsPrivate,false,'account isolation');
 assert.equal((await request(a,'preferences.save',{...fast,profilePostsPrivate:'false'})).reason,'INPUT_INVALID');
 let save=db.SaveDatabase;try{db.SaveDatabase=()=>false;assert.equal((await request(a,'preferences.save',{...fast,profilePostsPrivate:false})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal((await run(a,'preferences')).preferences.profilePostsPrivate,true,'failed privacy save rolls back');
 await run(a,'preferences.save',{...fast,profilePostsPrivate:false});
 assert.equal((await run(b,'member',{...fast,id:pa.id,postCards:true})).posts.items.length,1);
 // Stored preferences survive a database export/import, independent of local UI state.
 const originalProfiles=Object.keys(store.DB().profiles);assert.ok(originalProfiles.length>=2);
 db.SaveDatabase();const persisted=JSON.parse(JSON.stringify(store.DB()));store.Import({memberHub:persisted});
 assert.equal((await run(a,'preferences')).preferences.profilePostsPrivate,false);
 // Every committed root/reply contains a complete bounded page and the direct target.
 let ack=await run(b,'comment.create',{...fast,postId:post.id,body:'첫 댓글',offset:0,limit:12});
 const root=ack.comment;assert.ok(ack.commentPage.items.some(x=>x.id===root.id));
 store.ProfileById(pb.id).last_comment=0;
 ack=await run(b,'comment.create',{...fast,postId:post.id,parentId:root.id,body:'답글',offset:0,limit:12});
 const reply=ack.comment;assert.equal(reply.replyToId,root.id);assert.equal(reply.parentId,root.id);
 assert.equal(reply.replyToHandle,store.Handle(store.ProfileById(pb.id)));
 store.ProfileById(pa.id).last_comment=0;
 ack=await run(a,'comment.create',{...fast,postId:post.id,parentId:reply.id,body:'대댓글',offset:0,limit:12});
 assert.equal(ack.comment.replyToId,reply.id);assert.equal(ack.comment.parentId,root.id);assert.equal(ack.replyCounts[0].id,reply.id);
 assert.equal(ack.commentPage.total,3);assert.ok(ack.commentPage.items.some(x=>x.id===ack.comment.id));
 const thread=await run(c,'thread',{...fast,postId:post.id,limit:12});
 const known=thread.comments.items.map(x=>x.id+'/'+x.revision);
 store.ProfileById(pb.id).last_comment=0;
 const fresh=await run(b,'comment.create',{...fast,postId:post.id,parentId:reply.id,body:'다른 기기에서 답글',offset:0,limit:12});
 let live=await run(c,'live',{...fast,posts:[post.id],comments:thread.comments.items.map(x=>x.id),scope:'thread',query:{postId:post.id,offset:0,limit:12},knownComments:known});
 assert.ok(live.commentPage.items.some(x=>x.id===fresh.comment.id));assert.equal(live.commentPage.total,4);assert.equal(live.posts[0].comments,4);
 assert.ok(!('image' in live.posts[0]),'live reply update does not redownload post media');
 live=await run(c,'live',{...fast,scope:'thread',query:{postId:post.id,limit:12},knownComments:live.commentPage.items.map(x=>x.id+'/'+x.revision)});
 assert.equal(live.commentPage,undefined,'unchanged thread sends counters only');
 // Reply beyond the first 12 rows must not disappear at the next live scope check.
 for(let i=0;i<15;i++){store.ProfileById(pb.id).last_comment=0;ack=await run(b,'comment.create',{...fast,postId:post.id,parentId:reply.id,body:'추가 답글 '+i,offset:0,limit:12});}
 const ackRequestID='FIX37-REQUEST-'+seq;assert.ok(ack.commentPage.offset>0);assert.equal(ack.commentPage.items.length,12);assert.ok(ack.commentPage.items.some(x=>x.id===ack.comment.id));
 live=await run(b,'live',{...fast,scope:'thread',query:{postId:post.id,offset:ack.commentPage.offset,limit:12},knownComments:ack.commentPage.items.map(x=>x.id+'/'+x.revision)});
 assert.equal(live.commentPage,undefined);assert.deepEqual(live.scope.slice(1),ack.commentPage.items.map(x=>x.id+'/'+x.revision));
 const repeat=await run(b,'comment.create',{...fast,postId:post.id,parentId:reply.id,body:'추가 답글 14',offset:0,limit:12},ackRequestID);
 assert.equal(repeat.comment.id,ack.comment.id,'durable retry is idempotent');
 // The final unblock response is the renderable empty state, without another read.
 await run(a,'block.set',{...fast,id:pb.id,blocked:true});assert.equal((await run(a,'blocks')).total,1);
 ack=await run(a,'block.set',{...fast,id:pb.id,blocked:false});assert.equal(ack.blocks.total,0);assert.deepEqual(ack.blocks.items,[]);assert.equal(ack.blocks.nextOffset,null);
 await run(a,'block.set',{...fast,id:pb.id,blocked:true});save=db.SaveDatabase;
 try{db.SaveDatabase=()=>false;assert.equal((await request(a,'block.set',{...fast,id:pb.id,blocked:false})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal((await run(a,'blocks')).total,1,'failed unblock keeps the member blocked');
 console.log('FIX37 PASS: signed TCP privacy/profile validation and rollback, feed remains public, nested reply ACK pages, cross-device live updates, paging, idempotency and final unblock state.');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
