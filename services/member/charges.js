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
  const row={id,accountId:p.id,token,tokenHash:hash(token),mode:'WALLET',status:'PENDING',at:Date.now(),expiresAt:Date.now()+TTL};s.DB().chargeRequests[id]=row;return row;
 };return persist?s.Atomic(create):create();
}
function Read(p){
 let row=Object.values(s.DB().chargeRequests).filter(x=>x.accountId===p.id).reverse().sort((a,b)=>b.at-a.at)[0]||Issue(p);
 if(row.status==='PENDING'&&row.expiresAt<=Date.now())s.Atomic(()=>Expire(row));
 const data={request:Public(row),profile:s.PublicProfile(p,true)};
 if(row.status==='PENDING')data.qr=require('../qrApproval').QrMatrix('QRC1.'+row.id+'.'+row.token);
 return data;
}
function ApprovalToken(row){return crypto.createHmac('sha256',row.tokenHash).update('CHARGE_APPROVE|'+row.id+'|'+row.expiresAt).digest('hex');}
function Equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function Inspect(payload){
 const parts=String(payload).split('.');if(parts.length!==3||!['QRC1','RCH1'].includes(parts[0])||!/^CHG-[A-F0-9]{24}$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))s.Fail('CHARGE_QR_INVALID');
 const row=s.DB().chargeRequests[parts[1]];if(!row||!Equal(row.tokenHash,hash(parts[2])))s.Fail('CHARGE_QR_INVALID');
 if(row.status!=='PENDING')s.Fail('CHARGE_PROCESSED');if(row.expiresAt<=Date.now())s.Fail('CHARGE_EXPIRED');
 const p=s.ProfileById(row.accountId);if(!p||p.blocked)s.Fail('ACCOUNT_BLOCKED');
 return {request:Public(row),member:s.PublicProfile(p),approvalToken:ApprovalToken(row)};
}
function Scan(body){return Inspect(require('../qrImageDecoder').DecodeQrImage(body.imageData||''));}
function Approve(body,actor){
 const row=s.DB().chargeRequests[body.id];if(!row||!Equal(body.approvalToken,ApprovalToken(row)))s.Fail('CHARGE_QR_INVALID');
 // A stale FIX16 approval form must never silently become a wallet credit.
 if(body.mode!=='WALLET'||body.days!==undefined||body.accessType!==undefined)s.Fail('CHARGE_MODE_CHANGED');
 const amount=s.Money(body.amount),memo=s.Text(body.memo,500);
 const fingerprint=hash(JSON.stringify({mode:'WALLET',amount,memo}));
 if(row.status==='APPROVED'){if(row.mode!=='WALLET')s.Fail('CHARGE_PROCESSED');if(row.fingerprint!==fingerprint)s.Fail('CONTENT_CHANGED');return Public(row);}
 if(row.status!=='PENDING')s.Fail('CHARGE_PROCESSED');if(row.expiresAt<=Date.now())s.Fail('CHARGE_EXPIRED');
 const p=s.ProfileById(row.accountId);if(!p||p.blocked)s.Fail('ACCOUNT_BLOCKED');
 return s.Atomic(()=>{
  const payment=s.Ledger(p,amount,'QR_TOPUP',row.id);
  Object.assign(row,{mode:'WALLET',status:'APPROVED',amount,memo,paymentId:payment.id,balance:payment.balance,approvedAt:Date.now(),approvedBy:actor,fingerprint});
  return Public(row);
 });
}
function Reject(body,actor){
 const row=s.DB().chargeRequests[body.id];if(!row)s.Fail('CHARGE_QR_INVALID');
 if(row.status==='REJECTED')return Public(row);if(row.status!=='PENDING')s.Fail('CHARGE_PROCESSED');
 return s.Atomic(()=>{Object.assign(row,{status:'REJECTED',reason:s.Text(body.reason,200,true),rejectedBy:actor,rejectedAt:Date.now()});return Public(row);});
}
module.exports={Read,Issue,Inspect,Scan,Approve,Reject,Public,Names};
