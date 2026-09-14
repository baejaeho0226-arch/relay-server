'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix54-casino-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),casino=require('../services/member/casino'),database=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000,sequence=0,accounts=0;
Date.now=()=>clock;
function member(balance=10000000){const subject='FIX54-CASINO-'+(++accounts),id='USR-'+subject;s.Atomic(()=>{s.DB().profiles[subject]={id,subject,nickname:'테스트',avatar:'',createdAt:clock,balance,points:0};});return ()=>s.ProfileById(id);}
function call(p,action,body,id='FIX54-CASINO-'+String(++sequence).padStart(8,'0')){return s.Operation(p(),id,'casino.'+action,body,()=>casino[{play:'Play',start:'Start',action:'Action'}[action]](p(),body));}
function fresh(){clock+=300;}
function invalid(fn,error=/INPUT_INVALID/){const before=JSON.stringify(s.DB());assert.throws(fn,error);assert.equal(JSON.stringify(s.DB()),before,'failed mutation must roll back all state');}
function ranks(values){const list=[...values];crypto.randomInt=max=>{assert.equal(max,52);assert.ok(list.length);return list.shift()-1;};return ()=>assert.equal(list.length,0);}
function shoe(values,deck=Array.from({length:312},(_,i)=>i%52)){const list=[...values],remaining=[...deck];crypto.randomInt=max=>{assert.equal(max,remaining.length);assert.ok(list.length,'unexpected card draw');const rank=list.shift(),at=remaining.findIndex(value=>value%13+1===rank);assert.ok(at>=0);remaining.splice(at,1);return at;};return ()=>assert.equal(list.length,0);}
function hidden(snapshot){const text=JSON.stringify(snapshot);assert.ok(!/"(?:secret|deck|trapTiles)"/.test(text),'running round must not disclose future cards or traps');}
function settleLedger(p,result){const rows=Object.values(s.DB().ledger).filter(row=>row.reference===result.id);assert.equal(rows.filter(row=>row.kind==='CASINO_PAYOUT').length,1);assert.equal(rows.filter(row=>row.kind==='CASINO_BET').reduce((sum,row)=>sum-row.amount,0),result.betAmount);assert.equal(rows.find(row=>row.kind==='CASINO_PAYOUT').amount,result.payout);assert.equal(result.payout-result.betAmount,result.net);assert.equal(result.balance,p().balance);}
function start(p,game){fresh();return call(p,'start',{game,amount:1000,rulesRevision:1});}
function action(p,game,round,verb,extra={}){return call(p,'action',{game,roundId:round.active.id,action:verb,...extra});}
try{
 const p=member(),rules=casino.Read(p()).rules;
 assert.ok(['LIMBO','HILO','TOWER','BLACKJACK'].every(game=>casino.Read(p(),{game}).game===game));
 assert.equal(rules.blackjack.decks,6);assert.equal(rules.blackjack.dealerStandsSoft17,true);assert.equal(rules.hilo.tieAction,'PUSH');
 // Limbo handles exact target equality, losses and the bounded tail, with
 // no client-supplied outcomes and no reroll when an operation is retried.
 for(const [target,draw,expected] of [[2,48500000,2000],[2.01,48500000,0],[1.01,100000000,0],[1000,1,1000000]]){
  fresh();crypto.randomInt=(min,max)=>{assert.equal(min,1);assert.equal(max,100000001);return draw;};
  const body={game:'LIMBO',amount:1000,rulesRevision:1,targetMultiplier:target},id='FIX54-LIMBO-'+(++sequence),out=call(p,'play',body,id);
  assert.equal(out.result.payout,expected);assert.equal(out.result.targetMultiplier,target);settleLedger(p,out.result);
  crypto.randomInt=()=>assert.fail('replay must not draw');assert.deepEqual(call(p,'play',body,id),out);
 }
 fresh();crypto.randomInt=()=>assert.fail('invalid input must not draw');
 for(const targetMultiplier of [1,0,-1,1000.01,2.001,'2',null,NaN,Infinity])invalid(()=>call(p,'play',{game:'LIMBO',amount:1000,rulesRevision:1,targetMultiplier}));
 invalid(()=>call(p,'play',{game:'LIMBO',amount:1000,rulesRevision:1,targetMultiplier:2,rollMultiplier:999}));
 // Tower traps are sampled once, remain private while playing, and can
 // only be selected from the current row. All eight clear/lose branches.
 const tower=member();crypto.randomInt=max=>{assert.equal(max,3);return 0;};let out=start(tower,'TOWER');hidden(out);
 const towerId=out.active.id;assert.deepEqual(tower().casino.TOWER.active.secret.trapTiles,[0,3,6,9,12,15,18,21]);
 invalid(()=>action(tower,'TOWER',out,'CASHOUT'),/CASINO_CASHOUT_REQUIRED/);
 invalid(()=>action(tower,'TOWER',out,'REVEAL',{tile:4}));
 for(let row=0;row<8;row++){
  const current=out;out=action(tower,'TOWER',current,'REVEAL',{tile:row*3+1});
  if(row<7){hidden(out);assert.equal(out.active.row,row+1);assert.equal(out.active.multiplier,rules.tower.multipliers[row]);invalid(()=>action(tower,'TOWER',out,'REVEAL',{tile:row*3+1}),/CASINO_TILE_OPENED/);}
 }
 assert.equal(out.active,null);assert.equal(out.result.reason,'CLEARED');assert.equal(out.result.payout,24860);settleLedger(tower,out.result);
 const ledgerCount=Object.keys(s.DB().ledger).length;
 assert.deepEqual(call(tower,'action',{game:'TOWER',roundId:towerId,action:'CASHOUT'}).result,out.result);assert.equal(Object.keys(s.DB().ledger).length,ledgerCount);
 for(let stop=0;stop<8;stop++){
  out=start(tower,'TOWER');for(let row=0;row<stop;row++)out=action(tower,'TOWER',out,'REVEAL',{tile:row*3+1});
  out=action(tower,'TOWER',out,'REVEAL',{tile:stop*3});assert.equal(out.result.reason,'TRAP_HIT');assert.equal(out.result.hitTile,stop*3);assert.equal(out.result.payout,0);settleLedger(tower,out.result);
 }
 out=start(tower,'TOWER');out=action(tower,'TOWER',out,'REVEAL',{tile:1});out=action(tower,'TOWER',out,'CASHOUT');assert.equal(out.result.payout,1450);settleLedger(tower,out.result);
 out=start(tower,'TOWER');clock+=rules.tower.expiresAfterMs;out=casino.Read(tower(),{game:'TOWER'});assert.equal(out.lastResult.reason,'EXPIRED_CASHOUT');assert.equal(out.lastResult.payout,1000);settleLedger(tower,out.lastResult);
 // Hilo draws independent server cards: Ace is low, impossible directions
 // reject before RNG, ties preserve the stake/multiplier, and outcomes are
 // replay safe. Current rank and visible history are all the client receives.
 const hilo=member();ranks([7]);out=start(hilo,'HILO');assert.equal(out.active.currentCard.rank,7);assert.equal(out.active.nextHighMultiplier,1.94);hidden(out);
 invalid(()=>action(hilo,'HILO',out,'CASHOUT'),/CASINO_CASHOUT_REQUIRED/);
 ranks([7]);out=action(hilo,'HILO',out,'HIGH');assert.equal(out.result.reason,'TIE');assert.equal(out.active.multiplier,1);assert.equal(out.active.steps,0);
 ranks([13]);out=action(hilo,'HILO',out,'HIGH');assert.equal(out.active.multiplier,1.94);assert.equal(out.active.canHigh,false);assert.equal(out.active.nextHighMultiplier,null);assert.equal(out.active.steps,1);
 crypto.randomInt=()=>assert.fail('impossible prediction cannot draw');invalid(()=>action(hilo,'HILO',out,'HIGH'));
 out=action(hilo,'HILO',out,'CASHOUT');assert.equal(out.result.payout,1940);settleLedger(hilo,out.result);
 ranks([1]);out=start(hilo,'HILO');assert.equal(out.active.canLow,false);assert.equal(out.active.nextHighMultiplier,1);ranks([2]);out=action(hilo,'HILO',out,'HIGH');assert.equal(out.active.multiplier,1);
 ranks([1]);out=action(hilo,'HILO',out,'HIGH');assert.equal(out.result.reason,'MISSED');assert.equal(out.result.payout,0);settleLedger(hilo,out.result);
 ranks([7]);out=start(hilo,'HILO');ranks([1]);out=action(hilo,'HILO',out,'LOW');assert.equal(out.active.multiplier,1.94);clock+=rules.hilo.expiresAfterMs;out=casino.Read(hilo(),{game:'HILO'});assert.equal(out.lastResult.payout,1940);assert.equal(out.lastResult.reason,'EXPIRED_CASHOUT');settleLedger(hilo,out.lastResult);
 ranks([7]);out=start(hilo,'HILO');for(let i=0;i<64;i++){ranks([7]);out=action(hilo,'HILO',out,'HIGH');}assert.equal(out.active,null);assert.equal(out.result.reason,'CLEARED');assert.equal(out.result.turns,64);assert.equal(out.result.payout,1000);
 // Full blackjack card hands, natural payouts and all settlement outcomes.
 // Initial deal order is player/dealer/player/dealer; all dealer draws and
 // the shoe stay private until the same atomic transaction settles.
 const bj=member();
 for(const [cards,verb,reason,payout,total,dealer] of [
  [[1,9,13,8],null,'NATURAL',2500,21,17],
  [[1,1,13,13],null,'PUSH',1000,21,21],
  [[10,1,8,13],null,'DEALER_BLACKJACK',0,18,21],
  [[10,10,8,7],'STAND','PLAYER_WIN',2000,18,17],
  [[10,10,7,8],'STAND','DEALER_WIN',0,17,18],
  [[10,10,8,8],'STAND','PUSH',1000,18,18],
  [[10,10,8,6,10],'STAND','DEALER_BUST',2000,18,26],
  [[10,9,6,8,10],'HIT','PLAYER_BUST',0,26,17],
  [[10,1,8,6],'STAND','PLAYER_WIN',2000,18,17],
  [[1,10,1,7,9],'HIT','PLAYER_WIN',2000,21,17]
 ]){
  const verify=shoe(cards);out=start(bj,'BLACKJACK');if(verb){assert.equal(out.active.dealerCards.length,1);assert.equal(out.active.dealerHidden,true);hidden(out);out=action(bj,'BLACKJACK',out,verb);}verify();
  assert.equal(out.active,null);assert.equal(out.result.reason,reason);assert.equal(out.result.payout,payout);assert.equal(out.result.playerTotal,total);assert.equal(out.result.dealerTotal,dealer);assert.equal(out.result.dealerHidden,false);settleLedger(bj,out.result);
 }
 shoe([5,10,6,7,10]);out=start(bj,'BLACKJACK');const doubleId=out.active.id;assert.equal(out.active.canDouble,true);out=action(bj,'BLACKJACK',out,'DOUBLE');assert.equal(out.result.doubled,true);assert.equal(out.result.betAmount,2000);assert.equal(out.result.payout,4000);assert.equal(out.result.extraBetIds.length,1);settleLedger(bj,out.result);
 const doubleLedger=Object.keys(s.DB().ledger).length;call(bj,'action',{game:'BLACKJACK',roundId:doubleId,action:'DOUBLE'});assert.equal(Object.keys(s.DB().ledger).length,doubleLedger);
 shoe([5,10,6,7,2]);out=start(bj,'BLACKJACK');out=action(bj,'BLACKJACK',out,'HIT');assert.equal(out.active.playerTotal,13);assert.equal(out.active.canDouble,false);invalid(()=>action(bj,'BLACKJACK',out,'DOUBLE'));out=action(bj,'BLACKJACK',out,'STAND');assert.equal(out.result.reason,'DEALER_WIN');
 const poor=member(1000);shoe([5,10,6,7]);out=start(poor,'BLACKJACK');assert.equal(out.active.canDouble,false);invalid(()=>action(poor,'BLACKJACK',out,'DOUBLE'),/ARCADE_BALANCE_REQUIRED/);
 invalid(()=>action(poor,'BLACKJACK',out,'CASHOUT'));invalid(()=>action(poor,'BLACKJACK',out,'HIT',{tile:1}));
 const unrelated=member();invalid(()=>call(unrelated,'action',{game:'BLACKJACK',roundId:out.active.id,action:'HIT'}),/CASINO_ROUND_NOT_FOUND/);
 // Durable active hand reconnect, failed double debit and failed payout
 // both roll back the shoe/hand/balance. Exact operation retry draws once.
 shoe([5,10,6,7]);out=start(bj,'BLACKJACK');const persisted=JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8'));s.Import(persisted);hidden(casino.Read(bj(),{game:'BLACKJACK'}));
 const save=database.SaveDatabase,body={game:'BLACKJACK',roundId:out.active.id,action:'DOUBLE'},operation='FIX54-BJ-ROLLBACK-DOUBLE';
 try{shoe([10],bj().casino.BLACKJACK.active.secret.deck);database.SaveDatabase=()=>false;invalid(()=>call(bj,'action',body,operation),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(bj().casino.BLACKJACK.active.playerCards.length,2);assert.equal(bj().casino.BLACKJACK.active.doubled,false);shoe([10],bj().casino.BLACKJACK.active.secret.deck);out=call(bj,'action',body,operation);assert.equal(out.result.payout,4000);settleLedger(bj,out.result);
 crypto.randomInt=()=>assert.fail('durable settlement replay cannot draw');s.Import(JSON.parse(fs.readFileSync(require('../config/config').DB_FILE,'utf8')));assert.deepEqual(call(bj,'action',body,operation),out);
 shoe([10,10,8,6]);out=start(bj,'BLACKJACK');clock+=rules.blackjack.expiresAfterMs;
 try{shoe([10],bj().casino.BLACKJACK.active.secret.deck);database.SaveDatabase=()=>false;invalid(()=>casino.Read(bj(),{game:'BLACKJACK'}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 shoe([10],bj().casino.BLACKJACK.active.secret.deck);out=casino.Read(bj(),{game:'BLACKJACK'});assert.equal(out.lastResult.expired,true);assert.equal(out.lastResult.reason,'DEALER_BUST');settleLedger(bj,out.lastResult);
 const expiryState=JSON.stringify(s.DB());casino.Read(bj(),{game:'BLACKJACK'});assert.equal(JSON.stringify(s.DB()),expiryState);
 // Credits from another active game can consume reserved headroom. A move
 // must reject before drawing or inspecting a hidden winning/losing tile;
 // otherwise failed winning outcomes could be rerolled into payable losses.
 function fillHeadroom(account,available){s.Atomic(()=>s.Ledger(account(),Number.MAX_SAFE_INTEGER-available-account().balance,'FIX54_OTHER_GAME_CREDIT','HEADROOM'));}
 const cappedBj=member();shoe([10,9,7,6]);out=start(cappedBj,'BLACKJACK');const cappedBjId=out.active.id;fillHeadroom(cappedBj,1000);
 let hiddenDraws=0;crypto.randomInt=()=>{hiddenDraws++;return 0;};
 for(let retry=0;retry<2;retry++)for(const verb of ['STAND','HIT','DOUBLE'])invalid(()=>call(cappedBj,'action',{game:'BLACKJACK',roundId:cappedBjId,action:verb}),/ARCADE_BALANCE_LIMIT/);
 assert.equal(hiddenDraws,0);let limited=casino.Read(cappedBj(),{game:'BLACKJACK'});assert.equal(limited.active.canStand,false);assert.equal(limited.active.canHit,false);assert.equal(limited.active.canDouble,false);
 clock+=rules.blackjack.expiresAfterMs;invalid(()=>casino.Read(cappedBj(),{game:'BLACKJACK'}),/ARCADE_BALANCE_LIMIT/);assert.equal(hiddenDraws,0);
 s.Atomic(()=>s.Ledger(cappedBj(),-5000,'FIX54_SPEND','HEADROOM'));const resumedDraw=shoe([8],cappedBj().casino.BLACKJACK.active.secret.deck);
 limited=casino.Read(cappedBj(),{game:'BLACKJACK'});resumedDraw();assert.equal(limited.lastResult.reason,'DEALER_BUST');assert.equal(limited.lastResult.payout,2000);settleLedger(cappedBj,limited.lastResult);
 const cappedHilo=member();ranks([7]);out=start(cappedHilo,'HILO');ranks([7]);out=action(cappedHilo,'HILO',out,'HIGH');const cappedHiloId=out.active.id;fillHeadroom(cappedHilo,1000);
 hiddenDraws=0;crypto.randomInt=()=>{hiddenDraws++;return 0;};
 for(const verb of ['HIGH','LOW'])invalid(()=>call(cappedHilo,'action',{game:'HILO',roundId:cappedHiloId,action:verb}),/ARCADE_BALANCE_LIMIT/);
 assert.equal(hiddenDraws,0);limited=casino.Read(cappedHilo(),{game:'HILO'});assert.equal(limited.active.canHigh,false);assert.equal(limited.active.canLow,false);assert.equal(limited.active.canCashout,true,'a smaller deterministic cashout stays available');
 out=action(cappedHilo,'HILO',limited,'CASHOUT');assert.equal(out.result.payout,1000);settleLedger(cappedHilo,out.result);
 for(const game of ['MINES','TOWER']){
  const blocked=member();crypto.randomInt=()=>0;out=start(blocked,game);fillHeadroom(blocked,1000);const blockedId=out.active.id;
  crypto.randomInt=()=>assert.fail('persisted tiles cannot redraw');
  // Tile zero is a trap and tile one is safe in both deterministic fixtures.
  for(const tile of [0,1])invalid(()=>call(blocked,'action',{game,roundId:blockedId,action:'REVEAL',tile}),/ARCADE_BALANCE_LIMIT/);
  assert.deepEqual(blocked().casino[game].active.revealed,[]);
  s.Atomic(()=>s.Ledger(blocked(),-1000,'FIX54_SPEND','REVEAL-HEADROOM'));
  out=call(blocked,'action',{game,roundId:blockedId,action:'REVEAL',tile:0});assert.equal(out.result.payout,0);assert.ok(['MINE_HIT','TRAP_HIT'].includes(out.result.reason));
 }
 // Transport-forged fields and overflow fail before draws; all wagers use
 // the existing KRW integer ledger regardless of display currency choices.
 fresh();crypto.randomInt=()=>assert.fail('invalid input may not draw');
 for(const game of ['HILO','TOWER','BLACKJACK']){
  invalid(()=>call(p,'start',{game,amount:1000,rulesRevision:1,mines:3}));
  invalid(()=>call(p,'start',{game,amount:101,rulesRevision:1}),/AMOUNT_INVALID/);
  invalid(()=>call(p,'start',{game,amount:1000,rulesRevision:1,playerCards:[]}));
  const max=member(Number.MAX_SAFE_INTEGER);invalid(()=>call(max,'start',{game,amount:100,rulesRevision:1}),/ARCADE_BALANCE_LIMIT/);
 }
 console.log('FIX54 CASINO PASS: Limbo exact bounds/replay, every Tower row and private traps, Hilo directions/ties/expiry/turn cap, blackjack naturals/aces/soft17/all outcomes/double/reconnect/expiry, hidden cards, account ownership, integer limits, atomic save rollback and pre-draw headroom against outcome-biased retries.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
