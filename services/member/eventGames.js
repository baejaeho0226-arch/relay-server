'use strict';
const crypto=require('node:crypto'),s=require('./store');

// These are free daily point events. Wallet-funded arcade/casino rules and
// charge-funded wheel turns are deliberately independent of these counters.
const GAMES=[
 {game:'CARD',title:'행운 카드',titleEn:'Lucky Cards',description:'여섯 장 중 한 장을 골라 오늘의 행운을 확인해보세요.',descriptionEn:'Choose one of six cards and reveal today’s luck.',choices:6},
 {game:'CHEST',title:'보물상자',titleEn:'Treasure Chests',description:'세 개의 상자 중 하나를 열고 포인트 선물을 찾아보세요.',descriptionEn:'Open one of three chests to find your point gift.',choices:3},
 {game:'RPS',title:'가위바위보',titleEn:'Rock Paper Scissors',description:'가위, 바위, 보! 오늘의 한 판에 도전해보세요.',descriptionEn:'Make your choice and challenge today’s opponent.',choices:3}
];
const CARD=[{points:5,weight:45},{points:10,weight:30},{points:20,weight:20},{points:50,weight:5}];
const CHEST=[{points:5,weight:50},{points:15,weight:35},{points:40,weight:15}];
const RPS={win:30,draw:10,lose:5};
function Rules(){return structuredClone({playsPerDay:1,card:CARD,chest:CHEST,rps:RPS});}
function Read(p,now=Date.now()){
 const rewards=require('./rewards'),rules=rewards.Rules(),day=rewards.Day(now);
 return {day,enabled:rules.enabled,revision:rules.revision,rules:Rules(),games:GAMES.map(game=>{
  const state=p.eventGames?.[game.game],played=state?.day===day;
  return {...game,played,available:rules.enabled&&!played,totalPlayed:state?.played||0,lastResult:state?.lastResult?structuredClone(state.lastResult):null};
 })};
}
function Validate(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['game','choice','day','revision','_wire','_delta'].includes(key)))s.Fail('INPUT_INVALID');
 const game=GAMES.find(row=>row.game===body.game);
 if(!game||!Number.isSafeInteger(body.choice)||body.choice<0||body.choice>=game.choices||typeof body.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.day)||!Number.isSafeInteger(body.revision)||body.revision<1)s.Fail('INPUT_INVALID');
 if(Object.hasOwn(body,'_wire')&&body._wire!=='zlib'||Object.hasOwn(body,'_delta')&&typeof body._delta!=='boolean')s.Fail('INPUT_INVALID');
 return game;
}
function Draw(table){
 let draw=crypto.randomInt(table.reduce((sum,row)=>sum+row.weight,0));
 for(const row of table){if(draw<row.weight)return row.points;draw-=row.weight;}
 // Every published weight is a positive integer; this cannot be reached.
 s.Fail('INPUT_INVALID');
}
function Play(p,body){
 const game=Validate(body),rewards=require('./rewards'),rules=rewards.Rules(),now=Date.now(),day=rewards.Day(now);
 if(!rules.enabled)s.Fail('EVENT_CLOSED');
 if(body.revision!==rules.revision||body.day!==day)s.Fail('CONTENT_CHANGED');
 const old=p.eventGames?.[game.game],kind='EVENT_'+game.game;
 if(old?.day===day||s.DB().pointLedger[p.id+':'+kind+':'+day])s.Fail('EVENT_ALREADY_PLAYED');
 // Check the largest possible award before drawing or allocating an outcome.
 // Near-cap wallets must not accept only low rewards and retry rejected draws.
 const maxReward=game.game==='RPS'?RPS.win:Math.max(...(game.game==='CARD'?CARD:CHEST).map(row=>row.points)),points=p.points||0;
 if(!Number.isSafeInteger(points)||points<0||points+maxReward>100000000)s.Fail('POINT_BALANCE_INVALID');
 const eventGame={id:s.Id('EVT'),game:game.game,choice:body.choice,day,at:now,revision:rules.revision};
 if(game.game==='RPS'){
  // Indices are scissors=0, rock=1, paper=2. A one-step advance wins.
  eventGame.opponent=crypto.randomInt(3);
  const distance=(body.choice-eventGame.opponent+3)%3;
  eventGame.outcome=distance===0?'DRAW':distance===1?'WIN':'LOSE';
  eventGame.points=RPS[eventGame.outcome.toLowerCase()];
 }else eventGame.points=Draw(game.game==='CARD'?CARD:CHEST);
 const reward=rewards.Credit(p,eventGame.points,kind,day);
 p.eventGames={...p.eventGames,[game.game]:{day,played:(old?.played||0)+1,lastResult:structuredClone(eventGame)}};
 return {...rewards.Read(p),eventGame,reward};
}
module.exports={Rules,Read,Play};
