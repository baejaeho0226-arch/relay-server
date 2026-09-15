'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const restart=process.env.FIX58_TITLE_RESTART,dir=restart||fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix58-titles-'));
process.env.DATA_DIR=dir;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),database=require('../storage/database'),shop=require('../services/member/customization');
let serial=0;
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX58-TITLE-REQ-'+(++serial),action,body);
const account=c=>s.Account(c),snapshot=()=>JSON.stringify(s.DB());
const ledger=(c,kind)=>Object.values(s.DB().pointLedger).filter(row=>row.accountId===account(c).id&&(!kind||row.kind===kind));
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX58-TITLE-DEVICE-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 const lm=require('../license/licenseManager');c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
function unchanged(fn,error){const before=snapshot();assert.throws(fn,error);assert.equal(snapshot(),before,'failed request cannot mutate awards, inventory, styles, points or replay receipts');}
function failedSave(fn){const save=database.SaveDatabase;try{database.SaveDatabase=()=>false;unchanged(fn,/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}}
// An actual fresh Node process reloads the durable file and checks the stored
// requests/ledger/appearance; this is separate from an in-memory import test.
if(restart){
 database.LoadDatabase();
 const expected=JSON.parse(fs.readFileSync(path.join(dir,'fix58-title-expected.json'),'utf8')),p=s.ProfileById(expected.id);
 assert.ok(p);assert.equal(p.points,expected.points);assert.deepEqual(s.PublicProfile(p).titleBadge,expected.badge);
 const before=snapshot();require('../services/member/badges').Read(p,{});assert.equal(snapshot(),before,'restart cannot repay collection reward');
 assert.equal(s.DB().pointLedger[p.id+':BADGE_REWARD:ALL_TITLES'].amount,expected.reward);
 const replay=s.Operation(p,'FIX58-RENAME-SAVED','title.name',{id:'POSTS_1',name:'나의 첫 이야기'},()=>{throw Error('replay executed mutation');});
 assert.equal(replay.publicProfile.titleBadge.title,'나의 첫 이야기');assert.equal(snapshot(),before);
 console.log('FIX58 TITLE RESTART PASS');
}else try{
 const a=client(1),b=client(2),cap=client(3);for(const c of [a,b,cap])run(c,'me');
 let view=run(a,'shop');assert.equal(view.items.length,4);assert.equal(view.allTitlesEarned,false);
 assert.equal(view.items.find(x=>x.id==='TITLE_COLOR').price,500);assert.equal(view.items.find(x=>x.id==='TITLE_NAME').price,2000);
 assert.equal(view.items.find(x=>x.id==='TITLE_NAME').purchasable,false);assert.equal(view.items.find(x=>x.id==='TITLE_NAME').lockedReason,'ALL_TITLES_REQUIRED');
 assert.deepEqual(view.inventory,{nicknameTickets:0,nicknameColors:0,titleColors:0,titleNames:0});
 const catalog=run(a,'badges').items,base=catalog.filter(row=>row.id!=='ALL_TITLES'),collection=catalog.find(row=>row.id==='ALL_TITLES'),sum=base.reduce((n,row)=>n+row.rewardPoints,0);
 assert.equal(collection.target,base.length);assert.equal(collection.rewardPoints,sum);assert.equal(collection.earned,false);
 const svg=fs.readFileSync(path.join(__dirname,'../../MoaPlayApp_Android64/MoaPlayMemberSvg.pas'),'utf8'),icons=new Set([...svg.matchAll(/Name = '([^']+)'/g)].map(m=>m[1]));
 assert.ok(catalog.every(row=>icons.has(row.icon)),'every catalog icon must resolve in native SVG source');assert.ok(new Set(base.map(row=>row.icon)).size>=20,'mission groups have meaningful varied icons');
 unchanged(()=>run(a,'shop.purchase',{itemId:'TITLE_COLOR',revision:view.rules.revision}),/INSUFFICIENT_POINTS/);
 s.Atomic(()=>{account(a).points=10000;});
 unchanged(()=>run(a,'shop.purchase',{itemId:'TITLE_NAME',revision:view.rules.revision}),/ALL_TITLES_REQUIRED/);
 const post=run(a,'post.create',{body:'내 칭호의 색을 바꿔요'}).post;run(a,'badge.select',{id:'POSTS_1'});
 unchanged(()=>run(a,'title.color',{id:'POSTS_50',color:'#123456',iconColor:'#ABCDEF'}),/BADGE_UNAVAILABLE/);
 unchanged(()=>run(a,'title.color',{id:'POSTS_1',color:'#123456',iconColor:'#ABCDEF'}),/TITLE_COLOR_TICKET_REQUIRED/);
 const bought=run(a,'shop.purchase',{itemId:'TITLE_COLOR',revision:view.rules.revision},'FIX58-COLOR-BUY');assert.equal(bought.inventory.titleColors,1);
 const afterPurchase=snapshot();run(a,'shop.purchase',{itemId:'TITLE_COLOR',revision:view.rules.revision},'FIX58-COLOR-BUY');assert.equal(snapshot(),afterPurchase);
 assert.equal(ledger(a,'SHOP_PURCHASE').length,1);
 for(const body of [{color:'#123',iconColor:'#ABCDEF'},{color:'#123456',iconColor:'red'},{color:'#123456',iconColor:null}])unchanged(()=>run(a,'title.color',{id:'POSTS_1',...body}),/TITLE_COLOR_INVALID/);
 unchanged(()=>run(b,'title.color',{id:'POSTS_1',profileId:account(a).id,color:'#123456',iconColor:'#ABCDEF'}),/NOT_OWNER/);
 const colorBody={id:'POSTS_1',color:'#123abc',iconColor:'#456def'};
 failedSave(()=>run(a,'title.color',colorBody,'FIX58-COLOR-USE'));
 let saves=0;const save=database.SaveDatabase;let colored;try{database.SaveDatabase=(...args)=>{saves++;return save(...args);};colored=run(a,'title.color',colorBody,'FIX58-COLOR-USE');}finally{database.SaveDatabase=save;}
 assert.equal(saves,1,'both colors, token consumption and operation receipt share one save');assert.equal(colored.inventory.titleColors,0);
 assert.equal(colored.publicProfile.titleBadge.color,'#123ABC');assert.equal(colored.publicProfile.titleBadge.iconColor,'#456DEF');
 assert.equal(colored.publicProfile.titleBadge.title,'첫 이야기');assert.equal(colored.publicProfile.titleBadge.originalTitle,'첫 이야기');
 const used=snapshot();run(a,'title.color',colorBody,'FIX58-COLOR-USE');assert.equal(snapshot(),used);
 run(a,'title.color',colorBody);assert.equal(run(a,'shop').inventory.titleColors,0,'same-value application consumes nothing');
 unchanged(()=>run(a,'title.color',{...colorBody,iconColor:'#111111'}),/TITLE_COLOR_TICKET_REQUIRED/);
 // Completed source missions are durable saved records; only the final ordinary
 // mission is completed by this new read. The aggregate award must be independent.
 const finalId=base.at(-1).id,earnedAt=Date.now()-86400000;
 s.Atomic(()=>{const p=account(a);p.badgeProgress.awards=Object.fromEntries(base.filter(row=>row.id!==finalId).map(row=>[row.id,{at:earnedAt,rewardPoints:row.rewardPoints,rewardPaid:true}]));p.badgeProgress.counts={};});
 assert.equal(run(a,'badges').items.find(row=>row.id==='ALL_TITLES').earned,false);
 unchanged(()=>run(a,'shop.purchase',{itemId:'TITLE_NAME',revision:shop.Rules().revision}),/ALL_TITLES_REQUIRED/);
 s.Atomic(()=>{account(a).badgeProgress.counts.reportsReceived=1;});
 const pointsBefore=account(a).points;failedSave(()=>run(a,'badges'));
 const complete=run(a,'badges'),meta=complete.items.find(row=>row.id==='ALL_TITLES');assert.equal(meta.earned,true);assert.equal(meta.progress,base.length);assert.equal(meta.rewardPaid,true);assert.equal(meta.rewardPoints,sum);
 assert.equal(account(a).points,pointsBefore+sum+base.at(-1).rewardPoints);assert.equal(ledger(a,'BADGE_REWARD').filter(row=>row.reference==='ALL_TITLES').length,1);
 const earnedSnapshot=snapshot();run(a,'badges');run(a,'shop');assert.equal(snapshot(),earnedSnapshot,'read refresh does not duplicate the collection reward');
 run(a,'post.delete',{id:post.id});assert.equal(run(a,'shop').allTitlesEarned,true,'deleting old activity cannot revoke collection ownership');
 const gate=run(a,'shop').items.find(row=>row.id==='TITLE_NAME');assert.equal(gate.purchasable,true);
 unchanged(()=>run(a,'title.name',{id:'POSTS_1',name:'바꾼 이름'}),/TITLE_NAME_TICKET_REQUIRED/);
 run(a,'shop.purchase',{itemId:'TITLE_NAME',revision:shop.Rules().revision});
 for(const name of ['',null,'가'.repeat(21),'<b>사칭</b>','첫\n이야기','첫\u202E이야기'])unchanged(()=>run(a,'title.name',{id:'POSTS_1',name}),/TITLE_NAME_INVALID/);
 const renameBody={id:'POSTS_1',name:'나의 첫 이야기'};
 failedSave(()=>run(a,'title.name',renameBody,'FIX58-RENAME-SAVED'));
 const renamed=run(a,'title.name',renameBody,'FIX58-RENAME-SAVED');assert.equal(renamed.inventory.titleNames,0);assert.equal(renamed.publicProfile.titleBadge.title,'나의 첫 이야기');assert.equal(renamed.publicProfile.titleBadge.color,'#123ABC');
 const renamedSnapshot=snapshot();run(a,'title.name',renameBody,'FIX58-RENAME-SAVED');assert.equal(snapshot(),renamedSnapshot);
 run(a,'title.name',renameBody);assert.equal(run(a,'shop').inventory.titleNames,0);
 unchanged(()=>run(a,'title.name',{id:'POSTS_1',name:'다른 이름'}),/TITLE_NAME_TICKET_REQUIRED/);
 const publicView=run(b,'badges',{profileId:account(a).id}),publicItem=publicView.items.find(x=>x.id==='POSTS_1');
 assert.equal(publicItem.title,'나의 첫 이야기');assert.equal(publicItem.originalTitle,'첫 이야기');assert.equal(publicItem.color,'#123ABC');assert.equal(publicView.readOnly,true);
 for(const p of [publicView.profile,run(b,'member',{id:account(a).id}).profile,...run(b,'live',{profiles:[account(a).id]}).profiles]){
  assert.equal(p.titleBadge.title,'나의 첫 이야기');assert.equal(p.titleBadge.iconColor,'#456DEF');
  for(const field of ['inventory','points','titleStyles','badgeProgress','balance','subject'])assert.equal(p[field],undefined,'public projection hides '+field);
 }
 assert.ok(publicView.items.every(row=>row.rewardPaid===undefined&&row.progress===undefined));
 assert.equal(run(b,'shop',{profileId:account(a).id}).inventory.titleNames,0,'shop always resolves authenticated inventory');
 // Reward cap defers the entire aggregate payment and retries exactly once after space exists.
 s.Atomic(()=>{const p=account(cap);p.points=100000000;p.badgeProgress={version:1,counts:{},seen:{},awards:Object.fromEntries(base.map(row=>[row.id,{at:earnedAt,rewardPoints:row.rewardPoints,rewardPaid:true}]))};});
 assert.equal(run(cap,'badges').items.find(row=>row.id==='ALL_TITLES').rewardStatus,'PENDING');
 const capSnapshot=snapshot();run(cap,'badges');assert.equal(snapshot(),capSnapshot);
 s.Atomic(()=>{require('../services/member/rewards').Credit(account(cap),-sum,'FIX58_TEST_SPEND','CAP-SPACE');});
 assert.equal(run(cap,'badges').items.find(row=>row.id==='ALL_TITLES').rewardStatus,'PAID');assert.equal(account(cap).points,100000000);assert.equal(ledger(cap,'BADGE_REWARD').filter(row=>row.reference==='ALL_TITLES').length,1);
 // Inventory and admin guards apply equally to the two new products.
 s.Atomic(()=>{account(a).inventory.titleColors=10000;});unchanged(()=>run(a,'shop.purchase',{itemId:'TITLE_COLOR',revision:shop.Rules().revision}),/INVENTORY_LIMIT/);
 const oldRules=shop.Rules(),edited=hub.AdminWrite('shop.save',{revision:oldRules.revision,items:{NICKNAME_TICKET:{enabled:true,price:100},NICKNAME_COLOR:{enabled:true,price:50}}},'FIX58');
 assert.deepEqual(edited.items.TITLE_COLOR,oldRules.items.TITLE_COLOR,'older admin form preserves new offers');
 unchanged(()=>hub.AdminWrite('shop.save',{revision:edited.revision,items:{...edited.items,TITLE_COLOR:{enabled:true,price:0}}},'FIX58'),/AMOUNT_INVALID/);
 const stopped=hub.AdminWrite('shop.save',{revision:edited.revision,items:{...edited.items,TITLE_COLOR:{enabled:false,price:500}}},'FIX58');
 unchanged(()=>run(a,'shop.purchase',{itemId:'TITLE_COLOR',revision:stopped.revision}),/SHOP_UNAVAILABLE/);
 unchanged(()=>run(a,'shop.purchase',{itemId:'TITLE_NAME',revision:oldRules.revision}),/CONTENT_CHANGED/);
 const expected={id:account(a).id,points:account(a).points,badge:s.PublicProfile(account(a)).titleBadge,reward:sum};
 fs.writeFileSync(path.join(dir,'fix58-title-expected.json'),JSON.stringify(expected));assert.equal(database.SaveDatabase(),true);
 const child=require('node:child_process').spawnSync(process.execPath,[__filename],{env:{...process.env,FIX58_TITLE_RESTART:dir},encoding:'utf8',timeout:20000});assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
 console.log('FIX58 TITLE CUSTOMIZATION PASS: appropriate native icons, full-collection sum/once-only cap-safe rewards, owned title color pair and gated rename, server pricing, authenticated public/private projections, atomic rollback, idempotency, admin upgrade and fresh-process persistence.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
