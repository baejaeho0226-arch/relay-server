'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix52-reposts-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),lm=require('../license/licenseManager'),database=require('../storage/database');
let sequence=0;
function client(n){
 const id=String(n).repeat(16),key='FIX52-REPOST-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:Date.now()});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},requestId='FIX52-REPOST-'+(++sequence))=>hub.Execute(c,requestId,action,body);
function SameReceipt(actual,expected,p,message){
 const {wallet:actualWallet,...actualReceipt}=actual,{wallet:expectedWallet,...expectedReceipt}=expected;
 assert.deepEqual(actualReceipt,expectedReceipt,message);
 if(expectedWallet)assert.deepEqual(actualWallet,require('../services/member/arcade').Wallet(s.ProfileById(p.id)),'only the authenticated wallet reflects the latest committed state');
 else assert.equal(actualWallet,undefined);
}
try{
 const a=client(1),b=client(2),pa=run(a,'me').profile,pb=run(b,'me').profile;
 const source=run(a,'post.create',{title:'첫 이야기',body:'리포스트해도 보존할 본문',poll:{question:'어느 쪽인가요?',options:['왼쪽','오른쪽']}}).post;
 s.Atomic(()=>{s.DB().posts[source.id].at=Date.now()-180000;});
 const original=structuredClone(s.DB().posts[source.id]);
 const newer=run(b,'post.create',{body:'원글보다 나중에 작성한 글'}).post;
 assert.equal(run(b,'feed').items[0].id,newer.id);
 const requestId='FIX52-REPOST-IDEMPOTENT',body={postId:source.id,value:true};
 const result=run(a,'repost.set',body,requestId),key=pa.id+':'+source.id;
 assert.equal(result.reposted,true);assert.equal(result.post.myRepost,true);assert.equal(result.post.reposts,1);
 assert.equal(result.post.repostedBy.id,pa.id);assert.ok(result.post.repostedBy.at>original.at);
 assert.equal(result.post.at,original.at);assert.deepEqual(s.DB().posts[source.id],original);
 assert.equal(run(a,'me').posts.total,1,'direct self repost cannot add a duplicate post to the profile');
 assert.equal(run(b,'feed').items[0].id,source.id,'existing repost time promotes the original in the latest feed');
 assert.equal(run(b,'thread',{postId:source.id}).post.myRepost,false,'repost state belongs to the authenticated viewer');
 SameReceipt(run(a,'repost.set',body,requestId),result,pa,'replaying the same operation returns its committed receipt');
 const directId=s.DB().reposts[key].id,realNow=Date.now,clock=Date.now()+2;
 Date.now=()=>clock;
 try{
  s.Atomic(()=>{s.ProfileById(pb.id).last_post=0;});
  const intervening=run(b,'post.create',{body:'다시 리포스트하기 전에 작성한 최신 글'}).post;
  assert.equal(run(b,'feed').items[0].id,intervening.id);
  let lastAt=result.post.repostedBy.at;
  for(let i=0;i<12;i++){
   const repeatId='FIX53-REPOST-REPEAT-'+i,repeated=run(a,'repost.set',body,repeatId);
   assert.equal(repeated.post.reposts,1);
   assert.ok(repeated.post.repostedBy.at>lastAt,'each new confirmation advances time even in the same clock millisecond');
   assert.equal(s.DB().reposts[key].id,directId,'repeated promotions retain the single relationship');
   assert.equal(run(b,'feed',{sort:'latest'}).items[0].id,source.id,'confirmed repost is immediately first in the latest feed');
   const committedAt=s.DB().reposts[key].at;
   SameReceipt(run(a,'repost.set',body,repeatId),repeated,pa);
   assert.equal(s.DB().reposts[key].at,committedAt,'transport replay cannot promote again');
   lastAt=repeated.post.repostedBy.at;
  }
 }finally{Date.now=realNow;}
 assert.equal(Object.keys(s.DB().reposts).length,1,'different confirmations cannot create duplicate repost rows');
 assert.deepEqual(s.DB().posts[source.id],original,'unlimited promotions preserve the original content, poll, and time');
 const latestAt=s.DB().reposts[key].at;
 SameReceipt(run(a,'repost.set',body,requestId),result,pa,'an old receipt remains immutable after later promotions');
 assert.equal(s.DB().reposts[key].at,latestAt,'an old network retry cannot rewind the latest timestamp');
 run(a,'react',{postId:newer.id,value:1});
 assert.equal(run(b,'feed',{sort:'popular'}).items[0].id,newer.id,'reposting changes recency but does not manufacture popularity');
 assert.equal(run(b,'feed',{sort:'latest'}).items[0].id,source.id);
 assert.throws(()=>run(a,'repost.set',{...body,value:false},requestId),/REQUEST_REUSED/);
 assert.throws(()=>run(a,'repost.set',{postId:source.id,value:1}),/INPUT_INVALID/);
 assert.throws(()=>run(b,'repost.set',{postId:source.id,value:true}),/REPOST_COMPOSE_REQUIRED/);
 assert.throws(()=>run(b,'repost.set',{postId:source.id,value:false}),/REPOST_COMPOSE_REQUIRED/);
 assert.equal(s.DB().reposts[pb.id+':'+source.id],undefined);
 s.Atomic(()=>{s.ProfileById(pb.id).last_post=0;});
 const quote=run(b,'post.create',{body:'다른 회원의 의견',quotePostId:source.id}).post;
 assert.equal(quote.quote.id,source.id);assert.equal(quote.author.id,pb.id);assert.equal(quote.quote.body,original.body);
 const compact=run(a,'repost.set',{...body,_delta:true});
 assert.equal(compact.partial,true);assert.equal(compact.post.myRepost,true);assert.equal(compact.post.reposts,2);
 assert.equal(compact.post.repostedBy.id,pa.id);assert.equal(compact.post.author,undefined);
 const save=database.SaveDatabase,committedRepost=structuredClone(s.DB().reposts[key]);database.SaveDatabase=()=>false;
 try{
  assert.throws(()=>run(a,'repost.set',body),/STORAGE_SAVE_FAILED/);
  assert.deepEqual(s.DB().reposts[key],committedRepost,'failed persistence cannot change an existing repost timestamp');
  assert.throws(()=>run(a,'repost.set',{postId:source.id,value:false}),/STORAGE_SAVE_FAILED/);
 }finally{database.SaveDatabase=save;}
 assert.ok(s.DB().reposts[key],'failed persistence rolls back repost removal');
 s.Atomic(()=>{s.DB().posts[source.id].hidden=true;});
 assert.throws(()=>run(a,'repost.set',body),/POST_NOT_FOUND/);
 assert.ok(!run(b,'feed').items.some(x=>x.id===source.id));
 assert.equal(run(b,'thread',{postId:quote.id}).post.quote.unavailable,true,'repost metadata cannot expose a hidden source');
 s.Atomic(()=>{s.DB().posts[source.id].hidden=false;});
 run(a,'block.set',{id:pb.id,blocked:true});
 assert.ok(!run(b,'feed').items.some(x=>x.id===source.id),'blocking also applies to direct self reposts');
 assert.throws(()=>run(b,'thread',{postId:source.id}),/POST_NOT_FOUND/);
 run(a,'block.set',{id:pb.id,blocked:false});
 assert.equal(database.ImportDatabaseObject(database.BuildDatabaseObject()),true);
 assert.equal(run(a,'thread',{postId:source.id}).post.repostedBy.at,compact.post.repostedBy.at,'latest repost promotion survives storage reload');
 const removed=run(a,'repost.set',{postId:source.id,value:false});assert.equal(removed.reposted,false);assert.equal(removed.post.reposts,1);
 assert.equal(run(a,'repost.set',{postId:source.id,value:false}).post.reposts,1,'idempotent removal preserves another member quote');
 database.SaveDatabase=()=>false;
 try{assert.throws(()=>run(a,'repost.set',body),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(s.DB().reposts[key],undefined,'failed persistence cannot publish a new repost');
 s.Atomic(()=>{s.ProfileById(pa.id).last_post=0;});
 const ownQuote=run(a,'post.create',{body:'인용했던 내 글',quotePostId:newer.id}).post;
 s.Atomic(()=>{s.DB().posts[ownQuote.id].at=Date.now()-60000;});
 const ownQuoteRepost=run(a,'repost.set',{postId:ownQuote.id,value:true}).post;
 assert.ok(ownQuoteRepost.repostedBy.at>ownQuoteRepost.at,'reposting an owned quote uses the fresh direct attribution time');
 assert.equal(ownQuoteRepost.quote.id,newer.id,'an owned quote preserves its source after direct repost');
 run(a,'post.delete',{id:source.id});assert.throws(()=>run(a,'repost.set',body),/POST_NOT_FOUND/);
 assert.equal(s.DB().posts[quote.id].deleted,false,'deleting the source does not remove the other member quote');
 console.log('FIX53 SELF REPOST PASS: repeated owner confirmations, same-millisecond latest promotion, one relationship, immutable network retries, original content/time, compact response, composer compatibility, visibility/blocks, persistence and rollback.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
