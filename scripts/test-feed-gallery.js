'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix26-social-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX26-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX26-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX26-REQUEST-'+(++seq)){
 p.c.hubRate=null;const encoded=Buffer.from(JSON.stringify(body)).toString('base64');if(encoded.length>40000){const total=Math.ceil(encoded.length/12000);for(let i=0;i<total;i++){const fields=[id,action,String(i),String(total),encoded.slice(i*12000,(i+1)*12000)];p.send(['HUB_UPLOAD',...fields,mac(p,'HUB_UPLOAD',fields)].join('|'));}}else p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total;
 do{const parts=(await p.wait('HUB_CHUNK|'+id+'|')).split('|');assert.equal(parts[2],action);assert.equal(parts[6],mac(p,'HUB_RESPONSE',parts.slice(1,6)));total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 return JSON.parse(Buffer.from(pieces.join(''),'base64').toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}
let regressionCompleted=false;process.once('exit',()=>{if(!regressionCompleted){console.error('TCP regression ended before completing assertions');process.exitCode=1;}});
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const author=await login(),viewer=await login();
 const a=(await run(author,'me')).profile,b=(await run(viewer,'me')).profile,own=()=>store.ProfileById(a.id),other=()=>store.ProfileById(b.id);
 const original=fs.readFileSync(path.join(__dirname,'fixtures/gallery-animation.gif'));
 // Preserve actual GIF bytes, including extensions, through > 50 signed upload chunks
 // and > 80 response chunks. Preview pages contain only bounded animation frames.
 const ext=[Buffer.from([0x21,0xfe])];for(let i=0;i<3600;i++)ext.push(Buffer.from([255]),Buffer.alloc(255,65));ext.push(Buffer.from([0]));
 const bytes=Buffer.concat([original.subarray(0,-1),...ext,Buffer.from([0x3b])]),gifData='data:image/gif;base64,'+bytes.toString('base64');
 assert.ok(Buffer.from(JSON.stringify({gifData})).toString('base64').length>960000);
 const post=(await run(author,'post.create',{title:'갤러리 첨부',body:'사진 GIF 투표',image:avatar(20),gifData,poll:{question:'어떤 게임?',options:['레이싱','RPG']}})).post;
 assert.ok(post.image);assert.equal(post.poll.options.length,2);assert.equal(post.gif.frames.length,6);assert.equal(post.gif.data,undefined);
 let detail=await run(viewer,'thread',{postId:post.id});assert.equal(detail.memberProtocol,33);assert.equal(detail.post.poll.options.length,2);
 assert.equal((await run(viewer,'photo',{id:post.id})).photo.image,store.DB().posts[post.id].image);
 assert.equal((await run(viewer,'gif',{id:post.id})).photo.gif.data,gifData);
 await run(author,'post.edit',{id:post.id,revision:0,title:'수정 제목',body:'사진 유지',gifId:post.gif.id,poll:{question:'어떤 게임?',options:['레이싱','RPG']}});
 assert.equal((await run(viewer,'gif',{id:post.id})).photo.gif.data,gifData);
 await run(viewer,'react',{postId:post.id,value:1});const quoted=(await run(viewer,'post.create',{quotePostId:post.id,body:'원글 공유'})).post;
 await run(viewer,'bookmark.set',{kind:'post',id:post.id,saved:true});
 await run(viewer,'poll.vote',{postId:post.id,optionId:'1'});detail=await run(viewer,'thread',{postId:post.id});assert.equal(detail.post.poll.myVote,'1');assert.equal(detail.post.poll.options[1].votes,1);assert.equal(detail.post.likes,1);assert.equal(detail.post.myRepost,true);
 const root1=(await run(author,'comment.create',{postId:post.id,body:'첫 댓글'})).comment;
 const root2=(await run(viewer,'comment.create',{postId:post.id,body:'둘째 댓글'})).comment;
 own().last_comment=0;const reply=(await run(author,'comment.create',{postId:post.id,parentId:root1.id,body:'첫 댓글의 답글'})).comment;
 other().last_comment=0;const nested=(await run(viewer,'comment.create',{postId:post.id,parentId:reply.id,body:'답글의 답글'})).comment;
 assert.equal(nested.parentId,root1.id);assert.equal(nested.replyToName,own().nickname);
 for(const [i,c] of [root1,root2,reply,nested].entries())store.DB().comments[c.id].at=Date.now()+i*100;
 detail=await run(viewer,'thread',{postId:post.id});assert.deepEqual(detail.comments.items.map(x=>x.id),[root1.id,reply.id,nested.id,root2.id]);
 for(const id of [root1.id,reply.id,nested.id]){await run(viewer,'comment.react',{id,value:1});await run(viewer,'bookmark.set',{kind:'comment',id,saved:true});}
 await run(author,'comment.edit',{id:root1.id,revision:0,body:'댓글 수정'});await run(author,'comment.edit',{id:reply.id,revision:0,body:'답글 수정'});
 await run(viewer,'comment.edit',{id:nested.id,revision:0,body:'대댓글 수정'});
 assert.equal((await request(viewer,'comment.edit',{id:reply.id,revision:1,body:'도용'})).reason,'NOT_OWNER');
 await run(viewer,'comment.delete',{id:nested.id});await run(author,'comment.delete',{id:reply.id});
 detail=await run(viewer,'thread',{postId:post.id});assert.equal(detail.comments.items.length,2);
 assert.equal((await run(viewer,'bookmarks')).total,2);
 // Server validates original GIF data, ignores filenames/MIME claims and rolls back bad edits.
 const media=require('../services/member/gifMedia');for(const bad of ['data:image/gif;base64,AAAA','data:image/gif;base64,'+Buffer.from('not a gif').toString('base64')])assert.throws(()=>media.Validate(bad),/GIF_INVALID/);
 assert.equal((await request(author,'post.edit',{id:post.id,revision:1,body:'손상',gifData:'data:image/gif;base64,AAAA'})).reason,'GIF_INVALID');
 assert.equal(store.DB().posts[post.id].body,'사진 유지');
 const full=await run(viewer,'feed');assert.ok(Buffer.from(JSON.stringify({ok:true,data:full})).toString('base64').length<900000);
 const snapshot=db.BuildDatabaseObject();assert.equal(db.ImportDatabaseObject(snapshot),true);assert.equal((await run(viewer,'gif',{id:post.id})).photo.gif.data,gifData);
 await run(author,'post.edit',{id:post.id,revision:1,title:'사진 제거',body:'투표 유지',image:'',gifData:'',gifId:''});
 detail=await run(viewer,'thread',{postId:post.id});assert.equal(detail.post.image,'');assert.equal(detail.post.gif,null);assert.equal(detail.post.poll.myVote,'1');
 await run(author,'post.delete',{id:post.id});const remaining=await run(viewer,'feed');assert.equal(remaining.total,1);assert.equal(remaining.items[0].quote.unavailable,true);await run(viewer,'post.delete',{id:quoted.id});assert.equal((await run(viewer,'feed')).total,0);assert.equal((await request(viewer,'gif',{id:post.id})).reason,'POST_NOT_FOUND');
 console.log('FIX26 PASS: gallery GIF chunk upload/original/preview, photo edit/remove, two-choice poll selection, all social actions, grouped replies, ownership, persistence and malformed GIF rollback.');
 regressionCompleted=true;
}catch(e){console.error(e);process.exitCode=1;}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
