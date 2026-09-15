'use strict';
// Manual withdrawal queue. Only the member's server wallet funds the reservation.
// Approval records a transfer already performed by an administrator; this module
// never initiates a bank transfer or invokes an external payment provider.
const s=require('./store');
function Mask(account){return '*'.repeat(Math.max(4,account.length-4))+account.slice(-4);}
function Public(row){
 return {id:row.id,amount:row.amount,status:row.status,bank:row.bank,accountMasked:Mask(row.account),holder:row.holder,at:row.at,
  ...(row.processedAt?{processedAt:row.processedAt}:{}),...(row.status==='REJECTED'?{reason:row.reason}: {})};
}
function Read(p,body={}){
 const rows=Object.values(s.DB().withdrawRequests).filter(x=>x.accountId===p.id).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
 return {wallet:require('./arcade').Wallet(p),...s.Page(rows.map(Public),body,20),pending:rows.some(x=>x.status==='PENDING')};
}
function Request(p,body){
 const amount=s.Money(body.amount),bank=s.Text(body.bank,40,true),account=s.Text(body.account,40,true).replace(/[\s-]/g,''),holder=s.Text(body.holder,60,true);
 if(body.confirmed!==true||!/^\d{6,30}$/.test(account)||/[\r\n]/.test(bank+holder))s.Fail('WITHDRAW_DETAILS_INVALID');
 if(Object.values(s.DB().withdrawRequests).some(x=>x.accountId===p.id&&x.status==='PENDING'))s.Fail('WITHDRAW_PENDING');
 if(amount>p.balance)s.Fail('WITHDRAW_BALANCE_REQUIRED');
 // Execute wraps this entire mutation, reservation and replay receipt in Operation.
 const id=s.Id('WDR'),row={id,accountId:p.id,amount,bank,account,holder,status:'PENDING',at:Date.now()};
 const payment=s.Ledger(p,-amount,'WITHDRAW_RESERVE',id);row.paymentId=payment.id;s.DB().withdrawRequests[id]=row;
 return {...Read(p),request:Public(row)};
}
function Admin(body={}){
 let rows=Object.values(s.DB().withdrawRequests);
 if(body.id)rows=rows.filter(x=>x.id===body.id);
 if(body.status)rows=rows.filter(x=>x.status===body.status);
 const q=String(body.q||'').trim().toLowerCase();
 rows=rows.filter(x=>{const p=s.ProfileById(x.accountId);return !q||[x.id,p?.nickname,p?s.Handle(p):'',x.holder].some(v=>String(v||'').toLowerCase().includes(q));});
 rows.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
 return s.Page(rows.map(x=>{const p=s.ProfileById(x.accountId);return {...Public(x),memberHandle:p?'@'+s.Handle(p):'',memberName:p?.nickname||'회원',...(body.id?{account:x.account,payoutReference:x.payoutReference||''}: {})};}),body,30);
}
function Approve(body,actor){
 const row=s.DB().withdrawRequests[body.id];if(!row)s.Fail('WITHDRAW_NOT_FOUND');
 const reference=s.Text(body.payoutReference,120,true);
 if(body.paidConfirmed!==true)s.Fail('WITHDRAW_PAYMENT_CONFIRM');
 if(row.status==='PAID'){if(row.payoutReference!==reference)s.Fail('CONTENT_CHANGED');return Public(row);}
 if(row.status!=='PENDING')s.Fail('WITHDRAW_PROCESSED');
 return s.Atomic(()=>{row.status='PAID';row.payoutReference=reference;row.processedAt=Date.now();row.processedBy=actor;return Public(row);});
}
function Reject(body,actor){
 const row=s.DB().withdrawRequests[body.id];if(!row)s.Fail('WITHDRAW_NOT_FOUND');
 if(row.status==='REJECTED')return Public(row);
 if(row.status!=='PENDING')s.Fail('WITHDRAW_PROCESSED');
 const reason=s.Text(body.reason,200,true),p=s.ProfileById(row.accountId);if(!p)s.Fail('ACCOUNT_REQUIRED');
 return s.Atomic(()=>{row.status='REJECTED';const refund=s.Ledger(p,row.amount,'WITHDRAW_RELEASE',row.id);Object.assign(row,{reason,refundId:refund.id,processedAt:Date.now(),processedBy:actor});return Public(row);});
}
module.exports={Read,Request,Admin,Approve,Reject,Public};
