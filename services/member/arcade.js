'use strict';
const crypto=require('node:crypto'),s=require('./store'),indicators=require('./indicators');
const GAMES=Object.freeze({BACCARAT:'바카라',ROULETTE:'룰렛',SLOTS:'슬롯'});
const LEGACY_CHOICES=Object.freeze({BACCARAT:['PLAYER','TIE','BANKER'],ROULETTE:['RED','GREEN','BLACK',...Array.from({length:37},(_,number)=>'NUMBER_'+number)],SLOTS:['SPIN']});
const CHOICES=Object.freeze({BACCARAT:[...LEGACY_CHOICES.BACCARAT,'PLAYER_PAIR','BANKER_PAIR'],ROULETTE:[...LEGACY_CHOICES.ROULETTE,'EVEN','ODD','LOW','HIGH','DOZEN_1','DOZEN_2','DOZEN_3','COLUMN_1','COLUMN_2','COLUMN_3'],SLOTS:LEGACY_CHOICES.SLOTS});
const SLOT_SYMBOLS=Object.freeze([
 Object.freeze({id:'CHERRY',label:'체리'}),Object.freeze({id:'LEMON',label:'레몬'}),
 Object.freeze({id:'GRAPE',label:'포도'}),Object.freeze({id:'BELL',label:'종'}),
 Object.freeze({id:'STAR',label:'별'}),Object.freeze({id:'SEVEN',label:'7'})
]);
const RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
// Shared app credits only. These rules never receive money or provide cash-out.
const MIN_INTERVAL_MS=300,MAX_BALANCE=Number.MAX_SAFE_INTEGER,MIN_BET=100,BET_STEP=100,RULES_REVISION=5;
function Rules(){return {revision:RULES_REVISION,mode:'VIRTUAL_BALANCE',currency:'BALANCE',virtual:true,free:false,rewards:true,redeemable:false,
 chips:[100,500,1000,5000,10000],minBet:MIN_BET,maxBet:null,maxBetMode:'AVAILABLE_BALANCE',maxBalance:MAX_BALANCE,step:BET_STEP,minIntervalMs:MIN_INTERVAL_MS,multiBet:true,maxBets:50,choices:structuredClone(CHOICES),
 paytable:{BACCARAT:{PLAYER:{numerator:2,denominator:1},BANKER:{numerator:195,denominator:100},TIE:{numerator:9,denominator:1},PLAYER_PAIR:{numerator:12,denominator:1},BANKER_PAIR:{numerator:12,denominator:1},tiePush:true,pairCards:'FIRST_TWO',pairMatch:'RANK',pairTiePush:false},
 ROULETTE:{RED:2,BLACK:2,GREEN:36,NUMBER:36,EVEN:2,ODD:2,LOW:2,HIGH:2,DOZEN_1:3,DOZEN_2:3,DOZEN_3:3,COLUMN_1:3,COLUMN_2:3,COLUMN_3:3},SLOTS:{PAIR:1,TRIPLE:12,SEVEN_TRIPLE:60}},payoutIncludesStake:true};}
