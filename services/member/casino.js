'use strict';
const crypto=require('node:crypto'),s=require('./store'),arcade=require('./arcade');

// App credits only: these games do not accept external money or offer cash-out.
// Every draw, elapsed time, stake and settlement is decided on this server.
const GAMES=Object.freeze({CRASH:'크래시',DICE:'다이스',MINES:'마인즈',PLINKO:'플링코'});
const REVISION=1,MIN_BET=100,STEP=100,INTERVAL=300,MAX=Number.MAX_SAFE_INTEGER;
const CRASH_GROWTH_MS=8000,MAX_MULTIPLIER_CENTS=100000,MINES_TTL=30*60*1000;
const PLINKO_CENTS=Object.freeze({
 LOW:Object.freeze([560,210,110,90,58,90,110,210,560]),
 MEDIUM:Object.freeze([1300,300,130,60,49,60,130,300,1300]),
 HIGH:Object.freeze([2900,400,130,37,17,37,130,400,2900])
});
function Rules(){return {revision:REVISION,mode:'VIRTUAL_BALANCE',virtual:true,redeemable:false,currency:'BALANCE',
 chips:[100,500,1000,5000,10000],minBet:MIN_BET,maxBet:null,maxBetMode:'AVAILABLE_BALANCE',step:STEP,maxBalance:MAX,minIntervalMs:INTERVAL,payoutIncludesStake:true,
 crash:{growthMs:CRASH_GROWTH_MS,maxMultiplier:MAX_MULTIPLIER_CENTS/100,serverTimed:true},
 dice:{minThreshold:5,maxThreshold:95,minRoll:0,maxRoll:99,directions:['UNDER','OVER'],underComparison:'LT',overComparison:'GTE',baseReturnPercent:97,multiplierRounding:'FLOOR_2_DECIMALS'},
 mines:{rows:5,columns:5,totalTiles:25,minMines:1,maxMines:10,defaultMines:3,maxMultiplier:MAX_MULTIPLIER_CENTS/100,expiresAfterMs:MINES_TTL,expiryAction:'AUTO_CASHOUT'},
 plinko:{rows:8,risks:Object.keys(PLINKO_CENTS),multipliers:Object.fromEntries(Object.entries(PLINKO_CENTS).map(([key,values])=>[key,values.map(value=>value/100)]))}};}
