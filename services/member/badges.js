'use strict';
const s=require('./store');
const catalog=[
 {id:'FOLLOWERS_500',title:'팔로우 부자',description:'나를 팔로우하는 회원 500명',metric:'followers',target:500},
 {id:'POSTS_10',title:'이야기꾼',description:'공개 게시글 10개 작성',metric:'posts',target:10},
 {id:'POSTS_50',title:'인기 작가',description:'공개 게시글 50개 작성',metric:'posts',target:50},
 {id:'ATTENDANCE_7',title:'꾸준한 발걸음',description:'누적 출석 7일',metric:'attendance',target:7},
 {id:'ATTENDANCE_30',title:'매일의 동행',description:'누적 출석 30일',metric:'attendance',target:30}
];
function Metrics(p,known){return {posts:known?.posts??Object.values(s.DB().posts).filter(x=>x.accountId===p.id&&!x.deleted&&!x.hidden).length,followers:known?.followers??require('./follows').Counts(p.id).followers,attendance:p.attendance?.count||0};}
function Public(p,known){
 if(!p.titleBadgeId)return null;const row=catalog.find(x=>x.id===p.titleBadgeId);if(!row)return null;
 const metrics=Metrics(p,known);return metrics[row.metric]>=row.target?{id:row.id,title:row.title}:null;
}
function Read(p){
 const metrics=Metrics(p),selected=Public(p,metrics)?.id||'';
 return {items:catalog.map(row=>({id:row.id,title:row.title,description:row.description,target:row.target,progress:metrics[row.metric],earned:metrics[row.metric]>=row.target,selected:selected===row.id})),selected,profile:s.PublicProfile(p,true)};
}
function Select(p,body){
 if(typeof body.id!=='string')s.Fail('INPUT_INVALID');
 if(body.id){const row=catalog.find(x=>x.id===body.id);if(!row||Metrics(p)[row.metric]<row.target)s.Fail('BADGE_UNAVAILABLE');}
 if(p.titleBadgeId!==body.id){p.titleBadgeId=body.id;p.profileRevision=Math.max(p.profileRevision||0,p.avatarRevision||0)+1;}
 return {...Read(p),publicProfile:s.PublicProfile(p)};
}
module.exports={Public,Read,Select};