function Game(value){if(typeof value!=='string'||!Object.hasOwn(GAMES,value))s.Fail('INPUT_INVALID');return value;}
function Stats(value={}){return {played:value.played||0,matched:value.matched||0,score:value.score||0,streak:value.streak||0,bestStreak:value.bestStreak||0,totalStaked:value.totalStaked||0,totalPayout:value.totalPayout||0,netWin:value.netWin||0};}
function Wallet(p){return {accountId:p.id,revision:s.DB().revision,balance:p.balance,points:p.points||0,eventSpins:p.eventSpins||0};}
function Read(p,body={}){
 const game=Game(body.game||'BACCARAT'),record=p.arcade?.[game]||{};
 return {mode:'VIRTUAL_BALANCE',virtual:true,redeemable:false,game,wallet:Wallet(p),rules:Rules(),games:Object.entries(GAMES).map(([id,name])=>({id,name,stats:Stats(p.arcade?.[id]),lastResult:structuredClone(p.arcade?.[id]?.lastResult||null)})),
  stats:Stats(record),lastResult:structuredClone(record.lastResult||null),history:structuredClone(record.history||[]),indicators:indicators.Snapshot(game,record)};
}
function Card(id){
 const rankIndex=id%13,suitIndex=Math.floor(id/13)%4,rank=['A','2','3','4','5','6','7','8','9','10','J','Q','K'][rankIndex];
 return {rank,suit:['SPADE','HEART','DIAMOND','CLUB'][suitIndex],value:rankIndex<9?rankIndex+1:0,label:rank+['♠','♥','♦','♣'][suitIndex]};
}
function Total(hand){return hand.reduce((sum,card)=>sum+card.value,0)%10;}
// Standard punto-banco third-card tableau for the virtual-credit simulation.
// https://massgaming.com/wp-content/uploads/RULES-Baccarat-10-08-2020.pdf section 11.
function BankerDraw(total,third){
 if(third===null)return total<=5;
 return total<=2||total===3&&third!==8||total===4&&third>=2&&third<=7||total===5&&third>=4&&third<=7||total===6&&(third===6||third===7);
}
function Baccarat(){
 // Draw without replacement from a fresh eight-deck shoe. At most six draws.
 const shoe=Array.from({length:416},(_,i)=>i);
 const draw=()=>{const index=crypto.randomInt(shoe.length),id=shoe[index];shoe[index]=shoe[shoe.length-1];shoe.pop();return Card(id);};
 const player=[draw()],banker=[draw()];player.push(draw());banker.push(draw());
 if(Total(player)<8&&Total(banker)<8){
  let third=null;if(Total(player)<=5){const card=draw();player.push(card);third=card.value;}
  if(BankerDraw(Total(banker),third))banker.push(draw());
 }
 const playerTotal=Total(player),bankerTotal=Total(banker);
 return {player,banker,playerTotal,bankerTotal,playerPair:Pair(player),bankerPair:Pair(banker),winner:playerTotal>bankerTotal?'PLAYER':playerTotal<bankerTotal?'BANKER':'TIE'};
}
// Pair means equal ranks in the first two cards, regardless of suit or baccarat
// point value. A third card never forms this wager; ties do not push side bets.
// https://www.star.com.au/sites/default/files/2024-07/tiger_baccarat_game_guide_0.pdf
function Pair(hand){return Array.isArray(hand)&&hand.length>=2&&typeof hand[0]?.rank==='string'&&hand[0].rank===hand[1]?.rank;}
function Roulette(){const number=crypto.randomInt(37);return {number,color:number===0?'GREEN':RED.has(number)?'RED':'BLACK'};}
// Single-zero outside bets exclude zero. Returns the gross multiplier, so this
// exact same predicate is used by settlement and integer overflow reservation.
// https://www.venetianlasvegas.com/resort/casino/table-games/roulette-basic-rules.html
function RouletteMultiplier(choice,number){
 if(choice==='NUMBER_'+number||choice==='GREEN'&&number===0)return 36;
 if(number===0)return 0;
 if(choice===(RED.has(number)?'RED':'BLACK')||choice==='EVEN'&&number%2===0||choice==='ODD'&&number%2===1||choice==='LOW'&&number<=18||choice==='HIGH'&&number>=19)return 2;
 if(choice==='DOZEN_'+Math.ceil(number/12)||choice==='COLUMN_'+((number-1)%3+1))return 3;
 return 0;
}
function Slots(){
 // Each of the six symbols has equal independent probability on each reel.
 const reels=Array.from({length:3},()=>({...SLOT_SYMBOLS[crypto.randomInt(SLOT_SYMBOLS.length)]}));
 return {reels,symbol:reels.every(reel=>reel.id===reels[0].id)?reels[0].id:null};
}
function Settlement(game,choice,amount,outcome){
 let payout=0,matched=false;
 if(game==='BACCARAT'){
  if(choice==='PLAYER_PAIR'||choice==='BANKER_PAIR'){
   matched=Pair(choice==='PLAYER_PAIR'?outcome.player:outcome.banker);if(matched)payout=amount*12;
  }else{
   matched=choice===outcome.winner;
   if(matched)payout=choice==='BANKER'?(amount/100)*195:amount*(choice==='TIE'?9:2);
   else if(outcome.winner==='TIE'&&(choice==='PLAYER'||choice==='BANKER'))payout=amount;
  }
 }else if(game==='ROULETTE'){
  const multiplier=RouletteMultiplier(choice,outcome.number);matched=multiplier>0;payout=amount*multiplier;
 }else{
  const count=new Set(outcome.reels.map(reel=>reel.id)).size;
  matched=count<3;
  if(count===2)payout=amount;
  else if(count===1)payout=amount*(outcome.reels[0].id==='SEVEN'?60:12);
 }
 if(!Number.isSafeInteger(payout)||payout<0)s.Fail('AMOUNT_INVALID');
 return {matched,payout,net:payout-amount};
}
// New clients submit one aggregate per occupied area. Legacy choice/amount
// requests keep their existing payout and receipt shape. Duplicate areas are
// combined before checking the total or sampling a single round outcome.
function Bets(game,body){
 let rows;
 if(Object.hasOwn(body,'bets')){
  if(Object.hasOwn(body,'choice')||Object.hasOwn(body,'amount'))s.Fail('INPUT_INVALID');
  rows=body.bets;if(!Array.isArray(rows)||rows.length<1||rows.length>(body.rulesRevision===4?40:50))s.Fail('INPUT_INVALID');
 }else rows=[{choice:body.choice,amount:body.amount}];
 const amounts=new Map();let amount=0;
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!['choice','amount'].includes(key)))s.Fail('INPUT_INVALID');
  if(!CHOICES[game].includes(row.choice))s.Fail('INPUT_INVALID');
  if(body.rulesRevision===4&&!LEGACY_CHOICES[game].includes(row.choice))s.Fail('ARCADE_RULES_CHANGED');
  const value=s.Money(row.amount,MIN_BET,MAX_BALANCE);if(value%BET_STEP!==0)s.Fail('AMOUNT_INVALID');
  if(value>MAX_BALANCE-amount)s.Fail('AMOUNT_INVALID');amount+=value;
  amounts.set(row.choice,(amounts.get(row.choice)||0)+value);
 }
 return {amount,bets:CHOICES[game].filter(choice=>amounts.has(choice)).map(choice=>({choice,amount:amounts.get(choice)}))};
}
function MaximumPayout(game,bets){
 // Mutually exclusive outcomes cannot all win. Reserve the largest total
 // possible for a shared outcome, using exact arithmetic before any RNG call.
 const outcomes=game==='BACCARAT'?['PLAYER','BANKER','TIE']:
  game==='ROULETTE'?Array.from({length:37},(_,number)=>number):['SEVEN'];
 let maximum=0n;
 for(const outcome of outcomes){
  let payout=0n;
  for(const {choice,amount} of bets){
   const stake=BigInt(amount);
   if(game==='BACCARAT'){
    // Both pairs can occur together for every winner, including a tie. Thus
    // this is an achievable shared maximum, not a sum of exclusive winners.
    if(choice==='PLAYER_PAIR'||choice==='BANKER_PAIR')payout+=stake*12n;
    else if(choice===outcome)payout+=choice==='BANKER'?stake*195n/100n:stake*(choice==='TIE'?9n:2n);
    else if(outcome==='TIE'&&(choice==='PLAYER'||choice==='BANKER'))payout+=stake;
   }else if(game==='ROULETTE'){
    payout+=stake*BigInt(RouletteMultiplier(choice,outcome));
   }else payout+=stake*60n;
  }
  if(payout>maximum)maximum=payout;
 }
 if(maximum>BigInt(MAX_BALANCE))s.Fail('ARCADE_BALANCE_LIMIT');
 return Number(maximum);
}
function Play(p,body={}){
 if(!body||typeof body!=='object'||Array.isArray(body))s.Fail('INPUT_INVALID');
 // Identity, wallet, result, payout and RNG input always come from the server.
 if(Object.keys(body).some(key=>!['game','choice','amount','bets','rulesRevision','_wire','_delta'].includes(key)))s.Fail('INPUT_INVALID');
 const game=Game(body.game);
 if(!Object.hasOwn(body,'bets')&&!CHOICES[game].includes(body.choice))s.Fail('INPUT_INVALID');
 if(body.rulesRevision!==RULES_REVISION&&body.rulesRevision!==4)s.Fail('ARCADE_RULES_CHANGED');
 const {amount,bets}=Bets(game,body),choice=bets.length===1?bets[0].choice:'MULTIPLE';
 if(!Number.isSafeInteger(p.balance)||p.balance<0||p.balance>MAX_BALANCE)s.Fail('BALANCE_INVALID');
 if(p.balance<amount)s.Fail('ARCADE_BALANCE_REQUIRED');
 const maxPayout=MaximumPayout(game,bets);
 if(maxPayout>MAX_BALANCE-s.ReservedBalance(p)-(p.balance-amount))s.Fail('ARCADE_BALANCE_LIMIT');
 const now=Date.now();if(p.arcadePlayedAt&&now-p.arcadePlayedAt<MIN_INTERVAL_MS)s.Fail('ARCADE_WAIT');
 const old=p.arcade?.[game]||{},stats=Stats(old);
 for(const key of Object.keys(stats))if(!Number.isSafeInteger(stats[key])||(key!=='netWin'&&stats[key]<0))s.Fail('INPUT_INVALID');
 // All possible cumulative totals must fit before a result is sampled too.
 // This prevents a large winning round from being discarded after the draw.
 const possibleTotals=[stats.played+1,stats.matched+1,stats.score+1,stats.streak+1,
  stats.totalStaked+amount,stats.totalPayout+maxPayout,stats.netWin-amount,stats.netWin+(maxPayout-amount)];
 if(possibleTotals.some(value=>!Number.isSafeInteger(value)))s.Fail('ARCADE_BALANCE_LIMIT');
 const outcome=game==='BACCARAT'?Baccarat():game==='ROULETTE'?Roulette():Slots();
 const settledBets=bets.map(bet=>{
  const settled=Settlement(game,bet.choice,bet.amount,outcome);
  return {choice:bet.choice,betAmount:bet.amount,...settled,status:settled.net>0?'WIN':settled.net===0?'PUSH':'LOSS'};
 });
 const totalPayout=settledBets.reduce((sum,bet)=>sum+bet.payout,0);
 const settled={matched:settledBets.some(bet=>bet.matched),payout:totalPayout,net:totalPayout-amount},scoreEarned=settled.matched?1:0;
 const result={id:s.Id('PLAY'),game,choice,at:now,virtual:true,redeemable:false,rulesRevision:RULES_REVISION,
  bets:settledBets,betCount:bets.length,betAmount:amount,...settled,status:settled.net>0?'WIN':settled.net===0?'PUSH':'LOSS',scoreEarned,...outcome};
 stats.played++;stats.matched+=scoreEarned;stats.score+=scoreEarned;stats.streak=settled.matched?stats.streak+1:0;stats.bestStreak=Math.max(stats.bestStreak,stats.streak);
 stats.totalStaked+=amount;stats.totalPayout+=settled.payout;stats.netWin+=settled.net;
 for(const value of Object.values(stats))if(!Number.isSafeInteger(value))s.Fail('AMOUNT_INVALID');
 // Execute wraps debit, payout, stats and replay receipt in Operation.
 // A zero payout is still an explicit linked settlement row for auditability.
 const bet=s.Ledger(p,-amount,'ARCADE_BET',result.id),payout=s.Ledger(p,settled.payout,'ARCADE_PAYOUT',result.id);
 Object.assign(bet,{game,virtual:true,redeemable:false});Object.assign(payout,{game,virtual:true,redeemable:false});
 result.balance=p.balance;result.betId=bet.id;result.payoutId=payout.id;
 p.arcade={...p.arcade,[game]:{...stats,lastResult:result,history:[result,...(old.history||[])].slice(0,10),indicatorRounds:indicators.Append(old,result)}};p.arcadePlayedAt=now;
 const response={...Read(p,{game}),result:structuredClone(result)};
 response.wallet.revision=s.DB().revision+1; // Revision assigned by the enclosing Operation commit.
 return response;
}
module.exports={Read,Play,Wallet,BankerDraw,Settlement};
