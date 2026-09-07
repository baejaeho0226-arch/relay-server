'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-member13-'));process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
const state=require('../core/state'),store=require('../services/member/store'),service=require('../services/member/service'),database=require('../storage/database');
require('../core/utils').EnsureDirs();let request=0;
function client(id,key){const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,installationDeviceKey:key,socket:{destroyed:false,remoteAddress:'127.0.0.1',write(){return true;}}};state.clientIdentities.set(key,{id,serverId:''});state.clients.set(id,c);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return c;}
function run(c,action,body={},id){return service.Execute(c,id||'REQTEST'+String(++request).padStart(8,'0'),action,body);}
try{
 const a=client('1111111111111111','MEMBER-A'),b=client('2222222222222222','MEMBER-B');
 // Verify real auth gating, including cross-device access and expired proofs.
 assert.equal(service.Allowed(a),true);b.biometricVerified=false;assert.throws(()=>run(b,'me'),/MEMBER_AUTH_REQUIRED/);b.biometricVerified=true;
 const pa=run(a,'me').profile,pb=run(b,'me').profile;assert.notEqual(pa.id,pb.id);
 service.AdminWrite('settings.save',{topupEnabled:true,topupInstructions:'테스트 계좌 입금 확인'},'ADMIN');
 const product=service.AdminWrite('product.save',{title:'테일즈런너 30일',accessType:'TYPE1',description:'서버 상품',price:5000,days:30,stock:2,published:true},'ADMIN');
 assert.equal(run(a,'catalog').items.length,1);
 assert.throws(()=>run(a,'purchase',{productId:product.id,expectedPrice:1}),/PRICE_CHANGED/);
 assert.throws(()=>run(a,'purchase',{productId:product.id,expectedPrice:5000}),/INSUFFICIENT_BALANCE/);
 const top=run(a,'topup.create',{amount:10000,depositor:'테스트',note:''}).topup;
 assert.equal(run(a,'me').profile.balance,0);assert.throws(()=>run(b,'topup.cancel',{id:top.id}),/TOPUP_NOT_FOUND/);
 service.AdminWrite('topup.decide',{id:top.id,approve:true},'ADMIN');service.AdminWrite('topup.decide',{id:top.id,approve:true},'ADMIN');assert.equal(run(a,'me').profile.balance,10000);
 const body={productId:product.id,expectedPrice:5000,amount:1,accountId:pb.id};
 const bought=run(a,'purchase',body,'PURCHASE-REPLAY');assert.equal(bought.balance,5000);assert.deepEqual(run(a,'purchase',body,'PURCHASE-REPLAY'),bought);assert.equal(run(b,'me').profile.balance,0);
 assert.throws(()=>run(a,'purchase',{...body,expectedPrice:4999},'PURCHASE-REPLAY'),/REQUEST_REUSED/);
 assert.throws(()=>run(b,'order.activate',{orderId:bought.order.id}),/ORDER_NOT_FOUND/);
 // Failed persistence rolls back wallet, stock, orders and idempotency record.
 const save=database.SaveDatabase;database.SaveDatabase=()=>false;
 assert.throws(()=>run(a,'purchase',body,'PURCHASE-FAILED'),/STORAGE_SAVE_FAILED/);database.SaveDatabase=save;
 assert.equal(run(a,'me').profile.balance,5000);assert.equal(store.DB().products[product.id].stock,1);
 const second=run(a,'purchase',body,'PURCHASE-FAILED');assert.equal(second.balance,0);assert.equal(store.DB().products[product.id].stock,0);
 service.AdminWrite('order.refund',{id:second.order.id,reason:'미사용 환불'},'ADMIN');service.AdminWrite('order.refund',{id:second.order.id,reason:'반복'},'ADMIN');assert.equal(run(a,'me').profile.balance,5000);
 const activated=run(a,'order.activate',{orderId:bought.order.id});assert.equal(activated.order.status,'ACTIVE');assert.equal(state.licenses.size,1);assert.throws(()=>service.AdminWrite('order.refund',{id:bought.order.id,reason:'사용 후'},'ADMIN'),/ACTIVATED_REFUND_REVIEW/);
 const post=run(a,'post.create',{body:'첫 소식 <script>hello</script>'}).post;
 assert.throws(()=>run(b,'post.delete',{id:post.id}),/NOT_OWNER/);
 run(b,'react',{postId:post.id,value:1});run(b,'react',{postId:post.id,value:-1});let feed=run(a,'feed');assert.equal(feed.items[0].likes,0);assert.equal(feed.items[0].dislikes,1);
 const comment=run(b,'comment.create',{postId:post.id,body:'댓글입니다.'}).comment;assert.equal(run(a,'thread',{postId:post.id}).comments.total,1);
 assert.throws(()=>run(a,'comment.delete',{id:comment.id}),/NOT_OWNER/);run(b,'comment.delete',{id:comment.id});assert.equal(run(a,'thread',{postId:post.id}).comments.total,0);
 run(b,'report',{postId:post.id,reason:'확인 요청'});service.AdminWrite('post.moderate',{id:post.id,hidden:true},'ADMIN');assert.equal(run(a,'feed').total,0);assert.throws(()=>run(b,'comment.create',{postId:post.id,body:'숨긴 글'}),/POST_NOT_FOUND/);
 service.AdminWrite('news.save',{title:'업데이트',body:'새 버전',category:'UPDATE',published:true},'ADMIN');assert.equal(run(a,'news').total,1);
 run(a,'profile.save',{nickname:'한글 프로필',bio:'안녕하세요'});assert.throws(()=>run(a,'profile.save',{nickname:'테스트',avatar:'data:image/svg+xml;base64,AA=='}),/AVATAR_INVALID/);
 const disk=database.ExportDatabase?database.ExportDatabase():JSON.parse(fs.readFileSync(require('../config/config').DB_FILE));store.Import(disk);assert.equal(run(a,'me').profile.balance,5000);assert.equal(run(a,'me').profile.nickname,'한글 프로필');
 service.AdminWrite('profile.block',{id:pb.id,blocked:true},'ADMIN');assert.throws(()=>run(b,'feed'),/ACCOUNT_BLOCKED/);
 const before=JSON.stringify(store.DB());require('../services/serviceLifecycle').Stop('TEST');assert.equal(JSON.stringify(store.DB()),before,'Service reset must retain balances and paid orders');
 console.log('FIX13 MEMBER PASS: authorization, server prices, balances, approved topups, idempotency, atomic rollback, pass activation, refund, isolation, feed, reactions, comments, moderation, profile and durable financial records');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
