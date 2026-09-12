'use strict';
const s=require('./store');
function Count(kind,id){return kind==='post'?s.ViewCount(kind,id):0;}
function OpenPost(p,post){
 if(!post||post.deleted||post.hidden)return;
 Article(p,post,'post');
}
function Article(p,row,kind='news'){
 const day=new Date().toISOString().slice(0,10),key=kind+':'+row.id,hit=p.id+':'+key;
 if(s.DB().viewHits[hit]===day)return;
 s.Atomic(()=>{const db=s.DB();db.viewHits[hit]=day;db.viewCounters[key]={kind,id:row.id,count:s.ViewCount(kind,row.id)+1,updatedAt:Date.now()};});
}
module.exports={Count,OpenPost,Article};
