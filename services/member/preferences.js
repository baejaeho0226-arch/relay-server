"use strict";
const s=require('./store');
function Read(p){return {profilePostsPrivate:p.profilePostsPrivate===true};}
function Save(p,body){
 if(typeof body.profilePostsPrivate!=="boolean")s.Fail('INPUT_INVALID');
 p.profilePostsPrivate=body.profilePostsPrivate;
 p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;
 return {preferences:Read(p),profile:s.PublicProfile(p,true),publicProfile:s.PublicProfile(p)};
}
function CanReadPosts(viewer,target){return viewer.id===target.id||target.profilePostsPrivate!==true;}
module.exports={Read,Save,CanReadPosts};
