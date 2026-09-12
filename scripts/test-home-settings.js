'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix39-profiles-'));
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
async function login(){const p=await connect();p.send('CONNECT|2|2.20.0|MEMBER-REFRESH-FIX39-'+peers.length);const id=(await p.wait('CONNECTED|')).split('|')[1];p.c=state.clients.get(id);p.secret=crypto.randomBytes(32).toString('hex');Object.assign(p.c,{permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,deviceAuthChallengeId:'AUTH-FIX39-'+id});state.deviceSecrets.set('CLIENT:'+id,p.secret);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return p;}
async function request(p,action,body={},id='FIX39-REQUEST-'+(++seq)){
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
 const [a,b,c,a2]=[await login(),await login(),await login(),await login()],fast={_wire:'zlib',_delta:true};
 // Fixture: two authenticated connections are bound to the same account subject.
 a2.c.installationDeviceKey=require('../identity/identityManager').FindClientDeviceKey(a.c.clientId);
 const pa=(await run(a,'me')).profile,pb=(await run(b,'me')).profile,pc=(await run(c,'me')).profile;
 assert.equal((await run(a2,'me')).profile.id,pa.id);
 const home=require('../services/member/home'),hub=require('../services/member/service');
 const now=Date.now,epoch=Date.parse('2026-09-12T14:59:00Z');let clock=epoch;Date.now=()=>clock;
 try{
  assert.equal(home.Day(clock),'2026-09-12');assert.equal(home.Day(clock+60000),'2026-09-13');
  assert.equal((await run(a,'home')).attendance.checked,false);
  const first=await run(a,'attendance.check',fast,'CHECKIN-SHARED-0001');
  assert.equal(first.attendance.count,1);assert.equal(first.attendance.streak,1);
  assert.deepEqual(await run(a,'attendance.check',fast,'CHECKIN-SHARED-0001'),first,'request replay is idempotent');
  assert.equal((await run(a2,'attendance.check',fast)).attendance.count,1,'same account on another phone');
  assert.equal((await run(b,'home')).attendance.count,0,'different account isolated');
  clock+=60000;assert.equal((await run(a2,'attendance.check',fast)).attendance.streak,2);
  clock+=2*86400000;const save=db.SaveDatabase;
  try{db.SaveDatabase=()=>false;assert.equal((await request(a,'attendance.check',fast)).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save;}
  assert.equal((await run(a,'home')).attendance.count,2);
  const third=await run(a,'attendance.check',fast);assert.equal(third.attendance.count,3);assert.equal(third.attendance.streak,1);
 }finally{Date.now=now;}
 await run(a,'preferences.save',{...fast,notifyApproval:false,notifyRelease:false,language:'en',profilePostsPrivate:true});
 const prefs=(await run(a2,'preferences')).preferences;
 assert.equal(prefs.notifyApproval,false);assert.equal(prefs.language,'en');assert.equal(prefs.profilePostsPrivate,true);
 assert.equal((await run(b,'preferences')).preferences.language,'ko');
 assert.equal((await run(a2,'live',{...fast,profiles:[pa.id]})).profiles[0].preferences.language,'en');
 assert.equal((await run(c,'live',{...fast,profiles:[pa.id]})).profiles[0].preferences,undefined,'another member never receives notification/privacy preferences');
 assert.equal((await request(a,'preferences.save',{language:'invalid'})).reason,'INPUT_INVALID');
 assert.equal((await request(a,'preferences.save',{notifyApproval:'false'})).reason,'INPUT_INVALID');
 assert.equal((await request(a,'preferences.save',{})).reason,'INPUT_INVALID');
 const saved=db.SaveDatabase;try{db.SaveDatabase=()=>false;assert.equal((await request(a,'preferences.save',{language:'ko',notifyApproval:true})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=saved;}
 assert.equal((await run(a,'preferences')).preferences.language,'en');
 const original=(await run(a,'post.create',{...fast,title:'인기 글',body:'본문',poll:{question:'선택',options:['가나다라마바사아자차카타','😀'.repeat(10)]}})).post;
 const newest=(await run(b,'post.create',{...fast,title:'최근 글',body:'본문'})).post;
 store.Atomic(()=>{store.DB().posts[original.id].at=Date.now()-60000;store.DB().posts[newest.id].at=Date.now()-1000;});
 assert.equal((await run(c,'feed',{...fast,sort:'latest'})).items[0].id,newest.id);
 await run(b,'react',{...fast,postId:original.id,value:1});
 assert.equal((await run(c,'feed',{...fast,sort:'popular'})).items[0].id,original.id);
 assert.equal(store.ViewCount('post',original.id),0,'rankings and lists do not increment views');
 const q={sort:'popular',limit:8};const scope=(await run(c,'live',{...fast,scope:'feed',query:q})).scope;
 await run(a,'react',{...fast,postId:newest.id,value:1});await run(c,'react',{...fast,postId:newest.id,value:1});
 assert.notDeepEqual((await run(c,'live',{...fast,scope:'feed',query:q})).scope,scope,'popular scope changes with reactions');
 assert.equal((await run(c,'feed',{...fast,sort:'popular'})).items[0].id,newest.id);
 assert.equal((await request(c,'feed',{sort:'unsupported'})).reason,'INPUT_INVALID');
 const poll=require('../services/member/pollText');
 for(const text of ['A'.repeat(24),'한'.repeat(12),'日'.repeat(12),'😀'.repeat(12),'مرحبا','e\u0301'.repeat(12)])assert.equal(poll.Input(text),text);
 for(const text of ['A'.repeat(25),'한'.repeat(13),'😀'.repeat(13),'x\ny'])assert.throws(()=>poll.Input(text));
 assert.equal(poll.Input('한'.repeat(30),'한'.repeat(30)),'한'.repeat(30),'legacy options survive unchanged');
 await run(b,'poll.vote',{...fast,postId:original.id,optionId:'0'});
 assert.equal((await request(b,'poll.vote',{...fast,postId:original.id,optionId:'1'})).reason,'POLL_ALREADY_VOTED');
 const event=hub.AdminWrite('news.save',{title:'현재 이벤트',body:'행사 내용',category:'EVENT',published:true},'TEST');
 hub.AdminWrite('news.save',{title:'임시 이벤트',body:'초안',category:'EVENT',published:false},'TEST');
 const other=hub.AdminWrite('news.save',{title:'다른 회원 이벤트',body:'비공개',category:'EVENT',audience:pb.id,published:true},'TEST');
 store.Atomic(()=>{store.Ledger(store.ProfileById(pa.id),90000,'QR_TOPUP','A');store.Ledger(store.ProfileById(pb.id),70000,'QR_TOPUP','B');store.Ledger(store.ProfileById(pc.id),30000,'QR_TOPUP','C');});
 const game=hub.AdminWrite('product.save',{title:'구매 활동 테스트',description:'본문',accessType:'TYPE1',published:true,plans:[{days:3,price:500}]},'TEST');
 const purchase=(await run(b,'purchase',{...fast,productId:game.id,days:3,price:500,revision:game.revision})).order;
 let data=await run(c,'home');assert.equal(data.balanceRanking,undefined);assert.ok(data.popular.length<=10);assert.ok(data.recentPurchases.some(x=>x.member.id===pb.id&&x.title===game.title));
 assert.deepEqual(data.events.items.map(x=>x.id),[event.id]);assert.ok(!data.events.items.some(x=>x.id===other.id));
 for(const rows of [data.recentPurchases])for(const row of rows){assert.ok(!('amount'in row)&&!('balance'in row));for(const key of ['balance','subject','phone','devices','gender','preferences'])assert.equal(row.member[key],undefined);}
 await run(a,'preferences.save',{balanceRankingVisible:false});await run(b,'preferences.save',{purchaseActivityVisible:false});
 data=await run(c,'home');assert.equal(data.balanceRanking,undefined);assert.equal(data.recentPurchases.length,0);
 await run(b,'preferences.save',{purchaseActivityVisible:true});await run(c,'block.set',{id:pb.id,blocked:true});
 data=await run(c,'home');assert.equal(data.balanceRanking,undefined);assert.ok(!data.popular.some(x=>x.author.id===pb.id));assert.equal(data.recentPurchases.length,0);
 await run(c,'block.set',{id:pb.id,blocked:false});hub.AdminWrite('order.refund',{id:purchase.id,reason:'취소'},'TEST');assert.equal((await run(c,'home')).recentPurchases.length,0);
 assert.equal((await run(c,'policies',{kind:'terms'})).document.body,'');
 assert.equal((await request(c,'policy.save',{kind:'terms'})).reason,'UNKNOWN_ACTION','member cannot publish legal documents');
 hub.AdminWrite('policy.save',{kind:'terms',body:'테스트 운영 문서\n두 번째 줄',published:true,revision:0},'TEST');
 let doc=(await run(c,'policies',{kind:'terms'})).document;assert.equal(doc.body,'테스트 운영 문서\n두 번째 줄');assert.equal(doc.revision,1);assert.equal(doc.updatedBy,undefined);
 assert.throws(()=>hub.AdminWrite('policy.save',{kind:'terms',body:'덮어쓰기',published:true,revision:0},'TEST'),/CONTENT_CHANGED/);
 hub.AdminWrite('policy.save',{kind:'terms',body:doc.body,published:false,revision:1},'TEST');assert.equal((await run(c,'policies',{kind:'terms'})).document.body,'');
 assert.equal((await request(c,'policies',{kind:'bad'})).reason,'INPUT_INVALID');
 store.Import({memberHub:JSON.parse(JSON.stringify(store.DB()))});assert.equal((await run(a,'preferences')).preferences.language,'en');assert.equal((await run(a2,'home')).attendance.count,3);
 console.log('FIX39 PASS: signed multi-device check-in, Korean date boundary, retry/rollback, private preferences, real latest/popular/live scopes, multilingual poll limits, popular feed ranking, purchase/privacy/block filters, admin-only documents and persistence.');
 regressionCompleted=true;
}catch(e){console.error(e);process.exitCode=1;}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
