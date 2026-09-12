'use strict';
const s=require('./store'),rewards=require('./rewards');
function Person(p){return p?s.PublicProfile(p):{id:'',handle:'',nickname:'탈퇴 회원',avatar:''};}
function PurchaseRows(p){
 const db=s.DB(),extra=require('./socialActions');
 return Object.values(db.orders).filter(x=>x.source!=='QR_CHARGE'&&x.status!=='REFUNDED'&&x.amount>0).reverse()
  .sort((a,b)=>b.at-a.at).filter(x=>{const owner=s.ProfileById(x.accountId);return owner&&!owner.blocked&&!extra.Blocked(p.id,owner.id)&&require('./preferences').Read(owner).purchaseActivityVisible;});
}
function PublicPurchase(x){return {id:x.id,member:Person(s.ProfileById(x.accountId)),title:x.title||s.DB().products[x.productId]?.title||'게임 이용권',at:x.at};}
function Activity(p,body={}){const page=s.Page(PurchaseRows(p),body,20);return {...page,items:page.items.map(PublicPurchase)};}
function RecentPurchases(p){
 const members=new Set(),rows=[];
 for(const row of PurchaseRows(p)){
  if(members.has(row.accountId))continue;
  members.add(row.accountId);rows.push(PublicPurchase(row));if(rows.length===5)break;
 }
 return rows;
}
function Extras(p){
 const social=require('./social'),commerce=require('./commerce');
 const feed=social.FeedRows(p,{sort:'popular'}),news=social.News(p,{summary:true,limit:1}),games=commerce.Catalog({summary:true,limit:1},p);
 const events=social.News(p,{category:'EVENT',summary:true,limit:1});
 const popular=feed.slice(0,10).map((x,i)=>({id:x.id,rank:i+1,title:x.title||(x.body||'').slice(0,80),author:Person(s.ProfileById(x.accountId)),following:require('./follows').IsFollowing(p.id,x.accountId),own:x.accountId===p.id}));
 return {attendance:rewards.Attendance(p),events,news,games,popular,rewards:rewards.Read(p,{limit:3}),recentPurchases:RecentPurchases(p),
  counts:{news:news.total,catalog:games.total,feed:feed.length,events:events.total,posts:commerce.OwnPostRows(p).length,comments:require('./activity').CommentRows(p).length}};
}
module.exports={Day:rewards.Day,Attendance:rewards.Attendance,Check:rewards.Check,Extras,Activity};
