'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const restarting=process.argv[2]==='--restart',temp=restarting?process.env.DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix59-notices-passes-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),commerce=require('../services/member/commerce'),database=require('../storage/database'),lm=require('../license/licenseManager');
const DAY=86400000,realNow=Date.now;let now=1790000000000,sequence=0;Date.now=()=>now;
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX59-NOTICE-PASS-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX59-NOTICE-PASS-REQUEST-'+(++sequence),action,body),own=c=>s.Account(c),snapshot=()=>JSON.stringify(s.DB());
const ids=result=>result.activeGames.map(x=>x.id),noticeIds=result=>result.items.map(x=>x.id);
const receipt=(c,id)=>JSON.stringify(s.DB().operations[own(c).id+':'+id].result);
function restart(){
 const expected=JSON.parse(fs.readFileSync(path.join(temp,'fix59-expected.json'),'utf8'));now=expected.now;database.LoadDatabase();
 const a=client(59001),empty=client(59003),game=client(59004);
 assert.deepEqual(noticeIds(run(a,'notifications')),expected.notifications);assert.equal(run(empty,'notifications').total,0);
 assert.deepEqual(ids(run(game,'live')),expected.activeIds,'every active game survives a fresh Node process');
 assert.equal(receipt(a,'FIX59-CLEAR-ONE'),expected.clearReceipt);
 const before=snapshot();assert.deepEqual(noticeIds(run(a,'notifications.clear',{confirmed:true},'FIX59-CLEAR-ONE')),expected.notifications);assert.equal(snapshot(),before,'replay after restart cannot dismiss newer notifications');
 const purchase=run(game,'purchase',expected.purchaseBody,'FIX59-PURCHASE-ONE');
 assert.deepEqual(ids(purchase),expected.activeIds);assert.deepEqual(purchase.order,expected.purchaseOrder);assert.equal(receipt(game,'FIX59-PURCHASE-ONE'),expected.purchaseReceipt);
 console.log('FIX59 notification/pass fresh-process restart checks passed');
}
try{
 if(restarting){restart();}
 else{
  const a=client(59001),b=client(59002),empty=client(59003),game=client(59004),remote=client(59005);
  for(const c of [a,b,empty,game,remote])run(c,'me');
  const aId=own(a).id,bId=own(b).id;
  s.Atomic(()=>{
   for(let i=0;i<27;i++){const id='NOTICE-'+i;s.DB().news[id]={id,title:'안내 '+i,body:'공개 안내 본문',published:true,category:'NOTICE',at:now-i,publishAt:0};}
   s.DB().news['PRIVATE-B']={id:'PRIVATE-B',title:'다른 회원의 비공개 안내',body:'SECRET-B',published:true,category:'NOTICE',audience:bId,at:now};
   s.DB().news.FUTURE={id:'FUTURE',title:'예약 안내',published:true,category:'NOTICE',at:now,publishAt:now+100};
   s.DB().pointLedger.POINTS={id:'POINTS',accountId:aId,kind:'ATTENDANCE',amount:125,at:now-1};own(a).points=125;
   s.DB().ledger.PAYMENT={id:'PAYMENT',accountId:aId,kind:'QR_TOPUP',amount:500,balance:500,reference:'TEST-TOPUP',at:now-1};own(a).balance=500;
  });
  run(a,'badges');
  const baseline=snapshot(),initial=run(a,'notifications');assert.equal(initial.total,29);assert.equal(initial.items.length,20);assert.equal(initial.nextOffset,20);assert.equal(snapshot(),baseline,'inbox reads are pure');
  assert.ok(!JSON.stringify(initial).includes('SECRET-B'));assert.equal(run(a,'notifications',{accountId:bId}).total,initial.total);
  const points=JSON.stringify(s.DB().pointLedger),wallet=JSON.stringify(s.DB().ledger),news=JSON.stringify(s.DB().news),otherBefore=noticeIds(run(b,'notifications'));
  for(const action of ['notifications','notifications.clear','live','me','menu']){a.biometricVerified=false;assert.throws(()=>run(a,action,{confirmed:true}),/MEMBER_AUTH_REQUIRED/);a.biometricVerified=true;}
  for(const confirmed of [false,undefined,1,'true'])assert.throws(()=>run(a,'notifications.clear',{confirmed}),/INPUT_INVALID/);
  let before=snapshot();const save=database.SaveDatabase;database.SaveDatabase=()=>false;
  try{assert.throws(()=>run(a,'notifications.clear',{confirmed:true},'FIX59-CLEAR-FAIL'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
  assert.equal(snapshot(),before,'save failure rolls back dismissal and operation receipt');
  const first=run(a,'notifications.clear',{confirmed:true},'FIX59-CLEAR-ONE');assert.equal(first.cleared,true);assert.equal(first.total,0);assert.deepEqual(first.items,[]);assert.equal(first.nextOffset,null);
  assert.equal(JSON.stringify(s.DB().pointLedger),points,'clearing the inbox never removes point history or rewards');assert.equal(own(a).points,125);
  assert.equal(JSON.stringify(s.DB().ledger),wallet);assert.equal(JSON.stringify(s.DB().news),news);assert.deepEqual(noticeIds(run(b,'notifications')),otherBefore,'one member cannot clear anyone else’s inbox');
  const clearReceipt=receipt(a,'FIX59-CLEAR-ONE');
  s.Atomic(()=>{s.DB().news.SAME_MS={id:'SAME_MS',title:'같은 밀리초의 새 알림',published:true,category:'NOTICE',at:now};});
  assert.deepEqual(noticeIds(run(a,'notifications')),['news:SAME_MS'],'a distinct event committed in the clear millisecond remains visible');
  now+=100;assert.deepEqual(noticeIds(run(a,'notifications')),['news:FUTURE','news:SAME_MS'],'scheduled news is visible only when its publish time arrives');
  before=snapshot();assert.deepEqual(noticeIds(run(a,'notifications.clear',{confirmed:true},'FIX59-CLEAR-ONE')),['news:FUTURE','news:SAME_MS']);assert.equal(snapshot(),before);assert.equal(receipt(a,'FIX59-CLEAR-ONE'),clearReceipt,'clear retry does not dismiss later arrivals or rewrite its receipt');
  assert.throws(()=>run(a,'notifications.clear',{confirmed:true,accountId:bId},'FIX59-CLEAR-ONE'),/REQUEST_REUSED/);
  run(empty,'notifications.clear',{confirmed:true},'FIX59-CLEAR-EMPTY');assert.equal(run(empty,'notifications').total,0);run(empty,'notifications.clear',{confirmed:true},'FIX59-CLEAR-EMPTY');
  // Purchase and activate distinct products through the actual authenticated API.
  s.Atomic(()=>{s.Ledger(own(game),10000,'TOPUP','PASS-FUND');s.Ledger(own(remote),10000,'TOPUP','PASS-FUND');});
  const product=title=>hub.AdminWrite('product.save',{title,description:'다중 이용권 검증',genre:'레이싱',accessType:'TYPE1',plans:[{days:1,price:100},{days:7,price:700}],published:true},'FIX59-TEST');
  const one=product('첫 번째 게임'),two=product('두 번째 게임'),unusedGame=product('미사용 게임'),refundedGame=product('환불 게임');
  const purchaseBody={productId:one.id,days:1,price:100,revision:one.revision};
  const bought=run(game,'purchase',purchaseBody,'FIX59-PURCHASE-ONE'),purchaseOrder=structuredClone(bought.order),purchaseReceipt=receipt(game,'FIX59-PURCHASE-ONE');
  assert.deepEqual(bought.activeGames,[]);const id1=bought.order.id;
  now++;const activated=run(game,'order.activate',{orderId:id1},'FIX59-ACTIVATE-ONE');assert.deepEqual(ids(activated),[id1]);
  const activationOrder=structuredClone(activated.order),activationReceipt=receipt(game,'FIX59-ACTIVATE-ONE');
  const buy=(c,item,days=1)=>run(c,'purchase',{productId:item.id,days,price:days*100,revision:item.revision});
  const id2=buy(game,two).order.id;now++;run(game,'order.activate',{orderId:id2});
  const remoteId=buy(remote,one).order.id;run(remote,'order.activate',{orderId:remoteId});
  const unused=buy(game,unusedGame).order.id,refundable=buy(game,refundedGame).order.id;hub.AdminWrite('order.refund',{id:refundable,reason:'미사용 환불 검증'},'FIX59-TEST');
  s.Atomic(()=>{
   const source=s.DB().orders[id1];
   s.DB().orders.MERGED={...source,id:'MERGED',status:'MERGED',mergedInto:id1};
   s.DB().orders.EXPIRED={...source,id:'EXPIRED',productId:'EXPIRED-PRODUCT',expiresAt:now};
   s.DB().orders.DETACHED_MERGED={...source,id:'DETACHED_MERGED',productId:'DETACHED-PRODUCT',status:'MERGED'};
   s.DB().orders.NOT_ACTIVATED={...source,id:'NOT_ACTIVATED',productId:'NOT-ACTIVATED-PRODUCT',activatedAt:0};
   s.DB().orders.REFUNDED={...source,id:'REFUNDED',productId:'REFUNDED-PRODUCT',status:'REFUNDED'};
  });
  const activeIds=[id1,id2];
  before=snapshot();const live=run(game,'live',{accountId:own(remote).id});assert.deepEqual(ids(live),activeIds);assert.equal(snapshot(),before,'active-game projections never normalize or write during live reads');
  for(const view of ['me','live']){
   const value=run(game,view);assert.deepEqual(ids(value),activeIds,view+' includes all own active passes');assert.equal(value.activeGame.id,id2,'legacy singular field keeps the last-used pass');
   for(const row of value.activeGames){assert.equal(row.genre,'레이싱');for(const key of ['licenseKey','accountId','subject','amount'])assert.equal(row[key],undefined);}
   for(const excluded of [remoteId,unused,refundable,'MERGED','EXPIRED','DETACHED_MERGED','NOT_ACTIVATED','REFUNDED'])assert.ok(!ids(value).includes(excluded));
  }
  assert.deepEqual(ids(run(remote,'live')),[remoteId]);assert.deepEqual(commerce.ActiveGames({...own(game),blocked:true}),[]);
  const paymentSnapshot=JSON.stringify(commerce.PurchasePayments(own(game))),oldExpiry=s.DB().orders[id1].expiresAt;
  const extension=buy(game,one,7);assert.equal(extension.order.id,id1);assert.equal(extension.order.expiresAt,oldExpiry+7*DAY);assert.deepEqual(ids(extension),activeIds);
  const oldPayments=JSON.parse(paymentSnapshot);for(const payment of oldPayments)assert.deepEqual(commerce.PurchasePayments(own(game)).find(x=>x.id===payment.id),payment,'extending a pass never rewrites historical receipt terms');
  before=snapshot();const replay=run(game,'purchase',purchaseBody,'FIX59-PURCHASE-ONE');assert.deepEqual(replay.order,purchaseOrder);assert.deepEqual(ids(replay),activeIds);assert.equal(replay.activeGames[0].expiresAt,oldExpiry+7*DAY);assert.equal(replay.profile.balance,own(game).balance);assert.equal(receipt(game,'FIX59-PURCHASE-ONE'),purchaseReceipt);assert.equal(snapshot(),before);
  const activateReplay=run(game,'order.activate',{orderId:id1},'FIX59-ACTIVATE-ONE');assert.deepEqual(activateReplay.order,activationOrder);assert.deepEqual(ids(activateReplay),activeIds);assert.equal(activateReplay.activeGame.id,id2);assert.equal(receipt(game,'FIX59-ACTIVATE-ONE'),activationReceipt);
  before=snapshot();assert.throws(()=>run(remote,'order.activate',{orderId:id1}),/ORDER_NOT_FOUND/);assert.equal(snapshot(),before);
  database.SaveDatabase=()=>false;try{assert.throws(()=>run(game,'order.activate',{orderId:unused},'FIX59-ACTIVATE-FAIL'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
  assert.equal(snapshot(),before,'failed activation restores pass state, current selection and receipt');assert.deepEqual(ids(run(game,'live')),activeIds);
  const at=now;now=s.DB().orders[id2].expiresAt;assert.deepEqual(ids(run(game,'live')),[id1]);now=s.DB().orders[id1].expiresAt;assert.deepEqual(ids(run(game,'live')),[]);assert.equal(run(game,'live').activeGame,null);now=at;
  assert.equal(database.SaveDatabase(),true);
  fs.writeFileSync(path.join(temp,'fix59-expected.json'),JSON.stringify({now,notifications:noticeIds(run(a,'notifications')),activeIds,clearReceipt,purchaseBody,purchaseOrder,purchaseReceipt}));
  const child=spawnSync(process.execPath,[__filename,'--restart'],{env:{...process.env,DATA_DIR:temp},encoding:'utf8',timeout:30000});assert.equal(child.status,0,(child.stdout||'')+(child.stderr||''));
  console.log('FIX59 NOTIFICATIONS/PASSES PASS: authenticated private clear, all pages, point-ledger preservation, same-millisecond/future arrivals, idempotent replay, failed-save rollback, simultaneous distinct passes, immutable purchase/activation receipts, expiry, fresh-process restart.');
 }
}finally{Date.now=realNow;if(!restarting)fs.rmSync(temp,{recursive:true,force:true});}
