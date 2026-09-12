"use strict";
const s=require('./store');
// A member has one check-in per Korean calendar day, shared across every device.
const Day=at=>new Date(at+9*3600000).toISOString().slice(0,10);
function Attendance(p,now=Date.now()){
 const record=p.attendance||{};
 return {day:Day(now),checked:record.day===Day(now),count:record.count||0,streak:record.day===Day(now)||record.day===Day(now-86400000)?record.streak||0:0,at:record.at||0,days:record.days||[]};
}
function Check(p){
 const now=Date.now(),day=Day(now),old=p.attendance||{};
 if(old.day!==day)p.attendance={day,at:now,count:(old.count||0)+1,streak:old.day===Day(now-86400000)?(old.streak||0)+1:1,days:[...(old.days||[]).filter(x=>x!==day),day].slice(-35)};
 return {attendance:Attendance(p,now)};
}
function Person(p){return p?{id:p.id,handle:s.Handle(p),nickname:p.nickname}:{id:'',handle:'',nickname:'탈퇴 회원'};}
function Extras(p){
 const db=s.DB(),extra=require('./socialActions'),now=Date.now();
 const visible=other=>other&&!other.blocked&&!extra.Blocked(p.id,other.id);
 // Only public names/handles are projected. Neither amounts nor devices leave this endpoint.
 const balanceRanking=Object.values(db.profiles).filter(x=>visible(x)&&require('./preferences').Read(x).balanceRankingVisible)
  .sort((a,b)=>b.balance-a.balance||a.id.localeCompare(b.id)).slice(0,5).map((x,i)=>({rank:i+1,member:Person(x)}));
 const recentPurchases=Object.values(db.orders).filter(x=>x.source!=='QR_CHARGE'&&x.status!=='REFUNDED'&&x.amount>0&&x.at>=now-7*86400000)
  .sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).filter(x=>{const owner=s.ProfileById(x.accountId);return visible(owner)&&require('./preferences').Read(owner).purchaseActivityVisible;})
  .slice(0,5).map(x=>({member:Person(s.ProfileById(x.accountId)),title:x.title||db.products[x.productId]?.title||'게임 이용권',at:x.at}));
 const events=Object.values(db.news).filter(x=>!x.deleted&&x.published&&x.category==='EVENT'&&(!x.publishAt||x.publishAt<=now)&&(!x.audience||x.audience===p.id))
  .sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).slice(0,3).map(x=>({id:x.id,title:x.title,category:x.category,at:x.at}));
 const popular=require('./social').FeedRows(p,{sort:'popular'}).slice(0,3).map((x,i)=>({id:x.id,rank:i+1,title:x.title||x.body.slice(0,64)||'사진 · 투표 게시글',author:Person(s.ProfileById(x.accountId)),at:x.at}));
 return {attendance:Attendance(p,now),events,popular,balanceRanking,recentPurchases};
}
module.exports={Day,Attendance,Check,Extras};
