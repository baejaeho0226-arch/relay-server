'use strict';
const s=require('./store'),follows=require('./follows');
function Read(viewer,body){
 const target=s.Resolve(body.handle||body.id);if(!target||target.blocked)s.Fail('MEMBER_NOT_FOUND');
 const rows=Object.values(s.DB().posts).filter(p=>p.accountId===target.id&&!p.deleted&&!p.hidden).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
 const page=s.Page(rows,body,12);
 return {profile:{...s.PublicProfile(target),avatar:target.avatar||'',joinedAt:target.createdAt,views:rows.reduce((n,p)=>n+s.ViewCount('post',p.id),0)},own:target.id===viewer.id,isFollowing:follows.IsFollowing(viewer.id,target.id),posts:{...page,items:page.items.map(p=>({id:p.id,body:p.body.slice(0,140),imageThumb:p.imageThumb||'',at:p.at,revision:p.revision||0}))}};
}
module.exports={Read};
