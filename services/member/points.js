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
function Convert(p,body,direction){
 const rewards=require('./rewards'),rules=rewards.Rules(),exchange=rules.pointExchange;
 if(!exchange.enabled||exchange.cashUnit<1||exchange.pointUnit<1)s.Fail('POINT_EXCHANGE_UNAVAILABLE');
 if(body.revision!==rules.revision)s.Fail('CONTENT_CHANGED');
 const amount=s.Money(body.amount,1,100000000),recharge=direction==='recharge';
 const sourceUnit=recharge?exchange.cashUnit:exchange.pointUnit,targetUnit=recharge?exchange.pointUnit:exchange.cashUnit;
 if(amount%sourceUnit!==0)s.Fail('POINT_EXCHANGE_UNIT');
 const converted=amount/sourceUnit*targetUnit;
 if(!Number.isSafeInteger(converted)||converted<1||converted>100000000)s.Fail('AMOUNT_INVALID');
 const cashAmount=recharge?-amount:converted,pointAmount=recharge?converted:-amount;
 if(p.balance+cashAmount<0)s.Fail('INSUFFICIENT_BALANCE');
 if((p.points||0)+pointAmount<0)s.Fail('INSUFFICIENT_POINTS');
 const id=s.Id('PCV'),kind=recharge?'POINT_RECHARGE':'POINT_EXCHANGE';
 // Execute's Operation commits both ledgers and the retry receipt together.
 // Internal conversion is not an approved QR deposit and grants no event turns.
 const payment=s.Ledger(p,cashAmount,kind,id),point=rewards.Credit(p,pointAmount,kind,id);
 const conversion={id,kind,sourceAmount:amount,targetAmount:converted,cashAmount,pointAmount,paymentId:payment.id,pointId:point.id,at:point.at};
 return {...rewards.Read(p),conversion};
}
module.exports={Rules,Validate,Convert};
