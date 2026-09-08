'use strict';
const s=require('./store');
function IsFollowing(viewer,target){return !!s.DB().follows[viewer+':'+target];}
function Counts(id){const rows=Object.values(s.DB().follows).filter(x=>!s.ProfileById(x.follower)?.blocked&&!s.ProfileById(x.following)?.blocked);return {followers:rows.filter(x=>x.following===id).length,following:rows.filter(x=>x.follower===id).length};}
function Set(p,body){
 const target=s.ProfileById(body.id);if(!target||target.blocked)s.Fail('MEMBER_NOT_FOUND');
 if(target.id===p.id||typeof body.following!=='boolean')s.Fail('INPUT_INVALID');
 const key=p.id+':'+target.id;
 if(body.following){if(!s.DB().follows[key])s.DB().follows[key]={follower:p.id,following:target.id,at:Date.now()};}
 else delete s.DB().follows[key];
 return {id:target.id,following:IsFollowing(p.id,target.id),...{counts:Counts(target.id)}};
}
function List(p,body){
 const followers=body.mode==='followers';
 const rows=Object.values(s.DB().follows).filter(x=>followers?x.following===p.id:x.follower===p.id).sort((a,b)=>b.at-a.at).map(x=>s.ProfileById(followers?x.follower:x.following)).filter(x=>x&&!x.blocked);
 const page=s.Page(rows,body,12);return {...page,items:page.items.map(x=>({...s.PublicProfile(x),isFollowing:IsFollowing(p.id,x.id)}))};
}
module.exports={IsFollowing,Counts,Set,List};
