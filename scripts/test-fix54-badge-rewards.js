'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix54-badge-rewards-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),lm=require('../license/licenseManager'),database=require('../storage/database'),badges=require('../services/member/badges');
let serial=0,now=1790000000000;const realNow=Date.now;Date.now=()=>now;
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX54-BADGE-DEVICE-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX54-BADGE-REQUEST-'+(++serial),action,body);
const account=c=>s.Account(c),award=(c,id)=>account(c).badgeProgress?.awards[id];
const ledger=c=>Object.values(s.DB().pointLedger).filter(row=>row.accountId===account(c).id&&row.kind==='BADGE_REWARD');
const read=c=>run(c,'badges'),snapshot=()=>JSON.stringify(s.DB());
function failedSave(fn){const before=snapshot(),save=database.SaveDatabase;try{database.SaveDatabase=()=>false;assert.throws(fn,/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}assert.equal(snapshot(),before,'a failed save rolls back awards, payments, activity and request receipts');}
try{
 const a=client(1),b=client(2),legacy=client(3),capped=client(4),failure=client(5),games=client(6);
 for(const c of [a,b,legacy,capped,failure,games])run(c,'me');
 const catalog=read(a).items;assert.equal(catalog.length,62);assert.equal(new Set(catalog.map(row=>row.id)).size,catalog.length);
 assert.ok(catalog.every(row=>Number.isSafeInteger(row.rewardPoints)&&row.rewardPoints>0),'every published title has a positive point award');
 assert.equal(ledger(a).length,0,'unearned titles do not pay');
 const postBody={body:'첫 칭호 포인트 확인'},first=run(a,'post.create',postBody,'FIX54-FIRST-POST');
 assert.equal(account(a).points,50);assert.equal(award(a,'POSTS_1').rewardPaid,true);assert.equal(ledger(a)[0].reference,'POSTS_1');
 assert.equal(award(a,'POSTS_1').rewardLedgerId,ledger(a)[0].id);
 const replayBefore=snapshot();run(a,'post.create',postBody,'FIX54-FIRST-POST');assert.equal(snapshot(),replayBefore);
 for(let i=0;i<4;i++)read(a);assert.equal(snapshot(),replayBefore,'repeated inventory reads neither pay nor increment revision');
 const target=run(b,'post.create',{body:'서로 다른 칭호 확인'}).post;
 run(a,'react',{postId:target.id,value:1},'FIX54-FIRST-LIKE');assert.equal(account(a).points,100);assert.equal(account(b).points,100);
 assert.equal(award(a,'LIKES_1').rewardPaid,true);assert.equal(award(b,'LIKED_1').rewardPaid,true,'the author receives their earned reward atomically with the reaction');
 run(a,'react',{postId:target.id,value:0});run(a,'react',{postId:target.id,value:1});assert.equal(account(a).points,100);assert.equal(ledger(a).length,2);
 run(a,'badge.select',{id:'POSTS_1'},'FIX54-SELECT-TITLE');run(a,'badge.select',{id:'POSTS_1'},'FIX54-SELECT-TITLE');assert.equal(account(a).points,100);
 run(a,'post.delete',{id:first.post.id});assert.equal(award(a,'POSTS_1').rewardPaid,true,'deletion never revokes a paid permanent title');
 // Existing durable awards are all backfilled, including both report titles.
 const earnedAt=now-86400000;
 s.Atomic(()=>{account(legacy).badgeProgress={version:1,counts:{},seen:{},awards:Object.fromEntries(catalog.map(row=>[row.id,{at:earnedAt,legacy:true}]))};});
 failedSave(()=>read(legacy));assert.equal(account(legacy).points||0,0);
 const restored=read(legacy),total=catalog.reduce((sum,row)=>sum+row.rewardPoints,0);
 assert.equal(account(legacy).points,total);assert.equal(ledger(legacy).length,catalog.length);assert.equal(restored.profile.points,total);
 assert.ok(restored.items.every(row=>row.earnedAt===earnedAt&&row.rewardPaid&&row.rewardStatus==='PAID'));
 assert.ok(['REPORT_1','REPORT_RECEIVED_1'].every(id=>ledger(legacy).some(row=>row.reference===id&&row.amount===50)));
 assert.ok(ledger(legacy).every(row=>s.DB().pointLedger[account(legacy).id+':BADGE_REWARD:'+row.reference]===row));
 const legacyBefore=snapshot();for(let i=0;i<4;i++)read(legacy);assert.equal(snapshot(),legacyBefore);
 // A persisted ledger is a second idempotency guard if an older award marker is missing.
 const paidId=award(legacy,'POSTS_1').rewardLedgerId;
 s.Atomic(()=>{const old=award(legacy,'POSTS_1');delete old.rewardPaid;delete old.rewardLedgerId;delete old.rewardPaidAt;});
 read(legacy);assert.equal(account(legacy).points,total);assert.equal(ledger(legacy).length,catalog.length);assert.equal(award(legacy,'POSTS_1').rewardLedgerId,paidId);
 const remote=run(b,'badges',{profileId:account(legacy).id});assert.equal(remote.readOnly,true);assert.equal(remote.items.length,catalog.length);
 for(const field of ['balance','points','inventory','eventSpins','subject','badgeProgress'])assert.equal(remote.profile[field],undefined);
 assert.ok(remote.items.every(row=>row.progress===undefined&&row.rewardPaid===undefined&&row.rewardStatus===undefined&&row.rewardPoints>0),'public titles do not reveal another wallet or payment state');
 // A capped point wallet defers rewards without blocking balance-funded play.
 s.Atomic(()=>{Object.assign(account(capped),{points:100000000,balance:50000,badgeProgress:{version:1,counts:{posts:1},seen:{},awards:{POSTS_1:{at:earnedAt}}}});});
 const pending=read(capped).items.find(row=>row.id==='POSTS_1');assert.equal(pending.rewardStatus,'PENDING');assert.equal(pending.rewardPaid,false);assert.equal(ledger(capped).length,0);
 const pendingBefore=snapshot();read(capped);assert.equal(snapshot(),pendingBefore,'unpayable rewards do not generate writes on every refresh');
 const arcadeBody={game:'ROULETTE',choice:'RED',amount:100,rulesRevision:run(capped,'arcade').rules.revision};
 const played=run(capped,'arcade.play',arcadeBody,'FIX54-CAPPED-GAME');assert.ok(played.result.id);assert.equal(played.wallet.points,100000000);assert.equal(award(capped,'ROULETTE_1').rewardPaid,false);
 assert.equal(ledger(capped).length,0);assert.equal(account(capped).arcade.ROULETTE.played,1);
 s.Atomic(()=>{require('../services/member/rewards').Credit(account(capped),-75,'FIX54_SPEND','FIRST');});
 failedSave(()=>read(capped));const partial=read(capped);assert.equal(account(capped).points,99999975);assert.equal(ledger(capped).length,1);
 assert.equal(partial.items.find(row=>row.id==='POSTS_1').rewardStatus,'PAID');assert.equal(partial.items.find(row=>row.id==='ROULETTE_1').rewardStatus,'PENDING');
 s.Atomic(()=>{require('../services/member/rewards').Credit(account(capped),-25,'FIX54_SPEND','SECOND');});
 let selectSaves=0;const originalSave=database.SaveDatabase;try{database.SaveDatabase=(...args)=>{selectSaves++;return originalSave(...args);};run(capped,'badge.select',{id:'ROULETTE_1'});}finally{database.SaveDatabase=originalSave;}
 assert.equal(selectSaves,1,'selecting a title and paying its pending reward uses one transaction, with no nested read save');assert.equal(account(capped).points,100000000);assert.equal(ledger(capped).length,2);
 const cappedBefore=snapshot(),oldPlay=run(capped,'arcade.play',arcadeBody,'FIX54-CAPPED-GAME');assert.equal(oldPlay.wallet.points,100000000);assert.equal(snapshot(),cappedBefore,'old play replay uses the current wallet without repaying titles');
 // New activity awards and their ledgers share the action's one save boundary.
 const bioBody={nickname:account(failure).nickname,bio:'원자적 칭호 지급 확인'};
 failedSave(()=>run(failure,'profile.save',bioBody,'FIX54-FAILED-BIO'));assert.equal(account(failure).badgeProgress,undefined);assert.equal(account(failure).points||0,0);
 run(failure,'profile.save',bioBody,'FIX54-FAILED-BIO');assert.equal(account(failure).points,100);assert.equal(ledger(failure).length,2);
 const failedActionBefore=snapshot();assert.throws(()=>run(failure,'post.create',{}),/INPUT_INVALID/);assert.equal(snapshot(),failedActionBefore);
 // All newly added game records participate in the common completed-play metrics.
 s.Atomic(()=>{account(games).casino=Object.fromEntries(['LIMBO','HILO','TOWER','BLACKJACK'].map(game=>[game,{played:1}]));});
 read(games);for(const game of ['LIMBO','HILO','TOWER','BLACKJACK'])assert.equal(award(games,game+'_1').rewardPaid,true);
 assert.equal(account(games).badgeProgress.counts.casinoPlays,4);assert.equal(account(games).points,200);
 // Public projections are pure; disk reload retains both payout guards.
 const pureBefore=snapshot();for(let i=0;i<10;i++)badges.Public(account(a));assert.equal(snapshot(),pureBefore);
 const exported=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(exported),true);
 const restartBefore=snapshot();read(legacy);read(capped);read(games);assert.equal(snapshot(),restartBefore);assert.equal(account(legacy).points,total);
 assert.equal(ledger(legacy).length,catalog.length);assert.equal(ledger(games).length,4);
 console.log('FIX54 BADGE REWARDS PASS: all published positive title rewards, atomic action/owner payments, permanent awards, once-only reads and replay, legacy backfill and ledger repair, cap deferral, rollback, new-game metrics, private wallet isolation and restart persistence.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
