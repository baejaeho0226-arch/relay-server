'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix59-skill-events-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),lm=require('../license/licenseManager'),database=require('../storage/database'),rewards=require('../services/member/rewards'),engine=require('../services/member/eventEngine');
let serial=0,clientSerial=0,now=Date.parse('2026-09-15T00:00:00Z');const realNow=Date.now;Date.now=()=>now;
function client(){const n=++clientSerial,id=String(n).padStart(16,'0'),key='FIX59-EVENT-DEVICE-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;s.Account(c);return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX59-EVENT-REQUEST-'+(++serial),action,body);
const account=c=>s.Account(c),snapshot=()=>JSON.stringify(s.DB()),ledger=c=>Object.values(s.DB().pointLedger).filter(row=>row.accountId===account(c).id&&engine.GAME_IDS.some(game=>row.kind==='EVENT_'+game));
const start=(c,game)=>run(c,'event.start',{game,revision:rewards.Rules().revision}).session;
function unchanged(fn,error){const before=snapshot();assert.throws(fn,error);assert.equal(snapshot(),before,'rejected requests leave the entire database unchanged');}
function trace(game,seed){const rows=engine.Schedule(game,seed);let actions=[];
 if(game==='DINO')actions=rows.filter(row=>row.spawn+55<=1800).map(row=>({t:row.spawn+55,a:'tap'}));
 if(game==='WHACK')actions=rows.filter(row=>row.spawn+2<=1800).map(row=>({t:row.spawn+2,a:'tap',lane:row.lane}));
 if(game==='RHYTHM')actions=rows.map(row=>({t:row.spawn+45,a:'tap',lane:row.lane}));
 if(game==='DODGE'){let lane=2;for(const row of rows){const t=row.spawn+45;if(t>1800)break;if(row.lane===lane){lane=lane===4?3:lane+1;actions.push({t,a:'move',lane});}}}
 if(game==='FLAPPY'){let y=300,v=0,index=0;for(let t=1;t<=1800;t++){while(index<rows.length-1&&1000-(t-rows[index].spawn)*7+65<202)index++;if(y>rows[index].center+30&&v>=0){actions.push({t,a:'tap'});v=-10;}y+=v;v=Math.min(v+1,12);}}
 return actions;
}
try{
 const a=client(),b=client(),failure=client(),capped=client(),locked=client();
 const data=run(a,'rewards');assert.deepEqual(data.eventGames.games.map(row=>row.game),engine.GAME_IDS);assert.equal(data.eventGames.rules.repeatable,true);assert.equal(data.eventGames.rules.pointsPerScore,1);
 assert.ok(data.eventGames.games.every(row=>row.available&&!row.session&&row.totalPlayed===0&&row.bestScore===0));
 let before=snapshot();run(a,'rewards');run(b,'rewards');assert.equal(snapshot(),before,'event reads are pure');
 const knownScores={DINO:220,FLAPPY:170,WHACK:750,DODGE:435,RHYTHM:1470};
 for(const game of engine.GAME_IDS)assert.deepEqual(engine.Simulate(game,1,1800,trace(game,1)),{ticks:1800,score:knownScores[game],outcome:'COMPLETE'},'fixed seed native/server protocol fixture '+game);
 assert.deepEqual(engine.Simulate('DINO',1,125,[]),{ticks:125,score:0,outcome:'COLLISION'});
 assert.deepEqual(engine.Simulate('FLAPPY',1,30,[]),{ticks:30,score:0,outcome:'COLLISION'});
 const dodgeLoss=engine.Schedule('DODGE',1).findIndex(row=>row.lane===2),lossTick=engine.Schedule('DODGE',1)[dodgeLoss].spawn+45;
 assert.deepEqual(engine.Simulate('DODGE',1,lossTick,[]),{ticks:lossTick,score:dodgeLoss*5,outcome:'COLLISION'});
 assert.equal(engine.Simulate('WHACK',1,1800,[]).score,0);assert.equal(engine.Simulate('RHYTHM',1,1800,[]).score,0);
 const mole=engine.Schedule('WHACK',1)[0].lane;
 assert.equal(engine.Simulate('WHACK',1,3,[{t:1,a:'tap',lane:mole},{t:2,a:'tap',lane:mole},{t:3,a:'tap',lane:(mole+1)%9}]).score,6,'one mole scores once and misses deduct two');
 const note=engine.Schedule('RHYTHM',1)[0].lane;
 assert.equal(engine.Simulate('RHYTHM',1,48,[{t:48,a:'tap',lane:note}]).score,7,'near timing earns seven');
 assert.equal(engine.Simulate('RHYTHM',1,51,[{t:51,a:'tap',lane:note}]).score,0,'late timing misses');
 account(a).balance=43210;account(a).eventSpins=7;
 let oldReceipt,oldBody,oldId,oldReward;
 for(const game of engine.GAME_IDS){
  const prePoints=account(a).points||0,session=start(a,game);assert.equal(account(a).points||0,prePoints,'starting a run grants no event points');assert.equal(session.game,game);assert.equal(session.tickHz,30);assert.equal(session.maxTicks,1800);assert.equal(session.expiresAt-session.startedAt,86400000);
  const body={sessionId:session.id,ticks:1800,actions:trace(game,session.seed)},id='FIX59-COMPLETED-'+game;
  unchanged(()=>run(a,'event.finish',body,id),/EVENT_TOO_FAST/);
  now+=60000;const result=run(a,'event.finish',body,id),expected=engine.Simulate(game,session.seed,1800,body.actions);
  assert.equal(result.result.score,expected.score);assert.equal(result.result.points,expected.score);assert.equal(result.reward.amount,expected.score);assert.equal(result.reward.kind,'EVENT_'+game);assert.equal(result.reward.reference,session.id);assert.equal(account(a).points-prePoints,expected.score);
  const item=result.eventGames.games.find(row=>row.game===game);assert.equal(item.session,null);assert.equal(item.totalPlayed,1);assert.equal(item.bestScore,expected.score);assert.deepEqual(item.lastResult,result.result);
  before=snapshot();assert.deepEqual(run(a,'event.finish',body,id).result,result.result);assert.equal(snapshot(),before,'same operation replays without a write');
  const count=ledger(a).length,balance=account(a).points;assert.deepEqual(run(a,'event.finish',body).result,result.result);assert.equal(ledger(a).length,count);assert.equal(account(a).points,balance,'new request ID cannot credit an already finished run twice');
  unchanged(()=>run(a,'event.finish',{...body,ticks:1799,actions:body.actions.filter(x=>x.t<=1799)}),/REQUEST_REUSED/);
  unchanged(()=>run(b,'event.finish',body),/EVENT_SESSION_NOT_FOUND/);
  if(game==='DINO'){oldReceipt=structuredClone(result.result);oldReward=structuredClone(result.reward);oldBody=body;oldId=id;}
 }
 assert.equal(account(a).balance,43210);assert.equal(account(a).eventSpins,7);assert.equal(ledger(a).length,5);
 // Repeat the same title on the same day; no daily counter or paid turn is used.
 const repeated=start(a,'WHACK'),lane=engine.Schedule('WHACK',repeated.seed)[0].lane;now+=1000;
 const repeat=run(a,'event.finish',{sessionId:repeated.id,ticks:20,actions:[{t:2,a:'tap',lane}]});assert.equal(repeat.result.points,10);assert.equal(repeat.result.outcome,'STOPPED');assert.equal(repeat.eventGames.games.find(x=>x.game==='WHACK').totalPlayed,2);
 // A paused game coexists with the other four and can finish later. Replacing
 // the same game abandons its old uncredited run; reads cannot allocate points.
 const paused=start(a,'RHYTHM'),nextGame=start(a,'WHACK'),abandoned=start(a,'DINO'),replacement=start(a,'DINO');
 const preAbandon=account(a).points;run(a,'rewards');assert.equal(account(a).points,preAbandon);assert.ok(run(a,'rewards').eventGames.games.find(x=>x.game==='RHYTHM').session);
 unchanged(()=>run(a,'event.finish',{sessionId:abandoned.id,ticks:1,actions:[]}),/EVENT_SESSION_NOT_FOUND/);
 now+=3600000;const pausedResult=run(a,'event.finish',{sessionId:paused.id,ticks:46,actions:[{t:46,a:'tap',lane:engine.Schedule('RHYTHM',paused.seed)[0].lane}]});assert.equal(pausedResult.result.points,10);
 assert.ok(nextGame.id&&replacement.id);
 const own=run(a,'rewards'),other=run(b,'rewards');assert.ok(own.eventGames.games.some(x=>x.lastResult));assert.ok(other.eventGames.games.every(x=>!x.session&&!x.lastResult&&x.totalPlayed===0));
 const publicProfile=run(b,'member',{id:account(a).id}).profile;assert.equal(publicProfile.skillEvents,undefined);assert.equal(publicProfile.eventGames,undefined);assert.equal(publicProfile.points,undefined);
 // The server never accepts a client score, a forged session or impossible
 // physics/input cadence; each failure rolls back badges and operation receipts.
 const invalid=start(b,'WHACK');now+=60000;
 const good={sessionId:invalid.id,ticks:60,actions:[{t:2,a:'tap',lane:engine.Schedule('WHACK',invalid.seed)[0].lane}]};
 for(const body of [null,[],{}, {...good,score:999999},{...good,points:999999},{...good,accountId:account(a).id},{...good,ticks:0},{...good,ticks:1801},{...good,ticks:1.5},{...good,actions:'bad'},{...good,actions:[{t:1,a:'tap',lane:9}]},{...good,actions:[{t:1,a:'tap',lane:0},{t:1,a:'tap',lane:1}]},{...good,actions:[{t:61,a:'tap',lane:0}]},{...good,actions:[{t:1,a:'tap',lane:0,score:10}]},{...good,_wire:'other'}])unchanged(()=>run(b,'event.finish',body),/INPUT_INVALID|EVENT_TRACE_INVALID/);
 const badDino=start(b,'DINO');now+=10000;unchanged(()=>run(b,'event.finish',{sessionId:badDino.id,ticks:126,actions:[]}),/EVENT_TRACE_INVALID/);
 const badDodge=start(b,'DODGE');now+=10000;
 unchanged(()=>run(b,'event.finish',{sessionId:badDodge.id,ticks:5,actions:[{t:1,a:'move',lane:4}]}),/EVENT_TRACE_INVALID/);
 unchanged(()=>run(b,'event.finish',{sessionId:badDodge.id,ticks:5,actions:[{t:1,a:'move',lane:3},{t:2,a:'move',lane:2}]}),/EVENT_TRACE_INVALID/);
 const expired=start(b,'FLAPPY');now+=86400001;unchanged(()=>run(b,'event.finish',{sessionId:expired.id,ticks:30,actions:[]}),/EVENT_SESSION_EXPIRED/);
 for(const body of [{game:'CARD',revision:1},{game:'dino',revision:1},{game:'DINO',revision:'1'},{game:'DINO',revision:rewards.Rules().revision,score:1}])unchanged(()=>run(b,'event.start',body),/INPUT_INVALID/);
 unchanged(()=>run(b,'event.start',{game:'DINO',revision:999}),/CONTENT_CHANGED/);unchanged(()=>run(b,'event.play',{game:'CARD',choice:0}),/UNKNOWN_ACTION/);
 locked.biometricVerified=false;unchanged(()=>start(locked,'DINO'),/MEMBER_AUTH_REQUIRED/);locked.biometricVerified=true;
 account(locked).blocked=true;unchanged(()=>start(locked,'DINO'),/ACCOUNT_BLOCKED/);account(locked).blocked=false;
 state.serviceEnabled=false;unchanged(()=>start(locked,'DINO'),/SERVICE_DISABLED/);state.serviceEnabled=true;
 const admitted=start(locked,'WHACK');now+=1000;rewards.SaveRules({...rewards.Rules(),enabled:false},'FIX59-TEST');
 unchanged(()=>start(locked,'DINO'),/EVENT_CLOSED/);assert.ok(run(locked,'rewards').eventGames.games.every(row=>!row.available));
 assert.equal(run(locked,'event.finish',{sessionId:admitted.id,ticks:10,actions:[{t:2,a:'tap',lane:engine.Schedule('WHACK',admitted.seed)[0].lane}]}).result.points,10,'a previously admitted run can bank its earned score after new starts close');
 rewards.SaveRules({...rewards.Rules(),enabled:true},'FIX59-TEST');
 const failed=start(failure,'WHACK'),retry={sessionId:failed.id,ticks:20,actions:[{t:2,a:'tap',lane:engine.Schedule('WHACK',failed.seed)[0].lane}]},retryId='FIX59-FAILED-FINISH';now+=1000;
 const save=database.SaveDatabase;try{database.SaveDatabase=()=>false;unchanged(()=>run(failure,'event.finish',retry,retryId),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(ledger(failure).length,0);assert.equal(account(failure).skillEvents.sessions.find(x=>x.id===failed.id).status,'ACTIVE');assert.equal(run(failure,'event.finish',retry,retryId).reward.amount,10);assert.equal(ledger(failure).length,1);
 const full=start(capped,'WHACK');now+=1000;account(capped).points=100000000;const capBody={sessionId:full.id,ticks:20,actions:[{t:2,a:'tap',lane:engine.Schedule('WHACK',full.seed)[0].lane}]};
 unchanged(()=>run(capped,'event.finish',capBody),/POINT_BALANCE_INVALID/);assert.equal(account(capped).skillEvents.sessions.find(x=>x.id===full.id).status,'ACTIVE');assert.equal(ledger(capped).length,0);
 account(capped).points=99999990;assert.equal(run(capped,'event.finish',capBody).reward.amount,10);assert.equal(account(capped).points,100000000);
 // Bounded abandoned/completed state cannot grow with unlimited restarts.
 for(let i=0;i<40;i++)start(b,'WHACK');assert.ok(account(b).skillEvents.sessions.filter(x=>x.status!=='ACTIVE').length<=20);assert.ok(account(b).skillEvents.sessions.filter(x=>x.status==='ACTIVE').length<=5);
 const exported=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(exported),true);
 before=snapshot();const replay=run(a,'event.finish',oldBody,oldId);assert.deepEqual(replay.result,oldReceipt);assert.deepEqual(replay.reward,oldReward);assert.equal(replay.wallet.points,account(a).points);assert.equal(snapshot(),before);
 // A genuinely fresh process rehydrates the same durable session/ledger format.
 const file=path.join(temp,'restart-snapshot.json');fs.writeFileSync(file,JSON.stringify(database.BuildDatabaseObject()));
 const child=cp.spawnSync(process.execPath,['-e',`const fs=require('node:fs'),assert=require('node:assert/strict');require(process.cwd()+'/core/utils').EnsureDirs();const db=require(process.cwd()+'/storage/database'),s=require(process.cwd()+'/services/member/store'),e=require(process.cwd()+'/services/member/eventGames');assert.equal(db.ImportDatabaseObject(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))),true);const p=s.ProfileById(process.argv[2]),body=JSON.parse(process.argv[3]),before=JSON.stringify(s.DB());const out=e.Finish(p,body);assert.equal(out.result.id,body.sessionId);assert.equal(out.result.points,Number(process.argv[4]));assert.equal(JSON.stringify(s.DB()),before);console.log('fresh event replay PASS');`,file,account(a).id,JSON.stringify(oldBody),String(oldReceipt.points)],{cwd:path.resolve(__dirname,'..'),env:{...process.env},encoding:'utf8'});
 assert.equal(child.status,0,child.stdout+child.stderr);
 console.log('FIX59 SKILL EVENTS PASS: five real deterministic games, exact score-to-point ledger, full/partial/collision runs, timing and impossible-trace rejection, unlimited repeatable play, private paused sessions, retirement of one-use games, auth/revision gates, bounded state, save/cap rollback, immutable once-only replay and fresh-process restart.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
