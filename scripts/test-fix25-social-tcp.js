'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix25-refresh-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX25-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX25-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX25-REQUEST-'+(++seq)){
 p.c.hubRate=null;const encoded=Buffer.from(JSON.stringify(body)).toString('base64');p.send(['HUB',id,action,encoded,mac(p,'HUB',[id,action,encoded])].join('|'));
 const pieces=[];let total;
 do{const parts=(await p.wait('HUB_CHUNK|'+id+'|')).split('|');assert.equal(parts[2],action);assert.equal(parts[6],mac(p,'HUB_RESPONSE',parts.slice(1,6)));total=Number(parts[4]);pieces[Number(parts[3])]=parts[5];}while(pieces.filter(Boolean).length<total);
 return JSON.parse(Buffer.from(pieces.join(''),'base64').toString());
}
async function run(p,action,body,id){const r=await request(p,action,body,id);assert.equal(r.ok,true,JSON.stringify(r));return r.data;}
async function changed(p,revision){for(;;){const parts=(await p.wait('HUB_EVENT|')).split('|');assert.equal(parts[2],mac(p,'HUB_EVENT',[parts[1]]));if(Number(parts[1])>=revision)return;}}
function avatar(color){const {PNG}=require('pngjs'),png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=color;png.data[i+1]=240-color;png.data[i+2]=90;png.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(png).toString('base64');}
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const author=await login(),viewer=await login(),third=await login();
 const a=(await run(author,'me')).profile,b=(await run(viewer,'me')).profile,c=(await run(third,'me')).profile,hub=require('../services/member/service');
 const save=(action,body)=>hub.AdminWrite(action,body,'TEST25'),row=id=>store.ProfileById(id);
 const news=save('news.save',{title:'본문 재열람',body:'첫 줄\n둘째 줄과 전체 본문',category:'NOTICE',published:true});
 assert.equal((await run(viewer,'news',{summary:true})).items[0].body,undefined);
 for(let i=0;i<3;i++)assert.equal((await run(viewer,'article',{id:news.id})).article.body,news.body);
 assert.equal(store.ViewCount('news',news.id),1);
 const game=save('product.save',{title:'자유 기간 게임',description:'소개',accessType:'TYPE1',details:{genre:'RPG',channels:{official:'javascript:ignored'}},image:avatar(80),plans:[{days:2,price:200},{days:45,price:4200},{days:365,price:20000}],published:true});
 assert.deepEqual(game.plans.map(x=>x.days),[2,45,365]);assert.equal(game.details.channels,undefined);
 for(let i=0;i<3;i++){const detail=(await run(viewer,'product',{id:game.id})).product;assert.equal(detail.views,1);assert.equal(detail.details.genre,'RPG');assert.ok(detail.image);assert.ok(detail.imagePreview);}
 const plans=require('../services/member/gamePlans');for(const bad of [[],[{days:0,price:1}],[{days:3651,price:1}],[{days:1.5,price:2}],[{days:2,price:1},{days:2,price:3}]])assert.throws(()=>plans.Validate(bad),/GAME_PLAN_INVALID/);
 store.Atomic(()=>store.Ledger(row(b.id),10000,'TEST','25'));
 const purchased=(await run(viewer,'purchase',{productId:game.id,days:45,price:4200,revision:game.revision})).order;assert.equal(purchased.days,45);
 save('product.save',{id:game.id,revision:game.revision,title:game.title,description:'',accessType:'TYPE1',plans:[{days:10,price:800}],published:true});
 assert.equal(store.DB().orders[purchased.id].days,45);assert.equal((await request(viewer,'purchase',{productId:game.id,days:45,price:4200,revision:game.revision})).reason,'GAME_PLAN_UNAVAILABLE');
 const pack=(await run(author,'gifs')).items;assert.equal(pack.length,4);assert.ok(pack.every(x=>x.frames.length===12));
 const post=(await run(author,'post.create',{title:'제목이 있는 게시물',body:'사진과 투표',image:avatar(22),gifId:pack[0].id,poll:{question:'함께 할 게임?',options:['레이싱','RPG','리듬']}})).post;
 assert.equal((await run(viewer,'photo',{id:post.id})).photo.image,store.DB().posts[post.id].image);assert.equal(post.title,'제목이 있는 게시물');assert.equal(post.gif.frames.length,12);assert.equal(post.dislikes,undefined);
 await run(viewer,'react',{postId:post.id,value:1},'FIX25-HEART');await run(viewer,'react',{postId:post.id,value:1},'FIX25-HEART');assert.equal((await run(author,'thread',{postId:post.id})).post.likes,1);
 assert.equal((await request(viewer,'react',{postId:post.id,value:-1})).reason,'REACTION_INVALID');
 const comment=(await run(viewer,'comment.create',{postId:post.id,body:'댓글'})).comment;
 const reply=(await run(author,'comment.create',{postId:post.id,parentId:comment.id,body:'작성자의 답글'})).comment;
 assert.equal(reply.parentId,comment.id);assert.equal(reply.isPostAuthor,true);assert.equal(comment.isPostAuthor,false);assert.ok(comment.at>0);
 await run(author,'comment.react',{id:comment.id,value:1});await run(third,'comment.react',{id:comment.id,value:1});
 let thread=await run(author,'thread',{postId:post.id});assert.equal(thread.comments.items.find(x=>x.id===comment.id).likes,2);
 assert.equal((await request(author,'comment.edit',{id:comment.id,body:'도용',revision:0})).reason,'NOT_OWNER');
 await run(viewer,'comment.edit',{id:comment.id,body:'수정 댓글',revision:0});assert.equal((await request(viewer,'comment.edit',{id:comment.id,body:'오래된 수정',revision:0})).reason,'CONTENT_CHANGED');
 await run(viewer,'poll.vote',{postId:post.id,optionId:'1'},'FIX25-POLL');await run(viewer,'poll.vote',{postId:post.id,optionId:'1'},'FIX25-POLL');await run(author,'poll.vote',{postId:post.id,optionId:'0'});
 thread=await run(third,'thread',{postId:post.id});assert.equal(thread.post.poll.total,2);assert.equal(thread.post.poll.options[1].votes,1);
 await run(viewer,'poll.vote',{postId:post.id,optionId:'2'});assert.equal((await run(viewer,'thread',{postId:post.id})).post.poll.total,2);
 assert.equal((await request(author,'post.edit',{id:post.id,revision:0,body:'본문',poll:{question:'변경',options:['가','나']}})).reason,'POLL_LOCKED');
 await run(author,'post.edit',{id:post.id,revision:0,title:'새 제목',body:'새 본문'});assert.equal((await run(viewer,'thread',{postId:post.id})).post.title,'새 제목');
 await run(viewer,'bookmark.set',{kind:'post',id:post.id,saved:true});await run(viewer,'bookmark.set',{kind:'comment',id:reply.id,saved:true});assert.equal((await run(viewer,'bookmarks')).total,2);assert.equal((await run(author,'bookmarks')).total,0);
 await run(viewer,'repost.set',{postId:post.id,value:true});await run(viewer,'repost.set',{postId:post.id,value:true});const feed=await run(third,'feed');assert.equal(feed.items.filter(x=>x.id===post.id).length,1);assert.equal(feed.items[0].reposts,1);
 await run(viewer,'report',{kind:'comment',id:reply.id,reason:'댓글 신고'});const report=Object.values(store.DB().reports)[0];assert.equal(report.commentId,reply.id);
 await run(viewer,'follow.set',{id:a.id,following:true});await run(viewer,'block.set',{id:a.id,blocked:true});
 assert.equal((await run(viewer,'feed')).total,0);assert.equal((await run(viewer,'bookmarks')).total,0);assert.equal((await run(viewer,'blocks')).items[0].id,a.id);
 for(const [action,body] of [['photo',{id:post.id}],['thread',{postId:post.id}],['member',{id:a.id}],['follow.set',{id:a.id,following:true}],['comment.react',{id:reply.id,value:1}],['poll.vote',{postId:post.id,optionId:'0'}],['repost.set',{postId:post.id,value:true}],['bookmark.set',{kind:'post',id:post.id,saved:true}]])assert.equal((await request(viewer,action,body)).ok,false,action+' blocked');
 assert.equal((await run(author,'follows',{id:a.id,mode:'followers'})).items.length,0);
 const snapshot=db.BuildDatabaseObject();assert.equal(db.ImportDatabaseObject(snapshot),true);assert.equal((await run(viewer,'blocks')).total,1);
 await run(viewer,'block.set',{id:a.id,blocked:false});assert.equal((await run(viewer,'bookmarks')).total,2);
 const before=JSON.stringify(store.DB()),saveDb=db.SaveDatabase;db.SaveDatabase=()=>false;try{assert.equal((await request(viewer,'bookmark.set',{kind:'post',id:post.id,saved:false},'FIX25-ROLLBACK')).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=saveDb;}assert.equal(JSON.stringify(store.DB()),before);await run(viewer,'bookmark.set',{kind:'post',id:post.id,saved:false},'FIX25-ROLLBACK');
 await run(author,'comment.delete',{id:reply.id});assert.equal((await run(viewer,'bookmarks')).total,0);
 // A full page containing photos, GIFs, long Korean text and reposts must
 // still fit the signed response envelope (900000 base64 characters).
 const noise=Buffer.alloc(320*320*4);let seed=25;for(let i=0;i<noise.length;i++){seed=(seed*1664525+1013904223)>>>0;noise[i]=i%4===3?255:seed>>>24;}
 const noisy='data:image/jpeg;base64,'+require('jpeg-js').encode({width:320,height:320,data:noise},72).data.toString('base64');
 const large=[];for(let i=0;i<8;i++){row(a.id).last_post=0;large.push(store.Atomic(()=>require('../services/member/social').Post(row(a.id),{title:'가'.repeat(90),body:'나'.repeat(2000),image:noisy,gifId:pack[0].id,poll:{question:'다'.repeat(90),options:['라'.repeat(80),'마'.repeat(80),'바'.repeat(80),'사'.repeat(80)]}})).post.id);store.DB().reposts[b.id+':'+large[i]]={accountId:b.id,postId:large[i],at:Date.now()};}
 const full=await run(third,'feed');assert.equal(full.items.length,8);assert.ok(Buffer.from(JSON.stringify({ok:true,data:full})).toString('base64').length<900000);
 const old=structuredClone(store.DB());for(const key of ['commentReactions','bookmarks','blocks','reposts','pollVotes'])delete old[key];store.Import({memberHub:old});for(const key of ['commentReactions','bookmarks','blocks','reposts','pollVotes'])assert.deepEqual(store.DB()[key],{});
 assert.equal(store.DB().orders[purchased.id].days,45);
 console.log('FIX25 TCP PASS: article reopen, custom paid periods, image/genre data, deduplicated views, GIF frames, title, post/comment hearts, author replies, ownership/revisions, poll vote change/idempotency, bookmarks privacy, repost dedup, comment reports, mutual block authorization, durable data migration and save rollback.');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
