'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix38-profiles-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX38-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX38-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX38-REQUEST-'+(++seq)){
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
 const pa=(await run(a,'me')).profile,pb=(await run(b,'me')).profile,pc=(await run(c,'me')).profile;
 const original=(await run(a,'post.create',{...fast,body:'목록에서는 조회하지 않은 글',image:avatar(80)})).post;
 const quote=(await run(b,'post.create',{...fast,body:'인용한 글',quotePostId:original.id})).post;
 await run(b,'bookmark.set',{...fast,kind:'post',id:original.id,saved:true});
 for(let i=0;i<3;i++)for(const peer of [a,b,c]){
  await run(peer,'feed',fast);await run(peer,'me',{...fast,postCards:true});
  await run(peer,'member',{...fast,id:pa.id,postCards:true});
  await run(peer,'live',{...fast,scope:'feed',query:{limit:8},posts:[original.id,quote.id],profiles:[pa.id,pb.id]});
 }
 await run(b,'bookmarks',fast);await run(b,'photo',{...fast,id:original.id});
 assert.equal(store.ViewCount('post',original.id),0);assert.equal(store.ViewCount('post',quote.id),0);
 for(const peer of [a,b,c])await run(peer,'thread',{...fast,postId:original.id,countView:false});
 assert.equal(store.ViewCount('post',original.id),0,'background thread reads never count');
 const read=await run(b,'thread',{...fast,postId:original.id,countView:true});assert.equal(read.post.views,1);
 for(let i=0;i<3;i++)await run(b,'thread',{...fast,postId:original.id,countView:true});
 assert.equal(store.ViewCount('post',original.id),1,'same member/day is deduplicated');
 await run(c,'thread',{...fast,postId:quote.id,countView:true});
 assert.equal(store.ViewCount('post',quote.id),1);assert.equal(store.ViewCount('post',original.id),1,'a nested quote does not count as opening its source');
 await run(c,'thread',{...fast,postId:original.id,countView:true});assert.equal(store.ViewCount('post',original.id),2);
 const live=await run(a,'live',{...fast,posts:[original.id]});assert.equal(live.posts[0].views,2);
 store.DB().viewHits[pb.id+':post:'+original.id]='2000-01-01';
 const cache=await run(b,'feed',fast),revision=store.DB().revision;
 assert.equal((await run(b,'feed',{...fast,_since:cache.revision})).unchanged,true);
 await run(b,'thread',{...fast,postId:original.id,countView:false});
 assert.equal(store.DB().revision,revision);assert.equal(store.ViewCount('post',original.id),2,'a new day still requires opening');
 await run(b,'thread',{...fast,postId:original.id,countView:true});assert.equal(store.ViewCount('post',original.id),3);
 // Old APKs still count explicit thread opens; no old or new APK counts list reads.
 await run(a,'thread',{postId:original.id});assert.equal(store.ViewCount('post',original.id),4);
 store.DB().viewHits[pc.id+':post:'+original.id]='2000-01-01';const save=db.SaveDatabase;
 try{db.SaveDatabase=()=>false;assert.equal((await request(c,'thread',{...fast,postId:original.id,countView:true})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal(store.ViewCount('post',original.id),4);assert.equal(store.DB().viewHits[pc.id+':post:'+original.id],'2000-01-01');
 await run(c,'thread',{...fast,postId:original.id,countView:true});assert.equal(store.ViewCount('post',original.id),5);
 await run(c,'block.set',{...fast,id:pa.id,blocked:true});
 assert.equal((await request(c,'thread',{...fast,postId:original.id,countView:true})).reason,'POST_NOT_FOUND');assert.equal(store.ViewCount('post',original.id),5);
 const news=require('../services/member/social').SaveNews({title:'소식',body:'본문',category:'NOTICE',published:true});
 const game=require('../services/member/commerce').SaveProduct({title:'게임',description:'설명',accessType:'TYPE1',published:true,plans:[{days:3,price:500}]});
 await run(b,'news',{summary:true});await run(b,'catalog',{summary:true});assert.equal(store.ViewCount('news',news.id),0);assert.equal(store.ViewCount('product',game.id),0);
 for(let i=0;i<2;i++){await run(b,'article',{id:news.id});await run(b,'product',{id:game.id});}
 assert.equal(store.ViewCount('news',news.id),1);assert.equal(store.ViewCount('product',game.id),1);
 console.log('FIX38 PASS: 3 signed TCP clients, list/profile/live/bookmark/media reads have no view side effects, explicit opens and legacy detail compatibility, quote isolation, day deduplication, rollback, blocked access and unchanged news/game rules.');
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
