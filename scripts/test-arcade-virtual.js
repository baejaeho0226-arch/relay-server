'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-arcade-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),arcade=require('../services/member/arcade'),db=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000,sequence=0;
Date.now=()=>clock;
try{
 const member={id:'USR-ARCADE-TEST',subject:'ARCADE-TEST',nickname:'테스트',avatar:'',balance:500000,points:50,eventSpins:4,createdAt:clock};
 s.Atomic(()=>{s.DB().profiles[member.subject]=member;});
 const p=()=>s.ProfileById(member.id),valid=(body={})=>({game:'ROULETTE',choice:'RED',amount:100,rulesRevision:4,...body});
 const play=(body,id='PLAY-REQUEST-'+String(++sequence).padStart(8,'0'))=>s.Operation(p(),id,'arcade.play',body,()=>arcade.Play(p(),body));
 const unchanged=(fn,error)=>{const before=JSON.stringify(s.DB());assert.throws(fn,error);assert.equal(JSON.stringify(s.DB()),before);};
 const original=JSON.stringify(s.DB()),empty=arcade.Read(p());assert.equal(empty.stats.played,0);assert.equal(JSON.stringify(s.DB()),original,'read is not a mutation');
 assert.equal(empty.mode,'VIRTUAL_BALANCE');assert.equal(empty.virtual,true);assert.equal(empty.redeemable,false);
 assert.deepEqual(empty.rules.chips,[100,500,1000,5000,10000]);assert.equal(empty.rules.revision,5);assert.equal(empty.rules.minIntervalMs,300);
 assert.deepEqual(empty.games.map(game=>game.id),['BACCARAT','ROULETTE','SLOTS']);
 assert.deepEqual(empty.wallet,{accountId:member.id,balance:500000,points:50,eventSpins:4,revision:s.DB().revision});
 // Forged values, stale rules and invalid bets are rejected before drawing.
 crypto.randomInt=()=>assert.fail('invalid input must not consume RNG');
 for(const key of ['balance','points','bet','stake','reward','payout','chips','mode','turns','accountId','id','reels','number','winner'])unchanged(()=>play(valid({[key]:1})),/INPUT_INVALID/);
 for(const amount of [0,-100,1,99,101,1234,100001,Infinity,NaN,100.5,'100',null,undefined])unchanged(()=>play(valid({amount})),/AMOUNT_INVALID/);
 for(const rulesRevision of [undefined,null,2,3,'4',6])unchanged(()=>play(valid({rulesRevision})),/ARCADE_RULES_CHANGED/);
 unchanged(()=>play(valid({game:'toString'})),/INPUT_INVALID/);unchanged(()=>play(valid({choice:'PLAYER'})),/INPUT_INVALID/);
 s.Atomic(()=>{p().balance=99;});unchanged(()=>play(valid()),/ARCADE_BALANCE_REQUIRED/);
 s.Atomic(()=>{p().balance=Number.MAX_SAFE_INTEGER-100;});unchanged(()=>play(valid({game:'SLOTS',choice:'SPIN'})),/ARCADE_BALANCE_LIMIT/);
 s.Atomic(()=>{p().balance=500000;});
 const setHand=ranks=>{const shoe=Array.from({length:416},(_,i)=>i);let calls=0;crypto.randomInt=max=>{assert.equal(max,shoe.length);assert.ok(calls<ranks.length);const rank=ranks[calls++],index=shoe.findIndex(id=>id%13===rank);shoe[index]=shoe[shoe.length-1];shoe.pop();return index;};return ()=>calls;};
 // Each selection against all three natural outcomes: win, lose and tie push.
 const hands={PLAYER:[3,1,3,2],BANKER:[0,3,1,4],TIE:[3,3,3,3]};let playedBaccarat=0;
 for(const winner of ['PLAYER','BANKER','TIE'])for(const choice of ['PLAYER','BANKER','TIE']){
  clock+=300;const calls=setHand(hands[winner]),before=p().balance,body=valid({game:'BACCARAT',choice}),id='BACCARAT-'+winner+'-'+choice;
  const out=play(body,id),gross=choice===winner?(choice==='TIE'?900:choice==='BANKER'?195:200):winner==='TIE'&&choice!=='TIE'?100:0;
  assert.equal(calls(),4,'natural stops both hands');assert.equal(out.result.winner,winner);assert.equal(out.result.payout,gross);assert.equal(out.result.net,gross-100);
  assert.equal(out.result.balance,before-100+gross);assert.equal(out.wallet.balance,p().balance);assert.equal(out.wallet.revision,s.DB().revision);
  assert.equal(out.stats.played,++playedBaccarat);assert.deepEqual(play(body,id),out,'durable replay keeps original result');
  unchanged(()=>play({...body,amount:200},id),/REQUEST_REUSED/);
 }
 unchanged(()=>play(valid()),/ARCADE_WAIT/);
 // Normative third-card tableau: stood player and every banker/player value.
 for(let total=0;total<=7;total++)assert.equal(arcade.BankerDraw(total,null),total<=5);
 const matrix=['1111111111','1111111111','1111111111','1111111101','0011111100','0000111100','0000001100','0000000000'];
 for(let total=0;total<8;total++)for(let third=0;third<10;third++)assert.equal(arcade.BankerDraw(total,third),matrix[total][third]==='1',`bank ${total}, third ${third}`);
 const reds=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];let rouletteCount=0;
 for(let number=0;number<=36;number++)for(const choice of ['RED','BLACK','GREEN']){
  clock+=300;crypto.randomInt=max=>{assert.equal(max,37);return number;};
  const color=number===0?'GREEN':reds.includes(number)?'RED':'BLACK',before=p().balance,out=play(valid({choice,_wire:'zlib',_delta:true}));
  const gross=color===choice?(choice==='GREEN'?3600:200):0;
  assert.equal(out.result.number,number);assert.equal(out.result.color,color);assert.equal(out.result.matched,color===choice);assert.equal(out.result.payout,gross);
  assert.equal(out.wallet.balance,before-100+gross);assert.equal(out.stats.played,++rouletteCount);
 }
 // Exhaustive six-symbol outcomes: 90 exact pairs, 5 normal triples and 777.
 const symbols=['CHERRY','LEMON','GRAPE','BELL','STAR','SEVEN'];let slotCount=0,slotMatches=0,allGross=0,lastSlot;
 for(let a=0;a<6;a++)for(let b=0;b<6;b++)for(let c=0;c<6;c++){
  clock+=300;const draws=[a,b,c];let calls=0;crypto.randomInt=max=>{assert.equal(max,6);assert.ok(calls<3);return draws[calls++];};
  const id='SLOT-REQUEST-'+clock,body=valid({game:'SLOTS',choice:'SPIN'}),before=p().balance,out=play(body,id),distinct=new Set(draws).size;
  const matched=distinct<3,gross=distinct===3?0:distinct===2?100:a===5?6000:1200;allGross+=gross;
  assert.equal(calls,3);assert.deepEqual(out.result.reels.map(reel=>reel.id),draws.map(index=>symbols[index]));
  assert.equal(out.result.matched,matched);assert.equal(out.result.symbol,distinct===1?symbols[a]:null);assert.equal(out.result.scoreEarned,Number(matched));
  assert.equal(out.result.payout,gross);assert.equal(out.result.net,gross-100);assert.equal(out.wallet.balance,before-100+gross);
  slotCount++;slotMatches+=Number(matched);assert.equal(out.stats.played,slotCount);assert.equal(out.stats.matched,slotMatches);assert.equal(out.stats.score,slotMatches);
  assert.equal(out.rules.redeemable,false);assert.deepEqual(play(body,id),out,'retry never draws or charges again');lastSlot={id,body,out};
 }
 assert.equal(allGross,21000,'216 equally likely 100-credit wagers pay 21,000 virtual credits in total');assert.equal(slotMatches,96);
 assert.equal(arcade.Read(p(),{game:'SLOTS'}).history.length,10);assert.equal(arcade.Read(p(),{game:'ROULETTE'}).history.length,10);
 assert.equal(p().points,50);assert.equal(p().eventSpins,4);
 for(const key of ['pointLedger','eventSpins','orders','shopPurchases','pointConversions','chargeRequests'])assert.deepEqual(s.DB()[key],{},'arcade never touches '+key);
 const ledger=Object.values(s.DB().ledger),rounds=new Map();
 for(const row of ledger){assert.equal(row.accountId,member.id);assert.equal(row.virtual,true);assert.equal(row.redeemable,false);if(!rounds.has(row.reference))rounds.set(row.reference,[]);rounds.get(row.reference).push(row);}
 assert.equal(rounds.size,playedBaccarat+rouletteCount+slotCount);assert.equal(ledger.length,rounds.size*2);
 for(const rows of rounds.values()){assert.deepEqual(rows.map(x=>x.kind),['ARCADE_BET','ARCADE_PAYOUT']);assert.equal(rows[0].amount,-100);assert.ok(rows[1].amount>=0);assert.equal(rows[1].balance,rows[0].balance+rows[1].amount);}
 assert.equal(p().balance,500000+ledger.reduce((sum,row)=>sum+row.amount,0),'global wallet equals all atomic settlements');
 const before=JSON.stringify(s.DB()),save=db.SaveDatabase;clock+=300;crypto.randomInt=()=>1;
 try{db.SaveDatabase=()=>false;unchanged(()=>play(valid(),'SAVE-FAILED-ROUND'),/STORAGE_SAVE_FAILED/);}finally{db.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),before,'failed save rolls back both ledgers, wallet, stats and replay receipt');
 s.Import({memberHub:JSON.parse(before)});assert.equal(arcade.Read(p(),{game:'ROULETTE'}).stats.played,111);assert.equal(arcade.Read(p()).stats.played,9);
 assert.equal(arcade.Read(p(),{game:'SLOTS'}).stats.played,216);assert.deepEqual(play(lastSlot.body,lastSlot.id),lastSlot.out,'saved retry survives restart');
 const retried=play(valid(),'SAVE-FAILED-ROUND');assert.equal(retried.result.payout,200);assert.equal(Object.values(s.DB().ledger).length,ledger.length+2);
 console.log('FIX48 ARCADE PASS: all virtual payouts, 216 slot combinations, 111 roulette selections, baccarat win/loss/push and third-card tableau, input/rules/funds/cap guards, exact paired ledger, replay and persistence rollback.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
