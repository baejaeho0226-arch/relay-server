'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix59-history-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const store=require('../services/member/store'),history=require('../services/member/history'),database=require('../storage/database');
try{
 const p={id:'USR-FIX59-HISTORY',subject:'FIX59-HISTORY',balance:0},other={id:'USR-FIX59-OTHER',subject:'FIX59-OTHER',balance:0};
 store.DB().profiles[p.subject]=p;store.DB().profiles[other.subject]=other;
 const routes=Object.keys(history.SERVICES).slice(0,25);
 for(const route of routes)history.Record(p,{route});
 assert.equal(p.recentHistory.services.length,20);assert.deepEqual(p.recentHistory.services.map(x=>x.route),routes.slice(-20).reverse());
 assert.deepEqual(history.Read(other).recentServices,[]);
 const clean=JSON.stringify(store.DB()),newest=p.recentHistory.services[0];
 for(let i=0;i<3;i++){history.Read(p);assert.equal(history.Record(p,{route:newest.route}).recorded,false);}
 assert.equal(JSON.stringify(store.DB()),clean,'normal refreshes and newest reopens never write');
 // A legacy oversized list is actually deleted on the next navigation, even if
 // that navigation repeats the newest item and must preserve its timestamp.
 p.recentHistory.services.push(...routes.slice(0,5).map((route,i)=>({route,at:100-i})));
 assert.equal(p.recentHistory.services.length,25);
 assert.equal(history.Record(p,{route:newest.route}).recorded,false);
 assert.equal(p.recentHistory.services.length,20);assert.deepEqual(p.recentHistory.services[0],newest);
 const saved=structuredClone(store.DB());saved.profiles[p.subject].recentHistory.services.push({route:'event.card',at:2},...routes.slice(0,5).map(route=>({route,at:1})));
 // Startup import invokes the exported migration without adding a revision.
 const oldRevision=saved.revision;store.Import({memberHub:saved});
 const restored=store.ProfileById(p.id);history.PruneStored(restored);
 assert.equal(restored.recentHistory.services.length,20);assert.equal(store.DB().revision,oldRevision);
 assert.ok(restored.recentHistory.services.every(x=>Object.hasOwn(history.SERVICES,x.route)));
 assert.equal(history.PruneStored(restored),false,'clean migration is a no-op');
 assert.equal(database.SaveDatabase(),true);store.Import({memberHub:store.Empty()});database.LoadDatabase();
 assert.equal(store.ProfileById(p.id).recentHistory.services.length,20,'pruned storage survives a real save/reload');
 for(const route of ['event.card','event.chest','event.rps','settings.features','settings.home','settings.news','settings.games'])assert.throws(()=>history.Record(store.ProfileById(p.id),{route}),/INPUT_INVALID/);
 for(const route of ['event.dino','event.flappy','event.whack','event.dodge','event.rhythm','playground'])assert.ok(Object.hasOwn(history.SERVICES,route));
 console.log('FIX59 HOME HISTORY PASS: physical 20-item bound, newest no-op/timestamp, account isolation, legacy migration, persistent reload and retired route rejection.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
