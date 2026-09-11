 'use strict';
const s=require('./store');
const extra=()=>require('./socialActions');
function Fields(p,body,previous){
 const id=body.quotePostId===undefined?(previous?.quotePostId||''):s.Text(body.quotePostId,80);
 if(previous&&id===(previous.quotePostId||''))return {quotePostId:id};
 if(id){
  extra().Post(p,id);const seen=new Set(previous?[previous.id]:[]);let next=id;
  while(next){if(seen.has(next)||seen.size>32)s.Fail('INPUT_INVALID');seen.add(next);next=s.DB().posts[next]?.quotePostId||'';}
 }
 return {quotePostId:id};
}
function Public(post,p,sharp,depth=0){
 const id=post.quotePostId;if(!id)return null;const source=s.DB().posts[id];
 if(!extra().Visible(source,p))return {id,unavailable:true};
 if(depth>=3)return {id,truncated:true,author:require('./social').Author(source.accountId),title:source.title||'',at:source.at,body:'이전 리포스트가 포함된 게시글입니다.'};
 return require('./social').PublicPost(source,p,false,sharp,false,depth+1);
}
function Info(post,p){
 const legacy=Object.values(s.DB().reposts).filter(x=>x.postId===post.id&&!extra().Blocked(p.id,x.accountId)&&!s.ProfileById(x.accountId)?.blocked);
 const quotes=Object.values(s.DB().posts).filter(x=>x.quotePostId===post.id&&extra().Visible(x,p));
 const rows=[...legacy,...quotes].sort((a,b)=>b.at-a.at);
 const last=post.quotePostId?post:rows[0];
 return {reposts:rows.length,myRepost:rows.some(x=>x.accountId===p.id),repostedBy:last?{id:last.accountId,nickname:s.ProfileById(last.accountId)?.nickname||'탈퇴 회원',at:last.at}:null};
}
function Delta(post,p,sharp){const source=s.DB().posts[post.quotePostId];return extra().Visible(source,p)?require('./social').PublicPost(source,p,false,sharp,true):null;}
module.exports={Fields,Public,Info,Delta};
