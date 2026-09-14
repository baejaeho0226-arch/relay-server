'use strict';
const s=require('./store'),state=require('../../core/state'),plans=require('./gamePlans');
function PublicGame(p){return {id:p.id,title:p.title,description:p.description,genre:p.genre||p.details?.genre||'기타',accessType:p.accessType,plans:plans.Plans(p),published:p.published,deleted:p.deleted,sort:p.sort,revision:p.revision,updatedAt:p.updatedAt,views:s.ViewCount('product',p.id)};}
function Catalog(body={},viewer){
 const rows=Object.values(s.DB().products).filter(p=>p.published&&!p.deleted&&(!body.category||p.accessType===body.category))
  .sort((a,b)=>a.sort-b.sort||b.updatedAt-a.updatedAt);
 return s.Page(rows.map(p=>{
  const item={...PublicGame(p),unread:!!viewer&&(viewer.readProducts?.[p.id]||0)<(p.revision||1)};
  if(body.summary===true)item.description=String(p.description||'').replace(/\s+/g,' ').trim().slice(0,140);
  return item;
 }),body);
}
function Product(body,p){const row=s.DB().products[body.id];if(!row||!row.published||row.deleted)s.Fail('PRODUCT_UNAVAILABLE');if(p){if((p.readProducts?.[row.id]||0)<(row.revision||1))s.Atomic(()=>{p.readProducts||={};p.readProducts[row.id]=row.revision||1;});require('./views').Article(p,row,'product');require('./history').RecordProduct(p,body);}return {product:{...PublicGame(row),unread:false},...(p?{profile:s.PublicProfile(p,true)}:{})};}
function SaveProduct(body){
 const id=body.id?s.Text(body.id,40):s.Id('PRD'),previous=s.DB().products[id];if(body.id&&!previous)s.Fail('PRODUCT_NOT_FOUND');
 const accessType=s.Text(body.accessType,16);if(!['TYPE1','TYPE2','TYPE3'].includes(accessType))s.Fail('ACCESS_TYPE_INVALID');
 if(previous&&body.revision!==undefined&&body.revision!==(previous.revision||0))s.Fail('CONTENT_CHANGED');
 const genre=s.Text(body.genre===undefined?(previous?.genre||previous?.details?.genre||'게임'):body.genre,50,true);
 // Retired photos and details stay untouched in storage; current saves only edit
 // the text, genre and purchase settings exposed by PublicGame.
 const row={...previous,id,deleted:previous?.deleted||false,revision:(previous?.revision||0)+1,title:s.Text(body.title,70,true),description:s.Text(body.description,1500),genre,accessType,plans:plans.Validate(body.plans,previous),published:body.published===true,sort:Number.isInteger(body.sort)?body.sort:0,updatedAt:Date.now()};
 return s.Atomic(()=>{s.DB().products[id]=row;return PublicGame(row);});
}
const DAY=86400000;
function DisplayExpiresAt(row){return row.expiresAt>0?row.expiresAt:row.at+row.days*DAY;}
function PublicOrder(row){const {licenseKey,...result}=row;if(result.status!=='REFUNDED'&&result.status!=='MERGED'&&result.expiresAt>0&&result.expiresAt<=Date.now())result.status='EXPIRED';return {...result,displayExpiresAt:DisplayExpiresAt(row)};}
function ResolveOrder(id){
 const db=s.DB(),seen=new Set();let order=db.orders[id];
 while(order?.mergedInto){if(seen.has(order.id))return null;seen.add(order.id);const parent=db.orders[order.mergedInto];if(!parent||parent.accountId!==order.accountId)return null;order=parent;}
 return order;
}
function Available(row,now){return !row.mergedInto&&row.status!=='REFUNDED'&&row.status!=='EXPIRED'&&(!row.expiresAt||row.expiresAt>now);}
function CheckDuration(days,expiresAt){if(!Number.isSafeInteger(days)||days<1||!Number.isSafeInteger(expiresAt)||expiresAt>8640000000000000)s.Fail('GAME_PLAN_INVALID');}
function SnapshotPayments(rows){
 const byId=new Map(rows.map(x=>[x.id,x]));
 for(const payment of Object.values(s.DB().ledger)){
  const order=byId.get(payment.reference);if(payment.kind!=='PURCHASE'||!order||payment.accountId!==order.accountId||payment.days!==undefined)continue;
  Object.assign(payment,{days:order.days,title:order.title,productId:order.productId,displayExpiresAt:DisplayExpiresAt(order)});
 }
}
function MergeRows(p,rows,now){
 // Keep every wallet receipt intact before changing the entitlement duration.
 SnapshotPayments(rows);
 rows.sort((a,b)=>Number(b.id===p.activeOrderId)-Number(a.id===p.activeOrderId)||Number(!!b.activatedAt)-Number(!!a.activatedAt)||a.at-b.at||a.id.localeCompare(b.id));
 const order=rows[0],others=rows.slice(1),days=rows.reduce((n,x)=>n+x.days,0),amount=rows.reduce((n,x)=>n+x.amount,0);
 const extraTime=others.reduce((n,x)=>n+(x.activatedAt?Math.max(0,x.expiresAt-now):x.days*DAY),0);
 const at=Math.min(...rows.map(x=>x.at)),expiresAt=order.activatedAt?order.expiresAt+extraTime:0;
 CheckDuration(days,expiresAt||at+days*DAY);if(!Number.isSafeInteger(amount))s.Fail('AMOUNT_INVALID');
 Object.assign(order,{days,amount,at,expiresAt,updatedAt:now});
 for(const child of others){child.mergedInto=order.id;child.status='MERGED';child.mergedAt=now;if(p.activeOrderId===child.id)p.activeOrderId=order.id;}
 return order;
}
function NormalizeOrders(p,atomic=true){
 const now=Date.now(),groups=new Map();
 for(const row of Object.values(s.DB().orders)){
  if(row.accountId!==p.id||!row.productId||row.source==='QR_CHARGE'||!Available(row,now))continue;
  const key=row.productId+'|'+row.accessType;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
 }
 const duplicates=[...groups.values()].filter(rows=>rows.length>1);
 if(!duplicates.length)return;
 const apply=()=>{for(const rows of duplicates)MergeRows(p,rows,now);};
 if(atomic)s.Atomic(apply);else apply();
}
function OwnOrders(p){NormalizeOrders(p);return Object.values(s.DB().orders).filter(x=>x.accountId===p.id&&!x.mergedInto).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).map(PublicOrder);}
function ActiveGame(p){
 const order=ResolveOrder(p.activeOrderId);
 if(p.blocked||!order||order.accountId!==p.id||order.status!=='ACTIVE'||!order.activatedAt||order.expiresAt<=Date.now())return null;
 return {id:order.id,productId:order.productId||'',title:order.title,accessType:order.accessType,days:order.days,activatedAt:order.activatedAt,expiresAt:order.expiresAt,status:'ACTIVE'};
}
function Purchase(p,body){
 const game=Product({id:body.productId}).product;
 if(!Number.isSafeInteger(body.days)||body.days<1||body.days>3650)s.Fail('GAME_PLAN_INVALID');
 const plan=game.plans.find(x=>x.days===body.days);
 if(!plan?.available)s.Fail('GAME_PLAN_UNAVAILABLE');
 if(body.price!==plan.price||body.revision!==game.revision)s.Fail('PRICE_CHANGED');
 if(p.balance<plan.price)s.Fail('INSUFFICIENT_BALANCE');
 NormalizeOrders(p,false);
 const now=Date.now();let row=Object.values(s.DB().orders).find(x=>x.accountId===p.id&&x.productId===game.id&&x.accessType===game.accessType&&x.source!=='QR_CHARGE'&&Available(x,now));
 if(row){
  SnapshotPayments([row]);
  const days=row.days+plan.days,expiresAt=row.activatedAt?row.expiresAt+plan.days*DAY:0;
  CheckDuration(days,expiresAt||row.at+days*DAY);if(!Number.isSafeInteger(row.amount+plan.price))s.Fail('AMOUNT_INVALID');
  Object.assign(row,{days,amount:row.amount+plan.price,expiresAt,updatedAt:now});
 }else{
  const id=s.Id('ORD');row={id,accountId:p.id,productId:game.id,title:game.title,accessType:game.accessType,days:plan.days,amount:plan.price,status:'PAID',at:now,activatedAt:0,expiresAt:0,licenseKey:'',source:'WALLET_PURCHASE'};
  s.DB().orders[id]=row;
 }
 const payment=s.Ledger(p,-plan.price,'PURCHASE',row.id);
 Object.assign(payment,{days:plan.days,title:game.title,productId:game.id,displayExpiresAt:DisplayExpiresAt(row)});
 return {order:PublicOrder(row),profile:s.PublicProfile(p,true),activeGame:ActiveGame(p)};
}
function Activate(p,c,body){
 const requested=s.DB().orders[body.orderId];if(!requested||requested.accountId!==p.id)s.Fail('ORDER_NOT_FOUND');
 NormalizeOrders(p,false);
 const order=ResolveOrder(body.orderId);if(!order||order.accountId!==p.id)s.Fail('ORDER_NOT_FOUND');if(order.status==='REFUNDED')s.Fail('ORDER_REFUNDED');
 const now=Date.now();if(order.expiresAt&&order.expiresAt<=now)s.Fail('PASS_EXPIRED');
 if(!order.activatedAt){order.activatedAt=now;order.expiresAt=now+order.days*DAY;CheckDuration(order.days,order.expiresAt);}
 order.lastUsedAt=now;p.activeOrderId=order.id;
 const bound=require('../../license/licenseManager').GetBoundLicenseEntry(c.clientId);
 if(!bound)s.Fail('MEMBER_AUTH_REQUIRED');
 require('./entryPass').Convert(bound.license);
 order.status='ACTIVE';state.licenseRevision++;
 return {order:PublicOrder(order),activeGame:ActiveGame(p),requiresBiometric:true};
}
function AfterActivation(c){
 require('../buildGate').RevokeForClient(c.clientId,'PURCHASE_SWITCH');
 c.biometricVerified=false;c.buildCompleted=false;c.buildSessionId='';
 require('../../license/licenseManager').AuthorizeBoundClientByQr(c,'PURCHASE');
}

