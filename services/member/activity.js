'use strict';
const s=require('./store'),extra=require('./socialActions');
function CommentRows(p){return Object.values(s.DB().comments).filter(x=>x.accountId===p.id&&!x.deleted&&!x.hidden&&extra.Visible(s.DB().posts[x.postId],p)).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));}
function Comments(p,body={}){
 const rows=s.Page(CommentRows(p),body,12);
 return {...rows,items:rows.items.map(x=>({...extra.PublicComment(x,p),postTitle:s.DB().posts[x.postId].title||s.DB().posts[x.postId].body.slice(0,60)||'사진 · 투표 게시글'}))};
}
function Person(p){return p?s.PublicProfile(p):{id:'',handle:'',nickname:'탈퇴 회원',avatar:''};}
function PurchaseRows(p){
 const db=s.DB(),extra=require('./socialActions');
 return Object.values(db.orders).filter(x=>x.source!=='QR_CHARGE'&&x.status!=='REFUNDED'&&x.amount>0).reverse()
  .sort((a,b)=>b.at-a.at).filter(x=>{const owner=s.ProfileById(x.accountId);return owner&&!owner.blocked&&!extra.Blocked(p.id,owner.id)&&require('./preferences').Read(owner).purchaseActivityVisible;});
}
function PublicPurchase(x){return {id:x.id,member:Person(s.ProfileById(x.accountId)),title:x.title||s.DB().products[x.productId]?.title||'게임 이용권',at:x.at};}
function Purchases(p,body={}){const page=s.Page(PurchaseRows(p),body,20);return {...page,items:page.items.map(PublicPurchase)};}
module.exports={CommentRows,Comments,Purchases};
