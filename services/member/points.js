'use strict';
const s=require('./store');
const inactive={enabled:false,cashUnit:0,pointUnit:0};
function Rules(value=s.DB().settings.rewards?.pointExchange){return structuredClone(value||inactive);}
function Validate(value,previous){
 if(value===undefined)return Rules(previous);
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.enabled!=='boolean')s.Fail('INPUT_INVALID');
 const cashUnit=s.Money(value.cashUnit,value.enabled?1:0,10000000),pointUnit=s.Money(value.pointUnit,value.enabled?1:0,10000000);
 return {enabled:value.enabled,cashUnit,pointUnit};
}
function Exchange(p,body){
 const rewards=require('./rewards'),rules=rewards.Rules(),exchange=rules.pointExchange;
 if(!exchange.enabled||exchange.cashUnit<1||exchange.pointUnit<1)s.Fail('POINT_EXCHANGE_UNAVAILABLE');
 if(body.revision!==rules.revision)s.Fail('CONTENT_CHANGED');
 const amount=s.Money(body.amount,1,100000000);
 const sourceUnit=exchange.pointUnit,targetUnit=exchange.cashUnit;
 if(amount%sourceUnit!==0)s.Fail('POINT_EXCHANGE_UNIT');
 const converted=amount/sourceUnit*targetUnit;
 if(!Number.isSafeInteger(converted)||converted<1||converted>100000000)s.Fail('AMOUNT_INVALID');
 const cashAmount=converted,pointAmount=-amount;
 if(p.balance+cashAmount<0)s.Fail('INSUFFICIENT_BALANCE');
 if((p.points||0)+pointAmount<0)s.Fail('INSUFFICIENT_POINTS');
 const id=s.Id('PCV'),kind='POINT_EXCHANGE';
 // Execute's Operation commits both ledgers and the retry receipt together.
 // Internal conversion is not an approved QR deposit and grants no event turns.
 const payment=s.Ledger(p,cashAmount,kind,id),point=rewards.Credit(p,pointAmount,kind,id);
 const conversion={id,accountId:p.id,kind,status:'COMPLETED',sourceAmount:amount,targetAmount:converted,cashAmount,pointAmount,paymentId:payment.id,pointId:point.id,at:point.at};
 s.DB().pointConversions[id]=conversion;
 return {...rewards.Read(p),conversion};
}
function Rows(){
 const db=s.DB(),rows=new Map(Object.values(db.pointConversions).map(x=>[x.id,x]));
 // FIX44/45 wrote matching ledgers before a dedicated conversion table existed.
 // Reconstruct only validated pairs, preserving the historical rate exactly.
 const pointIndex=new Map(Object.values(db.pointLedger).filter(x=>x.kind==='POINT_EXCHANGE').map(x=>[x.accountId+':'+x.reference,x]));
 const recoveredCash=new Map(Object.values(db.ledger).filter(x=>x.kind==='POINT_EXCHANGE_REVERSE').map(x=>[x.reverseOf,x]));
 const recoveredPoints=new Map(Object.values(db.pointLedger).filter(x=>x.kind==='POINT_EXCHANGE_REVERSE').map(x=>[x.reverseOf,x]));
 for(const payment of Object.values(db.ledger)){
  if(payment.kind!=='POINT_EXCHANGE'||rows.has(payment.reference))continue;
  const point=pointIndex.get(payment.accountId+':'+payment.reference);
  if(!point||payment.amount<=0||point.amount>=0)continue;
  const row={id:payment.reference,accountId:payment.accountId,kind:'POINT_EXCHANGE',status:'COMPLETED',sourceAmount:-point.amount,targetAmount:payment.amount,cashAmount:payment.amount,pointAmount:point.amount,paymentId:payment.id,pointId:point.id,at:point.at};
  const cashRecovery=recoveredCash.get(payment.id),pointRecovery=recoveredPoints.get(point.id);
  if(cashRecovery||pointRecovery){
   if(cashRecovery&&pointRecovery&&cashRecovery.reference===pointRecovery.reference&&cashRecovery.amount===-payment.amount&&pointRecovery.amount===-point.amount&&cashRecovery.accountId===payment.accountId&&pointRecovery.accountId===payment.accountId)
    Object.assign(row,{status:'REVERSED',reversalId:cashRecovery.reference,reversedAt:cashRecovery.at,reversedBy:cashRecovery.actor||'',reason:cashRecovery.reason||'',reversePaymentId:cashRecovery.id,reversePointId:pointRecovery.id});
   else row.status='INCONSISTENT';
  }
  rows.set(payment.reference,row);
 }
 return [...rows.values()];
}
function Admin(body={}){
 const query=String(body.q||'').trim().toLowerCase();
 const rows=Rows().map(row=>{const p=s.ProfileById(row.accountId);return {...row,memberHandle:p?'@'+s.Handle(p):'',member:p?s.PublicProfile(p):null};}).filter(row=>(!body.id||row.id===body.id)&&(!body.status||row.status===body.status)&&(!query||[row.id,row.memberHandle,row.member?.nickname].join(' ').toLowerCase().includes(query))).reverse().sort((a,b)=>b.at-a.at);
 return s.Page(rows,body,30);
}
function Reverse(body,actor){
 if(typeof body.id!=='string'||!body.id)s.Fail('POINT_CONVERSION_NOT_FOUND');
 const original=Rows().find(x=>x.id===body.id);if(!original)s.Fail('POINT_CONVERSION_NOT_FOUND');
 const reason=s.Text(body.reason,300,true);
 const p=s.ProfileById(original.accountId);if(!p)s.Fail('MEMBER_NOT_FOUND');
 if(original.status==='REVERSED')return {conversion:structuredClone(original),profile:s.PublicProfile(p,true),unchanged:true};
 if(original.status!=='COMPLETED')s.Fail('POINT_CONVERSION_INVALID');
 return s.Atomic(()=>{
  const payment=s.DB().ledger[original.paymentId],point=Object.values(s.DB().pointLedger).find(x=>x.id===original.pointId);
  if(!payment||!point||payment.reference!==original.id||point.reference!==original.id||payment.accountId!==p.id||point.accountId!==p.id||payment.amount!==original.cashAmount||point.amount!==original.pointAmount)s.Fail('POINT_CONVERSION_INVALID');
  if(p.balance<original.cashAmount)s.Fail('POINT_RECOVERY_BALANCE');
  const reference=s.Id('PCR'),cash=s.Ledger(p,-original.cashAmount,'POINT_EXCHANGE_REVERSE',reference),restored=require('./rewards').Credit(p,-original.pointAmount,'POINT_EXCHANGE_REVERSE',reference);
  cash.reverseOf=original.paymentId;cash.actor=actor;cash.reason=reason;restored.reverseOf=original.pointId;restored.actor=actor;restored.reason=reason;
  const row={...original,status:'REVERSED',reversalId:reference,reversedAt:cash.at,reversedBy:actor,reason,reversePaymentId:cash.id,reversePointId:restored.id};
  s.DB().pointConversions[row.id]=row;
  return {conversion:row,profile:s.PublicProfile(p,true)};
 });
}
module.exports={Rules,Validate,Exchange,Admin,Reverse};
