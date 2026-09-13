'use strict';
const s=require('./store'),follows=require('./follows'),commerce=require('./commerce');
function Target(viewer,body){
 const target=s.Resolve(body.handle||body.id);
 return target&&!target.blocked&&!require('./socialActions').Blocked(viewer.id,target.id)?target:null;
}
function CommentRows(viewer,target){
 if(!require('./preferences').CanReadPosts(viewer,target))return [];
 const extra=require('./socialActions'),threads=require('./commentThreads');
 return Object.values(s.DB().comments).filter(row=>row.accountId===target.id&&threads.Visible(row,viewer)&&extra.Visible(s.DB().posts[row.postId],viewer)).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
}
function Comments(viewer,target,body){
 const page=s.Page(CommentRows(viewer,target),body,12);
 return {...page,items:page.items.map(row=>{const post=s.DB().posts[row.postId];return {...require('./socialActions').PublicComment(row,viewer),postTitle:post.title||String(post.body||'').slice(0,60)||'사진 · 투표 게시글'};})};
}
function Read(viewer,body){
 const target=Target(viewer,body);if(!target)s.Fail('MEMBER_NOT_FOUND');
 const rows=commerce.OwnPostRows(target),hidden=!require('./preferences').CanReadPosts(viewer,target),page=s.Page(hidden||body.commentsOnly===true?[]:rows,body,12);
 return {
  profile:{...s.PublicProfile(target),avatar:target.avatar||'',joinedAt:target.createdAt,views:rows.reduce((n,p)=>n+s.ViewCount('post',p.id),0)},
  profilePostsHidden:hidden,own:target.id===viewer.id,isFollowing:follows.IsFollowing(viewer.id,target.id),
  posts:{...page,items:page.items.map(p=>body.postCards===true?require('./social').PublicPost(p,viewer,false,body._wire==='zlib'):{id:p.id,title:p.title||'',body:(p.title||p.body||'GIF · 투표').slice(0,140),imageThumb:p.imageThumb||require('./gifs').Get(p.gifId)?.frames[0]||'',at:p.at,revision:p.revision||0})},
  ...(body.commentsOnly===true?{comments:Comments(viewer,target,body)}:{})
 };
}
module.exports={Read,Target,CommentRows};
