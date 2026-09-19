'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix63-menu-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service');
let request=0;const run=(c,action,body={})=>hub.Execute(c,'FIX63-MENU-'+(++request),action,body);
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX63-MENU-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));return c;
}
try{
 const a=client(6301),b=client(6302),hidden=client(6303),p=s.Account(a),q=s.Account(b),blocked=s.Account(hidden),now=Date.now();
 s.Atomic(()=>{
  p.balance=321;q.balance=987654;
  for(let i=0;i<31;i++)s.DB().news['N'+i]={id:'N'+i,title:'공지 '+i,published:true,category:i===0?'EVENT':'NOTICE',at:now};
  s.DB().news.PRIVATE={id:'PRIVATE',title:'비공개',published:true,audience:q.id};
  s.DB().news.DRAFT={id:'DRAFT',published:false};s.DB().news.FUTURE={id:'FUTURE',published:true,publishAt:now+86400000};
  s.DB().products.GAME={id:'GAME',title:'게임',published:true};s.DB().products.DRAFT={id:'DRAFT',published:false};
  for(const [id,accountId,extra] of [['OWN',p.id,{}],['OTHER',q.id,{}],['DELETED',p.id,{deleted:true}],['HIDDEN',q.id,{hidden:true}],['BLOCKED',blocked.id,{}]])s.DB().posts[id]={id,accountId,body:id,at:now,...extra};
  for(const [id,accountId,extra] of [['OWN',p.id,{}],['OTHER',q.id,{}],['MERGED',p.id,{mergedInto:'OWN'}]])s.DB().orders[id]={id,accountId,at:now,title:id,status:'PAID',days:1,...extra};
  s.Ledger(p,-1,'PURCHASE','OWN');s.Ledger(p,5,'QR_TOPUP','DEPOSIT');s.Ledger(q,-2,'PURCHASE','OTHER');
 });
 run(a,'block.set',{id:blocked.id,blocked:true});
 const before=JSON.stringify(s.DB());
 const expensive=[['commerce','Catalog'],['commerce','OwnOrders'],['social','FeedRows'],['social','Popular'],['rewards','Read'],['history','Read'],['topGames','Read'],['media','GameCover']];
 const original=[];let menu;
 try{
  for(const [module,key] of expensive){const owner=require('../services/member/'+module);original.push([owner,key,owner[key]]);owner[key]=()=>{throw Error('menu must not build '+module+'.'+key);};}
  menu=run(a,'menu',{accountId:q.id,id:q.id,offset:10,limit:1});
 }finally{for(const [owner,key,value] of original)owner[key]=value;}
 assert.deepEqual(menu.counts,{news:31,catalog:1,feed:2,events:1,posts:1,orders:1,payments:1});
 assert.equal(menu.profile.id,p.id);assert.equal(menu.profile.balance,p.balance);assert.notEqual(menu.profile.balance,q.balance);
 assert.deepEqual(Object.keys(menu).sort(),['contentTag','counts','memberProtocol','profile','revision','viewer']);
 assert.equal(JSON.stringify(s.DB()),before,'menu refresh never rewrites committed state');
 s.Atomic(()=>{s.DB().settings.unrelatedDiagnostic=1;});
 assert.equal(run(a,'menu',{_ifNoneMatch:menu.contentTag}).unchanged,true,'unrelated pushes do not force a menu repaint');
 s.Atomic(()=>{s.DB().news.EXTRA={id:'EXTRA',published:true,category:'NOTICE',at:now};});
 const updated=run(a,'menu',{_ifNoneMatch:menu.contentTag});assert.equal(updated.counts.news,32);assert.notEqual(updated.contentTag,menu.contentTag);
 for(const key of ['summary','recentOrders','recentPayments','latestPayment','recentPointCredits','recentPurchases','topPurchased','popular','news','games','rewards'])assert.equal(updated[key],undefined);
 assert.throws(()=>run(a,'home'),/UNKNOWN_ACTION/);
 assert.equal(fs.existsSync(path.join(__dirname,'../services/member/home.js')),false,'Home implementation is physically deleted');
 assert.equal(Object.hasOwn(require('../services/member/identity'),'Home'),false);
 const admin=require('../services/member/identity').Read(p,{},true);assert.equal(admin.profile.id,p.id);assert.equal(admin.counts.orders,1);assert.equal(admin.summary,undefined);assert.equal(admin.recentOrders,undefined);
 for(const action of ['menu','activity','topgames','history','rewards','me']){a.biometricVerified=false;assert.throws(()=>run(a,action),/MEMBER_AUTH_REQUIRED/);a.biometricVerified=true;}
 console.log('FIX63 MENU API PASS: Home source/API removed, lightweight counts, private wallet ownership, visibility filters, complete counts, pure refresh, content-token freshness, independent destinations and authentication.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
