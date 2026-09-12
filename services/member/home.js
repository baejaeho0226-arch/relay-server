'use strict';
const s=require('./store'),rewards=require('./rewards');
function Person(p){return p?s.PublicProfile(p):{id:'',handle:'',nickname:'탈퇴 회원',avatar:''};}
function PurchaseRows(p){
 const db=s.DB(),extra=require('./socialActions');
 return Object.values(db.orders).filter(x=>x.source!=='QR_CHARGE'&&x.status!=='REFUNDED'&&x.amount>0)
  .sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).filter(x=>{const owner=s.ProfileById(x.accountId);return owner&&!owner.blocked&&!extra.Blocked(p.id,owner.id)&&require('./preferences').Read(owner).purchaseActivityVisible;});
}
function PublicPurchase(x){return {id:x.id,member:Person(s.ProfileById(x.accountId)),title:x.title||s.DB().products[x.productId]?.title||'게임 이용권',at:x.at};}
function Activity(p,body={}){const page=s.Page(PurchaseRows(p),body,20);return {...page,items:page.items.map(PublicPurchase)};}
function Extras(p){
 const social=require('./social'),commerce=require('./commerce');
 const feed=social.FeedRows(p,{sort:'popular'}),news=social.News(p,{summary:true,limit:1}),games=commerce.Catalog({summary:true,limit:1},p);
 const events=social.News(p,{category:'EVENT',summary:true,limit:1});
 const popular=feed.slice(0,10).map((x,i)=>({id:x.id,rank:i+1,title:x.title||x.body.slice(0,80)||'사진 · 투표 게시글',author:Person(s.ProfileById(x.accountId)),following:require('./follows').IsFollowing(p.id,x.accountId),own:x.accountId===p.id}));
 return {attendance:rewards.Attendance(p),events,news,games,popular,rewards:rewards.Read(p,{limit:3}),recentPurchases:Activity(p,{limit:3}).items,
  counts:{news:news.total,catalog:games.total,feed:feed.length,events:events.total,posts:commerce.OwnPostRows(p).length,comments:require('./activity').CommentRows(p).length}};
}
module.exports={Day:rewards.Day,Attendance:rewards.Attendance,Check:rewards.Check,Extras,Activity};
