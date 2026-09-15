'use strict';
// Protocol 1 is mirrored by MoaPlaySkillGames.pas. All positions and physics
// are integers; input is applied at the beginning of its numbered 30 Hz tick.
const TICK_HZ=30,MAX_TICKS=1800,PROTOCOL=1;
const GAME_IDS=['DINO','FLAPPY','WHACK','DODGE','RHYTHM'];
function Random(seed){let state=seed;return max=>{state=state*48271%2147483647;return state%max;};}
function Schedule(game,seed){
 const next=Random(seed),rows=[];
 if(game==='DINO')for(let spawn=60;spawn<=MAX_TICKS;){rows.push({spawn,height:60+next(3)*20});spawn+=65+next(25);}
 else if(game==='FLAPPY')for(let spawn=30;spawn<=MAX_TICKS;spawn+=100)rows.push({spawn,center:180+next(241)});
 else if(game==='WHACK')for(let spawn=1;spawn<=MAX_TICKS;spawn+=24)rows.push({spawn,lane:next(9)});
 else if(game==='DODGE')for(let spawn=30;spawn<=MAX_TICKS;){rows.push({spawn,lane:next(5)});spawn+=15+next(11);}
 else if(game==='RHYTHM')for(let spawn=1;spawn<=MAX_TICKS-45;spawn+=12)rows.push({spawn,lane:next(4)});
 return rows;
}
function Invalid(){const e=Error('EVENT_TRACE_INVALID');e.memberError=true;throw e;}
function ValidateActions(game,ticks,actions){
 if(!GAME_IDS.includes(game)||!Number.isSafeInteger(ticks)||ticks<1||ticks>MAX_TICKS||!Array.isArray(actions)||actions.length>ticks)Invalid();
 let previous=0;
 for(const input of actions){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['t','a','lane'].includes(k))||!Number.isSafeInteger(input.t)||input.t<=previous||input.t>ticks)Invalid();
  previous=input.t;
  if(game==='DODGE'){
   if(input.a!=='move'||!Number.isSafeInteger(input.lane)||input.lane<0||input.lane>4)Invalid();
  }else{
   if(input.a!=='tap')Invalid();
   if(game==='WHACK'||game==='RHYTHM'){
    if(!Number.isSafeInteger(input.lane)||input.lane<0||input.lane>(game==='WHACK'?8:3))Invalid();
   }else if(Object.hasOwn(input,'lane'))Invalid();
  }
 }
}
function Simulate(game,seed,ticks,actions){
 ValidateActions(game,ticks,actions);
 if(!Number.isSafeInteger(seed)||seed<1||seed>1000000000)Invalid();
 const rows=Schedule(game,seed),hit=new Set(),passed=new Set();
 let score=0,jumpTick=-30,y=300,v=0,lane=2,lastMove=-4,inputIndex=0;
 for(let t=1;t<=ticks;t++){
  const input=actions[inputIndex]?.t===t?actions[inputIndex++]:null;
  if(game==='DINO'){
   if(input&&t-jumpTick>=30)jumpTick=t;
   const k=t-jumpTick,offset=k>=0&&k<=30?k*(30-k):0;
   for(let i=0;i<rows.length&&rows[i].spawn<=t;i++){
    const x=1000-(t-rows[i].spawn)*12;
    if(x<=225&&x+45>=180&&offset<rows[i].height)return End(t,true);
    if(x+45<180&&!passed.has(i)){passed.add(i);score+=10;}
   }
  }else if(game==='FLAPPY'){
   if(input)v=-10;y+=v;v=Math.min(v+1,12);
   if(y-18<=0||y+18>=600)return End(t,true);
   for(let i=0;i<rows.length&&rows[i].spawn<=t;i++){
    const x=1000-(t-rows[i].spawn)*7,center=rows[i].center;
    if(x<=238&&x+65>=202&&(y-18<center-115||y+18>center+115))return End(t,true);
    if(x+65<202&&!passed.has(i)){passed.add(i);score+=10;}
   }
  }else if(game==='WHACK'){
   if(input){const i=Math.floor((t-1)/24),row=rows[i];
    if(t-row.spawn<18&&input.lane===row.lane&&!hit.has(i)){hit.add(i);score+=10;}else score=Math.max(0,score-2);
   }
  }else if(game==='DODGE'){
   if(input){if(Math.abs(input.lane-lane)!==1||t-lastMove<4)Invalid();lane=input.lane;lastMove=t;}
   for(const row of rows)if(row.spawn+45===t){if(row.lane===lane)return End(t,true);score+=5;}
  }else if(game==='RHYTHM'&&input){
   let best=-1,distance=5;
   for(let i=0;i<rows.length;i++){const d=Math.abs(t-(rows[i].spawn+45));if(rows[i].lane===input.lane&&!hit.has(i)&&d<distance){best=i;distance=d;}}
   if(best>=0){hit.add(best);score+=distance<=1?10:7;}
  }
 }
 return End(ticks,false);
 function End(at,collision){
  // No input may be reported after a collision, nor extra simulation ticks.
  if(at!==ticks||inputIndex!==actions.length)Invalid();
  return {ticks:at,score,outcome:collision?'COLLISION':at===MAX_TICKS?'COMPLETE':'STOPPED'};
 }
}
module.exports={TICK_HZ,MAX_TICKS,PROTOCOL,GAME_IDS,Random,Schedule,ValidateActions,Simulate};
