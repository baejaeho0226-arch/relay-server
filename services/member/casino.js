'use strict';
const crypto=require('node:crypto'),s=require('./store'),indicators=require('./indicators'),arcade=require('./arcade');

// App credits only: these games do not accept external money or offer cash-out.
// Every draw, elapsed time, stake and settlement is decided on this server.
const GAMES=Object.freeze({CRASH:'크래시',DICE:'다이스',MINES:'마인즈',PLINKO:'플링코',LIMBO:'림보',HILO:'하이로우',TOWER:'타워',BLACKJACK:'블랙잭'});
const REVISION=1,MIN_BET=100,STEP=100,INTERVAL=300,MAX=Number.MAX_SAFE_INTEGER;
const CRASH_GROWTH_MS=8000,MAX_MULTIPLIER_CENTS=100000,MINES_TTL=30*60*1000;
const TOWER_ROWS=8,TOWER_COLUMNS=3,HILO_MAX_TURNS=64;
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
 plinko:{rows:8,risks:Object.keys(PLINKO_CENTS),multipliers:Object.fromEntries(Object.entries(PLINKO_CENTS).map(([key,values])=>[key,values.map(value=>value/100)]))},
 limbo:{minTarget:1.01,maxTarget:1000,defaultTarget:2,step:0.01,baseReturnPercent:97,comparison:'GTE'},
 hilo:{ace:'LOW',tieAction:'PUSH',rankCount:13,independentDraws:true,baseReturnPercent:97,maxMultiplier:1000,maxTurns:HILO_MAX_TURNS,expiresAfterMs:MINES_TTL,expiryAction:'AUTO_CASHOUT'},
 tower:{rows:TOWER_ROWS,columns:TOWER_COLUMNS,trapsPerRow:1,expiresAfterMs:MINES_TTL,expiryAction:'AUTO_CASHOUT',multipliers:Array.from({length:TOWER_ROWS},(_,i)=>TowerCents(i+1)/100)},
 blackjack:{decks:6,blackjackPayout:1.5,payoutIncludesStake:true,dealerStandsSoft17:true,double:'FIRST_TWO_CARDS',split:false,insurance:false,surrender:false,expiresAfterMs:MINES_TTL,expiryAction:'AUTO_STAND'}};}
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
 if(maximum>MAX-s.ReservedBalance(p)-remaining)s.Fail('ARCADE_BALANCE_LIMIT');
 for(const value of [stats.played+1,stats.matched+1,stats.score+1,stats.streak+1,stats.totalStaked+amount,stats.totalPayout+maximum,stats.netWin-amount,stats.netWin+(maximum-amount)])
  if(!Number.isSafeInteger(value))s.Fail('ARCADE_BALANCE_LIMIT');
 if(p.casinoPlayedAt&&Date.now()-p.casinoPlayedAt<INTERVAL)s.Fail('ARCADE_WAIT');
}
function CheckSettlementHeadroom(p,round,maxCents){
 if(!p||!Number.isSafeInteger(p.balance)||p.balance<0)s.Fail('BALANCE_INVALID');
 const maximum=Pay(round.betAmount,maxCents),stats=Stats(p.casino?.[round.game]);
 if(maximum>MAX-s.ReservedBalance(p)-p.balance)s.Fail('ARCADE_BALANCE_LIMIT');
 for(const value of [stats.played+1,stats.matched+1,stats.score+1,stats.streak+1,stats.totalStaked+round.betAmount,
  stats.totalPayout+maximum,stats.netWin-round.betAmount,stats.netWin+(maximum-round.betAmount)])
  if(!Number.isSafeInteger(value))s.Fail('ARCADE_BALANCE_LIMIT');
}
function CanSettle(p,round,cents){
 if(!p||cents===null)return false;
 try{CheckSettlementHeadroom(p,round,cents);return true;}catch(e){if(e.memberError&&['ARCADE_BALANCE_LIMIT','BALANCE_INVALID'].includes(e.message))return false;throw e;}
}
function MinesCents(mines,count){
 if(count===0)return 100;
 let numerator=97n,denominator=1n;
 for(let i=0;i<count;i++){numerator*=BigInt(25-i);denominator*=BigInt(25-mines-i);}
 return Number(numerator/denominator>BigInt(MAX_MULTIPLIER_CENTS)?BigInt(MAX_MULTIPLIER_CENTS):numerator/denominator);
}
function TowerCents(count){return count===0?100:Number(97n*3n**BigInt(count)/2n**BigInt(count));}
function Card(value){const rank=value%13+1;return {rank,suit:['S','H','D','C'][Math.floor(value/13)],label:({1:'A',11:'J',12:'Q',13:'K'})[rank]||String(rank)};}
function NewCard(){return Card(crypto.randomInt(52));}
function DrawCard(round){
 const deck=round.secret.deck;if(!deck.length)s.Fail('INPUT_INVALID');
 return Card(deck.splice(crypto.randomInt(deck.length),1)[0]);
}
function Hand(cards){
 let total=0,aces=0;for(const card of cards){total+=Math.min(card.rank,10);if(card.rank===1)aces++;}
 const soft=aces>0&&total+10<=21;if(soft)total+=10;return {total,soft};
}
function HiloNext(round,direction){
 const count=direction==='HIGH'?13-round.currentCard.rank:round.currentCard.rank-1;if(count===0)return null;
 // Ties push. Extreme ranks offer no-profit safe movement; every other
 // successful prediction uses the conditional 97% return, rounded down.
 return Math.min(MAX_MULTIPLIER_CENTS,Math.max(round.multiplierCents,Math.floor(round.multiplierCents*1164/(count*100))));
}
function BlackjackDoubleAllowed(p,round){
 const amount=round.betAmount,stats=Stats(p?.casino?.BLACKJACK);
 return !!p&&round.playerCards.length===2&&!round.doubled&&Hand(round.playerCards).total<21&&p.balance>=amount&&
  Number.isSafeInteger(amount*2)&&Number.isSafeInteger(p.balance+amount*3)&&amount*3<=MAX-s.ReservedBalance(p)-p.balance&&
  [stats.totalStaked+amount*2,stats.totalPayout+amount*4,stats.netWin+amount*2,stats.netWin-amount*2].every(Number.isSafeInteger);
}
function BlackjackFields(round,reveal=false,p){
 const player=Hand(round.playerCards),dealerCards=reveal?round.dealerCards:round.dealerCards.slice(0,1),dealer=Hand(dealerCards);
 return {playerCards:structuredClone(round.playerCards),dealerCards:structuredClone(dealerCards),dealerHidden:!reveal,
  playerTotal:player.total,playerSoft:player.soft,dealerTotal:dealer.total,dealerSoft:dealer.soft,doubled:!!round.doubled,
  canHit:!reveal&&player.total<21&&CanSettle(p,round,200),canStand:!reveal&&CanSettle(p,round,200),canDouble:!reveal&&BlackjackDoubleAllowed(p,round)};
}
function CrashCents(round,now){return Math.min(MAX_MULTIPLIER_CENTS,Math.floor(Math.exp(Math.max(0,now-round.startedAt)/CRASH_GROWTH_MS)*100));}
function Due(round,now){return !!round&&(round.game==='CRASH'?CrashCents(round,now)>=round.secret.crashCents:now>=round.expiresAt);}
function Active(round,now=Date.now(),p){
 if(!round)return null;
 const cents=round.game==='CRASH'?CrashCents(round,now):round.game==='MINES'?MinesCents(round.mines,round.revealed.length):
  round.game==='TOWER'?TowerCents(round.revealed.length):round.game==='HILO'?round.multiplierCents:100;
 const active={id:round.id,roundId:round.id,game:round.game,status:'RUNNING',betAmount:round.betAmount,startedAt:round.startedAt,expiresAt:round.expiresAt,
  serverTime:now,multiplier:cents/100,payout:Pay(round.betAmount,cents),canCashout:(round.game==='CRASH'?!Due(round,now):round.game==='BLACKJACK'?false:round.game==='HILO'?round.turns>0:round.revealed.length>0)&&CanSettle(p,round,cents),virtual:true,redeemable:false,rulesRevision:REVISION};
 if(round.game==='CRASH')Object.assign(active,{elapsedMs:Math.max(0,now-round.startedAt),growthMs:CRASH_GROWTH_MS});
 else if(round.game==='MINES')Object.assign(active,{mines:round.mines,totalTiles:25,revealed:[...round.revealed],nextMultiplier:round.revealed.length<25-round.mines?MinesCents(round.mines,round.revealed.length+1)/100:null});
 else if(round.game==='TOWER')Object.assign(active,{rows:TOWER_ROWS,columns:TOWER_COLUMNS,row:round.revealed.length,revealed:[...round.revealed],nextMultiplier:round.revealed.length<TOWER_ROWS?TowerCents(round.revealed.length+1)/100:null});
 else if(round.game==='HILO')Object.assign(active,{currentCard:structuredClone(round.currentCard),cards:structuredClone(round.cards),steps:round.steps,turns:round.turns,
  canHigh:CanSettle(p,round,HiloNext(round,'HIGH')),canLow:CanSettle(p,round,HiloNext(round,'LOW')),nextHighMultiplier:HiloNext(round,'HIGH')===null?null:HiloNext(round,'HIGH')/100,nextLowMultiplier:HiloNext(round,'LOW')===null?null:HiloNext(round,'LOW')/100});
 else if(round.game==='BLACKJACK')Object.assign(active,BlackjackFields(round,false,p));
 return active;
}
function Snapshot(p,game,now=Date.now()){
 const record=p.casino?.[game]||{};
 return {mode:'VIRTUAL_BALANCE',virtual:true,redeemable:false,game,wallet:arcade.Wallet(p),rules:Rules(),
  games:Object.entries(GAMES).map(([id,name])=>({id,name,stats:Stats(p.casino?.[id])})),stats:Stats(record),
  active:Active(record.active,now,p),lastResult:structuredClone(record.lastResult||null),history:structuredClone(record.history||[]),indicators:indicators.Snapshot(game,record)};
}
function Receipt(p,game,result){const response={...Snapshot(p,game),result:structuredClone(result)};response.wallet.revision=s.DB().revision+1;return response;}
function Debit(p,round){
 const ledger=s.Ledger(p,-round.betAmount,'CASINO_BET',round.id);Object.assign(ledger,{game:round.game,virtual:true,redeemable:false});round.betId=ledger.id;
}
function Finish(p,round,cents,details={}){
 const old=p.casino?.[round.game]||{},stats=Stats(old),payout=Pay(round.betAmount,cents),net=payout-round.betAmount,matched=payout>=round.betAmount;
 // An unrelated wallet credit may have consumed headroom since Start. Reject
 // atomically, preserving the round and its stake until headroom is available.
 if(payout>MAX-s.ReservedBalance(p)-p.balance)s.Fail('ARCADE_BALANCE_LIMIT');
 const ledger=s.Ledger(p,payout,'CASINO_PAYOUT',round.id);Object.assign(ledger,{game:round.game,virtual:true,redeemable:false});
 const result={id:round.id,roundId:round.id,game:round.game,at:Date.now(),startedAt:round.startedAt,betAmount:round.betAmount,
  multiplier:cents/100,payout,net,matched,status:net>0?'WIN':net===0?'PUSH':'LOSS',scoreEarned:matched?1:0,virtual:true,redeemable:false,rulesRevision:REVISION,
  betId:round.betId,payoutId:ledger.id,balance:p.balance,...(round.extraBetIds?{extraBetIds:[...round.extraBetIds]}:{}),...details};
 stats.played++;stats.matched+=matched?1:0;stats.score+=matched?1:0;stats.streak=matched?stats.streak+1:0;stats.bestStreak=Math.max(stats.bestStreak,stats.streak);
 stats.totalStaked+=round.betAmount;stats.totalPayout+=payout;stats.netWin+=net;
 for(const value of Object.values(stats))if(!Number.isSafeInteger(value))s.Fail('ARCADE_BALANCE_LIMIT');
 p.casino={...p.casino,[round.game]:{...stats,active:null,lastResult:result,history:[result,...(old.history||[])].slice(0,10),indicatorRounds:indicators.Append(old,result)}};
 return result;
}
function TowerFields(round){return {rows:TOWER_ROWS,columns:TOWER_COLUMNS,row:round.revealed.length,revealed:[...round.revealed],trapTiles:[...round.secret.trapTiles]};}
function HiloFields(round){return {currentCard:structuredClone(round.currentCard),cards:structuredClone(round.cards),steps:round.steps,turns:round.turns};}
function BlackjackStand(p,round,expired=false){
 // Other games and credits can consume Start's wallet headroom. Reject the
 // whole decision before drawing, not only its winning outcomes afterward.
 CheckSettlementHeadroom(p,round,200);
 const player=Hand(round.playerCards);
 if(player.total>21)return Finish(p,round,0,{...BlackjackFields(round,true),reason:'PLAYER_BUST',...(expired?{expired:true}:{})});
 while(Hand(round.dealerCards).total<17)round.dealerCards.push(DrawCard(round));
 const dealer=Hand(round.dealerCards),reason=dealer.total>21?'DEALER_BUST':player.total>dealer.total?'PLAYER_WIN':player.total<dealer.total?'DEALER_WIN':'PUSH';
 return Finish(p,round,reason==='PUSH'?100:reason==='DEALER_WIN'?0:200,{...BlackjackFields(round,true),reason,...(expired?{expired:true}:{})});
}
function Expire(p,game,now=Date.now()){
 const round=p.casino?.[game]?.active;if(!Due(round,now))return null;
 if(game==='CRASH')return Finish(p,round,0,{reason:'CRASHED',crashMultiplier:round.secret.crashCents/100,elapsedMs:Math.max(0,now-round.startedAt)});
 if(game==='BLACKJACK')return BlackjackStand(p,round,true);
 if(game==='HILO')return Finish(p,round,round.multiplierCents,{reason:'EXPIRED_CASHOUT',...HiloFields(round)});
 if(game==='TOWER')return Finish(p,round,TowerCents(round.revealed.length),{reason:'EXPIRED_CASHOUT',...TowerFields(round)});
 return Finish(p,round,MinesCents(round.mines,round.revealed.length),{reason:'EXPIRED_CASHOUT',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles]});
}
function Read(p,body={}){
 Input(body,['game','_since']);const game=Game(body.game===undefined?'CRASH':body.game),now=Date.now();
 if(Due(p.casino?.[game]?.active,now))s.Atomic(()=>{
  Expire(p,game,now);
  // This transition may be triggered by a read, without the normal mutation
  // hooks. Capture is idempotent and runs in the same durable transaction.
  const badges=require('./badges');if(typeof badges.Settle==='function')badges.Settle(p);else if(typeof badges.Capture==='function')badges.Capture(p);
 });
 return Snapshot(p,game,now);
}
function Play(p,body={}){
 Input(body,['game','amount','rulesRevision','direction','threshold','risk','targetMultiplier']);const game=Game(body.game);
 if(!['DICE','PLINKO','LIMBO'].includes(game))s.Fail('INPUT_INVALID');
 const amount=Stake(body);let maxCents;
 if(game==='DICE'){
  if(Object.hasOwn(body,'risk')||Object.hasOwn(body,'targetMultiplier')||!['UNDER','OVER'].includes(body.direction)||!Number.isInteger(body.threshold)||body.threshold<5||body.threshold>95)s.Fail('INPUT_INVALID');
  maxCents=Math.floor(9700/(body.direction==='UNDER'?body.threshold:100-body.threshold));
 }else if(game==='PLINKO'){
  if(Object.hasOwn(body,'direction')||Object.hasOwn(body,'threshold')||Object.hasOwn(body,'targetMultiplier')||typeof body.risk!=='string'||!Object.hasOwn(PLINKO_CENTS,body.risk))s.Fail('INPUT_INVALID');
  maxCents=Math.max(...PLINKO_CENTS[body.risk]);
 }else{
  const target=body.targetMultiplier,cents=Math.round(target*100);
  if(['direction','threshold','risk'].some(key=>Object.hasOwn(body,key))||typeof target!=='number'||!Number.isFinite(target)||target<1.01||target>1000||Math.abs(cents/100-target)>1e-10)s.Fail('INPUT_INVALID');
  maxCents=cents;
 }
 Prepare(p,game,amount,maxCents);
 const round={id:s.Id('CASINO'),game,betAmount:amount,startedAt:Date.now()};let cents,details;
 if(game==='DICE'){
  const roll=crypto.randomInt(100),won=body.direction==='UNDER'?roll<body.threshold:roll>=body.threshold;
  cents=won?maxCents:0;details={roll,threshold:body.threshold,direction:body.direction,winMultiplier:maxCents/100,reason:won?'MATCHED':'MISSED'};
 }else if(game==='PLINKO'){
  const path=Array.from({length:8},()=>crypto.randomInt(2)),bucket=path.reduce((total,direction)=>total+direction,0);
  cents=PLINKO_CENTS[body.risk][bucket];details={rows:8,path,bucket,risk:body.risk,multipliers:PLINKO_CENTS[body.risk].map(value=>value/100),reason:'LANDED'};
 }else{
  const draw=crypto.randomInt(1,100000001),roll=Math.max(100,Math.min(MAX_MULTIPLIER_CENTS,Math.floor(9700000000/draw))),won=roll>=maxCents;
  cents=won?maxCents:0;details={rollMultiplier:roll/100,targetMultiplier:maxCents/100,reason:won?'MATCHED':'MISSED'};
 }
 Debit(p,round);const result=Finish(p,round,cents,details);p.casinoPlayedAt=round.startedAt;return Receipt(p,game,result);
}
function Start(p,body={}){
 Input(body,['game','amount','rulesRevision','mines']);const game=Game(body.game);
 if(!['CRASH','MINES','HILO','TOWER','BLACKJACK'].includes(game))s.Fail('INPUT_INVALID');
 const amount=Stake(body),mines=Object.hasOwn(body,'mines')?body.mines:3;
 if(game!=='MINES'&&Object.hasOwn(body,'mines')||game==='MINES'&&(!Number.isInteger(mines)||mines<1||mines>10))s.Fail('INPUT_INVALID');
 Expire(p,game);if(p.casino?.[game]?.active)s.Fail('CASINO_ACTIVE');
 Prepare(p,game,amount,game==='BLACKJACK'?250:game==='TOWER'?TowerCents(TOWER_ROWS):game==='MINES'?MinesCents(mines,25-mines):MAX_MULTIPLIER_CENTS);
 const now=Date.now(),round={id:s.Id('CASINO'),game,betAmount:amount,startedAt:now,expiresAt:now+(game==='CRASH'?Math.ceil(Math.log(MAX_MULTIPLIER_CENTS/100)*CRASH_GROWTH_MS):MINES_TTL)};
 if(game==='CRASH'){
  // Uniform cryptographic draw with a 97% tail before 0.01x truncation and a
  // bounded 1000x cap. The threshold stays private across reconnects.
  const draw=crypto.randomInt(1,100000001);
  round.secret={crashCents:Math.max(100,Math.min(MAX_MULTIPLIER_CENTS,Math.floor(9700000000/draw)))};
 }else if(game==='MINES'){
  const tiles=Array.from({length:25},(_,index)=>index),mineTiles=[];
  for(let i=0;i<mines;i++){const index=crypto.randomInt(tiles.length);mineTiles.push(tiles[index]);tiles[index]=tiles[tiles.length-1];tiles.pop();}
  Object.assign(round,{mines,revealed:[],secret:{mineTiles:mineTiles.sort((a,b)=>a-b)}});
 }else if(game==='TOWER'){
  Object.assign(round,{revealed:[],secret:{trapTiles:Array.from({length:TOWER_ROWS},(_,row)=>row*TOWER_COLUMNS+crypto.randomInt(TOWER_COLUMNS))}});
 }else if(game==='HILO'){
  const currentCard=NewCard();Object.assign(round,{currentCard,cards:[currentCard],steps:0,turns:0,multiplierCents:100});
 }else{
  Object.assign(round,{secret:{deck:Array.from({length:312},(_,i)=>i%52)},playerCards:[],dealerCards:[],doubled:false});
  round.playerCards.push(DrawCard(round));round.dealerCards.push(DrawCard(round));round.playerCards.push(DrawCard(round));round.dealerCards.push(DrawCard(round));
 }
 Debit(p,round);p.casino={...p.casino,[game]:{...(p.casino?.[game]||Stats()),active:round}};p.casinoPlayedAt=now;
 let terminal;
 if(game==='BLACKJACK'){
  const natural=Hand(round.playerCards).total===21,dealerNatural=Hand(round.dealerCards).total===21;
  if(natural||dealerNatural)terminal=Finish(p,round,natural?(dealerNatural?100:250):0,{...BlackjackFields(round,true),reason:natural?(dealerNatural?'PUSH':'NATURAL'):'DEALER_BLACKJACK'});
 }
 if(!terminal)terminal=Expire(p,game);return Receipt(p,game,terminal||Active(round,now,p));
}
function Action(p,body={}){
 Input(body,['game','roundId','action','tile']);const game=Game(body.game);
 const actions={CRASH:['CASHOUT'],MINES:['CASHOUT','REVEAL'],TOWER:['CASHOUT','REVEAL'],HILO:['CASHOUT','HIGH','LOW'],BLACKJACK:['HIT','STAND','DOUBLE']};
 if(!actions[game]?.includes(body.action)||typeof body.roundId!=='string'||!/^CASINO-[A-F0-9]{24}$/.test(body.roundId))s.Fail('INPUT_INVALID');
 if(body.action==='REVEAL'){
  if(!Number.isInteger(body.tile)||body.tile<0||body.tile>=(game==='TOWER'?TOWER_ROWS*TOWER_COLUMNS:25))s.Fail('INPUT_INVALID');
 }else if(Object.hasOwn(body,'tile'))s.Fail('INPUT_INVALID');
 const round=p.casino?.[game]?.active;
 if(!round||round.id!==body.roundId){
  const prior=(p.casino?.[game]?.history||[]).find(result=>result.id===body.roundId);if(prior)return Receipt(p,game,prior);
  s.Fail('CASINO_ROUND_NOT_FOUND');
 }
 const now=Date.now(),expired=Expire(p,game,now);if(expired)return Receipt(p,game,expired);
 let result;
 if(game==='CRASH')result=Finish(p,round,CrashCents(round,now),{reason:'CASHED_OUT',elapsedMs:Math.max(0,now-round.startedAt),crashMultiplier:round.secret.crashCents/100});
 else if(game==='BLACKJACK'){
  if(body.action==='STAND')result=BlackjackStand(p,round);
  else{
   if(body.action==='DOUBLE'){
    if(round.playerCards.length!==2||round.doubled)s.Fail('INPUT_INVALID');
    if(p.balance<round.betAmount)s.Fail('ARCADE_BALANCE_REQUIRED');
    if(!BlackjackDoubleAllowed(p,round))s.Fail('ARCADE_BALANCE_LIMIT');
    const ledger=s.Ledger(p,-round.betAmount,'CASINO_BET',round.id);Object.assign(ledger,{game,virtual:true,redeemable:false});
    round.extraBetIds=[ledger.id];round.betAmount*=2;round.doubled=true;
   }
   CheckSettlementHeadroom(p,round,200);
   round.playerCards.push(DrawCard(round));
   const total=Hand(round.playerCards).total;
   result=total>=21||round.doubled?BlackjackStand(p,round):Active(round,now,p);
  }
 }else if(game==='HILO'){
  if(body.action==='CASHOUT'){
   if(!round.turns)s.Fail('CASINO_CASHOUT_REQUIRED');
   result=Finish(p,round,round.multiplierCents,{reason:'CASHED_OUT',...HiloFields(round)});
  }else{
   const next=HiloNext(round,body.action);if(next===null)s.Fail('INPUT_INVALID');
   CheckSettlementHeadroom(p,round,next);
   const oldRank=round.currentCard.rank,card=NewCard(),tie=oldRank===card.rank,won=body.action==='HIGH'?card.rank>oldRank:card.rank<oldRank;
   round.currentCard=card;round.cards.push(card);round.turns++;
   if(won){round.steps++;round.multiplierCents=next;}
   if(!tie&&!won)result=Finish(p,round,0,{reason:'MISSED',direction:body.action,...HiloFields(round)});
   else if(round.turns>=HILO_MAX_TURNS||round.multiplierCents===MAX_MULTIPLIER_CENTS)result=Finish(p,round,round.multiplierCents,{reason:'CLEARED',direction:body.action,tie,...HiloFields(round)});
   else result={...Active(round,now,p),reason:tie?'TIE':'MATCHED',direction:body.action,tie};
  }
 }else if(game==='TOWER'){
  if(body.action==='CASHOUT'){
   if(!round.revealed.length)s.Fail('CASINO_CASHOUT_REQUIRED');
   result=Finish(p,round,TowerCents(round.revealed.length),{reason:'CASHED_OUT',...TowerFields(round)});
  }else{
   if(round.revealed.includes(body.tile))s.Fail('CASINO_TILE_OPENED');
   if(Math.floor(body.tile/TOWER_COLUMNS)!==round.revealed.length)s.Fail('INPUT_INVALID');
   CheckSettlementHeadroom(p,round,TowerCents(round.revealed.length+1));
   if(round.secret.trapTiles.includes(body.tile))result=Finish(p,round,0,{reason:'TRAP_HIT',hitTile:body.tile,...TowerFields(round)});
   else{
    round.revealed.push(body.tile);
    result=round.revealed.length===TOWER_ROWS?Finish(p,round,TowerCents(TOWER_ROWS),{reason:'CLEARED',...TowerFields(round)}):{...Active(round,now,p),revealedTile:body.tile};
   }
  }
 }else if(body.action==='CASHOUT'){
  if(!round.revealed.length)s.Fail('CASINO_CASHOUT_REQUIRED');
  result=Finish(p,round,MinesCents(round.mines,round.revealed.length),{reason:'CASHED_OUT',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles]});
 }else{
  if(round.revealed.includes(body.tile))s.Fail('CASINO_TILE_OPENED');
  CheckSettlementHeadroom(p,round,MinesCents(round.mines,round.revealed.length+1));
  if(round.secret.mineTiles.includes(body.tile))result=Finish(p,round,0,{reason:'MINE_HIT',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles],hitTile:body.tile});
  else{
   round.revealed.push(body.tile);
   if(round.revealed.length===25-round.mines)result=Finish(p,round,MinesCents(round.mines,round.revealed.length),{reason:'CLEARED',mines:round.mines,totalTiles:25,revealed:[...round.revealed],mineTiles:[...round.secret.mineTiles]});
   else result={...Active(round,now,p),revealedTile:body.tile};
  }
 }
 return Receipt(p,game,result);
}
module.exports={Read,Play,Start,Action};
