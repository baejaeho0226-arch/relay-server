'use strict';
const s=require('./store');
function Count(kind,id){return kind==='post'?s.ViewCount(kind,id):0;}
function Impressions(p,posts){
 const now=Date.now(),day=new Date(now).toISOString().slice(0,10),db=s.DB();
 const fresh=[...new Map(posts.filter(x=>x&&!x.postId&&!x.deleted&&!x.hidden).map(x=>[x.id,x])).values()].filter(x=>db.viewHits[p.id+':post:'+x.id]!==day);
 if(fresh.length)s.Atomic(()=>{for(const post of fresh){const key='post:'+post.id;db.viewHits[p.id+':'+key]=day;db.viewCounters[key]={kind:'post',id:post.id,count:Count('post',post.id)+1,updatedAt:now};}});
}
function Article(p,row,kind='news'){
 const day=new Date().toISOString().slice(0,10),key=kind+':'+row.id,hit=p.id+':'+key;
 if(s.DB().viewHits[hit]===day)return;
 s.Atomic(()=>{const db=s.DB();db.viewHits[hit]=day;db.viewCounters[key]={kind,id:row.id,count:s.ViewCount(kind,row.id)+1,updatedAt:Date.now()};});
}
module.exports={Count,Impressions,Article};
