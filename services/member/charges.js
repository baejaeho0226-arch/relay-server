'use strict';
const crypto=require('node:crypto'),s=require('./store'),state=require('../../core/state');
const TTL=15*60000;
const Names={TYPE1:'테일즈런너',TYPE2:'알투비트',TYPE3:'로스트사가'};
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function Public(row){const {token,tokenHash,fingerprint,...rest}=row;if(rest.status==='PENDING'&&rest.expiresAt<=Date.now())rest.status='EXPIRED';return rest;}
function Expire(row){if(row.status==='PENDING'&&row.expiresAt<=Date.now())row.status='EXPIRED';return row;}
function Issue(p,persist=true){
 const pending=Object.values(s.DB().chargeRequests).find(x=>x.accountId===p.id&&x.status==='PENDING'&&x.expiresAt>Date.now());if(pending)return pending;
 const create=()=>{
  for(const row of Object.values(s.DB().chargeRequests).filter(x=>x.accountId===p.id))Expire(row);
  const token=crypto.randomBytes(32).toString('base64url'),id=s.Id('CHG');
  const row={id,accountId:p.id,token,tokenHash:hash(token),status:'PENDING',at:Date.now(),expiresAt:Date.now()+TTL};s.DB().chargeRequests[id]=row;return row;
 };return persist?s.Atomic(create):create();
}
function Read(p){
 let row=Object.values(s.DB().chargeRequests).filter(x=>x.accountId===p.id).reverse().sort((a,b)=>b.at-a.at)[0]||Issue(p);
 if(row.status==='PENDING'&&row.expiresAt<=Date.now())s.Atomic(()=>Expire(row));
 const data={request:Public(row)};
 if(row.status==='PENDING')data.qr=require('../qrApproval').QrMatrix('RCH1.'+row.id+'.'+row.token);
 return data;
}
function ApprovalToken(row){return crypto.createHmac('sha256',row.tokenHash).update('CHARGE_APPROVE|'+row.id+'|'+row.expiresAt).digest('hex');}
function Equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function Inspect(payload){
 const parts=String(payload).split('.');if(parts.length!==3||parts[0]!=='RCH1'||!/^CHG-[A-F0-9]{24}$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))s.Fail('CHARGE_QR_INVALID');
 const row=s.DB().chargeRequests[parts[1]];if(!row||!Equal(row.tokenHash,hash(parts[2])))s.Fail('CHARGE_QR_INVALID');
 if(row.status!=='PENDING')s.Fail('CHARGE_PROCESSED');if(row.expiresAt<=Date.now())s.Fail('CHARGE_EXPIRED');
 const p=s.ProfileById(row.accountId);if(!p||p.blocked)s.Fail('ACCOUNT_BLOCKED');
 return {request:Public(row),member:s.PublicProfile(p),approvalToken:ApprovalToken(row)};
}
function Scan(body){return Inspect(require('../qrImageDecoder').DecodeQrImage(body.imageData||''));}
function Approve(body,actor){
 const row=s.DB().chargeRequests[body.id];if(!row||!Equal(body.approvalToken,ApprovalToken(row)))s.Fail('CHARGE_QR_INVALID');
 const amount=s.Money(body.amount),days=s.Money(body.days,1,3650),accessType=s.Text(body.accessType,16),memo=s.Text(body.memo,500);
 if(!Names[accessType])s.Fail('ACCESS_TYPE_INVALID');
 const fingerprint=hash(JSON.stringify({amount,days,accessType,memo}));
 if(row.status==='APPROVED'){if(row.fingerprint!==fingerprint)s.Fail('CONTENT_CHANGED');return Public(row);}
 if(row.status!=='PENDING')s.Fail('CHARGE_PROCESSED');if(row.expiresAt<=Date.now())s.Fail('CHARGE_EXPIRED');
 const p=s.ProfileById(row.accountId);if(!p||p.blocked)s.Fail('ACCOUNT_BLOCKED');
 return s.Atomic(()=>{
  const orderId=s.Id('ORD');s.DB().orders[orderId]={id:orderId,accountId:p.id,productId:'',title:Names[accessType],accessType,days,amount,status:'PAID',at:Date.now(),activatedAt:0,expiresAt:0,licenseKey:'',source:'QR_CHARGE',chargeId:row.id};
  Object.assign(row,{status:'APPROVED',amount,days,accessType,title:Names[accessType],memo,orderId,approvedAt:Date.now(),approvedBy:actor,fingerprint});
  const payId=s.Id('PAY');s.DB().ledger[payId]={id:payId,accountId:p.id,amount,balance:p.balance,kind:'QR_CHARGE',reference:row.id,at:Date.now(),affectsBalance:false};
  return Public(row);
 });
}
function Reject(body,actor){
 const row=s.DB().chargeRequests[body.id];if(!row)s.Fail('CHARGE_QR_INVALID');
 if(row.status==='REJECTED')return Public(row);if(row.status!=='PENDING')s.Fail('CHARGE_PROCESSED');
 return s.Atomic(()=>{Object.assign(row,{status:'REJECTED',reason:s.Text(body.reason,200,true),rejectedBy:actor,rejectedAt:Date.now()});return Public(row);});
}
module.exports={Read,Issue,Inspect,Scan,Approve,Reject,Public,Names};
