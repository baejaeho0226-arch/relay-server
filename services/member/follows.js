'use strict';
const s=require('./store');
function IsFollowing(viewer,target){return !!s.DB().follows[viewer+':'+target];}
function Counts(id){
 let followers=0,following=0;
 for(const row of Object.values(s.DB().follows)){
  // Unrelated edges cannot affect this profile. Avoid two account lookups for
  // every relationship each time a feed author or home preview is projected.
  if(row.follower!==id&&row.following!==id)continue;
  if(s.ProfileById(row.follower)?.blocked||s.ProfileById(row.following)?.blocked)continue;
  if(row.following===id)followers++;if(row.follower===id)following++;
 }
 return {followers,following};
}
function Set(p,body){
 const target=s.Resolve(body.handle||body.id);if(!target||target.blocked||require('./socialActions').Blocked(p.id,target.id))s.Fail('MEMBER_NOT_FOUND');
 if(target.id===p.id||typeof body.following!=='boolean')s.Fail('INPUT_INVALID');
 const key=p.id+':'+target.id;
 if(body.following){if(!s.DB().follows[key])s.DB().follows[key]={follower:p.id,following:target.id,at:Date.now()};}
 else delete s.DB().follows[key];
 return {id:target.id,following:IsFollowing(p.id,target.id),...{counts:Counts(target.id)}};
}
function List(p,body){
 const followers=body.mode==='followers',target=(body.handle||body.id)?s.Resolve(body.handle||body.id):p;if(!target||target.blocked||require('./socialActions').Blocked(p.id,target.id))s.Fail('MEMBER_NOT_FOUND');
 const rows=Object.values(s.DB().follows).filter(x=>followers?x.following===target.id:x.follower===target.id).sort((a,b)=>b.at-a.at).map(x=>s.ProfileById(followers?x.follower:x.following)).filter(x=>x&&!x.blocked&&!require('./socialActions').Blocked(p.id,x.id));
 const page=s.Page(rows,body,12);return {...page,items:page.items.map(x=>({...s.PublicProfile(x),own:x.id===p.id,isFollowing:x.id!==p.id&&IsFollowing(p.id,x.id)}))};
}
module.exports={IsFollowing,Counts,Set,List};
