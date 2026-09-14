'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix57-point-summary-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),rewards=require('../services/member/rewards'),database=require('../storage/database'),lm=require('../license/licenseManager');
let sequence=0,now=1790000000000;const realNow=Date.now;Date.now=()=>now;
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX57-POINT-SUMMARY-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX57-POINT-REQUEST-'+(++sequence),action,body);
const account=c=>s.Account(c),read=(c,body={})=>run(c,'home',body).recentPointCredits;
const projected=row=>({id:row.id,kind:row.kind,amount:row.amount,at:row.at});
const credit=(c,amount,kind,reference)=>s.Atomic(()=>rewards.Credit(account(c),amount,kind,reference));
try{
 const a=client(5701),b=client(5702),empty=client(5703),active=client(5704);
 for(const c of [a,b,empty,active])run(c,'home');
 assert.deepEqual(read(a),[],'a new account has no fabricated point accruals');
 const first=credit(a,100,'ATTENDANCE','FIRST');now+=1000;
 const wheel=credit(a,20,'ROULETTE','WHEEL');now+=1000;
 const badge=credit(a,50,'BADGE_REWARD','POSTS_1');now+=1000;
 const restored=credit(a,10,'POINT_EXCHANGE_REVERSE','RESTORED');
 const expected=[restored,badge,wheel].map(projected);
 assert.deepEqual(read(a),expected,'the latest three positive committed credits lead regardless of reward kind');
 // A stream of newer expenditures or another account's credits must not crowd
 // this member's older earnings out of the three preview positions.
 for(let i=0;i<6;i++){
  now+=1000;credit(a,-1,i%2?'SHOP_PURCHASE':'POINT_EXCHANGE','SPEND-'+i);
  credit(b,5,'EVENT_CARD','OTHER-'+i);
 }
 now+=1000;credit(a,0,'EVENT_RPS','ZERO');
 assert.deepEqual(read(a),expected,'own-account and positive-amount filters run before the three-row limit');
 assert.deepEqual(read(empty,{accountId:account(a).id,id:account(a).id,profileId:account(a).id,offset:100,limit:100}),[],'request identifiers and pagination cannot select another wallet');
 assert.deepEqual(read(a,{accountId:account(b).id,offset:100,limit:1}),expected,'the summary is an authenticated fixed-size projection');
 for(const row of read(a))assert.deepEqual(Object.keys(row).sort(),['amount','at','id','kind'],'summary rows contain no balance, private account or ledger reference');
 let before=JSON.stringify(s.DB());
 for(let i=0;i<3;i++)assert.deepEqual(read(a),expected);
 const detached=read(a);detached[0].amount=999999;detached[0].kind='CHANGED';detached.pop();
 assert.equal(JSON.stringify(s.DB()),before,'refreshes and edits to response objects never mutate the source ledger');
 assert.deepEqual(read(a),expected);
 // Exact timestamp ties are deliberately inserted in the opposite order from
 // their receipt IDs, so results do not depend on object insertion order.
 now+=1000;
 const tied=[];
 for(const [id,kind] of [['PNT-FIX57-A','EVENT_CARD'],['PNT-FIX57-C','EVENT_CHEST'],['PNT-FIX57-B','EVENT_RPS']]){
  const row=credit(a,5,kind,id);s.Atomic(()=>{row.id=id;});tied.push(row);
 }
 const ranked=[tied[1],tied[2],tied[0]].map(projected);
 assert.deepEqual(read(a),ranked,'descending receipt IDs give stable ordering for equal timestamps');
 // A title awarded by a counted detail read is visible on the next home read.
 // badges.AfterRead intentionally handles detail actions, not home refreshes.
 now+=1000;
 const detail=run(active,'member',{id:account(b).id,countView:true});
 assert.equal(detail.wallet.points,50);
 const title=Object.values(s.DB().pointLedger).find(row=>row.accountId===account(active).id&&row.kind==='BADGE_REWARD');
 assert.equal(title.reference,'PROFILE_VISIT_1');assert.deepEqual(read(active),[projected(title)]);
 const eventBody=game=>({game,choice:0,day:rewards.Day(now),revision:rewards.Rules().revision});
 now+=1000;const firstBody=eventBody('CARD'),card=run(active,'event.play',firstBody,'FIX57-POINT-CARD');
 now+=1000;const chest=run(active,'event.play',eventBody('CHEST'));
 now+=1000;const rps=run(active,'event.play',eventBody('RPS'));
 const events=[rps.reward,chest.reward,card.reward].map(projected);
 assert.deepEqual(read(active),events,'actual server event rewards appear without a client-side accrual calculation');
 before=JSON.stringify(s.DB());
 assert.deepEqual(run(active,'event.play',firstBody,'FIX57-POINT-CARD').reward,card.reward);
 assert.deepEqual(read(active),events,'replaying an older reward keeps the current home ordering');
 assert.equal(JSON.stringify(s.DB()),before,'replaying a completed reward never duplicates accruals');
 const exported=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(exported),true);
 before=JSON.stringify(s.DB());
 assert.deepEqual(read(a),ranked);assert.deepEqual(read(active),events);assert.deepEqual(read(empty),[]);
 assert.deepEqual(run(active,'event.play',firstBody,'FIX57-POINT-CARD').reward,card.reward);
 assert.equal(JSON.stringify(s.DB()),before,'persisted ledgers and operation retries retain the same summary after restart');
 a.biometricVerified=false;assert.throws(()=>read(a),/MEMBER_AUTH_REQUIRED/);
 assert.equal(first.amount,100,'the preview never rewrites older receipts');
 console.log('FIX57 POINT SUMMARY PASS: authenticated own-account positive credits, filter before three-row limit, debit and foreign-wallet exclusion, minimal detached projection, stable ties, detail-earned title freshness, actual daily event rewards, read purity, retry and restart.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
