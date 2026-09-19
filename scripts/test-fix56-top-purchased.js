'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix56-top-purchased-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),commerce=require('../services/member/commerce'),database=require('../storage/database'),lm=require('../license/licenseManager');
let serial=0,now=1790000000000;const realNow=Date.now;Date.now=()=>now;
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX56-TOP-PURCHASED-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX56-TOP-REQUEST-'+(++serial),action,body);
const account=c=>s.Account(c),read=c=>{run(c,'topgames');return require('../services/member/topGames').RankedPurchases();};
const product=(title,genre='레이싱')=>commerce.SaveProduct({title,description:'구매 요약 검증',genre,accessType:'TYPE1',published:true,plans:[{days:1,price:100},{days:7,price:700}]});
const buy=(c,game,days=1,id)=>run(c,'purchase',{productId:game.id,days,price:days*100,revision:game.revision},id);
const expected=(game,purchaseCount,totalDays)=>({id:game.id,title:game.title,genre:game.genre,purchaseCount,totalDays});
function failedSave(fn){const before=JSON.stringify(s.DB()),save=database.SaveDatabase;try{database.SaveDatabase=()=>false;assert.throws(fn,/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}assert.equal(JSON.stringify(s.DB()),before,'failed purchase leaves no receipt or duration extension');}
try{
 const a=client(5601),b=client(5602),viewer=client(5603),legacy=client(5604);
 for(const c of [a,b,viewer,legacy])s.Atomic(()=>s.Ledger(account(c),100000,'QR_TOPUP','FIX56-FUND-'+c.clientId));
 assert.deepEqual(read(viewer),[],'an empty marketplace never fabricates popular purchases');
 const g=product('동일 제목'),other=product('동일 제목','퍼즐'),tieA=product('가나다'),tieB=product('라마바사');
 const first=buy(a,g,1,'FIX56-FIRST-PAYMENT');buy(a,g,7,'FIX56-EXTEND-PAYMENT');
 assert.equal(run(a,'me').orders.total,1,'two purchases merge into one pass');
 buy(a,g,7,'FIX56-EXTEND-PAYMENT');
 assert.deepEqual(read(viewer),[expected(g,2,8)],'count immutable payment receipts, not merged orders or request retries');
 failedSave(()=>buy(a,g,1));assert.deepEqual(read(viewer),[expected(g,2,8)]);
 assert.throws(()=>buy(a,g,3650),/GAME_PLAN_UNAVAILABLE/);assert.deepEqual(read(viewer),[expected(g,2,8)]);
 // Private purchases contribute to anonymous totals without appearing as activity.
 run(b,'preferences.save',{purchaseActivityVisible:false});buy(b,g);
 run(a,'block.set',{id:account(b).id,blocked:true});
 assert.deepEqual(read(a),[expected(g,3,9)]);
 assert.equal(run(a,'activity').items.some(x=>x.member.id===account(b).id),false);
 for(const game of [other,tieA,tieB]){buy(a,game,game===other?7:1);buy(b,game,game===other?7:1);}
 const ties=[tieA,tieB].sort((x,y)=>x.id<y.id?-1:1);
 const ranked=[expected(g,3,9),expected(other,2,14),expected(ties[0],2,2),expected(ties[1],2,2)];
 assert.deepEqual(read(viewer),ranked,'purchase count leads, days break ties, product ID gives stable final ordering across the full ranking');
 assert.deepEqual(read(a),ranked,'ranking is global and unaffected by viewer relationships');
 const full=run(viewer,'topgames',{limit:2});
 assert.equal(full.total,4,'ranking details include all four purchased games');
 assert.equal(full.nextOffset,2);assert.deepEqual(full.items.map(x=>x.rank),[1,2]);
 assert.deepEqual(full.items.map(x=>x.id),ranked.slice(0,2).map(x=>x.id));
 const secondPage=run(viewer,'topgames',{offset:2,limit:2});
 assert.deepEqual(secondPage.items.map(x=>x.rank),[3,4]);assert.equal(secondPage.nextOffset,null);
 assert.equal(run(viewer,'topgames',{offset:999}).items.length,0);
 assert.deepEqual(Object.keys(full.items[0]).sort(),['genre','id','imageCover','rank','title']);
 const rankingDb=JSON.stringify(s.DB());run(viewer,'topgames');assert.equal(JSON.stringify(s.DB()),rankingDb);

 for(const row of read(viewer))assert.deepEqual(Object.keys(row).sort(),['genre','id','purchaseCount','title','totalDays'],'ranking aggregation contains only public product metadata and counts');
 // Historical completed use remains a sale; refunds remove all merged receipts.
 s.Atomic(()=>{s.DB().orders[first.order.id].status='EXPIRED';});
 assert.deepEqual(read(viewer),ranked,'expiry does not erase successful historical purchases');
 commerce.Refund({id:first.order.id,reason:'구매 요약 환불 검증'},'FIX56-TEST');
 assert.deepEqual(read(viewer),[expected(other,2,14),expected(ties[0],2,2),expected(ties[1],2,2),expected(g,1,1)]);
 s.Atomic(()=>{s.DB().products[other.id].published=false;s.DB().products[ties[0].id].deleted=true;});
 assert.deepEqual(read(viewer),[expected(ties[1],2,2),expected(g,1,1)],'deleted and unpublished products cannot occupy clickable summary rows');
 s.Atomic(()=>{s.DB().products[ties[1].id].published=false;s.DB().products[g.id].published=false;});
 assert.deepEqual(read(viewer),[]);
 // Old independent orders carry one unsnapshotted payment each. Ranking reads must
 // remain pure until the account's normal commerce migration merges the passes.
 const old=product('이전 구매 기록','아케이드');
 function oldOrder(id,days){const p=account(legacy),row={id,accountId:p.id,productId:old.id,title:old.title,accessType:'TYPE1',days,amount:days*100,status:'PAID',at:now,activatedAt:0,expiresAt:0,licenseKey:'',source:'WALLET_PURCHASE'};s.DB().orders[id]=row;s.Ledger(p,-row.amount,'PURCHASE',id);return row;}
 s.Atomic(()=>{oldOrder('ORD-FIX56-LEGACY-1',1);oldOrder('ORD-FIX56-LEGACY-7',7);});
 let before=JSON.stringify(s.DB());assert.deepEqual(read(viewer),[expected(old,2,8)]);assert.equal(JSON.stringify(s.DB()),before,'aggregate reading does not migrate another account or mutate their records');
 assert.equal(run(legacy,'me').orders.total,1);assert.deepEqual(read(viewer),[expected(old,2,8)],'legacy merge snapshots retain exact individual purchase durations');
 const alias=Object.values(s.DB().orders).find(x=>x.productId===old.id&&x.mergedInto);
 commerce.Refund({id:alias.id,reason:'합산 별칭 환불'},'FIX56-TEST');assert.deepEqual(read(viewer),[]);
 // Ignore nonpurchase, pending/cancelled/failed, orphan and cross-account entries.
 // These malformed historical rows are seeded directly because live commerce
 // never records a failed checkout as a PURCHASE wallet receipt.
 const invalid=product('무효 기록');
 function seed(id,status,extra={}){
  const p=account(b),row={id,accountId:p.id,productId:invalid.id,title:invalid.title,accessType:'TYPE1',days:1,amount:100,status,at:now,source:'WALLET_PURCHASE',...extra};
  s.DB().orders[id]=row;const payment=s.Ledger(p,-100,'PURCHASE',id);return {row,payment};
 }
 s.Atomic(()=>{
  for(const status of ['PENDING','FAILED','CANCELLED','CANCELED','REFUNDED'])seed('ORD-FIX56-'+status,status);
  seed('ORD-FIX56-QR','PAID',{source:'QR_CHARGE'});
  const orphan=seed('ORD-FIX56-ORPHAN','PAID');delete s.DB().orders[orphan.row.id];
  seed('ORD-FIX56-OTHER-ACCOUNT','PAID').payment.accountId=account(a).id;
  seed('ORD-FIX56-OTHER-PRODUCT','PAID').payment.productId=old.id;
  seed('ORD-FIX56-REFUNDED-AT','PAID',{refundedAt:now});
  seed('ORD-FIX56-VOID-PAYMENT','PAID').payment.status='CANCELLED';
  seed('ORD-FIX56-CYCLE-A','MERGED',{mergedInto:'ORD-FIX56-CYCLE-B'});
  seed('ORD-FIX56-CYCLE-B','MERGED',{mergedInto:'ORD-FIX56-CYCLE-A'});
  seed('ORD-FIX56-MISSING-PARENT','MERGED',{mergedInto:'ORD-MISSING'});
  seed('ORD-FIX56-DETACHED-MERGE','MERGED');
 });
 assert.deepEqual(read(viewer),[]);
 before=JSON.stringify(s.DB());for(let i=0;i<3;i++)assert.deepEqual(read(viewer),[]);assert.equal(JSON.stringify(s.DB()),before,'ranking refresh is read-only even with invalid legacy references');
 const persisted=product('재시작 후 구매 순위');buy(a,persisted,7);
 const afterRestart=[expected(persisted,1,7)];assert.deepEqual(read(viewer),afterRestart);
 const exported=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(exported),true);assert.deepEqual(read(viewer),afterRestart,'ranking uses persisted receipts and refund state after reload');
 viewer.biometricVerified=false;assert.throws(()=>read(viewer),/MEMBER_AUTH_REQUIRED/);assert.throws(()=>run(viewer,'topgames'),/MEMBER_AUTH_REQUIRED/);
 console.log('FIX56 TOP PURCHASED PASS: authenticated complete global ranking, stable ties, payment/merged-duration counting, retries, rollback, aggregate privacy, available products, expiry, refunds and aliases, legacy read purity, invalid receipt filtering and reload.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
