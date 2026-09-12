'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix36-profiles-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX36-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX36-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX36-REQUEST-'+(++seq)){
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
let regressionCompleted=false;process.once('exit',()=>{if(!regressionCompleted){console.error('TCP regression ended before completing assertions');process.exitCode=1;}});
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const [a,b,c]=[await login(),await login(),await login()],fast={_wire:'zlib',_delta:true};
 const pa=(await run(a,'me')).profile,pb=(await run(b,'me')).profile,pc=(await run(c,'me')).profile;
 const commerce=require('../services/member/commerce');
 const source=(await run(c,'post.create',{...fast,body:'리포스트 원문'})).post;
 const gifData='data:image/gif;base64,'+fs.readFileSync(path.join(__dirname,'fixtures/gallery-animation.gif')).toString('base64');
 const original=(await run(a,'post.create',{...fast,title:'프로필의 원본 게시물',body:'전체 본문 '.repeat(60),image:avatar(60),gifData,quotePostId:source.id,poll:{question:'선택',options:['첫째','둘째']}})).post;
 await run(b,'post.create',{...fast,body:'다른 사람의 게시물'});
 await run(b,'react',{...fast,postId:original.id,value:1});await run(a,'poll.vote',{...fast,postId:original.id,optionId:'0'});
 await run(b,'follow.set',{...fast,id:pa.id,following:true});
 for(const [viewer,own,reaction,vote] of [[a,true,0,'0'],[b,false,1,''],[c,false,0,'']]){
  const feed=(await run(viewer,'feed',fast)).items.find(p=>p.id===original.id);
  const profile=await run(viewer,'member',{...fast,postCards:true,handle:pa.handle,offset:0,limit:8});
  assert.equal(profile.posts.total,1);assert.equal(profile.own,own);
  const card=profile.posts.items[0];
  for(const field of ['id','body','title','image','gif','poll','quote','likes','comments','own','myReaction','following','author'])assert.deepEqual(card[field],feed[field],field);
  assert.equal(card.own,own);assert.equal(card.myReaction,reaction);assert.equal(card.poll.myVote,vote);
  assert.ok(card.body.length>140);assert.ok(card.gif.frames.length>1);assert.equal(card.quote.id,source.id);
  for(const field of ['balance','subject','devices','phone'])assert.equal(profile.profile[field],undefined);
 }
 const legacy=(await run(b,'member',{id:pa.id})).posts.items[0];assert.equal(legacy.author,undefined);assert.equal(legacy.image,undefined);assert.ok(legacy.imageThumb);
 const query={postCards:true,id:pa.id,offset:0,limit:8},input={...fast,scope:'member',query,posts:[original.id],profiles:[pa.id]};
 let live=await run(b,'live',input),beforeScope=live.scope;
 await run(c,'react',{...fast,postId:original.id,value:1});await run(b,'poll.vote',{...fast,postId:original.id,optionId:'1'});
 live=await run(b,'live',input);assert.equal(live.posts[0].likes,2);assert.equal(live.posts[0].myReaction,1);assert.equal(live.posts[0].poll.myVote,'1');assert.equal(live.posts[0].poll.total,2);assert.deepEqual(live.scope,beforeScope);
 await run(a,'post.edit',{...fast,id:original.id,revision:0,title:'변경된 제목',body:'수정 본문'});
 assert.notDeepEqual((await run(b,'live',input)).scope,beforeScope);
 for(let i=0;i<9;i++){store.ProfileById(pa.id).last_post=0;await run(a,'post.create',{...fast,body:'추가 게시물 '+i});}
 const second=await run(b,'member',{...fast,...query,offset:8});
 const secondLive=await run(b,'live',{...input,query:{...query,offset:8}});
 assert.equal(second.posts.items.length,2);assert.deepEqual(secondLive.scope,second.posts.items.map(p=>p.id+'/'+p.revision));
 await run(a,'block.set',{...fast,id:pb.id,blocked:true});
 assert.equal((await request(b,'member',{...fast,...query})).reason,'MEMBER_NOT_FOUND');
 assert.deepEqual((await run(b,'live',input)).scope,['unavailable']);
 await run(a,'block.set',{...fast,id:pb.id,blocked:false});
 assert.equal((await run(b,'member',{...fast,...query})).posts.total,10);
 // Home receipts must describe purchases even after newer credits/refunds.
 store.Atomic(()=>{store.Ledger(store.ProfileById(pa.id),50000,'QR_TOPUP','TEST-CREDIT');store.Ledger(store.ProfileById(pb.id),5000,'TOPUP','TEST-OTHER');store.Ledger(store.ProfileById(pc.id),5000,'QR_TOPUP','CREDIT-ONLY');});
 const game=commerce.SaveProduct({title:'게임 이용권',description:'구매 테스트',accessType:'TYPE1',published:true,plans:[{days:7,price:1200}]});
 const purchase={...fast,productId:game.id,days:7,price:1200,revision:game.revision};
 const orders=[];for(let i=0;i<4;i++)orders.push((await run(a,'purchase',purchase)).order);
 const otherOrder=(await run(b,'purchase',purchase)).order;
 const now=Date.now();
 store.Atomic(()=>{
  for(let i=0;i<4;i++)store.DB().orders[orders[i].id].at=now-(4-i)*10000;
  Object.assign(store.DB().orders[orders[0].id],{status:'ACTIVE',activatedAt:now-1000,expiresAt:now+86400000});
  Object.assign(store.DB().orders[orders[2].id],{status:'ACTIVE',activatedAt:now-100000,expiresAt:now-1});
 });
 commerce.Refund({id:orders[3].id,reason:'미사용 환불 검사'},'TEST');
 store.Atomic(()=>{const row=store.Ledger(store.ProfileById(pa.id),2500,'QR_TOPUP','NEWEST-CREDIT');row.at=now+10000;});
 const home=await run(a,'home');
 assert.equal(home.summary.active,1);assert.equal(home.summary.ready,1);assert.equal(home.summary.payments,4);
 assert.deepEqual(home.recentOrders.map(x=>x.id),[orders[1].id,orders[0].id]);
 assert.deepEqual(home.recentOrders.map(x=>x.status),['PAID','ACTIVE']);
 assert.equal(home.recentPayments.length,2);assert.ok(home.recentPayments.every(x=>x.kind==='PURCHASE'&&x.accountId===pa.id&&x.title===game.title));
 assert.equal(home.latestPayment.kind,'PURCHASE');assert.ok(!home.recentPayments.some(x=>x.reference===otherOrder.id));
 const payments=(await run(a,'me',{...fast,purchasesOnly:true,offset:0,limit:20})).payments;
 assert.equal(payments.total,4);assert.ok(payments.items.every(x=>x.kind==='PURCHASE'&&x.amount===-1200));
 const paged=(await run(a,'me',{...fast,purchasesOnly:true,offset:2,limit:2})).payments;
 assert.equal(paged.items.length,2);assert.deepEqual(paged.items.map(x=>x.id),payments.items.slice(2).map(x=>x.id));
 assert.ok((await run(a,'me')).payments.total>4,'legacy/admin transaction data remains intact');
 const creditOnly=await run(c,'home');assert.equal(creditOnly.summary.payments,0);assert.equal(creditOnly.latestPayment,null);assert.deepEqual(creditOnly.recentPayments,[]);assert.deepEqual(creditOnly.recentOrders,[]);
 const save=db.SaveDatabase;
 try{db.SaveDatabase=()=>false;assert.equal((await request(a,'purchase',purchase)).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
 assert.equal((await run(a,'home')).summary.payments,4,'failed purchase has no receipt');
 console.log('FIX36 PASS: signed TCP self/other profile cards, per-viewer actions and media, live counts/paging/edits/blocks, active+unused home passes, purchase-only receipts with newer top-ups/refunds, account isolation and rollback.');
 regressionCompleted=true;
}catch(e){console.error(e);process.exitCode=1;}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
