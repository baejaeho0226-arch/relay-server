'use strict';
// FIX59 retired the three FIX56 daily games. Old awards remain historical data;
// upgrading must neither expose those games nor re-credit their old receipts.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix56-event-migration-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),games=require('../services/member/eventGames');
try{
 const p={id:'USR-LEGACY',points:95,eventGames:{CARD:{day:'2026-09-14',played:1,lastResult:{points:50}},CHEST:{day:'2026-09-14',played:1,lastResult:{points:15}},RPS:{day:'2026-09-14',played:1,lastResult:{points:30}}}};
 s.DB().profiles.legacy=p;
 for(const [game,amount] of [['CARD',50],['CHEST',15],['RPS',30]])s.DB().pointLedger[p.id+':EVENT_'+game+':2026-09-14']={id:'OLD-'+game,accountId:p.id,kind:'EVENT_'+game,reference:'2026-09-14',amount,balance:95,at:1};
 const before=JSON.stringify(s.DB()),read=games.Read(p);
 assert.deepEqual(read.games.map(x=>x.game),['DINO','FLAPPY','WHACK','DODGE','RHYTHM']);assert.equal(read.rules.repeatable,true);assert.equal(read.rules.playsPerDay,undefined);
 assert.ok(read.games.every(x=>x.totalPlayed===0&&x.bestScore===0&&!x.lastResult&&!x.session));assert.equal(games.Play,undefined);
 assert.equal(JSON.stringify(s.DB()),before);assert.equal(p.points,95);assert.equal(Object.keys(s.DB().pointLedger).length,3);
 console.log('FIX56 EVENT MIGRATION PASS: retired daily CARD/CHEST/RPS are no longer playable, repeatable skill games start cleanly, and historical state and awards remain unchanged.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