function Refund(body,actor){
 const requested=s.DB().orders[body.id];if(!requested)s.Fail('ORDER_NOT_FOUND');
 return s.Atomic(()=>{
  const p=s.ProfileById(requested.accountId);NormalizeOrders(p,false);
  const order=ResolveOrder(body.id);if(!order)s.Fail('ORDER_NOT_FOUND');if(order.status==='REFUNDED')return PublicOrder(order);
  if(order.activatedAt||order.source==='QR_CHARGE')s.Fail('ACTIVATED_REFUND_REVIEW');
  const reason=s.Text(body.reason,200,true),now=Date.now();
  // A combined unused pass is one entitlement; refund it once, including aliases.
  s.Ledger(p,order.amount,'REFUND',order.id);
  const linked=Object.values(s.DB().orders).filter(x=>x.accountId===p.id&&ResolveOrder(x.id)?.id===order.id);
  for(const row of linked)Object.assign(row,{status:'REFUNDED',refundedAt:now,refundedBy:actor,refundReason:reason});
  const product=s.DB().products[order.productId];if(product&&product.stock>=0)product.stock++;
  return PublicOrder(order);
 });
}
function PurchasePayments(p){
 const db=s.DB();
 return Object.values(db.ledger).filter(x=>x.accountId===p.id&&x.kind==='PURCHASE').reverse()
  .sort((a,b)=>b.at-a.at).map(x=>{
   const original=db.orders[x.reference],order=ResolveOrder(x.reference),owned=order?.accountId===p.id;
   const days=x.days??(owned?original.days:0);
   return {...x,title:x.title||(owned?order.title:'게임 이용권'),days,displayExpiresAt:x.displayExpiresAt||(owned?DisplayExpiresAt(original):x.at+days*DAY),orderId:owned?order.id:'',refunded:owned&&order.status==='REFUNDED'};
  });
}
function OwnPostRows(p){return Object.values(s.DB().posts).filter(x=>x.accountId===p.id&&!x.deleted&&!x.hidden).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));}
function Mine(p,body){
 const orders=OwnOrders(p),db=s.DB(),page=s.Page(OwnPostRows(p),body,12);
 const posts={...page,items:page.items.map(x=>body.postCards===true?require('./social').PublicPost(x,p,false,body._wire==='zlib'):{id:x.id,title:x.title||'',body:(x.title||x.body||'GIF · 투표').slice(0,140),imageThumb:x.imageThumb||require('./gifs').Get(x.gifId)?.frames[0]||'',at:x.at,revision:x.revision||0})};
 return {profile:s.PublicProfile(p,true),posts,...(body.commentsOnly?{comments:require('./activity').Comments(p,body)}:{}),activeGame:ActiveGame(p),orders:s.Page(orders,body,20),payments:s.Page(body.purchasesOnly===true?PurchasePayments(p):Object.values(db.ledger).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at),body,20)};
}
module.exports={PublicGame,Product,Catalog,SaveProduct,Purchase,Activate,AfterActivation,Refund,Mine,OwnPostRows,PurchasePayments,PublicOrder,OwnOrders,ActiveGame};