function Game(value){if(typeof value!=='string'||!Object.hasOwn(GAMES,value))s.Fail('INPUT_INVALID');return value;}
function Input(body,keys){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>![...keys,'_wire','_delta'].includes(key)))s.Fail('INPUT_INVALID');
}
function Stats(record={}){
 const result={played:0,matched:0,score:0,streak:0,bestStreak:0,totalStaked:0,totalPayout:0,netWin:0};
 for(const key of Object.keys(result)){
  const value=record[key]??0;if(!Number.isSafeInteger(value)||(key!=='netWin'&&value<0))s.Fail('INPUT_INVALID');result[key]=value;
 }
 return result;
}
function Pay(amount,cents){
 const value=BigInt(amount)*BigInt(cents)/100n;if(value>BigInt(MAX)||value<0n)s.Fail('ARCADE_BALANCE_LIMIT');return Number(value);
}
function Stake(body){
 if(body.rulesRevision!==REVISION)s.Fail('ARCADE_RULES_CHANGED');
 const amount=s.Money(body.amount,MIN_BET,MAX);if(amount%STEP!==0)s.Fail('AMOUNT_INVALID');return amount;
}
function Prepare(p,game,amount,maxCents){
 if(!Number.isSafeInteger(p.balance)||p.balance<0)s.Fail('BALANCE_INVALID');
 if(p.balance<amount)s.Fail('ARCADE_BALANCE_REQUIRED');
 const maximum=Pay(amount,maxCents),remaining=p.balance-amount,stats=Stats(p.casino?.[game]);
 if(maximum>MAX-remaining)s.Fail('ARCADE_BALANCE_LIMIT');
 for(const value of [stats.played+1,stats.matched+1,stats.score+1,stats.streak+1,stats.totalStaked+amount,stats.totalPayout+maximum,stats.netWin-amount,stats.netWin+(maximum-amount)])
  if(!Number.isSafeInteger(value))s.Fail('ARCADE_BALANCE_LIMIT');
 if(p.casinoPlayedAt&&Date.now()-p.casinoPlayedAt<INTERVAL)s.Fail('ARCADE_WAIT');
}
function MinesCents(mines,count){
 if(count===0)return 100;
 let numerator=97n,denominator=1n;
 for(let i=0;i<count;i++){numerator*=BigInt(25-i);denominator*=BigInt(25-mines-i);}
 return Number(numerator/denominator>BigInt(MAX_MULTIPLIER_CENTS)?BigInt(MAX_MULTIPLIER_CENTS):numerator/denominator);
}
function CrashCents(round,now){return Math.min(MAX_MULTIPLIER_CENTS,Math.floor(Math.exp(Math.max(0,now-round.startedAt)/CRASH_GROWTH_MS)*100));}
function Due(round,now){return !!round&&(round.game==='CRASH'?CrashCents(round,now)>=round.secret.crashCents:now>=round.expiresAt);}
function Active(round,now=Date.now()){
 if(!round)return null;
 const cents=round.game==='CRASH'?CrashCents(round,now):MinesCents(round.mines,round.revealed.length);
 const active={id:round.id,roundId:round.id,game:round.game,status:'RUNNING',betAmount:round.betAmount,startedAt:round.startedAt,expiresAt:round.expiresAt,
  serverTime:now,multiplier:cents/100,payout:Pay(round.betAmount,cents),canCashout:round.game==='CRASH'?!Due(round,now):round.revealed.length>0,virtual:true,redeemable:false,rulesRevision:REVISION};
 if(round.game==='CRASH')Object.assign(active,{elapsedMs:Math.max(0,now-round.startedAt),growthMs:CRASH_GROWTH_MS});
 else Object.assign(active,{mines:round.mines,totalTiles:25,revealed:[...round.revealed],nextMultiplier:round.revealed.length<25-round.mines?MinesCents(round.mines,round.revealed.length+1)/100:null});
 return active;
}
function Snapshot(p,game,now=Date.now()){
 const record=p.casino?.[game]||{};
 return {mode:'VIRTUAL_BALANCE',virtual:true,redeemable:false,game,wallet:arcade.Wallet(p),rules:Rules(),
  games:Object.entries(GAMES).map(([id,name])=>({id,name,stats:Stats(p.casino?.[id])})),stats:Stats(record),
  active:Active(record.active,now),lastResult:structuredClone(record.lastResult||null),history:structuredClone(record.history||[])};
}
function Receipt(p,game,result){const response={...Snapshot(p,game),result:structuredClone(result)};response.wallet.revision=s.DB().revision+1;return response;}
function Debit(p,round){
 const ledger=s.Ledger(p,-round.betAmount,'CASINO_BET',round.id);Object.assign(ledger,{game:round.game,virtual:true,redeemable:false});round.betId=ledger.id;
}
function Finish(p,round,cents,details={}){
 const old=p.casino?.[round.game]||{},stats=Stats(old),payout=Pay(round.betAmount,cents),net=payout-round.betAmount,matched=payout>=round.betAmount;
 // An unrelated wallet credit may have consumed headroom since Start. Reject
 // atomically, preserving the round and its stake until headroom is available.
 if(payout>MAX-p.balance)s.Fail('ARCADE_BALANCE_LIMIT');
 const ledger=s.Ledger(p,payout,'CASINO_PAYOUT',round.id);Object.assign(ledger,{game:round.game,virtual:true,redeemable:false});
 const result={id:round.id,roundId:round.id,game:round.game,at:Date.now(),startedAt:round.startedAt,betAmount:round.betAmount,
  multiplier:cents/100,payout,net,matched,status:net>0?'WIN':net===0?'PUSH':'LOSS',scoreEarned:matched?1:0,virtual:true,redeemable:false,rulesRevision:REVISION,
  betId:round.betId,payoutId:ledger.id,balance:p.balance,...details};
 stats.played++;stats.matched+=matched?1:0;stats.score+=matched?1:0;stats.streak=matched?stats.streak+1:0;stats.bestStreak=Math.max(stats.bestStreak,stats.streak);
 stats.totalStaked+=round.betAmount;stats.totalPayout+=payout;stats.netWin+=net;
 for(const value of Object.values(stats))if(!Number.isSafeInteger(value))s.Fail('ARCADE_BALANCE_LIMIT');
 p.casino={...p.casino,[round.game]:{...stats,active:null,lastResult:result,history:[result,...(old.history||[])].slice(0,10)}};
 return result;
}
function Expire(p,game,now=Date.now()){
 const round=p.casino?.[game]?.active;if(!Due(round,now))return null;
 if(game==='CRASH')return Finish(p,round,0,{reason:'CRASHED',crashMultiplier:round.secret.crashCents/100,elapsedMs:Math.max(0,now-round.startedAt)});
 return Finish(p,round,MinesCents(round.mines,round.revealed.length),{reason:'EXPIRED_CASHOUT',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles]});
}
function Read(p,body={}){
 Input(body,['game','_since']);const game=Game(body.game===undefined?'CRASH':body.game),now=Date.now();
 if(Due(p.casino?.[game]?.active,now))s.Atomic(()=>{
  Expire(p,game,now);
  // This transition may be triggered by a read, without the normal mutation
  // hooks. Capture is idempotent and runs in the same durable transaction.
  const badges=require('./badges');if(typeof badges.Capture==='function')badges.Capture(p);
 });
 return Snapshot(p,game,now);
}
function Play(p,body={}){
 Input(body,['game','amount','rulesRevision','direction','threshold','risk']);const game=Game(body.game);
 if(!['DICE','PLINKO'].includes(game))s.Fail('INPUT_INVALID');
 const amount=Stake(body);let maxCents;
 if(game==='DICE'){
  if(Object.hasOwn(body,'risk')||!['UNDER','OVER'].includes(body.direction)||!Number.isInteger(body.threshold)||body.threshold<5||body.threshold>95)s.Fail('INPUT_INVALID');
  maxCents=Math.floor(9700/(body.direction==='UNDER'?body.threshold:100-body.threshold));
 }else{
  if(Object.hasOwn(body,'direction')||Object.hasOwn(body,'threshold')||typeof body.risk!=='string'||!Object.hasOwn(PLINKO_CENTS,body.risk))s.Fail('INPUT_INVALID');
  maxCents=Math.max(...PLINKO_CENTS[body.risk]);
 }
 Prepare(p,game,amount,maxCents);
 const round={id:s.Id('CASINO'),game,betAmount:amount,startedAt:Date.now()};let cents,details;
 if(game==='DICE'){
  const roll=crypto.randomInt(100),won=body.direction==='UNDER'?roll<body.threshold:roll>=body.threshold;
  cents=won?maxCents:0;details={roll,threshold:body.threshold,direction:body.direction,winMultiplier:maxCents/100,reason:won?'MATCHED':'MISSED'};
 }else{
  const path=Array.from({length:8},()=>crypto.randomInt(2)),bucket=path.reduce((total,direction)=>total+direction,0);
  cents=PLINKO_CENTS[body.risk][bucket];details={rows:8,path,bucket,risk:body.risk,multipliers:PLINKO_CENTS[body.risk].map(value=>value/100),reason:'LANDED'};
 }
 Debit(p,round);const result=Finish(p,round,cents,details);p.casinoPlayedAt=round.startedAt;return Receipt(p,game,result);
}
function Start(p,body={}){
 Input(body,['game','amount','rulesRevision','mines']);const game=Game(body.game);
 if(!['CRASH','MINES'].includes(game))s.Fail('INPUT_INVALID');
 const amount=Stake(body),mines=Object.hasOwn(body,'mines')?body.mines:3;
 if(game==='CRASH'&&Object.hasOwn(body,'mines')||game==='MINES'&&(!Number.isInteger(mines)||mines<1||mines>10))s.Fail('INPUT_INVALID');
 Expire(p,game);if(p.casino?.[game]?.active)s.Fail('CASINO_ACTIVE');
 Prepare(p,game,amount,game==='CRASH'?MAX_MULTIPLIER_CENTS:MinesCents(mines,25-mines));
 const now=Date.now(),round={id:s.Id('CASINO'),game,betAmount:amount,startedAt:now,expiresAt:now+(game==='CRASH'?Math.ceil(Math.log(MAX_MULTIPLIER_CENTS/100)*CRASH_GROWTH_MS):MINES_TTL)};
 if(game==='CRASH'){
  // Uniform cryptographic draw with a 97% tail before 0.01x truncation and a
  // bounded 1000x cap. The threshold stays private across reconnects.
  const draw=crypto.randomInt(1,100000001);
  round.secret={crashCents:Math.max(100,Math.min(MAX_MULTIPLIER_CENTS,Math.floor(9700000000/draw)))};
 }else{
  const tiles=Array.from({length:25},(_,index)=>index),mineTiles=[];
  for(let i=0;i<mines;i++){const index=crypto.randomInt(tiles.length);mineTiles.push(tiles[index]);tiles[index]=tiles[tiles.length-1];tiles.pop();}
  Object.assign(round,{mines,revealed:[],secret:{mineTiles:mineTiles.sort((a,b)=>a-b)}});
 }
 Debit(p,round);p.casino={...p.casino,[game]:{...(p.casino?.[game]||Stats()),active:round}};p.casinoPlayedAt=now;
 const terminal=Expire(p,game);return Receipt(p,game,terminal||Active(round,now));
}
function Action(p,body={}){
 Input(body,['game','roundId','action','tile']);const game=Game(body.game);
 if(!['CRASH','MINES'].includes(game)||typeof body.roundId!=='string'||!/^CASINO-[A-F0-9]{24}$/.test(body.roundId)||!['CASHOUT','REVEAL'].includes(body.action))s.Fail('INPUT_INVALID');
 if(body.action==='REVEAL'){
  if(game!=='MINES'||!Number.isInteger(body.tile)||body.tile<0||body.tile>=25)s.Fail('INPUT_INVALID');
 }else if(Object.hasOwn(body,'tile'))s.Fail('INPUT_INVALID');
 const round=p.casino?.[game]?.active;
 if(!round||round.id!==body.roundId){
  const prior=(p.casino?.[game]?.history||[]).find(result=>result.id===body.roundId);if(prior)return Receipt(p,game,prior);
  s.Fail('CASINO_ROUND_NOT_FOUND');
 }
 const now=Date.now(),expired=Expire(p,game,now);if(expired)return Receipt(p,game,expired);
 let result;
 if(game==='CRASH')result=Finish(p,round,CrashCents(round,now),{reason:'CASHED_OUT',elapsedMs:Math.max(0,now-round.startedAt),crashMultiplier:round.secret.crashCents/100});
 else if(body.action==='CASHOUT'){
  if(!round.revealed.length)s.Fail('CASINO_CASHOUT_REQUIRED');
  result=Finish(p,round,MinesCents(round.mines,round.revealed.length),{reason:'CASHED_OUT',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles]});
 }else{
  if(round.revealed.includes(body.tile))s.Fail('CASINO_TILE_OPENED');
  if(round.secret.mineTiles.includes(body.tile))result=Finish(p,round,0,{reason:'MINE_HIT',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles],hitTile:body.tile});
  else{
   round.revealed.push(body.tile);
   if(round.revealed.length===25-round.mines)result=Finish(p,round,MinesCents(round.mines,round.revealed.length),{reason:'CLEARED',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles]});
   else result={...Active(round),revealedTile:body.tile};
  }
 }
 return Receipt(p,game,result);
}
module.exports={Read,Play,Start,Action};
