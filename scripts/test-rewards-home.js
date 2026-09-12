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
let done=false;process.once('exit',()=>{if(!done)process.exitCode=1;});
(async()=>{try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const a=await login(),b=await login(),a2=await login();a2.c.installationDeviceKey=require('../identity/identityManager').FindClientDeviceKey(a.c.clientId);
 const pa=(await run(a,'me')).profile,pb=(await run(b,'me')).profile,hub=require('../services/member/service'),rewards=require('../services/member/rewards'),charges=require('../services/member/charges');
 const originalNow=Date.now;let clock=Date.parse('2026-09-01T03:00:00Z');Date.now=()=>clock;
 try{
  for(let d=0;d<7;d++){if(d)clock+=86400000;const x=await run(a,'attendance.check',{},'STAMP-0000000'+d);assert.equal(x.attendance.streak,d+1);assert.equal(x.wallet.points,d===6?100:0);}
  const replay=await run(a2,'attendance.check',{},'STAMP-00000006');assert.equal(replay.wallet.points,100);
  assert.equal((await run(a2,'attendance.check')).wallet.points,100);assert.equal((await run(b,'rewards')).wallet.points,0);
  assert.equal((await run(a,'rewards')).history.total,1);
  clock+=2*86400000;assert.equal((await run(a,'attendance.check')).attendance.streak,1);
  const saved=db.SaveDatabase;clock+=86400000;try{db.SaveDatabase=()=>false;assert.equal((await request(a,'attendance.check')).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=saved;}
  assert.equal((await run(a,'rewards')).attendance.streak,1);
 }finally{Date.now=originalNow;}
 let rules=rewards.Rules();assert.equal((await request(a,'rewards.save',rules)).reason,'UNKNOWN_ACTION');
 assert.throws(()=>hub.AdminWrite('rewards.save',{...rules,attendanceDays:0},'TEST'),/AMOUNT_INVALID/);
 rules=hub.AdminWrite('rewards.save',{...rules,chargeUnit:1000},'TEST');assert.equal(rules.revision,2);
 assert.throws(()=>hub.AdminWrite('rewards.save',{...rules,revision:1},'TEST'),/CONTENT_CHANGED/);
 const saved=db.SaveDatabase;try{db.SaveDatabase=()=>false;assert.throws(()=>hub.AdminWrite('rewards.save',{...rules,chargeUnit:2000},'TEST'),/STORAGE_SAVE_FAILED/);}finally{db.SaveDatabase=saved;}
 assert.equal(rewards.Rules().chargeUnit,1000);
 function approval(amount){const q=charges.Issue(store.ProfileById(pa.id)),scan=charges.Inspect('QRC1.'+q.id+'.'+q.token);return {id:q.id,mode:'WALLET',approvalToken:scan.approvalToken,amount,memo:'TEST'};}
 let ap=approval(600);hub.AdminWrite('charge.approve',ap,'TEST');assert.equal((await run(a,'rewards')).wallet.spins,0);
 ap=approval(1800);const approved=hub.AdminWrite('charge.approve',ap,'TEST');assert.equal(approved.eventSpinsGranted,2);
 hub.AdminWrite('charge.approve',ap,'TEST');assert.equal((await run(a2,'rewards')).wallet.spins,2);
 ap=approval(600);const saved2=db.SaveDatabase;try{db.SaveDatabase=()=>false;assert.throws(()=>hub.AdminWrite('charge.approve',ap,'TEST'),/STORAGE_SAVE_FAILED/);}finally{db.SaveDatabase=saved2;}
 assert.equal((await run(a,'rewards')).wallet.spins,2);hub.AdminWrite('charge.approve',ap,'TEST');assert.equal((await run(a,'rewards')).wallet.spins,3);
 assert.equal((await request(a,'event.spin',{revision:1})).reason,'CONTENT_CHANGED');assert.equal((await run(a,'rewards')).wallet.spins,3);
 const spin=await run(a,'event.spin',{revision:rules.revision,index:99,points:99999999},'SPIN-REPLAY-0001');
 assert.ok(spin.spin.index>=0&&spin.spin.index<6);assert.equal(spin.reward.amount,rules.prizes[spin.spin.index].points);
 assert.equal(spin.wallet.spins,2);assert.equal(spin.wallet.points,100+spin.reward.amount);
 assert.deepEqual(await run(a2,'event.spin',{revision:rules.revision,index:99,points:99999999},'SPIN-REPLAY-0001'),spin);
 const save3=db.SaveDatabase;try{db.SaveDatabase=()=>false;assert.equal((await request(a,'event.spin',{revision:rules.revision})).reason,'STORAGE_SAVE_FAILED');}finally{db.SaveDatabase=save3;}
 assert.deepEqual((await run(a,'rewards')).wallet,spin.wallet);
 await run(a,'event.spin',{revision:rules.revision});await run(a,'event.spin',{revision:rules.revision});assert.equal((await request(a,'event.spin',{revision:rules.revision})).reason,'EVENT_NO_TURNS');
 rules=hub.AdminWrite('rewards.save',{...rules,enabled:false},'TEST');assert.equal((await request(a,'event.spin',{revision:rules.revision})).reason,'EVENT_CLOSED');
 const game=hub.AdminWrite('product.save',{title:'게임',description:'내용',accessType:'TYPE1',published:true,plans:[{days:5,price:200}]},'TEST');
 const order1=(await run(a,'purchase',{productId:game.id,days:5,price:200,revision:game.revision})).order;
 const order2=(await run(a,'purchase',{productId:game.id,days:5,price:200,revision:game.revision})).order;
 store.Atomic(()=>{store.DB().orders[order1.id].at=Date.now()-1000;store.DB().orders[order2.id].at=Date.now();});
 let home=await run(a,'home');assert.equal(home.recentOrders.length,1);assert.equal(home.recentOrders[0].id,order1.id);assert.equal(home.recentPayments.length,1);assert.notEqual(home.recentPayments[0].kind,'QR_TOPUP');
 store.Atomic(()=>{const x=store.DB().orders[order2.id];x.activatedAt=Date.now()-500;x.status='ACTIVE';});
 home=await run(a,'home');assert.equal(home.recentOrders[0].id,order2.id,'first used pass precedes unused pass');assert.equal(home.games.items[0].id,game.id);
 const post=(await run(b,'post.create',{title:'인기',body:'내용'})).post;await run(a,'react',{postId:post.id,value:1});
 let c=(await run(a,'comment.create',{postId:post.id,body:'내 댓글'})).comment;assert.ok(c);
 let page=await run(a,'me',{postCards:true,commentsOnly:true});assert.equal(page.comments.items[0].id,c.id);assert.equal(page.comments.items[0].postTitle,'인기');
 const commentScope=(await run(a2,'live',{scope:'me',query:{postCards:true,commentsOnly:true}})).scope;assert.equal(commentScope[0],c.id+'/'+c.revision);
 await run(a,'comment.edit',{id:c.id,body:'수정된 내 댓글',revision:c.revision});assert.notDeepEqual((await run(a2,'live',{scope:'me',query:{postCards:true,commentsOnly:true}})).scope,commentScope);
 home=await run(a,'home');assert.equal(home.popular[0].id,post.id);assert.equal(home.popular[0].author.id,pb.id);assert.equal(home.popular[0].author.points,undefined);assert.equal(store.ViewCount('post',post.id),0);
 await run(a,'follow.set',{id:pb.id,following:true});assert.equal((await run(a,'home')).popular[0].following,true);
 for(const audience of ['PRIVATE','FOLLOWING','PUBLIC']){const out=await run(a,'preferences.save',{profilePostsVisibility:audience,profilePostsPrivate:audience!=='PUBLIC'});assert.equal(out.preferences.profilePostsVisibility,audience);}
 await run(a,'block.set',{id:pb.id,blocked:true});assert.equal((await run(a,'home')).popular.length,0);assert.equal((await run(a,'mycomments')).total,0);
 const snapshot=JSON.parse(JSON.stringify(store.DB()));store.Import({memberHub:snapshot});assert.equal((await run(a2,'rewards')).wallet.points,store.ProfileById(pa.id).points);assert.equal((await run(a,'rewards')).history.total,4);
 const legacy=JSON.parse(JSON.stringify(store.DB()));delete legacy.pointLedger;delete legacy.eventSpins;store.Import({memberHub:legacy});assert.deepEqual(store.DB().pointLedger,{});assert.deepEqual(store.DB().eventSpins,{});
 console.log('FIX42 PASS: signed 3-device rewards/attendance, duplicate requests, approval carry, rollback, authoritative roulette, public home rankings, first-used pass, own comments, compatible privacy payloads and schema migration.');done=true;
}finally{for(const p of peers)p.close();await Promise.all(closed);await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
