'use strict';
const s=require('./store'),state=require('../../core/state');
function Catalog(body={}){return s.Page(Object.values(s.DB().products).filter(p=>p.published&&(!body.category||p.accessType===body.category)).sort((a,b)=>a.sort-b.sort||b.updatedAt-a.updatedAt),body);}
function SaveProduct(body){
 const id=body.id?s.Text(body.id,40):s.Id('PRD');const previous=s.DB().products[id];if(body.id&&!previous)s.Fail('PRODUCT_NOT_FOUND');
 const accessType=s.Text(body.accessType,16);if(!['TYPE1','TYPE2','TYPE3'].includes(accessType))s.Fail('ACCESS_TYPE_INVALID');
 const row={id,title:s.Text(body.title,70,true),description:s.Text(body.description,1500),price:s.Money(body.price),days:s.Money(body.days,1,3650),accessType,published:body.published===true,stock:body.stock===-1?-1:s.Money(body.stock,0,100000),sort:Number.isInteger(body.sort)?body.sort:0,updatedAt:Date.now()};
 return s.Atomic(()=>{s.DB().products[id]=row;return row;});
}
function Purchase(p,body){
 const item=s.DB().products[body.productId];if(!item||!item.published)s.Fail('PRODUCT_UNAVAILABLE');
 // The browser/app cannot set the charge, duration or destination account.
 if(body.expectedPrice!==item.price)s.Fail('PRICE_CHANGED');if(item.stock===0)s.Fail('SOLD_OUT');if(p.balance<item.price)s.Fail('INSUFFICIENT_BALANCE');
 const id=s.Id('ORD');const row={id,accountId:p.id,productId:item.id,title:item.title,accessType:item.accessType,days:item.days,amount:item.price,status:'PAID',at:Date.now(),activatedAt:0,expiresAt:0,licenseKey:''};
 s.Ledger(p,-item.price,'PURCHASE',id);if(item.stock>0)item.stock--;s.DB().orders[id]=row;return {order:PublicOrder(row),balance:p.balance};
}
function PublicOrder(row){const {licenseKey,...result}=row;return result;}
function Activate(p,c,body){
 const order=s.DB().orders[body.orderId];if(!order||order.accountId!==p.id)s.Fail('ORDER_NOT_FOUND');if(order.status==='REFUNDED')s.Fail('ORDER_REFUNDED');
 const now=Date.now();if(order.expiresAt && order.expiresAt<=now)s.Fail('PASS_EXPIRED');
 if(!order.activatedAt){order.activatedAt=now;order.expiresAt=now+order.days*86400000;}
 if(!order.licenseKey)order.licenseKey=require('../../core/utils').RandomLicenseKey();
 for(const lic of state.licenses.values())if(lic.boundClient===c.clientId){lic.boundClient='';lic.boundAt=0;}
 const old=state.licenses.get(order.licenseKey);
 state.licenses.set(order.licenseKey,{...(old||{}),createdAt:old?.createdAt||now,expiresAt:order.expiresAt,boundClient:c.clientId,boundAt:now,suspended:false,memo:'구매 이용권 '+order.id,tags:['구매'],accessType:order.accessType});
 order.status='ACTIVE';state.licenseRevision++;
 return {order:PublicOrder(order),requiresBiometric:true};
}
function AfterActivation(c){
 require('../buildGate').RevokeForClient(c.clientId,'PURCHASE_SWITCH');
 c.biometricVerified=false;c.buildCompleted=false;c.buildSessionId='';
 require('../../license/licenseManager').AuthorizeBoundClientByQr(c,'PURCHASE');
}
function RequestTopup(p,body){
 if(!s.DB().settings.topupEnabled)s.Fail('TOPUP_UNAVAILABLE');
 if(Object.values(s.DB().topups).filter(t=>t.accountId===p.id&&t.status==='PENDING').length>=3)s.Fail('TOPUP_PENDING_LIMIT');
 const id=s.Id('TOP'),row={id,accountId:p.id,amount:s.Money(body.amount,1000,1000000),depositor:s.Text(body.depositor,50,true),note:s.Text(body.note,150),status:'PENDING',at:Date.now(),processedAt:0,processedBy:'',reason:''};s.DB().topups[id]=row;return {topup:row,balance:p.balance};
}
function CancelTopup(p,body){const t=s.DB().topups[body.id];if(!t||t.accountId!==p.id)s.Fail('TOPUP_NOT_FOUND');if(t.status!=='PENDING')s.Fail('TOPUP_ALREADY_PROCESSED');t.status='CANCELED';return {topup:t};}
function DecideTopup(body,actor){
 const t=s.DB().topups[body.id];if(!t)s.Fail('TOPUP_NOT_FOUND');const status=body.approve===true?'APPROVED':'REJECTED';
 if(t.status===status)return t;if(t.status!=='PENDING')s.Fail('TOPUP_ALREADY_PROCESSED');
 return s.Atomic(()=>{const p=s.ProfileById(t.accountId);if(!p)s.Fail('ACCOUNT_REQUIRED');if(status==='APPROVED')s.Ledger(p,t.amount,'TOPUP',t.id);t.status=status;t.processedAt=Date.now();t.processedBy=actor;t.reason=s.Text(body.reason,200);return t;});
}
function Refund(body,actor){
 const order=s.DB().orders[body.id];if(!order)s.Fail('ORDER_NOT_FOUND');if(order.status==='REFUNDED')return PublicOrder(order);if(order.activatedAt)s.Fail('ACTIVATED_REFUND_REVIEW');
 return s.Atomic(()=>{const p=s.ProfileById(order.accountId);s.Ledger(p,order.amount,'REFUND',order.id);order.status='REFUNDED';order.refundedAt=Date.now();order.refundedBy=actor;order.refundReason=s.Text(body.reason,200,true);const product=s.DB().products[order.productId];if(product&&product.stock>=0)product.stock++;return PublicOrder(order);});
}
function Mine(p,body){const db=s.DB();return {profile:s.PublicProfile(p,true),orders:s.Page(Object.values(db.orders).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at).map(PublicOrder),body,20),payments:s.Page(Object.values(db.ledger).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at),body,20),topups:s.Page(Object.values(db.topups).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at),body,20),settings:db.settings};}
module.exports={Catalog,SaveProduct,Purchase,Activate,AfterActivation,RequestTopup,CancelTopup,DecideTopup,Refund,Mine,PublicOrder};
