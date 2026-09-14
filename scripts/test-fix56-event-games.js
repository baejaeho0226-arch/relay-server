'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix56-event-games-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),lm=require('../license/licenseManager'),database=require('../storage/database'),rewards=require('../services/member/rewards');
let serial=0,clientSerial=0,now=Date.parse('2026-09-14T14:59:58Z');const realNow=Date.now;Date.now=()=>now;
function client(){
 const n=++clientSerial,id=String(n).padStart(16,'0'),key='FIX56-EVENT-DEVICE-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;s.Account(c);return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX56-EVENT-REQUEST-'+(++serial),action,body);
const account=c=>s.Account(c),snapshot=()=>JSON.stringify(s.DB());
const request=(game='CARD',choice=0)=>({game,choice,day:rewards.Day(now),revision:rewards.Rules().revision});
const read=c=>run(c,'rewards'),game=(data,id)=>data.eventGames.games.find(row=>row.game===id);
const ledger=c=>Object.values(s.DB().pointLedger).filter(row=>row.accountId===account(c).id&&/^EVENT_(CARD|CHEST|RPS)$/.test(row.kind));
function unchanged(fn,error){const before=snapshot();assert.throws(fn,error);assert.equal(snapshot(),before,'failed event requests leave wallet, turns, results, ledger, badges and idempotency receipts unchanged');}
function draw(n,fn){const real=crypto.randomInt;try{crypto.randomInt=max=>{assert.ok(n>=0&&n<max);return n;};return fn();}finally{crypto.randomInt=real;}}
function balanceMatchesLedger(c){assert.equal(account(c).points,Object.values(s.DB().pointLedger).filter(row=>row.accountId===account(c).id).reduce((sum,row)=>sum+row.amount,0));}
try{
 const a=client(),b=client(),failure=client(),capped=client(),locked=client();
 const initial=read(a);assert.equal(initial.eventGames.day,'2026-09-14');assert.equal(initial.eventGames.enabled,true);
 assert.deepEqual(initial.eventGames.games.map(row=>[row.game,row.choices]),[['CARD',6],['CHEST',3],['RPS',3]]);
 assert.ok(initial.eventGames.games.every(row=>!row.played&&row.available&&row.totalPlayed===0&&row.lastResult===null));
 assert.deepEqual(initial.eventGames.rules,{playsPerDay:1,card:[{points:5,weight:45},{points:10,weight:30},{points:20,weight:20},{points:50,weight:5}],chest:[{points:5,weight:50},{points:15,weight:35},{points:40,weight:15}],rps:{win:30,draw:10,lose:5}});
 // Read projections cannot write daily markers or expose another member's data.
 const pureBefore=snapshot();read(a);read(b);assert.equal(snapshot(),pureBefore);
 account(a).balance=13579;account(a).eventSpins=7;
 const body={...request('CARD',5),_wire:'zlib',_delta:true},id='FIX56-IMMUTABLE-CARD';
 const first=draw(95,()=>run(a,'event.play',body,id)),receipt=structuredClone(first.eventGame),rewardReceipt=structuredClone(first.reward);
 assert.equal(receipt.points,50);assert.equal(receipt.choice,5);assert.equal(first.reward.kind,'EVENT_CARD');assert.equal(first.reward.reference,'2026-09-14');
 assert.equal(game(first,'CARD').played,true);assert.equal(game(first,'CARD').available,false);assert.equal(game(first,'CARD').totalPlayed,1);assert.deepEqual(game(first,'CARD').lastResult,receipt);
 assert.equal(first.wallet.spins,7);assert.equal(account(a).eventSpins,7);assert.equal(account(a).balance,13579);balanceMatchesLedger(a);
 let before=snapshot();const replay=run(a,'event.play',body,id);assert.deepEqual(replay.eventGame,receipt);assert.deepEqual(replay.reward,rewardReceipt);assert.equal(snapshot(),before);
 unchanged(()=>run(a,'event.play',request('CARD',0)),/EVENT_ALREADY_PLAYED/);
 unchanged(()=>run(a,'event.play',{...body,choice:4},id),/REQUEST_REUSED/);
 const second=draw(50,()=>run(a,'event.play',request('CHEST',2)));assert.equal(second.eventGame.points,15);assert.equal(second.reward.kind,'EVENT_CHEST');
 const third=draw(0,()=>run(a,'event.play',request('RPS',1)));assert.equal(third.eventGame.outcome,'WIN');assert.equal(third.eventGame.opponent,0);assert.equal(third.eventGame.points,30);
 assert.equal(ledger(a).length,3);assert.equal(account(a).eventSpins,7);assert.equal(account(a).balance,13579);balanceMatchesLedger(a);
 const ownNotifications=run(a,'notifications').items,otherNotifications=run(b,'notifications').items;
 for(const row of ledger(a)){
  const notification=ownNotifications.find(item=>item.id==='points:'+row.id);assert.ok(notification);assert.equal(notification.target,'points');assert.equal(notification.body,'+'+row.amount+'P');
  assert.equal(otherNotifications.some(item=>item.id==='points:'+row.id),false);
 }
 for(const route of ['event.card','event.chest','event.rps'])assert.equal(run(a,'history.record',{route}).recorded,true);
 assert.deepEqual(run(a,'history').recentServices.slice(0,3).map(row=>row.route),['event.rps','event.chest','event.card']);assert.equal(run(b,'history').recentServices.length,0);
 assert.ok(read(b).eventGames.games.every(row=>!row.played&&row.lastResult===null));assert.equal(ledger(b).length,0);
 const remote=run(b,'member',{id:account(a).id});assert.equal(remote.profile.eventGames,undefined);assert.equal(remote.profile.points,undefined);
 // Local midnight is UTC 15:00, not the server's UTC date boundary.
 now=Date.parse('2026-09-14T15:00:00Z');const tomorrow=read(a);assert.equal(tomorrow.eventGames.day,'2026-09-15');assert.ok(tomorrow.eventGames.games.every(row=>!row.played&&row.available));assert.deepEqual(game(tomorrow,'CARD').lastResult,receipt);
 unchanged(()=>run(a,'event.play',body,'FIX56-STALE-DAY'),/CONTENT_CHANGED/);
 const next=draw(0,()=>run(a,'event.play',request('CARD',0)));assert.equal(next.eventGame.day,'2026-09-15');assert.equal(game(next,'CARD').totalPlayed,2);
 before=snapshot();const old=run(a,'event.play',body,id);assert.deepEqual(old.eventGame,receipt);assert.deepEqual(old.reward,rewardReceipt);assert.equal(old.wallet.points,account(a).points);assert.equal(old.eventGames.day,'2026-09-15');assert.deepEqual(game(old,'CARD').lastResult,next.eventGame);assert.equal(game(old,'CARD').available,false);assert.equal(snapshot(),before);
 // Exact finite random bounds and all three outcome relations run through the real service.
 for(const [value,points] of [[0,5],[44,5],[45,10],[74,10],[75,20],[94,20],[95,50],[99,50]]){
  const c=client();assert.equal(draw(value,()=>run(c,'event.play',request('CARD',value%6))).eventGame.points,points);
 }
 for(const [value,points] of [[0,5],[49,5],[50,15],[84,15],[85,40],[99,40]]){
  const c=client();assert.equal(draw(value,()=>run(c,'event.play',request('CHEST',value%3))).eventGame.points,points);
 }
 const outcomes=[['DRAW','LOSE','WIN'],['WIN','DRAW','LOSE'],['LOSE','WIN','DRAW']];
 for(let choice=0;choice<3;choice++)for(let opponent=0;opponent<3;opponent++){
  const c=client(),result=draw(opponent,()=>run(c,'event.play',request('RPS',choice))).eventGame;
  assert.equal(result.opponent,opponent);assert.equal(result.outcome,outcomes[choice][opponent]);assert.equal(result.points,{WIN:30,DRAW:10,LOSE:5}[result.outcome]);
 }
 for(const invalid of [null,[],{},request('DICE'),request('card'),request('CARD',-1),request('CARD',6),request('CHEST',3),request('RPS',3),request('CARD',0.5),request('CARD','0'),{...request(),day:'today'},{...request(),revision:'1'},{...request(),revision:0},{...request(),points:99999},{...request(),opponent:0},{...request(),accountId:account(a).id},{...request(),_wire:'plain'},{...request(),_delta:'true'}])unchanged(()=>run(b,'event.play',invalid),/INPUT_INVALID/);
 unchanged(()=>run(b,'event.play',{...request(),revision:999}),/CONTENT_CHANGED/);
 unchanged(()=>run(b,'event.play',request(),'bad'),/REQUEST_ID_INVALID/);
 // Authentication and global rewards controls apply to the same mutation entry point.
 locked.biometricVerified=false;unchanged(()=>run(locked,'event.play',request()),/MEMBER_AUTH_REQUIRED/);locked.biometricVerified=true;
 locked.licenseAuthorized=false;unchanged(()=>run(locked,'event.play',request()),/MEMBER_AUTH_REQUIRED/);locked.licenseAuthorized=true;
 account(locked).blocked=true;unchanged(()=>run(locked,'event.play',request()),/ACCOUNT_BLOCKED/);account(locked).blocked=false;
 state.serviceEnabled=false;unchanged(()=>run(locked,'event.play',request()),/SERVICE_DISABLED/);state.serviceEnabled=true;
 rewards.SaveRules({...rewards.Rules(),enabled:false},'FIX56-TEST');assert.ok(read(b).eventGames.games.every(row=>!row.available));unchanged(()=>run(b,'event.play',request()),/EVENT_CLOSED/);
 before=snapshot();const closedReplay=run(a,'event.play',body,id);assert.deepEqual(closedReplay.eventGame,receipt);assert.equal(closedReplay.eventGames.enabled,false);assert.equal(closedReplay.rules.revision,rewards.Rules().revision);assert.equal(snapshot(),before);
 rewards.SaveRules({...rewards.Rules(),enabled:true},'FIX56-TEST');
 // A failed save/cap may not consume the free play, and the identical request may retry.
 const retryBody=request('CHEST',1),retryId='FIX56-SAVE-RETRY',save=database.SaveDatabase;
 try{database.SaveDatabase=()=>false;unchanged(()=>draw(85,()=>run(failure,'event.play',retryBody,retryId)),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(account(failure).eventGames,undefined);assert.equal(ledger(failure).length,0);
 const retried=draw(85,()=>run(failure,'event.play',retryBody,retryId));assert.equal(retried.eventGame.points,40);assert.equal(game(retried,'CHEST').played,true);assert.equal(ledger(failure).length,1);
 account(capped).points=100000000;unchanged(()=>run(capped,'event.play',request('CARD')),/POINT_BALANCE_INVALID/);assert.equal(account(capped).eventGames,undefined);assert.equal(ledger(capped).length,0);
 for(const [name,max] of [['CARD',50],['CHEST',40],['RPS',30]]){
  account(capped).points=100000000-max+1;
  for(const imaginedDraw of [0,99]){
   const random=crypto.randomInt;let randomCalls=0;
   try{crypto.randomInt=()=>{randomCalls++;return imaginedDraw;};unchanged(()=>run(capped,'event.play',request(name)),/POINT_BALANCE_INVALID/);}finally{crypto.randomInt=random;}
   assert.equal(randomCalls,0,'point capacity rejects before any draw, independently of a low or high outcome');
  }
 }
 account(capped).points=100000000-50;const exactCapacity=draw(95,()=>run(capped,'event.play',request('CARD')));assert.equal(exactCapacity.eventGame.points,50);assert.equal(account(capped).points,100000000);
 // Full database export/import exercises the same durable account and operation format as restart.
 const exported=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(exported),true);
 before=snapshot();const restarted=run(a,'event.play',body,id);assert.deepEqual(restarted.eventGame,receipt);assert.deepEqual(restarted.reward,rewardReceipt);assert.equal(restarted.wallet.points,account(a).points);assert.equal(game(restarted,'CARD').totalPlayed,2);assert.equal(snapshot(),before);
 unchanged(()=>run(a,'event.play',request('CARD')),/EVENT_ALREADY_PLAYED/);assert.equal(ledger(a).length,4);assert.equal(account(a).eventSpins,7);assert.equal(account(a).balance,13579);
 assert.ok(read(b).eventGames.games.every(row=>row.lastResult===null));
 console.log('FIX56 EVENT GAMES PASS: authenticated free daily CARD/CHEST/RPS, published rewards and random boundaries, all nine RPS outcomes, Korea midnight, independent limits and private state/notifications/history, strict input and revision guards, immutable replay with current day/wallet/rules, unchanged paid turns/balance, pre-draw cap and storage rollback, once-only ledger and restart persistence.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
