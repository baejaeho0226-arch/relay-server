'use strict';
// FIX58: bounded, account-local charts of completed server results only.
// Road construction: Microgaming's Baccarat Roadmap Manual, reproduced at
// https://www.livedealer.org/the-baccarat-roadmap-manual/ (rules 2a/2b and layout).
// Roads describe the recent completed rounds; this game's shoe is freshly
// shuffled per round, so the window is deliberately not labelled a shoe.
const LIMIT=120,STATUS=new Set(['WIN','PUSH','LOSS']);
const COLORS={WIN:'GREEN',PUSH:'NEUTRAL',LOSS:'RED'};
function Compact(result){
 if(!result||typeof result!=='object'||!STATUS.has(result.status)||typeof result.id!=='string')return null;
 const out={id:result.id,game:result.game,status:result.status,at:result.at};
 // Explicit whitelist: no balance, stake, ledger IDs, account, active state or secrets.
 for(const key of ['winner','number','color','reason','risk'])if(typeof result[key]==='string'||Number.isFinite(result[key]))out[key]=result[key];
 for(const key of ['multiplier','crashMultiplier','rollMultiplier','roll','bucket','playerTotal','dealerTotal','steps','turns','row'])
  if(Number.isFinite(result[key]))out[key]=result[key];
 if(Array.isArray(result.revealed))out.safeCount=result.revealed.length;
 if(Array.isArray(result.reels))out.symbols=result.reels.map(item=>item?.id).filter(value=>typeof value==='string').slice(0,3);
 return out;
}
function Rounds(record={},game){
 const source=Array.isArray(record.indicatorRounds)?record.indicatorRounds:Array.isArray(record.history)?record.history:[];
 const seen=new Set(),rows=[];
 for(const value of source){
  const row=Compact(value);if(!row||row.game!==game||seen.has(row.id))continue;
  // Compact rows already contain these sanitized derived fields.
  if(Number.isInteger(value.safeCount)&&value.safeCount>=0&&value.safeCount<=25)row.safeCount=value.safeCount;
  if(Array.isArray(value.symbols))row.symbols=value.symbols.filter(x=>typeof x==='string').slice(0,3);
  seen.add(row.id);rows.push(row);if(rows.length===LIMIT)break;
 }
 return rows;
}
function Append(record,result){const row=Compact(result);if(!row)return Rounds(record,result?.game);return [row,...Rounds(record,row.game).filter(item=>item.id!==row.id)].slice(0,LIMIT);}
function Road(values,style){
 const cells=[],occupied=new Set();let x=0,y=0,start=-1,last='',leadingTies=0;
 for(const color of values){
  if(color==='GREEN'){
   if(cells.length)cells[cells.length-1].ties++;else leadingTies++;
   continue;
  }
  if(color!==last){start++;while(occupied.has(start+',0'))start++;x=start;y=0;}
  else if(y<5&&!occupied.has(x+','+(y+1)))y++;
  else{do{x++;}while(occupied.has(x+','+y));}
  const cell={x,y,color,ties:cells.length===0?leadingTies:0};cells.push(cell);occupied.add(x+','+y);last=color;
 }
 if(!cells.length&&leadingTies)cells.push({x:0,y:0,color:'NONE',ties:leadingTies});
 return {kind:'road',style,rows:6,columns:Math.max(1,...cells.map(item=>item.x+1)),cells};
}
function Baccarat(rows){
 const colors=rows.map(item=>({BANKER:'RED',PLAYER:'BLUE',TIE:'GREEN'})[item.winner]).filter(Boolean);
 const bead={kind:'road',id:'bead',title:'육매',titleEn:'Bead road',style:'bead',rows:6,columns:Math.max(1,Math.ceil(colors.length/6)),cells:colors.map((color,i)=>({x:Math.floor(i/6),y:i%6,color,label:({RED:'B',BLUE:'P',GREEN:'T'})[color],ties:0}))};
 const big={...Road(colors,'ring'),id:'big',title:'대로',titleEn:'Big road'};
 const lengths=[],derived=[[],[],[]];let previous='';
 for(const color of colors){
  if(color==='GREEN')continue;
  if(color!==previous)lengths.push(0);
  const n=lengths.length-1,m=++lengths[n];previous=color;
  for(let k=1;k<=3;k++){
   let red;
   if(m===1){if(n-k-1<0)continue;red=lengths[n-1]===lengths[n-k-1];}
   else{if(n-k<0)continue;red=m!==lengths[n-k]+1;}
   derived[k-1].push(red?'RED':'BLUE');
  }
 }
 const names=[['bigEye','중국점 · 대안로','Big eye road','ring'],['small','중국점 · 소로','Small road','bead'],['cockroach','중국점 · 소강로','Cockroach road','slash']];
 return [bead,big,...derived.map((items,i)=>({...Road(items,names[i][3]),id:names[i][0],title:names[i][1],titleEn:names[i][2]}))];
}
function Bars(id,title,titleEn,items,kind='bars'){return {id,title,titleEn,kind,items};}
function Counts(rows,labels,pick){return labels.map(([key,label,color])=>({label,color:color||'BLUE',count:rows.filter(item=>pick(item)===key).length}));}
function Outcome(rows){return Bars('outcome','결과 분포','Outcome distribution',Counts(rows,[['WIN','승리','GREEN'],['PUSH','무승부','NEUTRAL'],['LOSS','패배','RED']],item=>item.status));}
function Sequence(id,title,titleEn,rows,pick,unit=''){return {id,title,titleEn,kind:'series',unit,items:rows.slice(-24).map((row,i)=>({label:String(i+1),value:Math.max(0,pick(row)||0),color:COLORS[row.status]}))};}
function Snapshot(game,record={}){
 const rows=Rounds(record,game).reverse();let charts=[];
 if(game==='BACCARAT')charts=Baccarat(rows);
 else if(game==='ROULETTE'){
  charts=[Bars('colors','색상 분포','Colour distribution',Counts(rows,[['RED','빨강','RED'],['BLACK','검정','NEUTRAL'],['GREEN','0','GREEN']],item=>item.color)),
   Bars('numbers','번호 분포 · 0–36','Number frequency · 0–36',Array.from({length:37},(_,number)=>({label:String(number),count:rows.filter(row=>row.number===number).length,color:number===0?'GREEN':'BLUE'})),'heat')];
 }else if(game==='SLOTS'){
  const symbols=[['CHERRY','체리'],['LEMON','레몬'],['GRAPE','포도'],['BELL','종'],['STAR','별'],['SEVEN','7']];
  charts=[Bars('symbols','심볼 출현','Symbol frequency',symbols.map(([id,label])=>({label,color:'BLUE',count:rows.reduce((n,row)=>n+(row.symbols||[]).filter(value=>value===id).length,0)}))),
   Bars('matches','라인 결과','Line results',Counts(rows,[[3,'불일치','NEUTRAL'],[2,'2개 일치','BLUE'],[1,'3개 일치','GREEN']],row=>new Set(row.symbols||[]).size))];
 }else if(game==='BLACKJACK'){
  charts=[Outcome(rows),Bars('totals','내 패 합계','Player hand totals',Counts(rows,[['LOW','16 이하'],['MID','17–20'],['TWENTYONE','21','GREEN'],['BUST','버스트','RED']],row=>row.playerTotal>21?'BUST':row.playerTotal===21?'TWENTYONE':row.playerTotal>=17?'MID':'LOW'))];
 }else if(game==='CRASH'||game==='LIMBO'){
  const crash=game==='CRASH';charts=[Sequence('multipliers',crash?'정산·종료 배율':'결과 배율',crash?'Collected / crashed multiplier':'Rolled multiplier',rows,row=>crash?(row.crashMultiplier??row.multiplier):row.rollMultiplier,'x'),Outcome(rows)];
 }else if(game==='DICE'){
  charts=[Bars('rolls','주사위 분포 · 0–99','Roll distribution · 0–99',Array.from({length:10},(_,i)=>({label:String(i*10),count:rows.filter(row=>row.roll>=i*10&&row.roll<(i+1)*10).length,color:'BLUE'})),'histogram'),Outcome(rows)];
 }else if(game==='MINES'){
  charts=[Bars('safe','안전 타일 발견','Safe tiles revealed',Counts(rows,[['ZERO','0개'],['LOW','1–4개'],['MID','5–9개'],['HIGH','10개 이상','GREEN']],row=>row.safeCount>=10?'HIGH':row.safeCount>=5?'MID':row.safeCount>=1?'LOW':'ZERO')),Outcome(rows)];
 }else if(game==='PLINKO'){
  charts=[Bars('pockets','도착 포켓 · 왼쪽 → 오른쪽','Landing pockets · left → right',Array.from({length:9},(_,i)=>({label:String(i+1),count:rows.filter(row=>row.bucket===i).length,color:'BLUE'})),'histogram'),
   Bars('risks','선택 난이도','Selected risk',Counts(rows,[['LOW','낮음'],['MEDIUM','중간'],['HIGH','높음']],row=>row.risk))];
 }else if(game==='HILO')charts=[Sequence('steps','연속 성공 단계','Successful steps',rows,row=>row.steps),Outcome(rows)];
 else if(game==='TOWER')charts=[Bars('levels','도달 층 · 0–8층','Floors reached · 0–8',Array.from({length:9},(_,i)=>({label:String(i),count:rows.filter(row=>row.row===i).length,color:'BLUE'})),'histogram'),Outcome(rows)];
 return {revision:1,game,sampleCount:rows.length,window:LIMIT,scope:'MEMBER_COMPLETED',charts};
}
module.exports={LIMIT,Compact,Rounds,Append,Road,Baccarat,Snapshot};
