'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-wallet-points-'));process.env.DATA_DIR=dir;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),rewards=require('../services/member/rewards');
const charges=require('../services/member/charges'),db=require('../storage/database'),lm=require('../license/licenseManager'),protocol=require('../services/member/protocol');
let sequence=0;
const run=(c,action,body={},id)=>hub.Execute(c,id||'POINTREQ'+String(++sequence).padStart(8,'0'),action,body);
const admin=(action,body)=>hub.AdminWrite(action,body,'POINT-TEST-ADMIN');
function client(id,key){
 const lines=[],c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(x){lines.push(x.trim());return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;
 return {c,lines};
}
function deposit(c,amount){const row=charges.Issue(s.Account(c)),scan=charges.Inspect('QRC1.'+row.id+'.'+row.token);return admin('charge.approve',{id:row.id,approvalToken:scan.approvalToken,mode:'WALLET',amount,memo:'테스트'});}
function signed(peer,action,body,id){
 const payload=Buffer.from(JSON.stringify(body)).toString('base64'),fields=[id,action,payload];
 peer.lines.length=0;hub.Handle(peer.c,['HUB',...fields,protocol.Sign(peer.c,'HUB',fields)].join('|'));
 const chunks=peer.lines.filter(x=>x.startsWith('HUB_CHUNK|')).map(x=>x.split('|')).sort((a,b)=>Number(a[3])-Number(b[3]));
 assert.ok(chunks.length);for(const x of chunks)assert.equal(x[6],protocol.Sign(peer.c,'HUB_RESPONSE',x.slice(1,6)));
 const result=JSON.parse(Buffer.from(chunks.map(x=>x[5]).join(''),'base64').toString());assert.equal(result.ok,true,JSON.stringify(result));return result.data;
}
const save=db.SaveDatabase,now=Date.now;
try{
 const a=client('1111111111111111','POINT-A'),a2=client('3333333333333333','POINT-A2'),b=client('2222222222222222','POINT-B');
 a2.c.installationDeviceKey=a.c.installationDeviceKey;
 const owner=run(a.c,'me').profile.id;run(b.c,'me');deposit(a.c,10000);
 let rules=rewards.Rules();assert.deepEqual(rules.pointExchange,{enabled:false,cashUnit:0,pointUnit:0});
 assert.throws(()=>run(a.c,'points.recharge',{revision:rules.revision,amount:200}),/UNKNOWN_ACTION/);
 assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision,amount:3}),/POINT_EXCHANGE_UNAVAILABLE/);
 assert.throws(()=>run(a.c,'rewards.save',{...rules,pointExchange:{enabled:true,cashUnit:1,pointUnit:999}}),/UNKNOWN_ACTION/);
 assert.throws(()=>admin('rewards.save',{...rules,pointExchange:{enabled:true,cashUnit:0,pointUnit:3}}),/AMOUNT_INVALID/);
 rules=admin('rewards.save',{...rules,attendanceDays:1,attendancePoints:12,pointExchange:{enabled:true,cashUnit:200,pointUnit:3}});
 assert.equal(run(a.c,'attendance.check').wallet.points,112,'12 attendance points plus the first charge and attendance title rewards');
 const before=JSON.stringify(s.DB());
 for(const amount of [0,-3,1.2,'3',Number.MAX_SAFE_INTEGER])assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision,amount}),/AMOUNT_INVALID/);
 assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision,amount:4}),/POINT_EXCHANGE_UNIT/);
 assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision-1,amount:3}),/CONTENT_CHANGED/);
 assert.throws(()=>run(b.c,'points.exchange',{revision:rules.revision,amount:3}),/INSUFFICIENT_POINTS/);
 assert.throws(()=>run(b.c,'points.exchange',{revision:rules.revision,amount:3,accountId:owner}),/INSUFFICIENT_POINTS/);
 assert.throws(()=>run(a.c,'points.recharge',{revision:rules.revision,amount:200}),/UNKNOWN_ACTION/);
 assert.equal(JSON.stringify(s.DB()),before,'invalid or removed requests do not change balances, history or retry receipts');
 db.SaveDatabase=()=>false;
 assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision,amount:6},'POINT-ROLLBACK-01'),/STORAGE_SAVE_FAILED/);
 db.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),before,'failed storage rolls back both wallets and histories');
 const spinCount=run(a.c,'rewards').wallet.spins;
 a2.lines.length=0;b.lines.length=0;
 const converted=signed(a,'points.exchange',{revision:rules.revision,amount:6},'POINT-ROLLBACK-01');
 assert.equal(converted.profile.balance,10400);assert.equal(converted.wallet.points,156);assert.equal(converted.wallet.spins,spinCount);
 assert.equal(converted.conversion.sourceAmount,6);assert.equal(converted.conversion.targetAmount,400);
 const point=converted.history.items.find(x=>x.id===converted.conversion.pointId);assert.equal(point.kind,'POINT_EXCHANGE');assert.equal(point.amount,-6);
 const payment=s.DB().ledger[converted.conversion.paymentId];assert.equal(payment.reference,converted.conversion.id);assert.equal(payment.amount,400);
 for(const peer of [a2,b]){const event=peer.lines.find(x=>x.startsWith('HUB_EVENT|'));assert.ok(event,'successful exchange broadcasts to other devices');const fields=event.split('|');assert.equal(fields.length,3,'notifications carry only revision and signature');assert.equal(fields[2],protocol.Sign(peer.c,'HUB_EVENT',[fields[1]]));}
 for(const profile of [run(b.c,'member',{id:owner}).profile,...run(b.c,'live',{profiles:[owner]}).profiles])for(const field of ['balance','points','eventSpins'])assert.equal(profile[field],undefined,'public profiles never expose '+field);
 const foreign=run(b.c,'rewards',{id:owner});assert.notEqual(foreign.profile.id,owner);assert.equal(foreign.wallet.points,0);assert.equal(foreign.profile.balance,0);assert.equal(foreign.history.total,0,'member identifiers cannot select another wallet');
 assert.equal(run(a2.c,'me').profile.balance,10400,'the second phone sees the authoritative exchanged wallet');
 assert.deepEqual(run(a2.c,'points.exchange',{revision:rules.revision,amount:6},'POINT-ROLLBACK-01'),converted,'same-account retry on a second phone exchanges once');
 assert.equal(run(a2.c,'rewards').history.total,5);
 assert.deepEqual(Object.values(s.DB().pointLedger).filter(row=>row.accountId===owner&&row.kind==='BADGE_REWARD').map(row=>[row.reference,row.amount]).sort(),[['ATTENDANCE_1',50],['POINT_EXCHANGE_1',50],['QR_CHARGE_1',50]],'charge, attendance and first exchange titles each pay once');
 assert.throws(()=>run(a2.c,'points.exchange',{revision:rules.revision,amount:3},'POINT-ROLLBACK-01'),/REQUEST_REUSED/);
 const exchange=run(a.c,'points.exchange',{revision:rules.revision,amount:6},'POINT-EXCHANGE-01');
 assert.equal(exchange.profile.balance,10800);assert.equal(exchange.wallet.points,150);assert.equal(exchange.wallet.spins,spinCount);
 assert.equal(exchange.conversion.cashAmount,400);assert.equal(exchange.conversion.pointAmount,-6);
 assert.deepEqual(run(a2.c,'points.exchange',{revision:rules.revision,amount:6},'POINT-EXCHANGE-01'),exchange);
 // An exact-integer overflow must not consume points or write either ledger.
 s.Atomic(()=>{s.ProfileById(owner).points=3;s.ProfileById(owner).balance=Number.MAX_SAFE_INTEGER-99;});const cap=JSON.stringify(s.DB());
 assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision,amount:3}),/BALANCE_INVALID/);assert.equal(JSON.stringify(s.DB()),cap);
 s.Atomic(()=>{s.ProfileById(owner).points=0;s.ProfileById(owner).balance=10800;});
 rules=admin('rewards.save',{...rules,pointExchange:{enabled:true,cashUnit:10000000,pointUnit:1}});
 assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision,amount:11}),/AMOUNT_INVALID/);
 rules=admin('rewards.save',{...rules,pointExchange:{enabled:false,cashUnit:200,pointUnit:3}});
 assert.throws(()=>run(a.c,'points.exchange',{revision:rules.revision,amount:3}),/POINT_EXCHANGE_UNAVAILABLE/);
 assert.equal(run(a.c,'me',{purchasesOnly:true}).payments.total,0,'deposits and points conversions are not game payments');
 const game=admin('product.save',{title:'게임',description:'게임 내용',accessType:'TYPE1',published:true,plans:[{days:3,price:200}]});
 const buy=()=>run(a.c,'purchase',{productId:game.id,days:3,price:200,revision:game.revision}).order;
 let clock=now();Date.now=()=>clock;
 const first=buy(),second=buy();
 let account=run(a.c,'me',{purchasesOnly:true});assert.equal(account.payments.total,2);assert.equal(account.payments.items[0].orderId,second.id);assert.equal(account.orders.total,1,'repeat purchases merge into one entitlement');assert.equal(account.orders.items[0].days,6);
 clock+=1000;const activation1=run(a.c,'order.activate',{orderId:first.id});clock+=1000;run(a.c,'order.activate',{orderId:second.id});
 assert.equal(run(a.c,'me').activeGame.id,second.id,'activated pass is exposed independently of summaries');
 clock+=1000;const reused=run(a.c,'order.activate',{orderId:first.id});
 assert.equal(reused.order.expiresAt,activation1.order.expiresAt,'reuse never extends validity');assert.equal(run(a.c,'me').activeGame.id,first.id);
 for(let i=0;i<5;i++){clock+=10;buy();}
 account=run(a.c,'me',{purchasesOnly:true});assert.equal(account.payments.total,7,'each purchase retains its receipt');assert.equal(account.orders.total,1,'merged duration remains a single entitlement');assert.equal(account.orders.items[0].days,21);assert.equal(run(a.c,'activity').items[0].id,first.id);
 const buyers=[];
 for(let i=0;i<6;i++){
  const peer=client('444444444444444'+i,'POINT-BUYER-'+i);clock+=10;deposit(peer.c,200);
  buyers.push(run(peer.c,'purchase',{productId:game.id,days:3,price:200,revision:game.revision}).order);
 }
 const activity=run(a.c,'activity');assert.equal(activity.total,7);assert.deepEqual(activity.items.slice(0,6).map(x=>x.id),buyers.slice().reverse().map(x=>x.id));assert.deepEqual(run(a.c,'activity',{offset:3,limit:3}).items.map(x=>x.id),activity.items.slice(3,6).map(x=>x.id),'full purchase activity supports independent pagination');
 const post=run(b.c,'post.create',{body:'',poll:{question:'선택',options:['하나','둘']}}).post;
 const popular=run(a.c,'popular');assert.equal(popular.items.find(x=>x.id===post.id).title,'');assert.equal(s.ViewCount('post',post.id),0,'ranking never counts a post view');
 const news=admin('news.save',{title:'소식',body:'본문',category:'NOTICE',published:true});
 run(a.c,'news');run(a.c,'catalog');assert.equal(s.ViewCount('news',news.id),0);assert.equal(s.ViewCount('product',game.id),0);
 assert.equal(run(a.c,'article',{id:news.id}).article.views,1);assert.equal(run(a.c,'product',{id:game.id}).product.views,1);
 run(a.c,'article',{id:news.id});run(a.c,'product',{id:game.id});assert.equal(s.ViewCount('news',news.id),1);assert.equal(s.ViewCount('product',game.id),1);
 const snapshot=JSON.parse(JSON.stringify(s.DB()));s.Import({memberHub:snapshot});assert.equal(run(a2.c,'rewards').history.total,8);assert.equal(run(a2.c,'me').orders.items.find(x=>x.id===first.id).lastUsedAt,reused.order.lastUsedAt);
 delete snapshot.settings.rewards.pointExchange;s.Import({memberHub:snapshot});assert.deepEqual(rewards.Rules().pointExchange,{enabled:false,cashUnit:0,pointUnit:0},'older settings migrate without enabling conversions');
 console.log('WALLET / POINTS PASS: activated entitlement and preserved purchase receipts, paginated purchase activity, explicit detail views, one-way configured points exchange, removed recharge, matching ledgers, limits, persistence rollback, retry idempotency and signed multi-device updates.');
}finally{Date.now=now;db.SaveDatabase=save;fs.rmSync(dir,{recursive:true,force:true});}
