'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix27-speed-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX27-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX27-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX27-REQUEST-'+(++seq)){
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
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const author=await login(),viewer=await login();
 const a=(await run(author,'me')).profile,b=(await run(viewer,'me')).profile;
 const fast={_wire:'zlib',_delta:true},jpeg=require('jpeg-js');
 const pixels=Buffer.alloc(1280*720*4);for(let y=0;y<720;y++)for(let x=0;x<1280;x++){const i=(y*1280+x)*4;pixels[i]=x%256;pixels[i+1]=y%256;pixels[i+2]=(x+y)%256;pixels[i+3]=255;}
 const photo='data:image/jpeg;base64,'+jpeg.encode({width:1280,height:720,data:pixels},90).data.toString('base64');
 const original=fs.readFileSync(path.join(__dirname,'fixtures/gallery-animation.gif')),ext=[Buffer.from([0x21,0xfe])];for(let i=0;i<3600;i++)ext.push(Buffer.from([255]),Buffer.alloc(255,65));ext.push(Buffer.from([0]));
 const gifData='data:image/gif;base64,'+Buffer.concat([original.subarray(0,-1),...ext,Buffer.from([0x3b])]).toString('base64');
 const post=(await run(author,'post.create',{...fast,title:'고해상도 첨부',body:'본문',image:photo,gifData,poll:{question:'게임 선택',options:['레이싱','RPG']}})).post;
 assert.ok(author.lastWire.uploadBytes<author.lastWire.uploadPlain*.6,'compress authenticated media uploads');
 const stored=store.DB().posts[post.id];assert.equal(stored.image,photo,'do not recompress a validated JPEG original');
 assert.equal(jpeg.decode(Buffer.from(post.image.split(',')[1],'base64')).width,720);assert.equal(stored.gifMedia.previewVersion,2);
 assert.ok(stored.gifMedia.frames.every(x=>x.length<16000));
 let feed=await run(viewer,'feed',fast);const fullBytes=viewer.lastWire.downloadBytes;assert.equal(feed.memberProtocol,28);
 assert.equal((await run(viewer,'feed',{...fast,_since:feed.revision})).unchanged,true);
 const reactionBody={...fast,postId:post.id,value:1},req='FIX27-REACTION-IDEMPOTENT';
 const reaction=await run(viewer,'react',reactionBody,req),deltaBytes=viewer.lastWire.downloadBytes;
 assert.equal(reaction.partial,true);assert.equal(reaction.post.likes,1);assert.equal(reaction.post.image,undefined);assert.equal(reaction.post.gif,undefined);assert.ok(deltaBytes<fullBytes/2);
 assert.deepEqual(await run(viewer,'react',reactionBody,req),reaction);assert.equal((await request(viewer,'react',{...reactionBody,value:0},req)).reason,'REQUEST_REUSED');
 const vote=(await run(viewer,'poll.vote',{...fast,postId:post.id,optionId:'1'})).post;assert.equal(vote.poll.myVote,'1');assert.equal(vote.poll.options[1].votes,1);
 const repost=(await run(viewer,'post.create',{...fast,quotePostId:post.id,body:'함께 나눠요'})).post;assert.equal(repost.repostedBy.id,b.id);assert.ok(repost.repostedBy.at>0);
 const saved=await run(viewer,'bookmark.set',{...fast,kind:'post',id:post.id,saved:true});assert.deepEqual(saved,{saved:true,kind:'post',id:post.id});
 const comment=(await run(author,'comment.create',{...fast,postId:post.id,body:'댓글'})).comment;
 const heart=(await run(viewer,'comment.react',{...fast,id:comment.id,value:1})).comment;assert.equal(heart.likes,1);assert.equal(heart.postId,post.id);assert.equal(heart.body,undefined);
 await run(author,'post.edit',{...fast,id:post.id,revision:0,title:'빠른 수정',body:'첨부 유지'});assert.equal(store.DB().posts[post.id].image,photo);assert.equal(store.DB().posts[post.id].gifMedia.data,gifData);
 const fetched=await run(viewer,'gif',{...fast,id:post.id});assert.equal(fetched.photo.gif.data,gifData);assert.equal(viewer.lastWire.compressed,true);
 // Cached reads still check visibility, daily impressions and time-sensitive announcements.
 feed=await run(viewer,'feed',fast);store.DB().viewHits[b.id+':post:'+post.id]='2000-01-01';const next=await run(viewer,'feed',{...fast,_since:feed.revision});assert.equal(next.unchanged,undefined);assert.ok(next.revision>feed.revision);
 const before=store.DB().posts[post.id].body;assert.equal((await request(viewer,'post.edit',{...fast,id:post.id,revision:1,body:'도용'})).reason,'NOT_OWNER');assert.equal(store.DB().posts[post.id].body,before);
 const database=require('../storage/database'),save=database.SaveDatabase;database.SaveDatabase=()=>false;
 assert.equal((await request(viewer,'react',{...fast,postId:post.id,value:0})).reason,'STORAGE_SAVE_FAILED');database.SaveDatabase=save;
 assert.equal(store.DB().reactions[b.id+':'+post.id].value,1,'storage failure rolls back optimistic server state');
 const product=require('../services/member/commerce').SaveProduct({title:'레이싱',accessType:'TYPE1',description:'게임',published:true,plans:[{days:3,price:500}],details:{genre:'레이싱'}});
 let catalog=await run(viewer,'catalog');assert.equal(catalog.items.find(x=>x.id===product.id).unread,true);await run(viewer,'product',{id:product.id});catalog=await run(viewer,'catalog');assert.equal(catalog.items.find(x=>x.id===product.id).unread,false);
 const media=require('../services/member/media');const legacy={...store.DB().posts[post.id],imageFeedVersion:0};assert.equal(jpeg.decode(Buffer.from(media.FeedImage(legacy).split(',')[1],'base64')).width,720);
 const uploads=require('../services/member/uploads'),fields=['FIX27-UPLOAD-MAC','post.edit','0','1','e30='];assert.equal(uploads.Accept(viewer.c,['HUB_ZUPLOAD',...fields,mac(viewer,'HUB_UPLOAD',fields)]),null,'compression prefix is authenticated');
 assert.throws(()=>require('../services/member/wire').Decode(zlib.deflateSync(Buffer.alloc(6000001)).toString('base64'),true),/limit|large/i);
 await run(author,'post.delete',{...fast,id:post.id});assert.equal((await request(viewer,'thread',{...fast,postId:post.id,_since:store.DB().revision})).reason,'POST_NOT_FOUND');
 console.log(`FIX27 PASS: signed compressed upload/download, legacy requests, compact replies (${deltaBytes} vs ${fullBytes} encoded bytes), idempotency, ownership, persistence rollback, daily cache freshness, original JPEG preservation, sharper previews, repost metadata and per-member game unread state.`);
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
