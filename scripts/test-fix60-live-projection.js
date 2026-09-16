'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix60-live-projection-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const s=require('../services/member/store'),social=require('../services/member/social'),extra=require('../services/member/socialActions'),commerce=require('../services/member/commerce'),live=require('../services/member/live');
const realNow=Date.now;Date.now=()=>1790000000000;
// Frozen FIX59 live projection. Both paths read the same real visibility,
// relationship, comment, preference and pass helpers with the same clock.
function previousIds(value){if(value===undefined)return [];if(!Array.isArray(value)||value.length>64||value.some(x=>typeof x!=='string'||x.length>80))s.Fail('INPUT_INVALID');return [...new Set(value)];}
function previousProfile(p,viewer){if(!p||p.blocked)return null;return {id:p.id,handle:s.Handle(p),nickname:p.nickname,nicknameColor:p.nicknameColor||'',titleBadge:require('../services/member/badges').Public(p),bio:p.bio,pronouns:p.pronouns||'',posts:commerce.OwnPostRows(p).length,isFollowing:require('../services/member/follows').IsFollowing(viewer.id,p.id),profileRevision:p.profileRevision||p.avatarRevision||0,...(p.id===viewer.id?{preferences:require('../services/member/preferences').Read(p)}:{}),...require('../services/member/follows').Counts(p.id)};}
function previousRead(p,body){
 const posts=[],comments=[],removedPosts=[],removedComments=[],profiles=new Map(),counts=new Map();
 const profile=id=>{const row=previousProfile(s.ProfileById(id),p);if(row&&!extra.Blocked(p.id,id))profiles.set(id,row);};
 for(const id of previousIds(body.posts)){
  const row=s.DB().posts[id];if(!extra.Visible(row,p)){removedPosts.push(id);continue;}
  const data=social.PublicPost(row,p,false,false,true);delete data.body;delete data.title;posts.push(data);profile(row.accountId);
 }
 for(const id of previousIds(body.comments)){
  const row=s.DB().comments[id];
  if(!row||!require('../services/member/commentThreads').Visible(row,p)||!extra.Visible(s.DB().posts[row.postId],p)){removedComments.push(id);continue;}
  if(!counts.has(row.postId))counts.set(row.postId,require('../services/member/commentThreads').Counts(row.postId,p));
  const data=extra.PublicComment(row,p,counts.get(row.postId));delete data.author;comments.push(data);profile(row.accountId);if(row.replyTo)profile(row.replyTo);
 }
 for(const id of previousIds(body.profiles)){const row=s.ProfileById(id);if(row&&!extra.Blocked(p.id,id))profile(id);}
 const query=body.query&&typeof body.query==='object'&&!Array.isArray(body.query)?body.query:{};
 const scope=live.Scope(p,body.scope,query);let commentPage;
 if(body.scope==='thread'&&Array.isArray(body.knownComments)&&body.knownComments.length<=40&&extra.Visible(s.DB().posts[query.postId],p)){
  const rows=s.Page(social.ThreadRows(p,s.DB().posts[query.postId]),query,12).items;
  if(JSON.stringify(rows.map(x=>x.id+'/'+(x.revision||0)))!==JSON.stringify(body.knownComments))commentPage=require('../services/member/commentThreads').Page(p,s.DB().posts[query.postId],query);
 }
 return {activeGame:commerce.ActiveGame(p),activeGames:commerce.ActiveGames(p),posts,comments,profiles:[...profiles.values()],removedPosts,removedComments,scope,commentPage,revision:s.DB().revision};
}
function measured(run){
 const lookup=s.ProfileById,ownPosts=commerce.OwnPostRows;let lookups=0,projections=0;
 s.ProfileById=(...args)=>{lookups++;return lookup(...args);};commerce.OwnPostRows=(...args)=>{projections++;return ownPosts(...args);};
 try{return {data:run(),lookups,projections};}finally{s.ProfileById=lookup;commerce.OwnPostRows=ownPosts;}
}
try{
 const db=s.DB(),members=['VIEWER','AUTHOR','REPLY','BLOCKED','DISABLED'].map((name,i)=>({id:'USR-LIVE-'+name,subject:'LIVE-'+name,nickname:name,bio:'소개 '+i,balance:7000+i,points:500+i,avatar:'',blocked:name==='DISABLED',preferences:{profilePostsVisibility:'PUBLIC'}}));
 for(const p of members)db.profiles[p.subject]=p;const [viewer,author,reply,blocked,disabled]=members;
 db.blocks[viewer.id+':'+blocked.id]={accountId:viewer.id,targetId:blocked.id};
 for(const p of [author,reply,blocked,disabled])db.follows[viewer.id+':'+p.id]={follower:viewer.id,following:p.id,at:Date.now()};
 const posts=[],comments=[];
 for(let i=0;i<20;i++){
  const post={id:'POST-LIVE-'+i,accountId:author.id,title:'제목 '+i,body:'내용 '+i,at:Date.now()-i,revision:i%3};db.posts[post.id]=post;posts.push(post.id);
  const comment={id:'COM-LIVE-'+i,postId:posts[0],accountId:author.id,body:'댓글 '+i,at:Date.now()+i,revision:i%2,replyTo:reply.id,parentId:'',replyToId:''};db.comments[comment.id]=comment;comments.push(comment.id);
 }
 for(const p of [blocked,disabled]){
  const id='POST-'+p.id;db.posts[id]={id,accountId:p.id,body:'숨겨진 작성자',at:Date.now()};posts.push(id);
  const commentId='COM-'+p.id;db.comments[commentId]={id:commentId,postId:posts[0],accountId:p.id,body:'숨겨진 댓글',at:Date.now()};comments.push(commentId);
 }
 db.posts['POST-DELETED']={id:'POST-DELETED',accountId:author.id,deleted:true};posts.push('POST-DELETED','POST-MISSING');comments.push('COM-MISSING');db.revision++;
 const body={posts,comments,profiles:[viewer.id,author.id,author.id,reply.id,blocked.id,disabled.id,'USR-MISSING'],scope:'feed',query:{sort:'latest',limit:8}};
 const before=JSON.stringify(db),old=measured(()=>previousRead(viewer,body)),next=measured(()=>live.Read(viewer,body));
 assert.deepEqual(next.data,old.data,'same output, profile ordering, removals, live counters and feed scope');
 assert.equal(next.projections,3,'each visible author/reply target/viewer is projected once');
 assert.ok(old.projections>next.projections*15,'repeated authors no longer rescan posts/follows for every card');
 assert.ok(next.lookups<old.lookups,'actual profile lookups decrease as well');
 assert.equal(JSON.stringify(db),before,'live projection never mutates read status, points, receipts or source rows');
 for(const p of next.data.profiles){for(const key of ['balance','points','subject','inventory'])assert.equal(p[key],undefined);assert.equal(!!p.preferences,p.id===viewer.id,'only the authenticated viewer receives private preferences');}
 for(const query of [{postId:posts[0],limit:12},{postId:posts[0],offset:12,limit:12}]){
  const thread={...body,scope:'thread',query,knownComments:[]};assert.deepEqual(live.Read(viewer,thread),previousRead(viewer,thread),'changed comment pages retain paging and reply context');
  thread.knownComments=s.Page(social.ThreadRows(viewer,db.posts[posts[0]]),query,12).items.map(x=>x.id+'/'+(x.revision||0));
  assert.deepEqual(live.Read(viewer,thread),previousRead(viewer,thread),'unchanged comment-page suppression remains intact');
 }
 // Request-local deduplication must not retain a previous viewer, privacy
 // decision, profile content or relationship count after any source change.
 assert.deepEqual(live.Read(author,body),previousRead(author,body));
 assert.equal(live.Read(author,body).profiles.find(x=>x.id===viewer.id).preferences,undefined);
 author.bio='다음 요청에 즉시 반영';author.profileRevision=9;db.revision++;
 assert.equal(live.Read(viewer,body).profiles.find(x=>x.id===author.id).bio,author.bio);
 db.blocks[viewer.id+':'+author.id]={accountId:viewer.id,targetId:author.id};db.revision++;
 assert.deepEqual(live.Read(viewer,body),previousRead(viewer,body));assert.ok(live.Read(viewer,body).profiles.every(x=>x.id!==author.id));
 delete db.blocks[viewer.id+':'+author.id];db.revision++;assert.equal(live.Read(viewer,body).posts.length,20);
 author.blocked=true;db.revision++;assert.deepEqual(live.Read(viewer,body),previousRead(viewer,body));assert.equal(live.Read(viewer,body).posts.length,0);
 for(const invalid of [{posts:Array(65).fill('POST-X')},{profiles:[9]},{comments:'COM-X'}])assert.throws(()=>live.Read(viewer,invalid),/INPUT_INVALID/);
 console.log('FIX60 LIVE PROJECTION PASS: identical visible output and ordering, removals, thread paging, request-local viewer/block/profile isolation and read purity; profile projections '+old.projections+' -> '+next.projections+', lookups '+old.lookups+' -> '+next.lookups+'.');
}finally{Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
