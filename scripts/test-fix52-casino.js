'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix52-casino-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),casino=require('../services/member/casino'),database=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000,sequence=0,accounts=0;
Date.now=()=>clock;
function member(balance=5000000){
 const subject='FIX52-CASINO-'+(++accounts),id='USR-'+subject;
 s.Atomic(()=>{s.DB().profiles[subject]={id,subject,nickname:'테스트',avatar:'',createdAt:clock,balance,points:432,eventSpins:9};});
 return ()=>s.ProfileById(id);
}
function call(p,action,body,id='FIX52-CASINO-'+String(++sequence).padStart(8,'0')){
 return s.Operation(p(),id,'casino.'+action,body,()=>casino[{play:'Play',start:'Start',action:'Action'}[action]](p(),body));
}
function fresh(){clock+=300;}
function unchanged(fn,reason){const before=JSON.stringify(s.DB());assert.throws(fn,reason);assert.equal(JSON.stringify(s.DB()),before,'invalid/failed request leaves wallet, round, ledger, stats and receipt intact');}
function exactRandom(value,maximum){let calls=0;crypto.randomInt=(max)=>{calls++;assert.equal(max,maximum);return value;};return ()=>assert.equal(calls,1);}
function crashRandom(draw){let calls=0;crypto.randomInt=(min,max)=>{calls++;assert.equal(min,1);assert.equal(max,100000001);return draw;};return ()=>assert.equal(calls,1);}
function mineRandom(){crypto.randomInt=max=>{assert.ok(max>=16&&max<=25);return 0;};}
function secretFree(value){
 const text=JSON.stringify(value);assert.ok(!text.includes('"secret"'));assert.ok(!text.includes('"mineTiles"'));assert.ok(!text.includes('"crashCents"'));assert.ok(!text.includes('"crashMultiplier"'));
}
function ledgers(p,result){
 const rows=Object.values(s.DB().ledger).filter(row=>row.reference===result.id);
 assert.equal(rows.length,2);assert.equal(rows.find(row=>row.kind==='CASINO_BET').amount,-result.betAmount);assert.equal(rows.find(row=>row.kind==='CASINO_PAYOUT').amount,result.payout);
 assert.ok(rows.every(row=>row.accountId===p().id&&row.virtual===true&&row.redeemable===false));
 assert.equal(result.payout-result.betAmount,result.net);assert.equal(result.balance,p().balance);
}
try{
 const p=member(),initial=casino.Read(p());assert.equal(initial.game,'CRASH');assert.equal(initial.rules.revision,1);assert.equal(initial.virtual,true);assert.equal(initial.redeemable,false);assert.equal(initial.wallet.points,432);
 // Exact discrete dice boundaries are advertised in Rules and match both
 // directions, including the endpoints 0 and 99 and threshold itself.
 for(const threshold of [5,50,95])for(const direction of ['UNDER','OVER'])for(const roll of [...new Set([0,threshold-1,threshold,99])]){
  fresh();const verify=exactRandom(roll,100),before=p().balance,won=direction==='UNDER'?roll<threshold:roll>=threshold;
  const out=call(p,'play',{game:'DICE',amount:100,rulesRevision:1,threshold,direction});verify();
  const factor=Math.floor(9700/(direction==='UNDER'?threshold:100-threshold));
  assert.equal(out.result.roll,roll);assert.equal(out.result.payout,won?factor:0);assert.equal(out.result.winMultiplier,factor/100);assert.equal(out.result.matched,won);
  assert.equal(out.wallet.balance,before-100+out.result.payout);ledgers(p,out.result);
 }
 // Every plinko bucket and risk settles from eight independent server bits.
 for(const risk of initial.rules.plinko.risks)for(let bucket=0;bucket<=8;bucket++){
  fresh();let draws=0;crypto.randomInt=max=>{assert.equal(max,2);return draws++<bucket?1:0;};
  const out=call(p,'play',{game:'PLINKO',amount:100,rulesRevision:1,risk});assert.equal(draws,8);assert.equal(out.result.bucket,bucket);
  assert.equal(out.result.path.length,8);assert.equal(out.result.path.reduce((sum,value)=>sum+value,0),bucket);assert.equal(out.result.payout,Math.round(initial.rules.plinko.multipliers[risk][bucket]*100));ledgers(p,out.result);
 }
 // Active mines are hidden, owned by one account, recoverable, and debited
 // once. Reopening or repeating a reveal cannot buy a second attempt.
 const m=member(),other=member();fresh();mineRandom();
 const startBody={game:'MINES',amount:1000,rulesRevision:1,mines:3},start=call(m,'start',startBody,'FIX52-MINES-START-REPLAY');
 const roundId=start.active.id,secret=m().casino.MINES.active.secret.mineTiles;assert.deepEqual(secret,[0,23,24]);assert.equal(start.wallet.balance,4999000);assert.equal(start.stats.played,0);secretFree(start);
 crypto.randomInt=()=>assert.fail('replay and reads must not re-sample the board');assert.deepEqual(call(m,'start',startBody,'FIX52-MINES-START-REPLAY'),start);
 secretFree(casino.Read(m(),{game:'MINES'}));assert.equal(casino.Read(other(),{game:'MINES'}).active,null);
 unchanged(()=>casino.Read(other(),{game:'MINES',accountId:m().id}),/INPUT_INVALID/);
 unchanged(()=>call(other,'action',{game:'MINES',roundId,action:'REVEAL',tile:1}),/CASINO_ROUND_NOT_FOUND/);
 unchanged(()=>call(m,'start',startBody),/CASINO_ACTIVE/);
 unchanged(()=>call(m,'action',{game:'MINES',roundId,action:'CASHOUT'}),/CASINO_CASHOUT_REQUIRED/);
 const revealBody={game:'MINES',roundId,action:'REVEAL',tile:1},revealed=call(m,'action',revealBody,'FIX52-MINES-REVEAL-REPLAY');
 assert.deepEqual(revealed.active.revealed,[1]);assert.equal(revealed.active.multiplier,1.10);assert.equal(revealed.active.payout,1100);secretFree(revealed);
 assert.deepEqual(call(m,'action',revealBody,'FIX52-MINES-REVEAL-REPLAY'),revealed);
 unchanged(()=>call(m,'action',revealBody),/CASINO_TILE_OPENED/);
 const cashed=call(m,'action',{game:'MINES',roundId,action:'CASHOUT'},'FIX52-MINES-CASHOUT-REPLAY');
 assert.equal(cashed.active,null);assert.equal(cashed.result.reason,'CASHED_OUT');assert.equal(cashed.result.payout,1100);assert.equal(cashed.wallet.balance,5000100);assert.deepEqual(cashed.result.mineTiles,secret);ledgers(m,cashed.result);
 const count=Object.keys(s.DB().ledger).length;
 assert.deepEqual(call(m,'action',{game:'MINES',roundId,action:'CASHOUT'}).result,cashed.result);assert.equal(Object.keys(s.DB().ledger).length,count);
 // A mine terminates immediately; revealing all safe tiles settles once at
 // the bounded published multiplier. No terminal request redraws anything.
 fresh();mineRandom();let out=call(m,'start',startBody);out=call(m,'action',{game:'MINES',roundId:out.active.id,action:'REVEAL',tile:0});
 assert.equal(out.result.reason,'MINE_HIT');assert.equal(out.result.hitTile,0);assert.equal(out.result.payout,0);assert.equal(out.active,null);ledgers(m,out.result);
 fresh();mineRandom();out=call(m,'start',{...startBody,mines:1});const clearId=out.active.id;
 for(let tile=1;tile<25;tile++)out=call(m,'action',{game:'MINES',roundId:clearId,action:'REVEAL',tile});
 assert.equal(out.result.reason,'CLEARED');assert.equal(out.result.multiplier,24.25);assert.equal(out.result.payout,24250);assert.equal(out.stats.played,3);ledgers(m,out.result);
 // On reconnect after expiry the server automatically cashes out safe tiles;
 // if untouched, it restores the stake. A second read never settles twice.
 fresh();mineRandom();out=call(m,'start',startBody);const expiredId=out.active.id,beforeExpiry=m().balance;
 clock+=initial.rules.mines.expiresAfterMs;out=casino.Read(m(),{game:'MINES'});assert.equal(out.lastResult.id,expiredId);assert.equal(out.lastResult.reason,'EXPIRED_CASHOUT');assert.equal(out.lastResult.payout,1000);assert.equal(out.wallet.balance,beforeExpiry+1000);
 const expiredSnapshot=JSON.stringify(s.DB());casino.Read(m(),{game:'MINES'});assert.equal(JSON.stringify(s.DB()),expiredSnapshot);
 fresh();mineRandom();out=call(m,'start',startBody);const timedId=out.active.id;call(m,'action',{game:'MINES',roundId:timedId,action:'REVEAL',tile:1});clock+=initial.rules.mines.expiresAfterMs;
 out=casino.Read(m(),{game:'MINES'});assert.equal(out.lastResult.payout,1100);ledgers(m,out.lastResult);
 // CRASH uses the same persisted hidden threshold after restart and a
 // server-time decision at cashout. Client multiplier/time are rejected.
 const c=member();fresh();let verify=crashRandom(10000000);out=call(c,'start',{game:'CRASH',amount:1000,rulesRevision:1});verify();secretFree(out);
 assert.equal(c().casino.CRASH.active.secret.crashCents,970);const crashId=out.active.id;assert.equal(out.active.multiplier,1);assert.equal(out.wallet.balance,4999000);
 crypto.randomInt=()=>assert.fail('reads/actions may not choose another crash threshold');clock+=1000;out=casino.Read(c(),{game:'CRASH'});assert.equal(out.active.multiplier,1.13);secretFree(out);
 unchanged(()=>call(c,'action',{game:'CRASH',roundId:crashId,action:'CASHOUT',multiplier:50}),/INPUT_INVALID/);
 unchanged(()=>call(c,'action',{game:'CRASH',roundId:crashId,action:'CASHOUT',now:0}),/INPUT_INVALID/);
 let persisted=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));s.Import(persisted);out=casino.Read(c(),{game:'CRASH'});assert.equal(out.active.id,crashId);assert.equal(out.active.multiplier,1.13);
 const cashBody={game:'CRASH',roundId:crashId,action:'CASHOUT'};out=call(c,'action',cashBody,'FIX52-CRASH-CASHOUT-REPLAY');assert.equal(out.result.payout,1130);assert.equal(out.result.reason,'CASHED_OUT');assert.equal(out.stats.played,1);ledgers(c,out.result);
 const original=out;clock+=300000;assert.deepEqual(call(c,'action',cashBody,'FIX52-CRASH-CASHOUT-REPLAY'),original);
 fresh();verify=crashRandom(50000000);out=call(c,'start',{game:'CRASH',amount:1000,rulesRevision:1});verify();const lossId=out.active.id;clock+=6000;
 out=call(c,'action',{game:'CRASH',roundId:lossId,action:'CASHOUT'});assert.equal(out.result.reason,'CRASHED');assert.equal(out.result.crashMultiplier,1.94);assert.equal(out.result.payout,0);ledgers(c,out.result);
 fresh();verify=crashRandom(100000000);out=call(c,'start',{game:'CRASH',amount:1000,rulesRevision:1});verify();assert.equal(out.active,null);assert.equal(out.result.reason,'CRASHED');assert.equal(out.result.crashMultiplier,1);
 fresh();verify=crashRandom(1);out=call(c,'start',{game:'CRASH',amount:1000,rulesRevision:1});verify();clock+=60000;out=casino.Read(c(),{game:'CRASH'});assert.equal(out.active,null);assert.equal(out.lastResult.crashMultiplier,1000);assert.equal(out.stats.played,4);
 // Validate hostile/ambiguous fields and all integer limits before RNG.
 const invalid=member();fresh();crypto.randomInt=()=>assert.fail('invalid input cannot draw');
 const dice={game:'DICE',amount:100,rulesRevision:1,threshold:50,direction:'UNDER'};
 for(const extra of [{roll:1},{payout:1000},{accountId:p().id},{balance:999},{seed:1},{risk:'LOW'},{direction:'under'},{threshold:0},{threshold:96},{threshold:'50'},{threshold:50.1}])unchanged(()=>call(invalid,'play',{...dice,...extra}),/INPUT_INVALID/);
 for(const amount of [0,-100,99,101,100.1,'100',null,MAX_SAFE()+1])unchanged(()=>call(invalid,'play',{...dice,amount}),/AMOUNT_INVALID/);
 unchanged(()=>call(invalid,'play',{...dice,rulesRevision:0}),/ARCADE_RULES_CHANGED/);
 for(const mines of [null,0,11,3.1,'3'])unchanged(()=>call(invalid,'start',{...startBody,mines}),/INPUT_INVALID/);
 unchanged(()=>call(invalid,'start',{game:'CRASH',amount:100,rulesRevision:1,mines:3}),/INPUT_INVALID/);
 unchanged(()=>call(invalid,'play',{game:'PLINKO',amount:100,rulesRevision:1,risk:'__proto__'}),/INPUT_INVALID/);
 for(const tile of [-1,25,1.2,'1',null])unchanged(()=>call(m,'action',{game:'MINES',roundId,action:'REVEAL',tile}),/INPUT_INVALID/);
 const empty=member(99);unchanged(()=>call(empty,'play',dice),/ARCADE_BALANCE_REQUIRED/);
 const max=member(MAX_SAFE());unchanged(()=>call(max,'play',dice),/ARCADE_BALANCE_LIMIT/);unchanged(()=>call(max,'start',{game:'CRASH',amount:100,rulesRevision:1}),/ARCADE_BALANCE_LIMIT/);
 const huge=member(MAX_SAFE());unchanged(()=>call(huge,'start',{game:'CRASH',amount:9007199254740900,rulesRevision:1}),/ARCADE_BALANCE_LIMIT/);
 s.Atomic(()=>{invalid().casino={DICE:{played:MAX_SAFE()}};});unchanged(()=>call(invalid,'play',dice),/ARCADE_BALANCE_LIMIT/);
 // A failed disk write restores the whole round or settlement, allowing the
 // original signed operation ID to be retried with no stranded debit.
 const rollback=member(),save=database.SaveDatabase;fresh();mineRandom();
 try{database.SaveDatabase=()=>false;unchanged(()=>call(rollback,'start',startBody,'FIX52-SAVE-START-RETRY'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 out=call(rollback,'start',startBody,'FIX52-SAVE-START-RETRY');const rollbackId=out.active.id;
 call(rollback,'action',{game:'MINES',roundId:rollbackId,action:'REVEAL',tile:1});const rollbackBody={game:'MINES',roundId:rollbackId,action:'CASHOUT'};
 try{database.SaveDatabase=()=>false;unchanged(()=>call(rollback,'action',rollbackBody,'FIX52-SAVE-PAYOUT-RETRY'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 const saved=call(rollback,'action',rollbackBody,'FIX52-SAVE-PAYOUT-RETRY');ledgers(rollback,saved.result);
 persisted=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));s.Import(persisted);crypto.randomInt=()=>assert.fail('durable replay must not sample');assert.deepEqual(call(rollback,'action',rollbackBody,'FIX52-SAVE-PAYOUT-RETRY'),saved);
 unchanged(()=>call(rollback,'action',{...rollbackBody,action:'REVEAL',tile:1},'FIX52-SAVE-PAYOUT-RETRY'),/REQUEST_REUSED/);
 // Late read settlement also rolls back atomically if persistence fails.
 fresh();crashRandom(50000000);out=call(rollback,'start',{game:'CRASH',amount:100,rulesRevision:1});clock+=6000;
 try{database.SaveDatabase=()=>false;unchanged(()=>casino.Read(rollback(),{game:'CRASH'}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 out=casino.Read(rollback(),{game:'CRASH'});assert.equal(out.lastResult.reason,'CRASHED');ledgers(rollback,out.lastResult);
 // The hub replays immutable receipts alongside the current wallet/round,
 // and still enforces existing device, biometric and member authorization.
 const hub=require('../services/member/service'),protocol=require('../services/member/protocol'),wire=require('../services/member/wire');
 function peer(id,key){
  const lines=[],client={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(line){lines.push(line.trim());return true;}}};
  state.clients.set(id,client);state.clientIdentities.set(key,{id,serverId:'',createdAt:clock});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:clock});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));return {client,lines};
 }
 function request(peer,action,body,id='FIX52-WIRE-'+String(++sequence).padStart(8,'0')){
  const fields=[id,action,Buffer.from(JSON.stringify(body)).toString('base64')];peer.lines.length=0;hub.Handle(peer.client,['HUB',...fields,protocol.Sign(peer.client,'HUB',fields)].join('|'));
  const chunks=peer.lines.filter(line=>/^HUB_(?:Z)?CHUNK\|/.test(line)).map(line=>line.split('|')).sort((a,b)=>Number(a[3])-Number(b[3]));assert.ok(chunks.length);
  for(const chunk of chunks)assert.equal(chunk[6],protocol.Sign(peer.client,chunk[0]==='HUB_ZCHUNK'?'HUB_ZRESPONSE':'HUB_RESPONSE',chunk.slice(1,6)));
  return JSON.parse(wire.Decode(chunks.map(chunk=>chunk[5]).join(''),chunks[0][0]==='HUB_ZCHUNK'));
 }
 function ok(peer,action,body,id){const out=request(peer,action,body,id);assert.equal(out.ok,true,JSON.stringify(out));return out.data;}
 const a=peer('1111111111111152','FIX52-CASINO-WIRE-A'),a2=peer('2222222222222252','FIX52-CASINO-WIRE-A2'),b=peer('3333333333333352','FIX52-CASINO-WIRE-B');a2.client.installationDeviceKey=a.client.installationDeviceKey;
 const owner=s.Account(a.client).id,otherOwner=s.Account(b.client).id;s.Atomic(()=>{Object.assign(s.ProfileById(owner),{balance:500000,points:321});});
 assert.equal(ok(a,'casino',{game:'DICE'}).wallet.accountId,owner);fresh();exactRandom(1,100);
 const wireBody={...dice,_wire:'zlib',_delta:true},wireOut=ok(a,'casino.play',wireBody,'FIX52-WIRE-DICE-REPLAY');assert.equal(wireOut.result.payout,194);assert.equal(wireOut.wallet.revision,s.DB().revision);
 crypto.randomInt=()=>assert.fail('hub retry cannot draw');assert.deepEqual(ok(a2,'casino.play',wireBody,'FIX52-WIRE-DICE-REPLAY'),wireOut);
 s.Atomic(()=>s.Ledger(s.ProfileById(owner),1000,'TEST','CASINO-REPLAY-WALLET'));
 const replay=ok(a2,'casino.play',wireBody,'FIX52-WIRE-DICE-REPLAY');assert.deepEqual(replay.result,wireOut.result);assert.equal(replay.wallet.balance,501094);assert.equal(replay.wallet.revision,s.DB().revision);
 assert.equal(ok(b,'casino',{game:'DICE'}).wallet.accountId,otherOwner);assert.equal(request(b,'casino.play',wireBody).reason,'ARCADE_BALANCE_REQUIRED');
 a.client.biometricVerified=false;assert.equal(request(a,'casino.play',wireBody).reason,'MEMBER_AUTH_REQUIRED');a.client.biometricVerified=true;
 s.ProfileById(owner).blocked=true;assert.equal(request(a,'casino',{game:'DICE'}).reason,'ACCOUNT_BLOCKED');s.ProfileById(owner).blocked=false;
 fresh();mineRandom();const activeWire=ok(a,'casino.start',{...startBody,_delta:true,_wire:'zlib'},'FIX52-WIRE-MINES-START');secretFree(activeWire);
 const activeWireId=activeWire.active.id;ok(a2,'casino.action',{game:'MINES',roundId:activeWireId,action:'REVEAL',tile:1});
 const latestStart=ok(a,'casino.start',{...startBody,_delta:true,_wire:'zlib'},'FIX52-WIRE-MINES-START');assert.deepEqual(latestStart.active.revealed,[1]);assert.deepEqual(latestStart.result,activeWire.result);
 const finishedWire=ok(a,'casino.action',{game:'MINES',roundId:activeWireId,action:'CASHOUT'});assert.equal(finishedWire.result.payout,1100);assert.equal(finishedWire.active,null);
 const staleStart=ok(a2,'casino.start',{...startBody,_delta:true,_wire:'zlib'},'FIX52-WIRE-MINES-START');assert.equal(staleStart.active,null);assert.equal(staleStart.lastResult.id,activeWireId);assert.equal(staleStart.wallet.balance,finishedWire.wallet.balance);
 const badgeRows=Object.values(s.DB().pointLedger);
 for(const account of [p,m,c,other,rollback]){assert.equal(account().points,432+badgeRows.filter(row=>row.accountId===account().id).reduce((total,row)=>total+row.amount,0));assert.equal(account().eventSpins,9);}
 assert.deepEqual(badgeRows.map(row=>row.accountId+':'+row.reference).sort(),[[m().id,'MINES_1'],[c().id,'CRASH_1'],[rollback().id,'MINES_1'],[rollback().id,'CRASH_1'],[owner,'DICE_1'],[owner,'MINES_1']].map(row=>row.join(':')).sort());
 for(const row of badgeRows){assert.equal(row.kind,'BADGE_REWARD');assert.equal(row.amount,50);assert.equal(s.DB().pointLedger[row.accountId+':BADGE_REWARD:'+row.reference],row);}
 assert.equal(s.ProfileById(owner).points,321+badgeRows.filter(row=>row.accountId===owner).reduce((total,row)=>total+row.amount,0));
 for(const key of ['eventSpins','orders','shopPurchases','pointConversions','chargeRequests'])assert.deepEqual(s.DB()[key],{},'casino must not modify '+key);
 console.log('FIX52 CASINO PASS: dice boundary outcomes, all plinko buckets/risks, private mines and crash rounds, exact server-time settlement, reconnect/expiry, clearing/mine-hit/cashout, account isolation, malformed inputs, safe-integer limits, atomic save rollback, persisted idempotency and signed hub replay with current wallet/active round.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
function MAX_SAFE(){return Number.MAX_SAFE_INTEGER;}
