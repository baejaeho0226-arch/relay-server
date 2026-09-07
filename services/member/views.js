'use strict';
const s=require('./store');
const SCREENS=['news','article','catalog','checkout','me','orders','payments','topups','topup','deposit','profile','feed','comments','compose','report','menu','about','support'];
function Count(kind,id){return s.ViewCount(kind,id);}
function PublicTarget(p,kind,id){
    const db=s.DB();let row;
    if(kind==='news'){row=db.news[id];return !!row&&!row.deleted&&row.published&&(!row.publishAt||row.publishAt<=Date.now())&&(!row.audience||row.audience===p.id);}
    if(kind==='product'){row=db.products[id];return !!row&&row.published&&!row.deleted;}
    if(kind==='post'){row=db.posts[id];return !!row&&!row.deleted&&!row.hidden;}
    if(kind==='comment'){row=db.comments[id];return !!row&&!row.deleted&&!row.hidden&&PublicTarget(p,'post',row.postId);}
    if(kind==='profile')return !!s.ProfileById(id);
    return false;
}
function Record(p,body){
    const screen=s.Text(body.screen,20,true);if(!SCREENS.includes(screen))s.Fail('INPUT_INVALID');
    const targets=[['screen',screen]],kind=s.Text(body.kind,16),id=s.Text(body.id,40);
    if(kind||id){if(!PublicTarget(p,kind,id))s.Fail('CONTENT_NOT_FOUND');targets.push([kind,id]);}
    const now=Date.now(),day=new Date(now).toISOString().slice(0,10),db=s.DB();
    const fresh=targets.filter(([k,i])=>db.viewHits[p.id+':'+k+':'+i]!==day);
    if(fresh.length)s.Atomic(()=>{
        for(const [k,i]of fresh){const key=k+':'+i;db.viewHits[p.id+':'+key]=day;const old=db.viewCounters[key];db.viewCounters[key]={kind:k,id:i,count:(old?.count||0)+1,updatedAt:now};}
    });
    return {screen,screenViews:Count('screen',screen),kind,id,views:kind?Count(kind,id):0};
}
function Impressions(p,posts){
    // Feed impressions count the post, its author and visible comments once per
    // authenticated account/day; auto refresh never inflates the same day's count.
    const now=Date.now(),day=new Date(now).toISOString().slice(0,10),db=s.DB(),targets=new Map();
    for(const x of posts)for(const [kind,id]of [[x.postId?'comment':'post',x.id],['profile',x.accountId]])if(id)targets.set(kind+':'+id,[kind,id]);
    const fresh=[...targets].filter(([key])=>db.viewHits[p.id+':'+key]!==day);
    if(fresh.length)s.Atomic(()=>{for(const [key,[kind,id]]of fresh){db.viewHits[p.id+':'+key]=day;db.viewCounters[key]={kind,id,count:Count(kind,id)+1,updatedAt:now};}});
}
module.exports={Count,Record,Impressions,SCREENS};
