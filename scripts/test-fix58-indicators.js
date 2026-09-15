'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix58-indicators-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),indicators=require('../services/member/indicators'),arcade=require('../services/member/arcade'),casino=require('../services/member/casino'),database=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000,sequence=0,accounts=0;Date.now=()=>clock;
function member(){const subject='FIX58-INDICATORS-'+(++accounts),id='USR-'+subject;s.Atomic(()=>{s.DB().profiles[subject]={id,subject,nickname:'지표',createdAt:clock,balance:10000000,points:0};});return ()=>s.ProfileById(id);}
function call(p,action,body,id='FIX58-INDICATORS-'+(++sequence)){clock+=300;const [service,method]=action.split('.'),api=service==='arcade'?arcade:casino;return s.Operation(p(),id,action,body,()=>api[{play:'Play',start:'Start',action:'Action'}[method]](p(),body));}
function read(p,game){return (['BACCARAT','ROULETTE','SLOTS'].includes(game)?arcade:casino).Read(p(),{game});}
function row(id,game,extra={}){return {id,game,at:clock,status:'WIN',...extra};}
function snap(game,rows){return indicators.Snapshot(game,{history:[...rows].reverse()});}
function find(data,id){return data.charts.find(chart=>chart.id===id);}
function shoe(values){const remaining=Array.from({length:312},(_,i)=>i%52),list=[...values];crypto.randomInt=max=>{assert.equal(max,remaining.length);const rank=list.shift(),index=remaining.findIndex(value=>value%13+1===rank);assert.ok(index>=0);remaining.splice(index,1);return index;};}
try{
 const wins=['TIE','TIE','BANKER','BANKER','TIE','PLAYER','PLAYER','BANKER','PLAYER'];
 const b=snap('BACCARAT',wins.map((winner,i)=>row(String(i),'BACCARAT',{winner})));
 assert.equal(b.sampleCount,9);assert.equal(b.charts.length,5);
 assert.deepEqual(find(b,'bead').cells.map(item=>[item.x,item.y]),[[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[1,0],[1,1],[1,2]]);
 assert.deepEqual(find(b,'big').cells.map(item=>[item.x,item.y,item.ties]),[[0,0,2],[0,1,1],[1,0,0],[1,1,0],[2,0,0],[3,0,0]]);
 assert.deepEqual(find(b,'bigEye').cells.map(item=>item.color),['RED','RED','BLUE']);
 assert.deepEqual(find(b,'small').cells.map(item=>item.color),['BLUE']);assert.equal(find(b,'cockroach').cells.length,0);
 const onlyTies=snap('BACCARAT',[row('t1','BACCARAT',{winner:'TIE'}),row('t2','BACCARAT',{winner:'TIE'})]);
 assert.deepEqual(find(onlyTies,'big').cells,[{x:0,y:0,color:'NONE',ties:2}]);assert.equal(find(onlyTies,'bigEye').cells.length,0);
 const dragon=indicators.Road([...Array(10).fill('RED'),...Array(8).fill('BLUE'),...Array(12).fill('RED'),...Array(9).fill('BLUE')],'ring');
 assert.deepEqual(dragon.cells.slice(0,10).map(item=>[item.x,item.y]),[[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[1,5],[2,5],[3,5],[4,5]]);
 assert.deepEqual([dragon.cells[10].x,dragon.cells[10].y],[1,0]);
 assert.equal(new Set(dragon.cells.map(item=>item.x+','+item.y)).size,39,'dragon tails and new streaks never overwrite earlier marks');
 assert.ok(dragon.cells.every(item=>item.y>=0&&item.y<6));
 const plain=['BANKER','BANKER','PLAYER','PLAYER','BANKER','BANKER','PLAYER','PLAYER','BANKER'];
 const withTies=plain.flatMap(winner=>[winner,'TIE','TIE']);
 const roads=values=>snap('BACCARAT',values.map((winner,i)=>row(String(i),'BACCARAT',{winner})));
 for(const id of ['bigEye','small','cockroach'])assert.deepEqual(find(roads(plain),id),find(roads(withTies),id),'ties do not influence derived roads');
 // Bounded migration keeps a compact, explicit whitelist and idempotent append.
 let record={history:Array.from({length:10},(_,i)=>row('old-'+i,'DICE',{roll:i,multiplier:1.94,balance:999,betId:'PRIVATE',secret:{roll:99}}))};
 assert.equal(indicators.Snapshot('DICE',record).sampleCount,10);
 for(let i=0;i<125;i++)record={...record,indicatorRounds:indicators.Append(record,row('new-'+i,'DICE',{roll:i%100,status:i%2?'LOSS':'WIN',active:{secret:123}}))};
 assert.equal(record.indicatorRounds.length,120);assert.equal(record.indicatorRounds[0].id,'new-124');assert.equal(record.indicatorRounds.at(-1).id,'new-5');
 assert.deepEqual(indicators.Append(record,record.indicatorRounds[0]),record.indicatorRounds);
 assert.ok(!/balance|betId|secret|active/.test(JSON.stringify(record.indicatorRounds)));
 assert.equal(indicators.Snapshot('DICE',{history:[row('x','DICE',{roll:2,status:'RUNNING'}),row('y','PLINKO',{bucket:2}),row('z','DICE',{roll:2}),row('z','DICE',{roll:2})]}).sampleCount,1);
 const roulette=snap('ROULETTE',[row('1','ROULETTE',{number:0,color:'GREEN'}),row('2','ROULETTE',{number:36,color:'RED'}),row('3','ROULETTE',{number:36,color:'RED'})]);
 assert.equal(find(roulette,'numbers').items.length,37);assert.equal(find(roulette,'numbers').items[36].count,2);assert.equal(find(roulette,'colors').items[0].count,2);
 const slots=snap('SLOTS',[row('1','SLOTS',{reels:[{id:'SEVEN'},{id:'SEVEN'},{id:'SEVEN'}]}),row('2','SLOTS',{reels:[{id:'CHERRY'},{id:'CHERRY'},{id:'BELL'}]})]);
 assert.equal(find(slots,'symbols').items.find(item=>item.label==='7').count,3);assert.deepEqual(find(slots,'matches').items.map(item=>item.count),[0,1,1]);
 const dice=snap('DICE',[0,9,10,99].map((roll,i)=>row(String(i),'DICE',{roll})));assert.deepEqual(find(dice,'rolls').items.map(item=>item.count),[2,1,0,0,0,0,0,0,0,1]);
 assert.equal(find(snap('CRASH',[row('1','CRASH',{multiplier:0,crashMultiplier:2.57,status:'LOSS'})]),'multipliers').items[0].value,2.57);
 assert.equal(find(snap('LIMBO',[row('1','LIMBO',{rollMultiplier:3.51,multiplier:2})]),'multipliers').items[0].value,3.51);
 assert.equal(find(snap('MINES',[row('1','MINES',{revealed:[1,2,3,4,5]})]),'safe').items[2].count,1);
 assert.equal(find(snap('PLINKO',[row('1','PLINKO',{bucket:8,risk:'HIGH'})]),'pockets').items[8].count,1);
 assert.equal(find(snap('HILO',[row('1','HILO',{steps:5,turns:8})]),'steps').items[0].value,5);
 assert.equal(find(snap('TOWER',[row('1','TOWER',{row:8})]),'levels').items[8].count,1);
 assert.equal(find(snap('BLACKJACK',[row('1','BLACKJACK',{playerTotal:26})]),'totals').items[3].count,1);
 // Actual server settlements, including active rounds and reconnect expiry.
 const p=member(),other=member(),expected={};
 crypto.randomInt=max=>0;
 for(const [game,choice] of [['BACCARAT','PLAYER'],['ROULETTE','RED'],['SLOTS','SPIN']]){
  const out=call(p,'arcade.play',{game,choice,amount:100,rulesRevision:4});assert.equal(out.indicators.sampleCount,1);expected[game]=out.indicators;
 }
 for(const [game,extra] of [['DICE',{direction:'UNDER',threshold:50}],['PLINKO',{risk:'LOW'}],['LIMBO',{targetMultiplier:2}]]){
  crypto.randomInt=(min,max)=>max?48500000:0;const out=call(p,'casino.play',{game,amount:100,rulesRevision:1,...extra});assert.equal(out.indicators.sampleCount,1);expected[game]=out.indicators;
 }
 crypto.randomInt=(min,max)=>48500000;let out=call(p,'casino.start',{game:'CRASH',amount:100,rulesRevision:1});
 assert.equal(out.indicators.sampleCount,0);assert.ok(!JSON.stringify(out.indicators).includes('crashMultiplier'));clock+=8000;
 out=read(p,'CRASH');assert.equal(out.indicators.sampleCount,1);expected.CRASH=out.indicators;
 crypto.randomInt=()=>0;out=call(p,'casino.start',{game:'MINES',amount:100,rulesRevision:1,mines:3});
 assert.equal(out.indicators.sampleCount,0);out=call(p,'casino.action',{game:'MINES',roundId:out.active.id,action:'REVEAL',tile:1});
 assert.equal(out.indicators.sampleCount,0,'incomplete safe progress is not charted');out=call(p,'casino.action',{game:'MINES',roundId:out.active.id,action:'CASHOUT'});expected.MINES=out.indicators;
 out=call(p,'casino.start',{game:'TOWER',amount:100,rulesRevision:1});out=call(p,'casino.action',{game:'TOWER',roundId:out.active.id,action:'REVEAL',tile:1});
 out=call(p,'casino.action',{game:'TOWER',roundId:out.active.id,action:'CASHOUT'});expected.TOWER=out.indicators;
 crypto.randomInt=()=>6;out=call(p,'casino.start',{game:'HILO',amount:100,rulesRevision:1});crypto.randomInt=()=>12;
 out=call(p,'casino.action',{game:'HILO',roundId:out.active.id,action:'HIGH'});assert.equal(out.indicators.sampleCount,0);
 out=call(p,'casino.action',{game:'HILO',roundId:out.active.id,action:'CASHOUT'});expected.HILO=out.indicators;
 shoe([1,9,13,8]);out=call(p,'casino.start',{game:'BLACKJACK',amount:100,rulesRevision:1});expected.BLACKJACK=out.indicators;
 assert.equal(Object.keys(expected).length,11);
 let before=JSON.stringify(s.DB());
 for(const game of Object.keys(expected)){
  assert.equal(expected[game].sampleCount,1);assert.deepEqual(read(p,game).indicators,expected[game]);assert.equal(read(other,game).indicators.sampleCount,0);
  const text=JSON.stringify(expected[game]);assert.ok(!/secret|balance|betId|payoutId|accountId|deck|mineTiles|trapTiles/.test(text));
 }
 assert.equal(JSON.stringify(s.DB()),before,'chart reads do not change accounts, histories or wallet');
 // A real upgrade seeds old ten-row records exactly once when the next round settles.
 s.Atomic(()=>{delete p().arcade.ROULETTE.indicatorRounds;});crypto.randomInt=()=>36;
 const body={game:'ROULETTE',choice:'RED',amount:100,rulesRevision:4},request='FIX58-INDICATOR-REPLAY';
 out=call(p,'arcade.play',body,request);assert.equal(out.indicators.sampleCount,2);assert.equal(p().arcade.ROULETTE.indicatorRounds.length,2);
 before=JSON.stringify(s.DB());assert.deepEqual(call(p,'arcade.play',body,request),out);assert.equal(JSON.stringify(s.DB()),before);
 const exported=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(exported),true);assert.equal(read(p,'ROULETTE').indicators.sampleCount,2);
 assert.deepEqual(call(p,'arcade.play',body,request),out);
 // Persisted compact symbol/progress fields survive a second compaction/read.
 assert.equal(find(read(p,'SLOTS').indicators,'symbols').items.reduce((total,item)=>total+item.count,0),3);
 assert.equal(find(read(p,'MINES').indicators,'safe').items[1].count,1);
 // Repeated completed rounds grow only the new bounded projection. Legacy
 // history remains exactly ten entries for existing receipts/UI clients.
 for(let i=0;i<12;i++){crypto.randomInt=()=>i;call(p,'arcade.play',body);}
 assert.equal(p().arcade.ROULETTE.history.length,10);assert.equal(p().arcade.ROULETTE.indicatorRounds.length,14);
 // A failed durable save cannot append a chart point or settle its wallet.
 const save=database.SaveDatabase;before=JSON.stringify(s.DB());crypto.randomInt=()=>7;
 try{database.SaveDatabase=()=>false;assert.throws(()=>call(p,'arcade.play',body,'FIX58-INDICATOR-ROLLBACK'),/STORAGE_SAVE_FAILED/);}
 finally{database.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),before,'indicator append rolls back together with the round and debit');
 out=call(p,'arcade.play',body,'FIX58-INDICATOR-ROLLBACK');assert.equal(out.indicators.sampleCount,15);
 out=read(p,'ROULETTE');before=JSON.stringify(s.DB());out.indicators.charts[0].items[0].count=999999;out.indicators.charts.length=0;
 assert.equal(JSON.stringify(s.DB()),before,'returned chart arrays never alias stored data');
 console.log('FIX58 INDICATORS PASS: five deterministic baccarat roads, ties, tails/collisions, bounded upgrade/idempotency, all 11 result schemas, authentic server settlement, active exclusion, account isolation, read purity, replay/restart, legacy history10 preserved.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
