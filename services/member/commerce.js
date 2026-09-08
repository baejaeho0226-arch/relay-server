'use strict';
const s=require('./store'),state=require('../../core/state');
function PublicGame(p){return {id:p.id,title:p.title,description:p.description,accessType:p.accessType,published:p.published,deleted:p.deleted,sort:p.sort,revision:p.revision,updatedAt:p.updatedAt};}
function Catalog(body={}){return s.Page(Object.values(s.DB().products).filter(p=>p.published&&!p.deleted&&(!body.category||p.accessType===body.category)).sort((a,b)=>a.sort-b.sort||b.updatedAt-a.updatedAt).map(PublicGame),body);}
function Product(body){const row=s.DB().products[body.id];if(!row||!row.published||row.deleted)s.Fail('PRODUCT_UNAVAILABLE');return {product:PublicGame(row)};}
function SaveProduct(body){
 const id=body.id?s.Text(body.id,40):s.Id('PRD'),previous=s.DB().products[id];if(body.id&&!previous)s.Fail('PRODUCT_NOT_FOUND');
 const accessType=s.Text(body.accessType,16);if(!['TYPE1','TYPE2','TYPE3'].includes(accessType))s.Fail('ACCESS_TYPE_INVALID');
 if(previous&&body.revision!==undefined&&body.revision!==(previous.revision||0))s.Fail('CONTENT_CHANGED');
 const row={id,deleted:previous?.deleted||false,revision:(previous?.revision||0)+1,title:s.Text(body.title,70,true),description:s.Text(body.description,1500),accessType,published:body.published===true,sort:Number.isInteger(body.sort)?body.sort:0,updatedAt:Date.now()};
 return s.Atomic(()=>{s.DB().products[id]=row;return PublicGame(row);});
}
function PublicOrder(row){const {licenseKey,...result}=row;if(result.status!=='REFUNDED'&&result.expiresAt>0&&result.expiresAt<=Date.now())result.status='EXPIRED';return result;}
function Activate(p,c,body){
 const order=s.DB().orders[body.orderId];if(!order||order.accountId!==p.id)s.Fail('ORDER_NOT_FOUND');if(order.status==='REFUNDED')s.Fail('ORDER_REFUNDED');
 const now=Date.now();if(order.expiresAt && order.expiresAt<=now)s.Fail('PASS_EXPIRED');
 if(!order.activatedAt){order.activatedAt=now;order.expiresAt=now+order.days*86400000;}
 p.activeOrderId=order.id;
 const bound=require('../../license/licenseManager').GetBoundLicenseEntry(c.clientId);
 if(!bound)s.Fail('MEMBER_AUTH_REQUIRED');
 require('./entryPass').Convert(bound.license);
 order.status='ACTIVE';state.licenseRevision++;
 return {order:PublicOrder(order),requiresBiometric:true};
}
function AfterActivation(c){
 require('../buildGate').RevokeForClient(c.clientId,'PURCHASE_SWITCH');
 c.biometricVerified=false;c.buildCompleted=false;c.buildSessionId='';
 require('../../license/licenseManager').AuthorizeBoundClientByQr(c,'PURCHASE');
}

function Refund(body,actor){
 const order=s.DB().orders[body.id];if(!order)s.Fail('ORDER_NOT_FOUND');if(order.status==='REFUNDED')return PublicOrder(order);if(order.activatedAt||order.source==='QR_CHARGE')s.Fail('ACTIVATED_REFUND_REVIEW');
 return s.Atomic(()=>{const p=s.ProfileById(order.accountId);s.Ledger(p,order.amount,'REFUND',order.id);order.status='REFUNDED';order.refundedAt=Date.now();order.refundedBy=actor;order.refundReason=s.Text(body.reason,200,true);const product=s.DB().products[order.productId];if(product&&product.stock>=0)product.stock++;return PublicOrder(order);});
}
function Mine(p,body){const db=s.DB();return {profile:s.PublicProfile(p,true),orders:s.Page(Object.values(db.orders).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at).map(PublicOrder),body,20),payments:s.Page(Object.values(db.ledger).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at),body,20)};}
module.exports={PublicGame,Product,Catalog,SaveProduct,Activate,AfterActivation,Refund,Mine,PublicOrder};
