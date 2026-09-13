'use strict';
const crypto=require('node:crypto'),s=require('./store');
const GAMES=Object.freeze({BACCARAT:'바카라',ROULETTE:'룰렛'});
const CHOICES=Object.freeze({BACCARAT:['PLAYER','BANKER','TIE'],ROULETTE:['RED','BLACK','GREEN']});
const RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const MIN_INTERVAL_MS=1200;
function Rules(){return {revision:1,free:true,rewards:false,redeemable:false,minIntervalMs:MIN_INTERVAL_MS};}
function Game(value){if(typeof value!=='string'||!Object.hasOwn(GAMES,value))s.Fail('INPUT_INVALID');return value;}
function Stats(value={}){return {played:value.played||0,matched:value.matched||0,score:value.score||0,streak:value.streak||0,bestStreak:value.bestStreak||0};}
function Read(p,body={}){
 const game=Game(body.game||'BACCARAT'),record=p.arcade?.[game]||{};
 return {mode:'FREE_DEMO',game,rules:Rules(),games:Object.entries(GAMES).map(([id,name])=>({id,name,stats:Stats(p.arcade?.[id]),lastResult:structuredClone(p.arcade?.[id]?.lastResult||null)})),
  stats:Stats(record),lastResult:structuredClone(record.lastResult||null),history:structuredClone(record.history||[])};
}
function Card(id){
 const rankIndex=id%13,suitIndex=Math.floor(id/13)%4,rank=['A','2','3','4','5','6','7','8','9','10','J','Q','K'][rankIndex];
 return {rank,suit:['SPADE','HEART','DIAMOND','CLUB'][suitIndex],value:rankIndex<9?rankIndex+1:0,label:rank+['♠','♥','♦','♣'][suitIndex]};
}
function Total(hand){return hand.reduce((sum,card)=>sum+card.value,0)%10;}
// Standard punto-banco third-card tableau. Card rules only; no wagers or payouts.
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
 return {player,banker,playerTotal,bankerTotal,winner:playerTotal>bankerTotal?'PLAYER':playerTotal<bankerTotal?'BANKER':'TIE'};
}
function Roulette(){const number=crypto.randomInt(37);return {number,color:number===0?'GREEN':RED.has(number)?'RED':'BLACK'};}
function Play(p,body={}){
 // These games cannot consume or create redeemable balances, points or turns.
 // Accept only the prediction and transport fields; even amount:0 is rejected.
 if(Object.keys(body).some(key=>!['game','choice','_wire','_delta'].includes(key)))s.Fail('ARCADE_DEMO_ONLY');
 const game=Game(body.game),choice=body.choice;
 if(!CHOICES[game].includes(choice))s.Fail('INPUT_INVALID');
 const now=Date.now();if(p.arcadePlayedAt&&now-p.arcadePlayedAt<MIN_INTERVAL_MS)s.Fail('ARCADE_WAIT');
 const outcome=game==='BACCARAT'?Baccarat():Roulette();
 const matched=choice===(game==='BACCARAT'?outcome.winner:outcome.color),scoreEarned=matched?1:0;
 const result={id:s.Id('PLAY'),game,choice,at:now,matched,scoreEarned,...outcome};
 const old=p.arcade?.[game]||{},stats=Stats(old);
 for(const key of ['played','matched','score','streak','bestStreak'])if(!Number.isSafeInteger(stats[key])||stats[key]<0)s.Fail('INPUT_INVALID');
 if(stats.played>=100000000)s.Fail('ARCADE_WAIT');
 stats.played++;stats.matched+=scoreEarned;stats.score+=scoreEarned;stats.streak=matched?stats.streak+1:0;stats.bestStreak=Math.max(stats.bestStreak,stats.streak);
 p.arcade={...p.arcade,[game]:{...stats,lastResult:result,history:[result,...(old.history||[])].slice(0,10)}};p.arcadePlayedAt=now;
 return {...Read(p,{game}),result:structuredClone(result)};
}
module.exports={Read,Play,BankerDraw};
