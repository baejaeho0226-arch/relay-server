'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix31-quotes-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX31-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX31-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX31-REQUEST-'+(++seq)){
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
 const author=await login(),viewer=await login(),third=await login();
 const a=(await run(author,'me')).profile,b=(await run(viewer,'me')).profile,c=(await run(third,'me')).profile;
 const own=id=>store.ProfileById(id),fast={_wire:'zlib',_delta:true};
 async function post(peer,account,fields,id){own(account).last_post=0;return run(peer,'post.create',{...fast,...fields},id);}
 async function comment(peer,account,fields){own(account).last_comment=0;return run(peer,'comment.create',{...fast,...fields});}
 const source=(await post(author,a.id,{title:'원본 제목',body:'원본 이야기',image:avatar(60),poll:{question:'한 번만 선택',options:['첫 번째','두 번째']}})).post;
 // Duplicate captions are permitted: the option ID, not its text, owns votes.
 const duplicate=(await post(author,a.id,{body:'동일 문구 투표',poll:{question:'같은 문구 허용',options:['선택','선택']}})).post;
 assert.deepEqual(duplicate.poll.options.map(x=>x.text),['선택','선택']);
 assert.deepEqual(duplicate.poll.options.map(x=>x.id),['0','1']);
 await run(author,'post.edit',{...fast,id:duplicate.id,revision:0,body:'중복 문구 수정도 허용',poll:{question:'수정된 질문',options:['동일','동일']}});
 await run(viewer,'poll.vote',{...fast,postId:duplicate.id,optionId:'1'});
 await run(third,'poll.vote',{...fast,postId:duplicate.id,optionId:'0'});
 const duplicatePoll=(await run(viewer,'thread',{...fast,postId:duplicate.id})).post.poll;
 assert.equal(duplicatePoll.total,2);assert.deepEqual(duplicatePoll.options.map(x=>x.votes),[1,1]);assert.equal(duplicatePoll.myVote,'1');
 assert.equal((await request(viewer,'poll.vote',{...fast,postId:duplicate.id,optionId:'0'})).reason,'POLL_ALREADY_VOTED');
 const voteBody={...fast,postId:source.id,optionId:'0'},voteId='FIX31-VOTE-REPLAY';
 const first=await run(viewer,'poll.vote',voteBody,voteId);
 assert.deepEqual(await run(viewer,'poll.vote',voteBody,voteId),first,'same request replay is idempotent');
 for(const optionId of ['0','1'])assert.equal((await request(viewer,'poll.vote',{...voteBody,optionId})).reason,'POLL_ALREADY_VOTED');
 await run(viewer,'profile.save',{handle:'once_voter',nickname:b.nickname,bio:''});
 assert.equal((await request(viewer,'poll.vote',{...voteBody,optionId:'1'})).reason,'POLL_ALREADY_VOTED','handle changes do not reset stable account vote');
 const save=db.SaveDatabase;db.SaveDatabase=()=>false;
 try{assert.equal((await request(third,'poll.vote',{...voteBody,optionId:'1'})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal(store.DB().pollVotes[c.id+':'+source.id],undefined);
 await run(third,'poll.vote',{...voteBody,optionId:'1'});
 const qBody={title:'내가 쓴 제목',body:'내 의견',quotePostId:source.id},qId='FIX31-QUOTE-REPLAY';
 const q1=await post(viewer,b.id,qBody,qId);assert.deepEqual(await run(viewer,'post.create',{...fast,...qBody},qId),q1);
 const q2=await post(viewer,b.id,{quotePostId:source.id,body:'두 번째 이야기'});
 assert.notEqual(q1.post.id,q2.post.id);assert.equal(q1.post.author.id,b.id);assert.equal(q1.post.body,'내 의견');
 assert.equal(q1.post.quote.body,'원본 이야기');assert.ok(q1.post.quote.image);assert.equal(q1.post.quote.poll.options.length,2);
 assert.equal(q2.quoteSource.reposts,2);assert.equal(q2.post.repostedBy.id,b.id);assert.ok(q2.post.repostedBy.at>0);
 assert.equal((await run(viewer,'me',fast)).posts.total,2,'quotes belong to the writer profile');
 let feed=await run(viewer,'feed',fast);assert.equal(feed.items.find(x=>x.id===source.id).reposts,2);
 assert.equal(store.DB().posts[source.id].body,'원본 이야기');
 await run(viewer,'post.edit',{...fast,id:q1.post.id,revision:0,title:'수정한 내 제목',body:'수정한 내 이야기',quotePostId:source.id});
 assert.equal(store.DB().posts[source.id].body,'원본 이야기','editing a quote cannot edit its source');
 assert.equal((await request(author,'post.edit',{...fast,id:q1.post.id,revision:1,body:'도용'})).reason,'NOT_OWNER');
 assert.equal((await request(viewer,'repost.set',{postId:source.id,value:true})).reason,'REPOST_COMPOSE_REQUIRED');
 assert.equal((await request(viewer,'post.edit',{...fast,id:q1.post.id,revision:1,body:'순환',quotePostId:q1.post.id})).reason,'INPUT_INVALID');
 const detached=await run(viewer,'post.edit',{...fast,id:q2.post.id,revision:0,body:'인용 제거',quotePostId:''});assert.equal(detached.quoteSources[0].reposts,1);
 const originalFromCard=await run(viewer,'thread',{...fast,postId:q1.post.quote.id});assert.equal(originalFromCard.post.id,source.id);
 const selfQuote=await post(author,a.id,{quotePostId:source.id});
 assert.equal(selfQuote.post.author.id,selfQuote.post.quote.author.id,'self repost retains the original author for the flat native layout');
 assert.equal(selfQuote.post.repostedBy.id,a.id);assert.equal(selfQuote.quoteSource.repostedBy,null,'a source is not mislabeled as somebody else reposting it');
 assert.equal(selfQuote.post.quote.body,'원본 이야기');

 const root=(await comment(author,a.id,{postId:source.id,body:'첫 댓글'})).comment;
 const replyResult=await comment(viewer,b.id,{postId:source.id,parentId:root.id,body:'직접 답글'}),reply=replyResult.comment;
 assert.equal(reply.replyToId,root.id);assert.deepEqual(replyResult.replyCounts,[{id:root.id,postId:source.id,replies:1}]);
 const nestedResult=await comment(third,c.id,{postId:source.id,parentId:reply.id,body:'대댓글에 답글'}),nested=nestedResult.comment;
 assert.equal(nested.parentId,root.id);assert.equal(nested.replyToId,reply.id);assert.equal(nested.replyToName,b.nickname);assert.equal(nestedResult.replyCounts[0].replies,1);
 const deeper=await comment(author,a.id,{postId:source.id,parentId:nested.id,body:'한 번 더 답글'});
 let thread=await run(author,'thread',{...fast,postId:source.id});
 for(const id of [root.id,reply.id,nested.id])assert.equal(thread.comments.items.find(x=>x.id===id).replies,1);
 assert.equal(thread.comments.items.find(x=>x.id===deeper.comment.id).replies,0);
 const removal=await run(third,'comment.delete',{id:nested.id});assert.equal(removal.replyCounts[0].id,reply.id);assert.equal(removal.replyCounts[0].replies,0);
 await run(author,'block.set',{id:b.id,blocked:true});thread=await run(author,'thread',{...fast,postId:source.id});assert.equal(thread.comments.items.find(x=>x.id===root.id).replies,0);
 await run(author,'block.set',{id:b.id,blocked:false});
 // A hidden/deleted source is never smuggled inside another person's quoted post.
 store.Atomic(()=>{store.DB().posts[source.id].hidden=true;});
 feed=await run(viewer,'feed',fast);assert.equal(feed.items.find(x=>x.id===q1.post.id).quote.unavailable,true);
 own(b.id).last_post=0;assert.equal((await request(viewer,'post.create',{...fast,quotePostId:source.id,body:'숨김 원글'})).reason,'POST_NOT_FOUND');
 await run(viewer,'post.edit',{...fast,id:q1.post.id,revision:1,body:'숨김 후 내 글 수정',quotePostId:source.id});
 store.Atomic(()=>{store.DB().posts[source.id].hidden=false;});
 let chain=source.id;
 for(let i=0;i<7;i++)chain=(await post(viewer,b.id,{quotePostId:chain,body:'중첩 '+i})).post.id;
 thread=await run(viewer,'thread',{...fast,postId:chain});let q=thread.post,depth=0;while(q.quote){depth++;q=q.quote;}assert.ok(depth<=4);assert.equal(q.truncated,true);
 const snapshot=db.BuildDatabaseObject();assert.equal(db.ImportDatabaseObject(snapshot),true);
 assert.equal((await request(viewer,'poll.vote',{...voteBody,optionId:'1'})).reason,'POLL_ALREADY_VOTED');
 assert.equal((await run(viewer,'thread',{...fast,postId:source.id})).post.poll.total,2);
 assert.equal(store.DB().comments[reply.id].replyToId,root.id,'direct targets survive storage reload');
 assert.equal(store.DB().posts[q1.post.id].quotePostId,source.id);
 await run(author,'post.delete',{id:source.id});
 thread=await run(viewer,'thread',{...fast,postId:q1.post.id});assert.deepEqual(thread.post.quote,{id:source.id,unavailable:true});
 assert.equal((await request(viewer,'photo',{id:source.id})).reason,'POST_NOT_FOUND');
 await run(viewer,'post.edit',{...fast,id:q1.post.id,revision:2,body:'원글 삭제 후에도 내 글 편집',quotePostId:source.id});
 console.log('FIX32 PASS: duplicate-option IDs, self repost/source navigation and attribution,  stable-account one-time votes, replay and rollback, repeatable quoted posts, edits and source privacy, nested quote limits, direct reply counts, deletion/block deltas, storage reload.');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
