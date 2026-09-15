'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-custom-'));process.env.DATA_DIR=dir;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),db=require('../storage/database');
const rewards=require('../services/member/rewards'),shop=require('../services/member/customization'),lm=require('../license/licenseManager'),protocol=require('../services/member/protocol');
let serial=0;const run=(peer,action,body={},id)=>hub.Execute(peer.c,id||'CUSTOM'+String(++serial).padStart(10,'0'),action,body);
const admin=(action,body)=>hub.AdminWrite(action,body,'ADMIN:FIX46');
function client(id,key){
 const lines=[],c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(x){lines.push(x.trim());return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;
 return {c,lines};
}
function signed(peer,action,body,id){
 const payload=Buffer.from(JSON.stringify(body)).toString('base64'),fields=[id,action,payload];peer.lines.length=0;
 hub.Handle(peer.c,['HUB',...fields,protocol.Sign(peer.c,'HUB',fields)].join('|'));
 const chunks=peer.lines.filter(x=>x.startsWith('HUB_CHUNK|')).map(x=>x.split('|')).sort((a,b)=>Number(a[3])-Number(b[3]));
 assert.ok(chunks.length);const result=JSON.parse(Buffer.from(chunks.map(x=>x[5]).join(''),'base64'));assert.equal(result.ok,true,JSON.stringify(result));return result.data;
}
const save=db.SaveDatabase;
(async()=>{try{
 const a=client('1111111111111111','CUSTOM-A'),a2=client('3333333333333333','CUSTOM-A2'),b=client('2222222222222222','CUSTOM-B');a2.c.installationDeviceKey=a.c.installationDeviceKey;
 const id=run(a,'me').profile.id;run(b,'me');
 s.Atomic(()=>{s.ProfileById(id).points=10000;});
 let offers=run(a,'shop');assert.equal(offers.items.length,4);assert.ok(offers.items.filter(x=>x.id.startsWith('NICKNAME_')).every(x=>!x.enabled));
 assert.throws(()=>run(a,'shop.purchase',{itemId:'NICKNAME_TICKET',revision:offers.rules.revision}),/SHOP_UNAVAILABLE/);
 assert.throws(()=>run(a,'shop.save',shop.Rules()),/UNKNOWN_ACTION/);
 assert.throws(()=>run(a,'points.reverse',{id:'PCV-ANY',reason:'test'}),/UNKNOWN_ACTION/);
 const access=[];const response={writeHead(status){access.push(status);},end(){}};
 await require('../web/routes/memberRoutes').Handle({method:'POST',pathname:'/api/member/action',body:{action:'points.reverse',id:'PCV-ANY',reason:'test'},res:response,session:{role:'VIEWER'}});assert.deepEqual(access,[403]);
 let rules=admin('shop.save',{revision:1,items:{NICKNAME_TICKET:{enabled:true,price:100},NICKNAME_COLOR:{enabled:true,price:50}}});
 assert.throws(()=>admin('shop.save',{...rules,items:{...rules.items,NICKNAME_COLOR:{enabled:true,price:-1}}}),/AMOUNT_INVALID/);
 const before=JSON.stringify(s.DB());db.SaveDatabase=()=>false;
 assert.throws(()=>run(a,'shop.purchase',{itemId:'NICKNAME_TICKET',revision:rules.revision},'CUSTOM-PURCHASE-01'),/STORAGE_SAVE_FAILED/);
 db.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),before);
 b.lines.length=0;a2.lines.length=0;
 const purchase=signed(a,'shop.purchase',{itemId:'NICKNAME_TICKET',revision:rules.revision},'CUSTOM-PURCHASE-01');
 assert.equal(purchase.profile.points,9950);assert.equal(purchase.inventory.nicknameTickets,1);
 assert.deepEqual(run(a2,'shop.purchase',{itemId:'NICKNAME_TICKET',revision:rules.revision},'CUSTOM-PURCHASE-01'),purchase);
 assert.equal(Object.keys(s.DB().shopPurchases).length,1);assert.ok(b.lines.some(x=>x.startsWith('HUB_EVENT|')));assert.ok(a2.lines.some(x=>x.startsWith('HUB_EVENT|')));
 assert.throws(()=>run(b,'shop.purchase',{itemId:'NICKNAME_COLOR',revision:rules.revision,accountId:id}),/INSUFFICIENT_POINTS/);
 assert.equal(run(b,'shop',{id}).inventory.nicknameTickets,0);
 const profileBefore=run(a,'me').profile;
 run(a,'profile.save',{nickname:'첫 이름',handle:profileBefore.handle,bio:''});assert.equal(run(a,'shop').inventory.nicknameTickets,1,'normal name change never spends a ticket');
 const invalid=JSON.stringify(s.DB());
 assert.throws(()=>run(a,'profile.save',{nickname:'다음 이름',handle:'invalid handle',bio:''}),/HANDLE_INVALID/);
 assert.equal(JSON.stringify(s.DB()),invalid,'invalid profile never consumes inventory');
 db.SaveDatabase=()=>false;
 assert.throws(()=>run(a,'profile.save',{nickname:'다음 이름',bio:''},'CUSTOM-NAME-01'),/STORAGE_SAVE_FAILED/);db.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),invalid);
 const renamed=run(a,'profile.save',{nickname:'다음 이름',bio:''},'CUSTOM-NAME-01');assert.equal(renamed.profile.inventory.nicknameTickets,0);
 assert.deepEqual(run(a2,'profile.save',{nickname:'다음 이름',bio:''},'CUSTOM-NAME-01'),renamed);assert.equal(Object.values(s.DB().cosmeticUses).filter(x=>x.kind==='NICKNAME_TICKET').length,1);
 assert.throws(()=>run(a,'profile.save',{nickname:'다시 이름',bio:''}),/NICKNAME_COOLDOWN/);
 run(a,'shop.purchase',{itemId:'NICKNAME_COLOR',revision:rules.revision});
 const colorBefore=JSON.stringify(s.DB());
 for(const color of ['red','#123','#zzzzzz','#123456;','<script>',null])assert.throws(()=>run(a,'nickname.color',{color}),/NICKNAME_COLOR_INVALID/);
 assert.equal(JSON.stringify(s.DB()),colorBefore);
 const colored=run(a,'nickname.color',{color:'#123abc'},'CUSTOM-COLOR-01');assert.equal(colored.publicProfile.nicknameColor,'#123ABC');assert.equal(colored.inventory.nicknameColors,0);
 assert.deepEqual(run(a2,'nickname.color',{color:'#123abc'},'CUSTOM-COLOR-01'),colored);
 run(a,'nickname.color',{color:'#123ABC'});assert.equal(run(a,'shop').inventory.nicknameColors,0,'applying identical color is harmless');
 assert.throws(()=>run(a,'nickname.color',{color:'#456789'}),/COLOR_TICKET_REQUIRED/);
 assert.throws(()=>run(a,'badge.select',{id:'FOLLOWERS_500'}),/BADGE_UNAVAILABLE/);
 s.Atomic(()=>{const p=s.ProfileById(id);p.attendance={count:7};});
 const earned=run(a,'badges').items.find(x=>x.id==='ATTENDANCE_7');assert.equal(earned.earned,true);
 const selected=signed(a,'badge.select',{id:'ATTENDANCE_7'},'CUSTOM-BADGE-01');assert.equal(selected.publicProfile.titleBadge.title,'꾸준한 발걸음');
 for(const profile of [run(b,'member',{id}).profile,...run(b,'live',{profiles:[id]}).profiles]){
  assert.equal(profile.nicknameColor,'#123ABC');assert.equal(profile.titleBadge.id,'ATTENDANCE_7');
  for(const key of ['balance','points','inventory','eventSpins'])assert.equal(profile[key],undefined,'other member must not see '+key);
 }
 run(a,'badge.select',{id:''});assert.equal(run(a,'me').profile.titleBadge,null);
 // Historical conversion recovery uses recorded amounts, not today's exchange rule.
 let rewardRules=admin('rewards.save',{...rewards.Rules(),pointExchange:{enabled:true,pointUnit:100,cashUnit:250}});
 const conversion=run(a,'points.exchange',{amount:1000,revision:rewardRules.revision}).conversion;
 const balances={cash:s.ProfileById(id).balance,points:s.ProfileById(id).points};
 s.Atomic(()=>{delete s.DB().pointConversions[conversion.id];});
 assert.equal(hub.AdminRead({view:'pointConversions'}).items[0].id,conversion.id,'old paired ledgers remain recoverable');
 rewardRules=admin('rewards.save',{...rewardRules,pointExchange:{enabled:false,pointUnit:20,cashUnit:1}});
 const beforeReverse=JSON.stringify(s.DB());db.SaveDatabase=()=>false;
 assert.throws(()=>admin('points.reverse',{id:conversion.id,reason:'잘못된 교환'}),/STORAGE_SAVE_FAILED/);db.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),beforeReverse);
 a.lines.length=0;a2.lines.length=0;
 const reversed=admin('points.reverse',{id:conversion.id,reason:'잘못된 교환'});
 assert.equal(reversed.profile.balance,balances.cash-conversion.cashAmount);assert.equal(reversed.profile.points,balances.points-conversion.pointAmount);
 assert.equal(reversed.conversion.status,'REVERSED');assert.equal(reversed.conversion.reversedBy,'ADMIN:FIX46');
 assert.ok(a.lines.some(x=>x.startsWith('HUB_EVENT|')));assert.ok(a2.lines.some(x=>x.startsWith('HUB_EVENT|')));
 const reversalState=JSON.stringify(s.DB());assert.equal(admin('points.reverse',{id:conversion.id,reason:'재시도'}).unchanged,true);assert.equal(JSON.stringify(s.DB()),reversalState,'reversal is exactly once');
 assert.equal(s.DB().ledger[reversed.conversion.reversePaymentId].reverseOf,conversion.paymentId);
 assert.equal(Object.values(s.DB().pointLedger).find(x=>x.id===reversed.conversion.reversePointId).reverseOf,conversion.pointId);
 rewardRules=admin('rewards.save',{...rewardRules,pointExchange:{enabled:true,pointUnit:100,cashUnit:250}});
 const spent=run(a,'points.exchange',{amount:1000,revision:rewardRules.revision}).conversion;
 s.Atomic(()=>{s.Ledger(s.ProfileById(id),-1,'TEST_SPEND','spent');});
 const spendState=JSON.stringify(s.DB());assert.throws(()=>admin('points.reverse',{id:spent.id,reason:'회수'}),/POINT_RECOVERY_BALANCE/);assert.equal(JSON.stringify(s.DB()),spendState);
 // All added tables migrate from older source packages; malformed tables still fail closed.
 const snapshot=JSON.parse(JSON.stringify(s.DB()));s.Import({memberHub:snapshot});assert.equal(run(a2,'shop').inventory.nicknameColors,0);
 for(const key of ['pointConversions','shopPurchases','cosmeticUses'])delete snapshot[key];s.Import({memberHub:snapshot});
 assert.equal(hub.AdminRead({view:'pointConversions'}).items.some(x=>x.id===spent.id),true);
 const restoredState=JSON.stringify(s.DB());assert.equal(admin('points.reverse',{id:conversion.id,reason:'이관 후 재시도'}).unchanged,true);assert.equal(JSON.stringify(s.DB()),restoredState,'paired reversal ledgers also prevent duplicate historical recovery');
 snapshot.cosmeticUses=[];assert.throws(()=>s.Import({memberHub:snapshot}),/MEMBER_STORAGE_INVALID/);
 console.log('FIX46 CUSTOMIZATION PASS: server-priced single-use inventory, cooldown bypass, validation, atomic rollback, retry receipts, badges, cosmetic live sync, private wallets, admin-only historical conversion recovery and migrations.');
}finally{db.SaveDatabase=save;fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
