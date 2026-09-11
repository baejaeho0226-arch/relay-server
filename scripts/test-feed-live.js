'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix34-live-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX34-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX34-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX34-REQUEST-'+(++seq)){
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
 const phones=[await login(),await login(),await login()], [a,b,c]=phones;
 const profiles=[];for(const p of phones)profiles.push((await run(p,'me')).profile);
 const [pa,pb,pc]=profiles, fast={_wire:'zlib',_delta:true};
 const jpeg=require('jpeg-js'),pixels=Buffer.alloc(640*360*4);
 for(let i=0;i<pixels.length;i+=4){pixels[i]=(i*13)%256;pixels[i+1]=(i>>4)%256;pixels[i+2]=(i>>10)%256;pixels[i+3]=255;}
 const photo='data:image/jpeg;base64,'+jpeg.encode({width:640,height:360,data:pixels},90).data.toString('base64');
 const gifData='data:image/gif;base64,'+fs.readFileSync(path.join(__dirname,'fixtures/gallery-animation.gif')).toString('base64');
 const post=(await run(a,'post.create',{...fast,body:'세 기기 동시 반영',image:photo,gifData,poll:{question:'게임 선택',options:['안녕하세요','두 번째']}})).post;
 const cached=[];for(const p of phones)cached.push(await run(p,'feed',fast));const mediaBytes=c.lastWire.downloadBytes;
 const input={posts:[post.id],comments:[],profiles:profiles.map(p=>p.id),scope:'feed',query:{offset:0,limit:8},...fast};
 const live=p=>run(p,'live',input), compact=await live(c),compactBytes=c.lastWire.downloadBytes;
 assert.ok(compactBytes<mediaBytes/3,`${compactBytes} compact bytes vs ${mediaBytes} media page bytes`);
 assert.ok(!JSON.stringify(compact).includes('data:image/'));
 for(const key of ['avatar','image','gif','body','title','quote'])assert.equal(compact.posts[0][key],undefined);
 assert.deepEqual(compact.scope,cached[2].items.map(p=>p.id+'/'+p.revision));
 await run(a,'react',{...fast,postId:post.id,value:1});await changed(b,store.DB().revision);
 await run(b,'react',{...fast,postId:post.id,value:1});await changed(a,store.DB().revision);
 let snapshots=await Promise.all(phones.map(live));
 assert.deepEqual(snapshots.map(x=>x.posts[0].likes),[2,2,2]);
 assert.deepEqual(snapshots.map(x=>x.posts[0].myReaction),[1,1,0]);
 await run(c,'react',{...fast,postId:post.id,value:1});await run(a,'react',{...fast,postId:post.id,value:0});
 snapshots=await Promise.all(phones.map(live));
 assert.deepEqual(snapshots.map(x=>x.posts[0].likes),[2,2,2]);assert.deepEqual(snapshots.map(x=>x.posts[0].myReaction),[0,1,1]);
 // The feed counter updates without any phone opening a thread.
 const root=(await run(b,'comment.create',{...fast,postId:post.id,body:'첫 댓글'}));
 assert.equal(root.post.comments,1);
 const reply=(await run(c,'comment.create',{...fast,postId:post.id,parentId:root.comment.id,body:'답글'}));assert.equal(reply.post.comments,2);
 const nested=(await run(a,'comment.create',{...fast,postId:post.id,parentId:reply.comment.id,body:'대댓글'}));assert.equal(nested.post.comments,3);
 input.comments=[root.comment.id,reply.comment.id,nested.comment.id];
 snapshots=await Promise.all(phones.map(live));
 for(const x of snapshots){assert.equal(x.posts[0].comments,3);assert.deepEqual(x.comments.map(c=>c.replies),[1,1,0]);}
 assert.deepEqual(snapshots[0].scope,compact.scope,'counter changes do not require downloading the card again');
 await run(a,'comment.react',{...fast,id:root.comment.id,value:1});await run(c,'comment.react',{...fast,id:root.comment.id,value:1});
 snapshots=await Promise.all(phones.map(live));assert.deepEqual(snapshots.map(x=>x.comments[0].likes),[2,2,2]);assert.deepEqual(snapshots.map(x=>x.comments[0].myReaction),[1,0,1]);
 await run(a,'poll.vote',{...fast,postId:post.id,optionId:'0'});
 await run(b,'poll.vote',{...fast,postId:post.id,optionId:'1'});
 await run(c,'poll.vote',{...fast,postId:post.id,optionId:'1'});
 snapshots=await Promise.all(phones.map(live));
 assert.deepEqual(snapshots.map(x=>x.posts[0].poll.myVote),['0','1','1']);
 for(const x of snapshots){assert.equal(x.posts[0].poll.total,3);assert.deepEqual(x.posts[0].poll.options.map(x=>x.votes),[1,2]);}
 assert.equal((await request(a,'poll.vote',{...fast,postId:post.id,optionId:'1'})).reason,'POLL_ALREADY_VOTED');
 await run(a,'bookmark.set',{...fast,kind:'post',id:post.id,saved:true});
 assert.equal((await live(a)).posts[0].bookmarked,true);assert.equal((await live(b)).posts[0].bookmarked,false);
 await run(a,'follow.set',{...fast,id:pb.id,following:true});await run(c,'follow.set',{...fast,id:pb.id,following:true});
 await run(b,'profile.save',{...fast,nickname:pb.nickname,handle:'live_member',bio:'한줄 소개 테스트'});
 snapshots=await Promise.all(phones.map(live));
 for(const x of snapshots){const p=x.profiles.find(p=>p.id===pb.id);assert.equal(p.followers,2);assert.equal(p.handle,'live_member');assert.equal(p.bio,'한줄 소개 테스트');assert.equal(p.balance,undefined);}
 assert.deepEqual(snapshots.map(x=>x.profiles.find(p=>p.id===pb.id).isFollowing),[true,false,true]);
 const followList=await run(b,'follows',{mode:'followers'});assert.equal(followList.total,2);assert.ok(followList.items.every(x=>x.handle&&typeof x.bio==='string'));
 const beforeThread=await run(a,'live',{...input,scope:'thread',query:{postId:post.id}});
 store.ProfileById(pb.id).last_comment=0;const fourth=await run(b,'comment.create',{...fast,postId:post.id,parentId:root.comment.id,body:'추가 답글'});
 const afterThread=await run(a,'live',{...input,scope:'thread',query:{postId:post.id}});
 assert.notDeepEqual(afterThread.scope,beforeThread.scope);assert.ok(afterThread.scope.includes(fourth.comment.id+'/0'));
 assert.equal(afterThread.posts[0].comments,4);assert.equal(afterThread.comments[0].replies,2);
 // Repeated updates while one phone keeps its own selection active.
 const started=performance.now();
 for(let i=0;i<12;i++){
  await run(a,'react',{...fast,postId:post.id,value:i%2});
  const x=await live(b);assert.equal(x.posts[0].myReaction,1);assert.equal(x.posts[0].likes,2+i%2);
 }
 assert.ok(performance.now()-started<5000,'loopback live propagation should not wait for a 12 second poll');
 store.ProfileById(pb.id).last_post=0;
 const quote=(await run(b,'post.create',{...fast,body:'리포스트',quotePostId:post.id})).post;
 const quoted=await run(c,'live',{...input,posts:[quote.id,post.id]});assert.equal(quoted.posts[1].poll.total,3);assert.equal(quoted.posts[1].comments,4);
 await run(c,'comment.delete',{...fast,id:reply.comment.id});const deleted=await live(a);
 assert.ok(deleted.removedComments.includes(reply.comment.id));assert.equal(deleted.posts[0].comments,3);assert.equal(deleted.comments[0].replies,1);
 const save=db.SaveDatabase;db.SaveDatabase=()=>false;
 try{assert.equal((await request(b,'react',{...fast,postId:post.id,value:0})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal((await live(b)).posts[0].myReaction,1);
 await run(a,'block.set',{...fast,id:pc.id,blocked:true});
 const blocked=await live(c);assert.ok(blocked.removedPosts.includes(post.id));assert.ok(!blocked.profiles.some(x=>x.id===pa.id));
 await run(a,'block.set',{...fast,id:pc.id,blocked:false});
 await run(a,'post.delete',{...fast,id:post.id});
 const gone=await live(b);assert.ok(gone.removedPosts.includes(post.id));assert.ok(!gone.scope.some(x=>x.startsWith(post.id+'/')));
 assert.equal((await request(b,'live',{posts:Array(65).fill(post.id)})).reason,'INPUT_INVALID');
 console.log(`FIX34 PASS: 3 signed TCP phones, per-viewer likes/votes/bookmarks, feed counts without thread navigation, nested replies, repeated selected-state updates, follows/handles/bio, removal and visibility, rollback. Live ${compactBytes} bytes vs media ${mediaBytes} bytes.`);
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
