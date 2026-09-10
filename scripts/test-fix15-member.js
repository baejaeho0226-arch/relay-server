'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix15-member-'));process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),database=require('../storage/database');
require('../core/utils').EnsureDirs();let seq=0;
function client(id,key){const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,installationDeviceKey:key,socket:{destroyed:false,remoteAddress:'127.0.0.1',write(){return true;}}};state.clientIdentities.set(key,{id,serverId:''});state.clients.set(id,c);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return c;}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX15REQ'+String(++seq).padStart(8,'0'),action,body);
const admin=(action,body)=>hub.AdminWrite(action,body,'TEST'),fail=(fn,code)=>assert.throws(fn,e=>e.message===code);
try{
 const a=client('1111111111111111','FIX15-A'),b=client('2222222222222222','FIX15-B');const pa=run(a,'me').profile,pb=run(b,'me').profile;
 // Upgrade preserves already-recorded balances and receipts, while all deposit operations are retired.
 s.Atomic(()=>{s.Ledger(s.Account(a),10000,'TOPUP','PRIOR_VERSION_RECEIPT');s.DB().coins.old={id:'old',address:'PRIOR_ADDRESS'};s.DB().quotes.old={id:'old'};s.DB().topups.old={id:'old',accountId:pa.id,status:'APPROVED',amount:10000};});
 const before=JSON.stringify(s.DB());
 for(const action of ['topup.quote','topup.create','topup.cancel','coin.save'])fail(()=>run(a,action,{}),'TOPUP_UNAVAILABLE');
 for(const action of ['coin.save','topup.decide','topup.reopen','settings.save'])fail(()=>admin(action,{}),'TOPUP_UNAVAILABLE');
 for(const view of ['coins','topups'])fail(()=>hub.AdminRead({view}),'TOPUP_UNAVAILABLE');
 fail(()=>admin('content.action',{table:'coins',id:'old',operation:'delete'}),'CONTENT_ACTION_INVALID');assert.equal(JSON.stringify(s.DB()),before);
 assert.equal(run(a,'me').profile.balance,10000);assert.equal(run(a,'me').topups,undefined);assert.equal(run(a,'me').settings,undefined);assert.deepEqual(run(a,'home').settings,{});
 const snapshot=structuredClone(s.DB());s.Import({memberHub:snapshot});assert.deepEqual(s.DB().topups,snapshot.topups);assert.deepEqual(s.DB().ledger,snapshot.ledger);
 // Only opening a published, authorized article marks that specific revision as read.
 const n1=admin('news.save',{title:'소식 1',body:'첫 내용',category:'NOTICE',published:true});const n2=admin('news.save',{title:'소식 2',body:'다른 내용',category:'UPDATE',published:true});
 const privateNews=admin('news.save',{title:'개인 알림',body:'비공개 내용',category:'ALERT',audience:pa.id,published:true});
 assert.ok(run(a,'news').items.every(x=>x.unread));run(a,'news');assert.ok(run(a,'news').items.every(x=>x.unread));
 run(a,'article',{id:n1.id});assert.equal(run(a,'news').items.find(x=>x.id===n1.id).unread,false);assert.equal(run(a,'news').items.find(x=>x.id===n2.id).unread,true);assert.equal(run(b,'news').items.find(x=>x.id===n1.id).unread,true);
 fail(()=>run(b,'article',{id:privateNews.id}),'NEWS_NOT_FOUND');assert.equal(run(a,'news').items.find(x=>x.id===privateNews.id).unread,true);
 admin('news.save',{...n1,body:'수정된 공지'});assert.equal(run(a,'news').items.find(x=>x.id===n1.id).unread,true);
 const save=database.SaveDatabase,old=JSON.stringify(s.DB());database.SaveDatabase=()=>false;fail(()=>run(a,'article',{id:n1.id}),'STORAGE_SAVE_FAILED');database.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),old);
 fail(()=>run(a,'news.read'),'UNKNOWN_ACTION');
 const product=admin('product.save',{title:'쇼핑 상품',description:'테스트',accessType:'TYPE2',price:2000,days:30,stock:2,published:true});
 assert.equal(run(a,'product',{id:product.id}).product.price,undefined);
 fail(()=>run(a,'purchase',{productId:product.id,expectedPrice:2000}),'GAME_PLAN_INVALID');assert.equal(run(a,'me').profile.balance,10000);
 // Content lists expose their existing counters; listing does not count as opening.
 assert.equal(run(a,'catalog').items[0].views,1);
 const newsViews=run(a,'news').items;
 assert.equal(newsViews.find(x=>x.id===n1.id).views,1);
 assert.equal(newsViews.find(x=>x.id===n2.id).views,0);
 assert.equal(newsViews.find(x=>x.id===privateNews.id).views,0);
 assert.equal(run(a,'me').profile.views,undefined);
 fail(()=>run(a,'view',{screen:'news',kind:'news',id:n1.id}),'UNKNOWN_ACTION');
 const post=run(a,'post.create',{body:'원문'}).post;const comment=run(b,'comment.create',{postId:post.id,body:'댓글'}).comment;
 run(a,'feed');run(a,'feed');assert.equal(s.ViewCount('post',post.id),1);run(b,'feed');assert.equal(s.ViewCount('post',post.id),2);
 const thread=run(a,'thread',{postId:post.id});assert.equal(thread.comments.items[0].views,undefined);assert.equal(thread.post.author.views,undefined);assert.equal(s.ViewCount('post',post.id),2);
 assert.ok(Object.values(s.DB().viewCounters).every(x=>['post','news','product'].includes(x.kind)));assert.equal(s.ViewCount('comment',comment.id),0);assert.equal(s.ViewCount('profile',pa.id),0);
 s.DB().viewHits[pa.id+':post:'+post.id]='2000-01-01';run(a,'feed');assert.equal(s.ViewCount('post',post.id),3);
 // Owner edits, optimistic revision checks and retries cannot alter someone else's post.
 fail(()=>run(b,'post.edit',{id:post.id,body:'도용',revision:0}),'NOT_OWNER');
 fail(()=>run(a,'post.edit',{id:post.id,body:'누락'}),'CONTENT_CHANGED');
 const update={id:post.id,body:'내 글 수정',revision:0};const edited=run(a,'post.edit',update,'EDIT_RETRY_0001');assert.equal(edited.post.body,'내 글 수정');assert.equal(edited.post.revision,1);assert.equal(edited.post.at,post.at);
 assert.deepEqual(run(a,'post.edit',update,'EDIT_RETRY_0001'),edited);fail(()=>run(a,'post.edit',{...update,body:'이전 화면'}),'CONTENT_CHANGED');
 fail(()=>run(a,'post.edit',{...update,revision:1,body:'가'.repeat(2001)}),'INPUT_INVALID');
 const prior=JSON.stringify(s.DB());database.SaveDatabase=()=>false;fail(()=>run(a,'post.edit',{...update,revision:1,body:'저장 실패'}),'STORAGE_SAVE_FAILED');database.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),prior);
 admin('post.save',{id:post.id,body:'관리자 수정',revision:1});fail(()=>run(a,'post.edit',{...update,revision:1}),'CONTENT_CHANGED');
 admin('content.action',{table:'posts',id:post.id,operation:'hide'});assert.equal(run(a,'feed').total,0);fail(()=>run(a,'post.edit',{...update,revision:2}),'POST_NOT_FOUND');
 admin('content.action',{table:'posts',id:post.id,operation:'show'});run(a,'post.delete',{id:post.id});fail(()=>run(a,'post.edit',{...update,revision:4}),'POST_NOT_FOUND');
 // Historical screen counters remain excluded, without rewriting durable snapshots.
 s.DB().viewCounters['screen:news']={kind:'screen',id:'news',count:999};
 const overview=hub.AdminRead({view:'overview'});assert.equal(overview.postViews,3);assert.equal(overview.pageViews,undefined);assert.ok(overview.topContent.every(x=>['post','news','product'].includes(x.kind)));
 for(const view of ['news','profiles','comments'])assert.ok(hub.AdminRead({view}).items.every(x=>x.views===undefined));
 admin('profile.block',{id:pb.id,blocked:true});fail(()=>run(b,'feed'),'ACCOUNT_BLOCKED');
 console.log('FIX15 MEMBER PASS: deposits disabled, financial history retained, per-article unread revisions, content views without profile/comment counters, owner editing, concurrent conflicts, idempotency and atomic rollback');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
