"use strict";
const s=require('./store');
const visibility=['PUBLIC','FOLLOWING','PRIVATE'];
const defaults={profilePostsPrivate:false,profilePostsVisibility:'PUBLIC',balanceRankingVisible:true,purchaseActivityVisible:true,notifyApproval:true,notifyRelease:true,language:'ko'};
function Visibility(p){return visibility.includes(p.profilePostsVisibility)?p.profilePostsVisibility:p.profilePostsPrivate===true?'PRIVATE':'PUBLIC';}
function Read(p){
 const result=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,typeof p[key]===typeof value?p[key]:value]));
 result.profilePostsVisibility=Visibility(p);
 // Older APKs only understand a private/public flag. Restricted audiences must
 // never appear public to them; their next boolean write is still supported.
 result.profilePostsPrivate=result.profilePostsVisibility!=='PUBLIC';
 return result;
}
function Save(p,body){
 const keys=Object.keys(defaults).filter(key=>Object.hasOwn(body,key));
 if(!keys.length)s.Fail('INPUT_INVALID');
 for(const key of keys){
  const value=body[key];
  if(typeof value!==typeof defaults[key]||(key==='language'&&!['ko','en'].includes(value))||
    (key==='profilePostsVisibility'&&!visibility.includes(value)))s.Fail('INPUT_INVALID');
 }
 for(const key of keys)p[key]=body[key];
 if(keys.includes('profilePostsVisibility'))p.profilePostsPrivate=body.profilePostsVisibility!=='PUBLIC';
 else if(keys.includes('profilePostsPrivate'))p.profilePostsVisibility=body.profilePostsPrivate?'PRIVATE':'PUBLIC';
 p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;
 return {preferences:Read(p),profile:s.PublicProfile(p,true),publicProfile:s.PublicProfile(p)};
}
function CanReadPosts(viewer,target){
 if(viewer.id===target.id)return true;
 const audience=Visibility(target);
 return audience==='PUBLIC'||(audience==='FOLLOWING'&&require('./follows').IsFollowing(target.id,viewer.id));
}
module.exports={Read,Save,CanReadPosts};
