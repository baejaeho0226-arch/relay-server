'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix52-badges-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),lm=require('../license/licenseManager'),database=require('../storage/database'),badges=require('../services/member/badges');
let serial=0,now=1790000000000;const realNow=Date.now;Date.now=()=>now;
function client(n){
 const id=String(n).repeat(16),key='FIX52-BADGES-'+n;
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:key,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(key,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));
 c.licenseKey=lm.CreateLicense(900,'출입증',['QR'],'QR').key;state.licenses.get(c.licenseKey).boundClient=id;return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX52-BADGES-'+(++serial),action,body);
const account=c=>s.Account(c),progress=c=>account(c).badgeProgress;
const badge=(c,id)=>run(c,'badges').items.find(x=>x.id===id);
const post=(c,text)=>{now+=11000;return run(c,'post.create',{body:text}).post;};
try{
 const a=client(1),b=client(2),c=client(3),d=client(4),pa=run(a,'me').profile,pb=run(b,'me').profile,pc=run(c,'me').profile;run(d,'me');
 const beforeFailure=JSON.stringify(s.DB());
 assert.throws(()=>run(d,'post.create',{}),/INPUT_INVALID/);assert.equal(JSON.stringify(s.DB()),beforeFailure,'invalid creation cannot migrate or grant badges');
 d.biometricVerified=false;assert.throws(()=>run(d,'attendance.check'),/MEMBER_AUTH_REQUIRED/);assert.equal(JSON.stringify(s.DB()),beforeFailure,'unauthenticated action cannot count');d.biometricVerified=true;
 // A FIX51 server-selected badge is proof of earlier completion even when its
 // live follower count has already declined before upgrading.
 s.Atomic(()=>{account(d).titleBadgeId='FOLLOWERS_500';});
 assert.equal(badge(d,'FOLLOWERS_500').earned,true);assert.equal(run(d,'me').profile.titleBadge.id,'FOLLOWERS_500');
 // Existing FIX51 eligibility is captured before the first reducing action.
 s.Atomic(()=>{for(let i=0;i<10;i++)s.DB().posts['POST-LEGACY-'+i]={id:'POST-LEGACY-'+i,accountId:pa.id,body:'기존 이야기 '+i,at:now-i,deleted:false,hidden:false};});
 run(a,'post.delete',{id:'POST-LEGACY-0'});assert.equal(badge(a,'POSTS_10').earned,true);const legacyAt=badge(a,'POSTS_10').earnedAt;assert.equal(badge(a,'POSTS_10').legacy,true);
 run(a,'badge.select',{id:'POSTS_10'});for(let i=1;i<10;i++)run(a,'post.delete',{id:'POST-LEGACY-'+i});
 assert.equal(run(a,'me').profile.posts,0);assert.equal(run(a,'me').profile.titleBadge.id,'POSTS_10');assert.equal(badge(a,'POSTS_10').earnedAt,legacyAt);assert.equal(badge(a,'POSTS_10').progress,10);
 const first=post(a,'피드백을 받을 공개 이야기'),other=post(b,'댓글과 공감의 원글');
 run(a,'react',{postId:other.id,value:1},'FIX52-LIKE-REPLAY');const afterLike=JSON.stringify(progress(a));run(a,'react',{postId:other.id,value:1},'FIX52-LIKE-REPLAY');assert.equal(JSON.stringify(progress(a)),afterLike);
 for(let i=0;i<12;i++){run(a,'react',{postId:other.id,value:0});run(a,'react',{postId:other.id,value:1});}
 assert.equal(progress(a).counts.likes,1,'same target toggles never farm progress');assert.equal(badge(a,'LIKES_10').earned,false);assert.equal(badge(b,'LIKED_1').earned,true);
 const likeState=JSON.stringify(s.DB());assert.throws(()=>run(a,'react',{postId:other.id,value:0},'FIX52-LIKE-REPLAY'),/REQUEST_REUSED/);assert.equal(JSON.stringify(s.DB()),likeState);
 run(a,'react',{postId:other.id,value:0});assert.equal(badge(a,'LIKES_1').earned,true);assert.equal(badge(b,'LIKED_1').earned,true);
 for(let i=0;i<12;i++){run(a,'bookmark.set',{kind:'post',id:other.id,saved:true});run(a,'bookmark.set',{kind:'post',id:other.id,saved:false});}
 assert.equal(progress(a).counts.bookmarks,1);assert.equal(badge(a,'BOOKMARK_1').earned,true);
 for(let i=0;i<12;i++){run(a,'follow.set',{id:pb.id,following:true});run(a,'follow.set',{id:pb.id,following:false});}
 assert.equal(progress(a).counts.following,1);assert.equal(badge(a,'FOLLOWING_10').earned,false);assert.equal(badge(b,'FOLLOWERS_1').earned,true);
 run(a,'follow.set',{id:pb.id,following:true});run(b,'block.set',{id:pa.id,blocked:true});assert.equal(badge(b,'FOLLOWERS_1').earned,true);run(b,'block.set',{id:pa.id,blocked:false});
 const comment=run(a,'comment.create',{postId:other.id,body:'첫 댓글'}).comment;now+=2000;
 const reply=run(a,'comment.create',{postId:other.id,parentId:comment.id,body:'첫 답글'}).comment;
 run(a,'comment.delete',{id:comment.id});run(a,'comment.delete',{id:reply.id});assert.equal(badge(a,'COMMENTS_1').earned,true);assert.equal(badge(a,'REPLY_1').earned,true);
 now+=11000;const poll=run(b,'post.create',{body:'한 표를 남겨주세요',poll:{question:'선택은?',options:['하나','둘']}}).post;
 assert.equal(badge(b,'POLL_CREATE_1').earned,true);run(a,'poll.vote',{postId:poll.id,optionId:'0'});assert.equal(badge(a,'POLL_VOTE_1').earned,true);
 const pollState=JSON.stringify(s.DB());assert.throws(()=>run(a,'poll.vote',{postId:poll.id,optionId:'1'}),/POLL_ALREADY_VOTED/);assert.equal(JSON.stringify(s.DB()),pollState);
 run(b,'report',{kind:'post',id:first.id,reason:'PRIVATE-REASON-DO-NOT-EXPOSE'});run(b,'report',{kind:'post',id:first.id,reason:'중복 신고'});
 assert.equal(progress(b).counts.reports,1);assert.equal(progress(a).counts.reportsReceived,1);assert.equal(badge(a,'REPORT_RECEIVED_1').earned,true);assert.equal(badge(b,'REPORT_1').earned,true);
 run(a,'badge.select',{id:'REPORT_RECEIVED_1'});run(a,'post.delete',{id:first.id});s.Atomic(()=>{s.DB().reports={};});
 const remote=run(c,'badges',{profileId:pa.id});assert.equal(remote.readOnly,true);assert.equal(remote.selected,'REPORT_RECEIVED_1');assert.ok(remote.items.some(x=>x.id==='REPORT_RECEIVED_1'));assert.ok(remote.items.every(x=>x.earned&&x.progress===undefined));
 for(const field of ['balance','points','inventory','eventSpins','preferences','subject','badgeProgress'])assert.equal(remote.profile[field],undefined,field+' stays private');
 assert.ok(!JSON.stringify(remote).includes('PRIVATE-REASON-DO-NOT-EXPOSE'));assert.ok(!JSON.stringify(remote).includes(pb.id),'badge inventory must not expose reporters');
 assert.throws(()=>run(c,'badge.select',{id:'POSTS_10',profileId:pa.id}),/NOT_OWNER/);
 // A profile projection/list refresh is not a visit. Explicit, visible opens count once.
 run(c,'member',{id:pa.id,countView:false});assert.equal(progress(c),undefined);run(c,'member',{id:pc.id,countView:true});assert.equal(progress(c),undefined);
 run(c,'member',{id:pa.id,countView:true});const visitRevision=s.DB().revision;for(let i=0;i<12;i++)run(c,'member',{id:pa.id,countView:true});assert.equal(progress(c).counts.profileVisits,1);assert.equal(s.DB().revision,visitRevision,'duplicate detail opens do not write');
 run(a,'block.set',{id:pc.id,blocked:true});const blocked=JSON.stringify(s.DB());assert.throws(()=>run(c,'member',{id:pa.id,countView:true}),/MEMBER_NOT_FOUND/);assert.equal(JSON.stringify(s.DB()),blocked);run(a,'block.set',{id:pc.id,blocked:false});
 // Roll back migration, counters, awards, ordinary data and request receipts together.
 const prior=JSON.stringify(s.DB()),save=database.SaveDatabase;try{database.SaveDatabase=()=>false;assert.throws(()=>run(d,'attendance.check',{},'FIX52-ROLLBACK-ATTENDANCE'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),prior);run(d,'attendance.check',{},'FIX52-ROLLBACK-ATTENDANCE');assert.equal(badge(d,'ATTENDANCE_1').earned,true);
 const readPrior=JSON.stringify(s.DB());try{database.SaveDatabase=()=>false;assert.throws(()=>run(d,'member',{id:pa.id,countView:true}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}assert.equal(JSON.stringify(s.DB()),readPrior,'failed read award leaves no in-memory progress');
 // Defaults/same-value profile saves do not complete the edit mission.
 run(d,'profile.save',{nickname:account(d).nickname,bio:''});assert.equal(badge(d,'PROFILE_EDIT_1').earned,false);
 run(d,'profile.save',{nickname:account(d).nickname,bio:'반가워요'});run(d,'profile.save',{nickname:account(d).nickname,bio:''});assert.equal(badge(d,'PROFILE_EDIT_1').earned,true);assert.equal(badge(d,'BIO_1').earned,true);
 // Wallet and event achievements require their authoritative completed records.
 const charges=require('../services/member/charges'),rewards=require('../services/member/rewards');
 const pending=charges.Issue(account(d));assert.equal(badge(d,'QR_CHARGE_1').earned,false);
 const approval={id:pending.id,mode:'WALLET',amount:20000,memo:'실제 승인 검증',approvalToken:charges.Inspect('QRC1.'+pending.id+'.'+pending.token).approvalToken};
 const chargeBefore=JSON.stringify(s.DB());try{database.SaveDatabase=()=>false;assert.throws(()=>charges.Approve(approval,'FIX52-TEST'),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),chargeBefore);charges.Approve(approval,'FIX52-TEST');assert.equal(badge(d,'QR_CHARGE_1').earned,true);
 const chargeAt=badge(d,'QR_CHARGE_1').earnedAt,chargeState=JSON.stringify(s.DB());charges.Approve(approval,'FIX52-TEST');assert.equal(JSON.stringify(s.DB()),chargeState);assert.equal(badge(d,'QR_CHARGE_1').earnedAt,chargeAt);
 const spinBody={revision:rewards.Rules().revision};run(d,'event.spin',spinBody,'FIX52-FIRST-WHEEL');const spinProgress=JSON.stringify(progress(d));run(d,'event.spin',spinBody,'FIX52-FIRST-WHEEL');assert.equal(JSON.stringify(progress(d)),spinProgress);assert.equal(badge(d,'WHEEL_1').earned,true);assert.equal(progress(d).counts.wheel,1);
 const casinoBefore=JSON.stringify(s.DB());assert.throws(()=>run(d,'arcade.play',{game:'BACCARAT',choice:'INVALID',amount:100,rulesRevision:run(d,'arcade').rules.revision}),/INPUT_INVALID/);assert.equal(JSON.stringify(s.DB()),casinoBefore);
 for(const [game,choice] of [['BACCARAT','PLAYER'],['ROULETTE','RED'],['SLOTS','SPIN']]){
  now+=500;const playBody={game,choice,amount:100,rulesRevision:run(d,'arcade',{game}).rules.revision};run(d,'arcade.play',playBody,'FIX52-FIRST-'+game);assert.equal(badge(d,game+'_1').earned,true);
  const playProgress=JSON.stringify(progress(d));run(d,'arcade.play',playBody,'FIX52-FIRST-'+game);assert.equal(JSON.stringify(progress(d)),playProgress);
 }
 assert.equal(progress(d).counts.casinoPlays,3);
 const game=hub.AdminWrite('product.save',{title:'뱃지 결제 검증 게임',description:'이용권',genre:'게임',accessType:'TYPE1',plans:[{days:1,price:100},{days:7,price:700}],published:true},'FIX52-TEST');
 run(d,'product',{id:game.id,countView:true});assert.equal(badge(d,'GAME_READ_1').earned,true);
 const purchaseBody={productId:game.id,days:1,price:100,revision:game.revision},bought=run(d,'purchase',purchaseBody,'FIX52-FIRST-PURCHASE');run(d,'purchase',purchaseBody,'FIX52-FIRST-PURCHASE');
 assert.equal(progress(d).counts.purchases,1);assert.equal(badge(d,'GAME_PURCHASE_1').earned,true);
 assert.equal(run(d,'purchase',purchaseBody).order.id,bought.order.id);assert.equal(progress(d).counts.purchases,2,'merged order extensions count distinct receipts');
 run(d,'order.activate',{orderId:bought.order.id});assert.equal(badge(d,'GAME_START_1').earned,true);
 const custom=require('../services/member/customization');
 s.Atomic(()=>{account(d).points=10000;const rules=rewards.Rules();s.DB().settings.rewards={...rules,revision:rules.revision+1,pointExchange:{enabled:true,cashUnit:100,pointUnit:100}};});
 const exchangeBody={revision:rewards.Rules().revision,amount:100};run(d,'points.exchange',exchangeBody,'FIX52-FIRST-EXCHANGE');run(d,'points.exchange',exchangeBody,'FIX52-FIRST-EXCHANGE');assert.equal(badge(d,'POINT_EXCHANGE_1').earned,true);assert.equal(progress(d).counts.exchanges,1);
 custom.SaveRules({revision:custom.Rules().revision,items:{NICKNAME_TICKET:{enabled:true,price:100},NICKNAME_COLOR:{enabled:true,price:100}}},'FIX52-TEST');
 run(d,'shop.purchase',{revision:custom.Rules().revision,itemId:'NICKNAME_COLOR'});assert.equal(badge(d,'SHOP_PURCHASE_1').earned,true);run(d,'nickname.color',{color:'#125ABC'});assert.equal(badge(d,'NICKNAME_COLOR_1').earned,true);
 // Background projections are pure and perform no achievement table scans.
 const projectionBefore=JSON.stringify(s.DB());for(let i=0;i<50;i++)badges.Public(account(a),{posts:0,followers:0});assert.equal(JSON.stringify(s.DB()),projectionBefore);
 const snapshot=database.BuildDatabaseObject(),awards=structuredClone(progress(a).awards);assert.equal(database.ImportDatabaseObject(snapshot),true);
 assert.deepEqual(progress(a).awards,awards);assert.equal(run(a,'me').profile.titleBadge.id,'REPORT_RECEIVED_1');assert.equal(badge(a,'POSTS_10').earnedAt,legacyAt);
 const all=run(a,'badges').items;for(const id of ['BACCARAT_1','ROULETTE_1','SLOTS_1','WHEEL_1','LIKES_1','COMMENTS_1','FOLLOWING_1','GAME_PURCHASE_1','REPORT_RECEIVED_1','REPORT_1','POSTS_1','PROFILE_VISIT_1','CRASH_1','DICE_1','MINES_1','PLINKO_1','QR_CHARGE_1','POINT_EXCHANGE_1'])assert.ok(all.some(x=>x.id===id),id+' catalog entry');
 console.log('FIX52 BADGES PASS: durable legacy and new awards, deletion/unfollow/block permanence, unique successful actions, replay/failed-action/failed-save isolation, authenticated explicit visits, profile edits, report owner capture without private content, readonly inventory, and restart persistence.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
