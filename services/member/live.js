'use strict';
const s=require('./store'),social=require('./social'),extra=require('./socialActions');
function Ids(value){if(value===undefined)return [];if(!Array.isArray(value)||value.length>64||value.some(x=>typeof x!=='string'||x.length>80))s.Fail('INPUT_INVALID');return [...new Set(value)];}
function Profile(p,viewer){if(!p||p.blocked)return null;return {id:p.id,handle:s.Handle(p),nickname:p.nickname,bio:p.bio,pronouns:p.pronouns||'',posts:require('./commerce').OwnPostRows(p).length,isFollowing:require('./follows').IsFollowing(viewer.id,p.id),profileRevision:p.profileRevision||p.avatarRevision||0,...require('./follows').Counts(p.id)};}
function Scope(p,action,query={}){
 if(action==='feed')return s.Page(social.FeedRows(p,query),query,8).items.map(x=>x.id+'/'+(x.revision||0));
 if(action==='me'&&query.postCards===true)return s.Page(require('./commerce').OwnPostRows(p),query,12).items.map(x=>x.id+'/'+(x.revision||0));
 if(action==='member'&&query.postCards===true){
  const target=require('./profiles').Target(p,query);
  if(!target)return ['unavailable'];
  if(!require('./preferences').CanReadPosts(p,target))return [];
  return s.Page(require('./commerce').OwnPostRows(target),query,12).items.map(x=>x.id+'/'+(x.revision||0));
 }
 if(action==='thread'){
  const post=s.DB().posts[query.postId];if(!extra.Visible(post,p))return [];
  return [post.id+'/'+(post.revision||0),...s.Page(social.ThreadRows(p,post),query,12).items.map(x=>x.id+'/'+(x.revision||0))];
 }
 return null;
}
function Read(p,body){
 const posts=[],comments=[],removedPosts=[],removedComments=[],profiles=new Map(),counts=new Map();
 const profile=id=>{const row=Profile(s.ProfileById(id),p);if(row&&!extra.Blocked(p.id,id))profiles.set(id,row);};
 for(const id of Ids(body.posts)){
  const row=s.DB().posts[id];if(!extra.Visible(row,p)){removedPosts.push(id);continue;}
  const data=social.PublicPost(row,p,false,false,true);delete data.body;delete data.title;posts.push(data);profile(row.accountId);
 }
 for(const id of Ids(body.comments)){
  const row=s.DB().comments[id];
  if(!row||!require('./commentThreads').Visible(row,p)||!extra.Visible(s.DB().posts[row.postId],p)){removedComments.push(id);continue;}
  if(!counts.has(row.postId))counts.set(row.postId,require('./commentThreads').Counts(row.postId,p));
  const data=extra.PublicComment(row,p,counts.get(row.postId));delete data.author;
  comments.push(data);profile(row.accountId);if(row.replyTo)profile(row.replyTo);
 }
 for(const id of Ids(body.profiles)){const row=s.ProfileById(id);if(row&&!extra.Blocked(p.id,id))profile(id);}
 const query=body.query&&typeof body.query==='object'&&!Array.isArray(body.query)?body.query:{};
 const scope=Scope(p,body.scope,query);let commentPage;
 if(body.scope==='thread'&&Array.isArray(body.knownComments)&&body.knownComments.length<=40&&extra.Visible(s.DB().posts[query.postId],p)){
  const rows=s.Page(social.ThreadRows(p,s.DB().posts[query.postId]),query,12).items;
  if(JSON.stringify(rows.map(x=>x.id+'/'+(x.revision||0)))!==JSON.stringify(body.knownComments))
   commentPage=require('./commentThreads').Page(p,s.DB().posts[query.postId],query);
 }
 return {posts,comments,profiles:[...profiles.values()],removedPosts,removedComments,scope,commentPage,revision:s.DB().revision};
}
module.exports={Read,Scope};
