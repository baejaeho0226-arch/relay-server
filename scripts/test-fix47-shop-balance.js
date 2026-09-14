'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-shop-balance-'));
process.env.DATA_DIR=dir;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service');
const rewards=require('../services/member/rewards'),lm=require('../license/licenseManager');
let serial=0;
function device(id,key){
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});
 state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'SHOPBALANCE'+String(++serial).padStart(8,'0'),action,body);
try{
 const phone=device('4711111111111111','SHOP-OWNER'),secondPhone=device('4722222222222222','SHOP-SECOND'),other=device('4733333333333333','SHOP-OTHER');
 secondPhone.installationDeviceKey=phone.installationDeviceKey;
 const member=run(phone,'me').profile.id;
 const rules=hub.AdminWrite('shop.save',{revision:1,items:{NICKNAME_TICKET:{enabled:true,price:100},NICKNAME_COLOR:{enabled:true,price:50}}},'ADMIN:SHOP-BALANCE');
 // Both devices read zero before an event credits this same authenticated account.
 const firstSnapshot=run(phone,'shop'),secondSnapshot=run(secondPhone,'shop');
 assert.equal(firstSnapshot.profile.points,0);assert.equal(secondSnapshot.profile.id,member);
 assert.equal(secondSnapshot.profile.points,0);
 s.Atomic(()=>rewards.Credit(s.ProfileById(member),500,'TEST_REWARD','earned-after-shop-open'));
 const request={itemId:'NICKNAME_TICKET',revision:rules.revision};
 const purchased=run(phone,'shop.purchase',request,'SHOPBALANCE-PURCHASE-01');
 assert.equal(purchased.profile.points,450,'a stale zero snapshot cannot block spending current earned points');
 assert.equal(purchased.inventory.nicknameTickets,1);
 assert.equal(Object.values(s.DB().pointLedger).find(row=>row.accountId===member&&row.kind==='BADGE_REWARD'&&row.reference==='SHOP_PURCHASE_1').amount,50);
 assert.equal(firstSnapshot.profile.points,0,'the scenario really uses an unchanged stale snapshot');
 assert.deepEqual(run(secondPhone,'shop.purchase',request,'SHOPBALANCE-PURCHASE-01'),purchased,'retry on another device never buys a second ticket');
 assert.equal(Object.keys(s.DB().shopPurchases).length,1);
 assert.equal(Object.values(s.DB().pointLedger).filter(row=>row.kind==='SHOP_PURCHASE').length,1);
 assert.equal(run(secondPhone,'shop').profile.points,450,'the other device reads the authoritative remaining points');
 // A sufficient-looking old snapshot and forged client balances cannot overspend.
 s.Atomic(()=>rewards.Credit(s.ProfileById(member),-450,'TEST_SPEND','spent-on-second-device'));
 const beforeReject=JSON.stringify(s.DB());
 assert.throws(()=>run(secondPhone,'shop.purchase',{...request,points:purchased.profile.points,profile:purchased.profile}),/INSUFFICIENT_POINTS/);
 assert.equal(JSON.stringify(s.DB()),beforeReject,'insufficient purchase changes no balance, inventory or receipt');
 assert.equal(run(phone,'shop').profile.points,0);
 s.Atomic(()=>rewards.Credit(s.ProfileById(member),100,'TEST_REWARD','exact-price'));
 const exact=run(secondPhone,'shop.purchase',request);
 assert.equal(exact.profile.points,0);assert.equal(exact.inventory.nicknameTickets,2);
 assert.throws(()=>run(other,'shop.purchase',{...request,accountId:member,points:100000000}),/INSUFFICIENT_POINTS/);
 assert.equal(run(other,'shop').inventory.nicknameTickets,0,'a supplied account ID never selects the owner account');
 const nextRules=hub.AdminWrite('shop.save',{...rules,items:{...rules.items,NICKNAME_TICKET:{enabled:true,price:120}}},'ADMIN:SHOP-BALANCE');
 s.Atomic(()=>rewards.Credit(s.ProfileById(member),120,'TEST_REWARD','new-price'));
 const beforePrice=JSON.stringify(s.DB());assert.throws(()=>run(phone,'shop.purchase',request),/CONTENT_CHANGED/);
 assert.equal(JSON.stringify(s.DB()),beforePrice,'a stale offer cannot charge a changed price');
 const updated=run(phone,'shop.purchase',{...request,revision:nextRules.revision});
 assert.equal(updated.profile.points,0);assert.equal(updated.purchase.price,120);
 // The native confirmation must reach the server even while its private shop snapshot is old.
 const native=fs.readFileSync(path.join(__dirname,'../../MoaPlayApp_Android64/MoaPlayApp.Member.Shop.inc'),'utf8');
 const confirm=native.slice(native.indexOf('procedure TMoaPlayForm.HubOpenShopConfirm'));
 assert.doesNotMatch(confirm,/if\s+HubNumber\([^\n]*['"]points['"]\)\s*</i,'native cached points must not veto a purchase before authoritative validation');
 assert.match(confirm,/shop\.purchase\.confirm\|/);
 console.log('FIX47 SHOP BALANCE PASS: stale-zero and stale-high multi-device snapshots, server-priced current balance, exact-price purchase, one-time retry receipt, private account isolation and price-change rejection.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
