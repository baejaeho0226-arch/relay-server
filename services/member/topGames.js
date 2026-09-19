'use strict';
const s=require('./store');
function RankedPurchases(){
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
 return [...groups.values()].sort((a,b)=>b.purchaseCount-a.purchaseCount||b.totalDays-a.totalDays||(a.id<b.id?-1:a.id>b.id?1:0));
}
function Read(p,body={}){
 const offset=Math.max(0,Math.min(100000,Math.floor(Number(body.offset)||0)));
 const page=s.Page(RankedPurchases(),{...body,offset},12);
 return {...page,items:page.items.map((item,i)=>({id:item.id,title:item.title,genre:item.genre,imageCover:require('./media').GameCover(s.DB().products[item.id]),rank:offset+i+1}))};
}
module.exports={Read,RankedPurchases};
