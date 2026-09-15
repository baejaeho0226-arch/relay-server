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
function RecentPointCredits(p){
 // Filter this account's positive credits before taking the preview limit.
 // The summary is a projection of committed points, never a second reward grant.
 return Object.values(s.DB().pointLedger)
  .filter(row=>row.accountId===p.id&&Number.isSafeInteger(row.amount)&&row.amount>0)
  .sort((a,b)=>b.at-a.at||(a.id<b.id?1:a.id>b.id?-1:0)).slice(0,3)
  .map(({id,kind,amount,at})=>({id,kind,amount,at}));
}
function TopPurchased(limit=3){
 const db=s.DB(),groups=new Map(),orders=new Map();
 // Purchases retain one wallet receipt per payment even when pass durations merge.
 // Resolve aliases read-only so refunds of a combined pass remove every receipt.
 const paidStates=new Set(['PAID','ACTIVE','EXPIRED','MERGED']);
 function Order(id){
  if(orders.has(id))return orders.get(id);
  const first=db.orders[id],seen=new Set();let row=first;
  while(row){
   if(seen.has(row.id)||row.accountId!==first.accountId||row.productId!==first.productId||
     row.source==='QR_CHARGE'||!paidStates.has(row.status)||row.refundedAt||(row.status==='MERGED'&&!row.mergedInto)){row=null;break;}
   seen.add(row.id);
   if(!row.mergedInto)break;
   row=db.orders[row.mergedInto];
  }
  orders.set(id,row||null);return row;
 }
 for(const payment of Object.values(db.ledger)){
  if(payment.kind!=='PURCHASE'||!Number.isSafeInteger(payment.amount)||payment.amount>=0||
    payment.refunded||payment.refundedAt||payment.status&&!['PAID','COMPLETED','SUCCESS'].includes(payment.status))continue;
  const original=db.orders[payment.reference],order=Order(payment.reference);
  if(!original||!order||payment.accountId!==order.accountId||payment.productId&&payment.productId!==original.productId)continue;
  const game=db.products[original.productId];if(!game||!game.published||game.deleted)continue;
  let row=groups.get(game.id);
  if(!row){row={id:game.id,title:game.title,genre:game.genre||game.details?.genre||'기타',purchaseCount:0,totalDays:0};groups.set(game.id,row);}
  row.purchaseCount++;
  // Old, separate receipts predate duration snapshots; their original order is
  // the fallback. MergeRows snapshots these values before changing any duration.
  const days=payment.days??original.days;
  if(Number.isSafeInteger(days)&&days>0)row.totalDays+=days;
 }
 // Aggregate counts never expose buyers, private wallet fields or receipt IDs.
 return [...groups.values()].sort((a,b)=>b.purchaseCount-a.purchaseCount||b.totalDays-a.totalDays||(a.id<b.id?-1:a.id>b.id?1:0)).slice(0,limit);
}
function TopGames(p,body={}){
 const offset=Math.max(0,Math.min(100000,Math.floor(Number(body.offset)||0)));
 const page=s.Page(TopPurchased(Infinity),{...body,offset},12);
 return {...page,items:page.items.map((item,i)=>({id:item.id,title:item.title,genre:item.genre,rank:offset+i+1}))};
}
function Extras(p){
 const social=require('./social'),commerce=require('./commerce');
 const feed=social.FeedRows(p,{sort:'popular'}),news=social.News(p,{summary:true,limit:1}),games=commerce.Catalog({summary:true,limit:1},p);
 const events=social.News(p,{category:'EVENT',summary:true,limit:1});
 const popular=feed.slice(0,10).map((x,i)=>({id:x.id,rank:i+1,title:x.title||(x.body||'').slice(0,80),author:Person(s.ProfileById(x.accountId)),following:require('./follows').IsFollowing(p.id,x.accountId),own:x.accountId===p.id}));
 return {...require('./history').Read(p),attendance:rewards.Attendance(p),events,news,games,popular,rewards:rewards.Read(p,{limit:3}),recentPurchases:RecentPurchases(p),recentPointCredits:RecentPointCredits(p),topPurchased:TopPurchased(),
  counts:{news:news.total,catalog:games.total,feed:feed.length,events:events.total,posts:commerce.OwnPostRows(p).length,comments:require('./activity').CommentRows(p).length}};
}
module.exports={Day:rewards.Day,Attendance:rewards.Attendance,Check:rewards.Check,Extras,Activity,TopGames};
