'use strict';
const crypto=require('node:crypto'),s=require('./store'),engine=require('./eventEngine');
const EXPIRY_MS=24*3600000,MAX_FINISHED=20;
const GAMES=[
 {game:'DINO',title:'공룡 게임',titleEn:'Dinosaur run',description:'장애물을 뛰어넘고 점수만큼 포인트를 받아요.',descriptionEn:'Jump over obstacles and earn a point for every score.'},
 {game:'FLAPPY',title:'플래피 버드',titleEn:'Flappy bird',description:'날갯짓으로 틈을 통과하고 기록에 도전해요.',descriptionEn:'Flap through the gaps and chase your best score.'},
 {game:'WHACK',title:'두더지 게임',titleEn:'Whack a mole',description:'나타난 두더지를 빠르게 찾아 눌러요.',descriptionEn:'Spot and tap the moles before they disappear.'},
 {game:'DODGE',title:'똥 피하기',titleEn:'Dodge drop',description:'좌우로 움직여 떨어지는 장애물을 피해요.',descriptionEn:'Move between lanes and avoid the falling obstacles.'},
 {game:'RHYTHM',title:'리듬 게임',titleEn:'Rhythm keys',description:'내려오는 노트를 타이밍에 맞춰 눌러요.',descriptionEn:'Tap the four lanes when each note reaches the line.'}
];
function Rules(){return {protocol:engine.PROTOCOL,tickHz:engine.TICK_HZ,maxTicks:engine.MAX_TICKS,pointsPerScore:1,repeatable:true};}
function PublicSession(row){return row?{id:row.id,game:row.game,seed:row.seed,startedAt:row.startedAt,expiresAt:row.expiresAt,...Rules()}:null;}
function Read(p,now=Date.now()){
 const rewards=require('./rewards'),rules=rewards.Rules(),state=p.skillEvents||{};
 return {enabled:rules.enabled,revision:rules.revision,rules:Rules(),games:GAMES.map(game=>{
  const stats=state.games?.[game.game]||{},active=(state.sessions||[]).find(row=>row.game===game.game&&row.status==='ACTIVE'&&row.expiresAt>=now);
  return {...game,available:rules.enabled,totalPlayed:stats.played||0,bestScore:stats.bestScore||0,lastResult:stats.lastResult?structuredClone(stats.lastResult):null,session:PublicSession(active)};
 })};
}
function Body(body,fields){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>![...fields,'_wire','_delta'].includes(key)))s.Fail('INPUT_INVALID');
 if(Object.hasOwn(body,'_wire')&&body._wire!=='zlib'||Object.hasOwn(body,'_delta')&&typeof body._delta!=='boolean')s.Fail('INPUT_INVALID');
}
function State(p){return p.skillEvents||(p.skillEvents={games:{},sessions:[]});}
function Prune(state,now){
 for(const row of state.sessions)if(row.status==='ACTIVE'&&row.expiresAt<now)row.status='ABANDONED';
 const keep=new Set(state.sessions.filter(row=>row.status!=='ACTIVE').slice(-MAX_FINISHED).map(row=>row.id));
 state.sessions=state.sessions.filter(row=>row.status==='ACTIVE'||keep.has(row.id));
}
function Start(p,body){
 Body(body,['game','revision']);
 if(!engine.GAME_IDS.includes(body.game)||!Number.isSafeInteger(body.revision)||body.revision<1)s.Fail('INPUT_INVALID');
 const rewards=require('./rewards'),rules=rewards.Rules(),now=Date.now();
 if(!rules.enabled)s.Fail('EVENT_CLOSED');if(body.revision!==rules.revision)s.Fail('CONTENT_CHANGED');
 const state=State(p);
 for(const row of state.sessions)if(row.game===body.game&&row.status==='ACTIVE')row.status='ABANDONED';
 const session={id:s.Id('RUN'),game:body.game,seed:crypto.randomInt(1,1000000001),startedAt:now,expiresAt:now+EXPIRY_MS,status:'ACTIVE',protocol:engine.PROTOCOL};
 state.sessions.push(session);Prune(state,now);
 return {...rewards.Read(p),session:PublicSession(session)};
}
function Finish(p,body){
 Body(body,['sessionId','ticks','actions']);
 if(typeof body.sessionId!=='string'||!/^RUN-[A-F0-9]{24}$/.test(body.sessionId))s.Fail('INPUT_INVALID');
 const state=p.skillEvents,row=state?.sessions?.find(item=>item.id===body.sessionId);
 if(!row)s.Fail('EVENT_SESSION_NOT_FOUND');
 engine.ValidateActions(row.game,body.ticks,body.actions);
 const trace=crypto.createHash('sha256').update(JSON.stringify({ticks:body.ticks,actions:body.actions})).digest('hex'),rewards=require('./rewards');
 if(row.status==='FINISHED'){
  if(row.trace!==trace)s.Fail('REQUEST_REUSED');
  return {...rewards.Read(p),result:structuredClone(row.result),reward:structuredClone(s.DB().pointLedger[p.id+':EVENT_'+row.game+':'+row.id]||null)};
 }
 if(row.status!=='ACTIVE')s.Fail('EVENT_SESSION_NOT_FOUND');
 const now=Date.now();if(now>row.expiresAt)s.Fail('EVENT_SESSION_EXPIRED');
 // Pauses are allowed. Completing a minute of physics in a shorter wall time is
 // not: the tolerance covers only scheduling/transport jitter on real devices.
 if(now+1500<row.startedAt+body.ticks*1000/engine.TICK_HZ)s.Fail('EVENT_TOO_FAST');
 const simulated=engine.Simulate(row.game,row.seed,body.ticks,body.actions),result={id:row.id,game:row.game,...simulated,points:simulated.score,at:now};
 const reward=simulated.score>0?rewards.Credit(p,simulated.score,'EVENT_'+row.game,row.id):null;
 row.status='FINISHED';row.trace=trace;row.result=result;
 const previous=state.games[row.game]||{};
 state.games[row.game]={played:(previous.played||0)+1,bestScore:Math.max(previous.bestScore||0,result.score),lastResult:structuredClone(result)};
 Prune(state,now);
 return {...rewards.Read(p),result:structuredClone(result),reward};
}
module.exports={Rules,Read,Start,Finish};
