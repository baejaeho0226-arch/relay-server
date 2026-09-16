'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix51-multibet-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),arcade=require('../services/member/arcade'),database=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000,sequence=0,accounts=0;
Date.now=()=>clock;
function member(balance){
 const subject='FIX51-MULTIBET-'+(++accounts),id='USR-'+subject;
 s.Atomic(()=>{s.DB().profiles[subject]={id,subject,nickname:'테스트',avatar:'',createdAt:clock,balance,points:432,eventSpins:9};});
 return ()=>s.ProfileById(id);
}
function body(game,bets){return {game,bets,rulesRevision:4};}
function play(p,request,id='FIX51-ROUND-'+String(++sequence).padStart(8,'0')){return s.Operation(p(),id,'arcade.play',request,()=>arcade.Play(p(),request));}
function unchanged(fn,reason){const before=JSON.stringify(s.DB());assert.throws(fn,reason);assert.equal(JSON.stringify(s.DB()),before,'rejection leaves all wallet, ledger, statistics and operation data unchanged');}
function number(value){clock+=300;let count=0;crypto.randomInt=max=>{count++;assert.equal(max,37);return value;};return ()=>assert.equal(count,1,'one shared roulette result for all occupied cells');}
function cards(ranks){
 clock+=300;const shoe=Array.from({length:416},(_,i)=>i);let count=0;
 crypto.randomInt=max=>{assert.equal(max,shoe.length);const rank=ranks[count++],index=shoe.findIndex(id=>id%13===rank);assert.ok(index>=0);shoe[index]=shoe[shoe.length-1];shoe.pop();return index;};
 return ()=>assert.equal(count,ranks.length,'one baccarat hand shared by all three choices');
}
function settled(p,request,result,before){
 assert.equal(result.result.betAmount,request.bets.reduce((sum,bet)=>sum+bet.amount,0));
 assert.equal(result.result.payout,result.result.bets.reduce((sum,bet)=>sum+bet.payout,0));
 assert.equal(result.result.net,result.result.payout-result.result.betAmount);
 assert.equal(result.wallet.balance,before+result.result.net);assert.equal(p().balance,result.wallet.balance);
 assert.equal(result.wallet.points,432);assert.equal(result.wallet.eventSpins,9);
 const rows=Object.values(s.DB().ledger).filter(row=>row.reference===result.result.id);
 assert.equal(rows.length,2,'a multi-bet round has exactly one linked debit and payout');
 assert.equal(rows.find(row=>row.kind==='ARCADE_BET').amount,-result.result.betAmount);
 assert.equal(rows.find(row=>row.kind==='ARCADE_PAYOUT').amount,result.result.payout);
 for(const bet of result.result.bets){
  const expected=arcade.Settlement(request.game,bet.choice,bet.betAmount,result.result);
  assert.equal(bet.payout,expected.payout);assert.equal(bet.net,expected.net);assert.equal(bet.matched,expected.matched);
 }
}
try{
 const p=member(500000),rules=arcade.Read(p()).rules;
 assert.equal(rules.revision,5);assert.equal(rules.multiBet,true);assert.equal(rules.maxBets,50);
 const all=rules.choices.ROULETTE.slice(0,40).map(choice=>({choice,amount:100})),request=body('ROULETTE',all);
 // Every color and every number stay occupied in one round. GREEN and
 // NUMBER_0 both win at zero; the color and exact number win elsewhere.
 for(let n=0;n<=36;n++){
  const verify=number(n),before=p().balance,result=play(p,request);verify();settled(p,request,result,before);
  assert.equal(result.result.betCount,40);assert.equal(result.result.choice,'MULTIPLE');
  assert.equal(result.result.bets.filter(bet=>bet.matched).length,2);
  assert.equal(result.result.payout,n===0?7200:3800);
  assert.equal(result.stats.played,n+1,'statistics count a round once regardless of occupied cells');
 }
 const duplicate=body('ROULETTE',[{choice:'RED',amount:100},{choice:'RED',amount:500},{choice:'NUMBER_1',amount:100},{choice:'GREEN',amount:200}]);
 let verify=number(1),before=p().balance,out=play(p,duplicate,'FIX51-MULTI-REPLAY');verify();settled(p,duplicate,out,before);
 assert.equal(out.result.betCount,3);assert.equal(out.result.bets.find(bet=>bet.choice==='RED').betAmount,600);assert.equal(out.result.payout,4800);
 crypto.randomInt=()=>assert.fail('replaying a complete multi-bet round must never draw again');
 assert.deepEqual(play(p,duplicate,'FIX51-MULTI-REPLAY'),out);
 unchanged(()=>play(p,{...duplicate,bets:[...duplicate.bets,{choice:'BLACK',amount:100}]},'FIX51-MULTI-REPLAY'),/REQUEST_REUSED/);
 unchanged(()=>play(p,duplicate),/ARCADE_WAIT/);
 const baccarat=body('BACCARAT',[{choice:'PLAYER',amount:100},{choice:'TIE',amount:200},{choice:'BANKER',amount:300}]);
 for(const [winner,ranks,payout] of [['PLAYER',[0,1,6,2],200],['BANKER',[1,0,2,6],585],['TIE',[0,1,6,5],2200]]){
  verify=cards(ranks);before=p().balance;out=play(p,baccarat);verify();settled(p,baccarat,out,before);
  assert.equal(out.result.winner,winner);assert.equal(out.result.betCount,3);assert.equal(out.result.payout,payout);
 }
 const slots=body('SLOTS',[{choice:'SPIN',amount:100},{choice:'SPIN',amount:500}]);
 clock+=300;let draws=0;crypto.randomInt=max=>{draws++;assert.equal(max,6);return 5;};before=p().balance;out=play(p,slots);assert.equal(draws,3);settled(p,slots,out,before);
 assert.equal(out.result.betCount,1);assert.equal(out.result.choice,'SPIN');assert.equal(out.result.payout,36000);
 // Reject invalid cells, mixed wire formats, aggregate deficits and oversized
 // payloads before sampling; no partial stake can survive the rejection.
 clock+=300;crypto.randomInt=()=>assert.fail('invalid multi-bet payload cannot draw');
 const valid=[{choice:'RED',amount:100}];
 for(const bets of [null,{},[],Array(41).fill(valid[0]),[null],[[]],[{choice:'NUMBER_37',amount:100}],[{choice:'RED',amount:100,payout:200}],[{choice:'RED',amount:100,accountId:p().id}]])unchanged(()=>play(p,body('ROULETTE',bets)),/INPUT_INVALID/);
 for(const amount of [0,-100,99,101,100.5,'100',null,Number.MAX_SAFE_INTEGER+1])unchanged(()=>play(p,body('ROULETTE',[{choice:'RED',amount} ])),/AMOUNT_INVALID/);
 unchanged(()=>play(p,{...body('ROULETTE',valid),choice:'RED',amount:100}),/INPUT_INVALID/);
 unchanged(()=>play(p,{...body('ROULETTE',valid),balance:999999}),/INPUT_INVALID/);
 unchanged(()=>play(p,body('SLOTS',[{choice:'PLAYER',amount:100}])),/INPUT_INVALID/);
 const insufficient=member(300);unchanged(()=>play(insufficient,body('ROULETTE',[{choice:'RED',amount:100},{choice:'BLACK',amount:300}])),/ARCADE_BALANCE_REQUIRED/);
 const max=Number.MAX_SAFE_INTEGER;
 unchanged(()=>play(p,body('ROULETTE',[{choice:'RED',amount:9007199254740900},{choice:'BLACK',amount:100}])),/AMOUNT_INVALID/);
 const capped=member(max);unchanged(()=>play(capped,body('ROULETTE',[{choice:'GREEN',amount:100},{choice:'NUMBER_0',amount:100}])),/ARCADE_BALANCE_LIMIT/);
 // RED and BLACK cannot win together. At the integer boundary the shared
 // outcome maximum fits; adding mutually exclusive maxima would reject it.
 const hedged=body('ROULETTE',[{choice:'RED',amount:100},{choice:'BLACK',amount:100}]);
 verify=number(1);before=capped().balance;out=play(capped,hedged);verify();settled(capped,hedged,out,before);assert.equal(out.wallet.balance,max);
 // Storage failure rolls back the whole batch and receipt, allowing retry.
 const rollback=member(500000),save=database.SaveDatabase;number(0);
 try{database.SaveDatabase=()=>false;unchanged(()=>play(rollback,request,'FIX51-STORAGE-RETRY'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 const committed=play(rollback,request,'FIX51-STORAGE-RETRY');
 const persisted=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));s.Import(persisted);
 crypto.randomInt=()=>assert.fail('durable multi-bet replay cannot draw');assert.deepEqual(play(rollback,request,'FIX51-STORAGE-RETRY'),committed);
 for(const key of ['pointLedger','eventSpins','orders','shopPurchases','pointConversions','chargeRequests'])assert.deepEqual(s.DB()[key],{},'multi-bet arcade does not modify '+key);
 console.log('FIX51 ARCADE MULTIBET PASS: all 40 roulette cells across all 37 outcomes, all 3 baccarat outcomes, slot aggregation, duplicate-target accumulation, atomic shared settlement, aggregate/forged-input limits, exact shared-outcome headroom, rate limit, save rollback and persisted replay.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
