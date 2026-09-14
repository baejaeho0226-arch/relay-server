'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix54-notifications-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),lm=require('../license/licenseManager');
let serial=0,now=1790000000000;const realNow=Date.now;Date.now=()=>now;
function client(n){
 const id=String(n).padStart(16,'0'),key='FIX54-NOTICE-DEVICE-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX54-NOTICE-REQUEST-'+(++serial),action,body);
const account=c=>s.Account(c),snapshot=()=>JSON.stringify(s.DB());
try{
 const a=client(1),b=client(2),c=client(3),wallet=client(4);for(const x of [a,b,c,wallet])run(x,'me');
 const pa=account(a),pb=account(b),pc=account(c),db=s.DB();
 assert.equal(run(a,'notifications').total,0);
 s.Atomic(()=>{
  Object.assign(pa,{notifyFollowers:true,notifyFollowing:true,notifyComments:true});
  db.ledger.own={id:'PAY-OWN',accountId:pa.id,kind:'QR_TOPUP',amount:1000,balance:1000,reference:'CHARGE-OWN',at:now-10};
  db.ledger.remote={id:'PAY-REMOTE-SECRET',accountId:pb.id,kind:'QR_TOPUP',amount:9999,at:now};
  db.pointLedger.own={id:'PNT-OWN',accountId:pa.id,kind:'BADGE_REWARD',amount:50,reference:'REPORT_1',at:now-9};
  db.pointLedger.remote={id:'PNT-REMOTE-SECRET',accountId:pb.id,kind:'BADGE_REWARD',amount:100,at:now};
  db.follows[pb.id+':'+pa.id]={follower:pb.id,following:pa.id,at:now-8};
  db.follows[pa.id+':'+pb.id]={follower:pa.id,following:pb.id,at:now-7};
  db.posts.own={id:'POST-OWN',accountId:pa.id,body:'My post',at:now-20};
  db.posts.followed={id:'POST-FOLLOWED',accountId:pb.id,body:'Followed post',at:now-6};
  db.posts.other={id:'POST-OTHER',accountId:pc.id,body:'Unfollowed post',at:now-6};
  // Table keys mirror identifiers, as they do for persisted real records.
  for(const [key,row]of Object.entries(db.posts)){delete db.posts[key];db.posts[row.id]=row;}
  db.comments.comment={id:'COM-OWN-POST',accountId:pb.id,postId:'POST-OWN',body:'A visible comment',at:now-5};
  db.comments.self={id:'COM-SELF',accountId:pa.id,postId:'POST-OWN',body:'My own comment',at:now-4};
  db.news.visible={id:'NEWS-VISIBLE',published:true,title:'Visible announcement',body:'No full text needed',at:now-3};
  db.news.other={id:'NEWS-PRIVATE-SECRET',published:true,audience:pb.id,title:'Other member secret',at:now};
  db.news.future={id:'NEWS-FUTURE-SECRET',published:true,title:'Not published yet',publishAt:now+1000,at:now};
  db.news.deleted={id:'NEWS-DELETED-SECRET',published:true,deleted:true,title:'Deleted news',at:now};
 });
 state.notifications.push({id:'ADMIN-SECRET',message:'Private device/security incident',entityId:a.clientId,createdAt:now});
 const before=snapshot(),first=run(a,'notifications');assert.equal(snapshot(),before,'notifications reads never persist, pay, mark read or create an operation');
 assert.deepEqual(first.items.map(x=>x.id),['news:NEWS-VISIBLE','comment:COM-OWN-POST','post:POST-FOLLOWED','follow:'+pb.id,'points:PNT-OWN','payment:PAY-OWN']);
 const serialized=JSON.stringify(first.items);for(const secret of ['REMOTE-SECRET','PRIVATE-SECRET','FUTURE-SECRET','DELETED-SECRET','ADMIN-SECRET','REPORT_1','subject','balance','token'])assert.ok(!serialized.includes(secret),secret+' must not leak');
 assert.ok(first.items.every(x=>/^(payments|charge|points|badges|comments\|[^|]+|member\|[^|]+|article\|[^|]+)$/.test(x.target)));
 assert.deepEqual(run(a,'notifications',{profileId:pb.id}).items,first.items,'untrusted target identifiers cannot select another inbox');
 const page1=run(a,'notifications',{limit:3}),page2=run(a,'notifications',{offset:page1.nextOffset,limit:3});
 assert.equal(page1.total,6);assert.equal(page2.nextOffset,null);assert.equal(new Set([...page1.items,...page2.items].map(x=>x.id)).size,6);
 s.Atomic(()=>{db.blocks[pa.id+':'+pb.id]={accountId:pa.id,targetId:pb.id,at:now};});
 assert.ok(run(a,'notifications').items.every(x=>!['post','follow','comment'].includes(x.id.split(':')[0])),'blocked accounts disappear from every social category');
 s.Atomic(()=>{delete db.blocks[pa.id+':'+pb.id];pb.profilePostsVisibility='PRIVATE';});
 assert.ok(!run(a,'notifications').items.some(x=>x.id==='post:POST-FOLLOWED'),'profile privacy applies to post subscription previews');
 s.Atomic(()=>{Object.assign(pa,{notifyFollowers:false,notifyFollowing:false,notifyComments:false,notifyRelease:false,notifyApproval:false});});
 assert.deepEqual(run(a,'notifications').items.map(x=>x.id),['points:PNT-OWN'],'social and publication preferences are honored without hiding earned rewards');
 s.Atomic(()=>{pa.language='en';});assert.equal(run(a,'notifications').items[0].title,'Title reward points received');
 a.biometricVerified=false;assert.throws(()=>run(a,'notifications'),/MEMBER_AUTH_REQUIRED/);a.biometricVerified=true;
 // A mutation can earn a title after building its ordinary response. The fresh
 // envelope reports the actor's wallet without altering any settlement receipt.
 const body={body:'A title reward is reflected immediately'},created=run(wallet,'post.create',body,'FIX54-WALLET-POST');
 assert.equal(created.wallet.accountId,account(wallet).id);assert.equal(created.wallet.points,50);assert.equal(created.ownProfile,undefined);
 assert.deepEqual(Object.keys(created.wallet).sort(),['accountId','balance','eventSpins','points','revision']);
 const key=account(wallet).id+':FIX54-WALLET-POST',receipt=JSON.stringify(s.DB().operations[key].result);
 const attendance=run(wallet,'attendance.check');assert.equal(attendance.wallet.points,account(wallet).points);assert.equal(attendance.attendance.points,attendance.wallet.points);assert.equal(attendance.profile.points,attendance.wallet.points);
 assert.ok(attendance.history.items.some(x=>x.kind==='BADGE_REWARD'&&x.reference==='ATTENDANCE_1'));
 const replayBefore=snapshot(),replayed=run(wallet,'post.create',body,'FIX54-WALLET-POST');
 assert.equal(replayed.wallet.points,account(wallet).points);assert.equal(JSON.stringify(s.DB().operations[key].result),receipt);assert.equal(snapshot(),replayBefore);
 const remote=run(wallet,'member',{id:pc.id,countView:true});assert.equal(remote.wallet.accountId,account(wallet).id);assert.equal(remote.wallet.points,account(wallet).points);assert.equal(remote.ownProfile,undefined);
 for(const field of ['points','balance','inventory','eventSpins','subject','badgeProgress'])assert.equal(remote.profile[field],undefined,'remote profile remains public: '+field);
 const historyBefore=Object.keys(s.DB().operations).length;
 assert.equal(run(wallet,'history.record',{route:'notifications'}).recorded,true);
 const historySnapshot=snapshot();assert.equal(run(wallet,'history.record',{route:'notifications'}).recorded,false);assert.equal(snapshot(),historySnapshot);
 assert.equal(Object.keys(s.DB().operations).length,historyBefore,'history does not create durable mutation receipts');
 assert.equal(run(wallet,'history').recentServices[0].route,'notifications');
 console.log('FIX54 NOTIFICATIONS/WALLET PASS: private read-only inbox, preferences, visibility, pagination, safe targets, auth, fresh award responses and replay, remote profile isolation, history integration.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
