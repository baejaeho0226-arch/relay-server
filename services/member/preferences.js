"use strict";
const s=require('./store');
const defaults={profilePostsPrivate:false,balanceRankingVisible:true,purchaseActivityVisible:true,notifyApproval:true,notifyRelease:true,language:'ko'};
function Read(p){return Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,typeof p[key]===typeof value?p[key]:value]));}
function Save(p,body){
 const keys=Object.keys(defaults).filter(key=>Object.hasOwn(body,key));
 if(!keys.length)s.Fail('INPUT_INVALID');
 for(const key of keys){
  const value=body[key];
  if(typeof value!==typeof defaults[key]||(key==='language'&&!['ko','en'].includes(value)))s.Fail('INPUT_INVALID');
 }
 for(const key of keys)p[key]=body[key];
 p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;
 return {preferences:Read(p),profile:s.PublicProfile(p,true),publicProfile:s.PublicProfile(p)};
}
function CanReadPosts(viewer,target){return viewer.id===target.id||target.profilePostsPrivate!==true;}
module.exports={Read,Save,CanReadPosts};
