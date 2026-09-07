'use strict';
const s=require('./store');
function Avatar(value){
 if(!value)return '';
 const m=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value));if(!m||m[1].length>28000)s.Fail('AVATAR_INVALID');
 const b=Buffer.from(m[1],'base64');if(b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')s.Fail('AVATAR_INVALID');
 const w=b.readUInt32BE(16),h=b.readUInt32BE(20);if(w<1||h<1||w>128||h>128)s.Fail('AVATAR_INVALID');
 // Decode then re-encode to exclude trailing payloads and ancillary metadata.
 try{const {PNG}=require('pngjs');const png=PNG.sync.read(b);const normalized=PNG.sync.write(png).toString('base64');if(normalized.length>28000)s.Fail('AVATAR_INVALID');return 'data:image/png;base64,'+normalized;}catch(_){s.Fail('AVATAR_INVALID');}
}
function SaveProfile(p,body){p.nickname=s.Text(body.nickname,24,true);p.bio=s.Text(body.bio,160);if(body.avatar!==undefined){p.avatar=Avatar(body.avatar);p.avatarRevision++;}return {profile:s.PublicProfile(p,true)};}
function Author(id){const p=s.ProfileById(id);return p?s.PublicProfile(p):{id,nickname:'탈퇴 회원',avatar:''};}
function News(p,body={}){return s.Page(Object.values(s.DB().news).filter(x=>x.published&&(!x.publishAt||x.publishAt<=Date.now())&&(!x.audience||x.audience===p.id)&&(!body.category||x.category===body.category)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.at-a.at).map(x=>({...x,unread:x.at>p.readNewsAt})),body);}
function SaveNews(body){const id=body.id||s.Id('NEWS');if(body.id&&!s.DB().news[id])s.Fail('NEWS_NOT_FOUND');const category=s.Text(body.category,20);if(!['UPDATE','NOTICE','EVENT','ALERT'].includes(category))s.Fail('CATEGORY_INVALID');const row={id,title:s.Text(body.title,90,true),body:s.Text(body.body,5000,true),category,published:body.published===true,pinned:body.pinned===true,audience:s.Text(body.audience,40),at:Date.now(),publishAt:0};return s.Atomic(()=>{s.DB().news[id]=row;return row;});}
function VisiblePost(id){const post=s.DB().posts[id];if(!post||post.deleted||post.hidden)s.Fail('POST_NOT_FOUND');return post;}
function PublicPost(post,p){const reactions=Object.values(s.DB().reactions).filter(x=>x.postId===post.id);return {id:post.id,body:post.body,at:post.at,author:Author(post.accountId),own:post.accountId===p.id,likes:reactions.filter(x=>x.value===1).length,dislikes:reactions.filter(x=>x.value===-1).length,myReaction:reactions.find(x=>x.accountId===p.id)?.value||0,comments:Object.values(s.DB().comments).filter(x=>x.postId===post.id&&!x.deleted&&!x.hidden).length};}
function Feed(p,body){const page=s.Page(Object.values(s.DB().posts).filter(x=>!x.deleted&&!x.hidden&&(!body.mine||x.accountId===p.id)).sort((a,b)=>b.at-a.at),body,8);return {...page,items:page.items.map(x=>PublicPost(x,p))};}
function Thread(p,body){const post=VisiblePost(body.postId);return {post:PublicPost(post,p),comments:s.Page(Object.values(s.DB().comments).filter(x=>x.postId===post.id&&!x.deleted&&!x.hidden).sort((a,b)=>a.at-b.at).map(x=>({id:x.id,postId:x.postId,body:x.body,at:x.at,author:Author(x.accountId),own:x.accountId===p.id})),body,12)};}
function Rate(p,kind,ms){const at=Date.now(),key='last_'+kind;if(at-(p[key]||0)<ms)s.Fail('PLEASE_WAIT');p[key]=at;}
function Post(p,body){Rate(p,'post',10000);const id=s.Id('POST'),post={id,accountId:p.id,body:s.Text(body.body,2000,true),at:Date.now(),deleted:false,hidden:false};s.DB().posts[id]=post;return {post:PublicPost(post,p)};}
function Comment(p,body){const post=VisiblePost(body.postId);Rate(p,'comment',1500);const id=s.Id('COM'),comment={id,postId:post.id,accountId:p.id,body:s.Text(body.body,600,true),at:Date.now(),deleted:false,hidden:false};s.DB().comments[id]=comment;return {comment:{...comment,author:Author(p.id),own:true}};}
function Remove(p,body,table){const item=s.DB()[table][body.id];if(!item||item.accountId!==p.id)s.Fail('NOT_OWNER');item.deleted=true;item.body='';return {removed:true};}
function React(p,body){const post=VisiblePost(body.postId);const value=Number(body.value);if(![-1,0,1].includes(value))s.Fail('REACTION_INVALID');const key=p.id+':'+post.id;if(value===0)delete s.DB().reactions[key];else s.DB().reactions[key]={postId:post.id,accountId:p.id,value};return {post:PublicPost(post,p)};}
function Report(p,body){const post=VisiblePost(body.postId);const key=p.id+':'+post.id;if(s.DB().reports[key])return {reported:true};s.DB().reports[key]={id:s.Id('RPT'),postId:post.id,accountId:p.id,reason:s.Text(body.reason,300,true),at:Date.now(),status:'OPEN'};return {reported:true};}
module.exports={Avatar,SaveProfile,News,SaveNews,Feed,Thread,Post,Comment,Remove,React,Report,PublicPost,Author};
