'use strict';
const s=require('./store'),follows=require('./follows'),commerce=require('./commerce');
function Target(viewer,body){
 const target=s.Resolve(body.handle||body.id);
 return target&&!target.blocked&&!require('./socialActions').Blocked(viewer.id,target.id)?target:null;
}
function Read(viewer,body){
 const target=Target(viewer,body);if(!target)s.Fail('MEMBER_NOT_FOUND');
 const rows=commerce.OwnPostRows(target),page=s.Page(rows,body,12);
 return {profile:{...s.PublicProfile(target),avatar:target.avatar||'',joinedAt:target.createdAt,views:rows.reduce((n,p)=>n+s.ViewCount('post',p.id),0)},own:target.id===viewer.id,isFollowing:follows.IsFollowing(viewer.id,target.id),posts:{...page,items:page.items.map(p=>body.postCards===true?require('./social').PublicPost(p,viewer,false,body._wire==='zlib'):{id:p.id,title:p.title||'',body:(p.title||p.body||'GIF · 투표').slice(0,140),imageThumb:p.imageThumb||require('./gifs').Get(p.gifId)?.frames[0]||'',at:p.at,revision:p.revision||0})}};
}
module.exports={Read,Target};
