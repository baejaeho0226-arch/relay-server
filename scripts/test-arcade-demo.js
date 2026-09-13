'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-arcade-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),arcade=require('../services/member/arcade'),db=require('../storage/database');
const oldNow=Date.now,oldRandom=crypto.randomInt;let clock=1900000000000;
Date.now=()=>clock;
try{
 const member={id:'USR-ARCADE-TEST',subject:'ARCADE-TEST',nickname:'테스트',avatar:'',balance:1200,points:50,eventSpins:4,createdAt:clock};
 s.Atomic(()=>{s.DB().profiles[member.subject]=member;});
 const p=()=>s.ProfileById(member.id);
 const play=(body,id='PLAY-REQUEST-'+clock)=>s.Operation(p(),id,'arcade.play',body,()=>arcade.Play(p(),body));
 const original=JSON.stringify(s.DB());assert.equal(arcade.Read(p()).stats.played,0);assert.equal(JSON.stringify(s.DB()),original,'read is not a mutation');
 assert.equal(arcade.Read(p()).rules.redeemable,false);
 assert.throws(()=>play({game:'ROULETTE',choice:'RED',amount:0}),/ARCADE_DEMO_ONLY/);
 for(const key of ['points','bet','stake','reward','mode','turns'])assert.throws(()=>play({game:'ROULETTE',choice:'RED',[key]:1}),/ARCADE_DEMO_ONLY/);
 assert.throws(()=>play({game:'toString',choice:'RED'}),/INPUT_INVALID/);
 assert.throws(()=>play({game:'ROULETTE',choice:'PLAYER'}),/INPUT_INVALID/);
 const wanted=[3,1,3,2],pool=Array.from({length:416},(_,i)=>i);let used=0;
 crypto.randomInt=max=>{assert.equal(max,pool.length);const rank=wanted[used++],index=pool.findIndex(id=>id%13===rank);pool[index]=pool[pool.length-1];pool.pop();return index;};
 const natural=play({game:'BACCARAT',choice:'PLAYER'},'NATURAL-REQUEST-01');
 assert.equal(natural.result.playerTotal,8);assert.equal(natural.result.bankerTotal,5);assert.equal(natural.result.winner,'PLAYER');assert.equal(used,4,'natural stops both hands');assert.equal(natural.stats.score,1);
 assert.deepEqual(play({game:'BACCARAT',choice:'PLAYER'},'NATURAL-REQUEST-01'),natural,'same durable request returns same outcome without another draw');
 assert.throws(()=>play({game:'BACCARAT',choice:'BANKER'},'NATURAL-REQUEST-01'),/REQUEST_REUSED/);
 assert.throws(()=>play({game:'ROULETTE',choice:'RED'}),/ARCADE_WAIT/);
 // Player stood: bank 0..5 draws. Player drew: normative tableau rows 0..7.
 for(let total=0;total<=7;total++)assert.equal(arcade.BankerDraw(total,null),total<=5);
 const matrix=['1111111111','1111111111','1111111111','1111111101','0011111100','0000111100','0000001100','0000000000'];
 for(let total=0;total<8;total++)for(let third=0;third<10;third++)assert.equal(arcade.BankerDraw(total,third),matrix[total][third]==='1',`bank ${total}, third ${third}`);
 const reds=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
 for(let number=0;number<=36;number++){
  clock+=1200;crypto.randomInt=max=>{assert.equal(max,37);return number;};
  const color=number===0?'GREEN':reds.includes(number)?'RED':'BLACK',out=play({game:'ROULETTE',choice:color,_wire:'zlib',_delta:true});
  assert.equal(out.result.number,number);assert.equal(out.result.color,color);assert.equal(out.result.matched,true);assert.equal(out.stats.played,number+1);
 }
 assert.equal(arcade.Read(p(),{game:'ROULETTE'}).history.length,10);assert.equal(p().balance,1200);assert.equal(p().points,50);assert.equal(p().eventSpins,4);
 for(const key of ['ledger','pointLedger','eventSpins','orders','shopPurchases'])assert.deepEqual(s.DB()[key],{},'arcade never touches '+key);
 const before=JSON.stringify(s.DB()),save=db.SaveDatabase;clock+=1200;
 try{db.SaveDatabase=()=>false;assert.throws(()=>play({game:'ROULETTE',choice:'RED'}),/STORAGE_SAVE_FAILED/);}finally{db.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),before,'failed storage rolls back result and all stats');
 s.Import({memberHub:JSON.parse(before)});assert.equal(arcade.Read(p(),{game:'ROULETTE'}).stats.played,37);assert.equal(arcade.Read(p()).stats.played,1);
 console.log('FIX46 ARCADE PASS: crypto outcome bounds, full third-card tableau, natural hands, replay/rate guard, persistence rollback, strict free-only payload and no financial side effects.');
}finally{Date.now=oldNow;crypto.randomInt=oldRandom;fs.rmSync(temp,{recursive:true,force:true});}
