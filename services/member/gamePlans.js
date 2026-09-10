'use strict';
const s=require('./store');
const DAYS=[1,7,15,30]; // Initial suggestions only; persisted plans define purchasable durations.
function Plans(product){
 const rows=Array.isArray(product?.plans)?product.plans:(product?.days?[{days:product.days,price:product.price}]:DAYS.map(days=>({days,price:0})));
 return rows.map(({days,price})=>({days,price,available:Number.isSafeInteger(days)&&days>=1&&days<=3650&&Number.isSafeInteger(price)&&price>0&&price<=10000000})).sort((a,b)=>a.days-b.days);
}
function Validate(value,previous){
 if(value===undefined)return Plans(previous).map(({days,price})=>({days,price}));
 if(!Array.isArray(value)||!value.length||value.length>24)s.Fail('GAME_PLAN_INVALID');
 const seen=new Set();return value.map(x=>{if(!x||!Number.isSafeInteger(x.days)||x.days<1||x.days>3650||seen.has(x.days))s.Fail('GAME_PLAN_INVALID');seen.add(x.days);return {days:x.days,price:s.Money(x.price,0)};}).sort((a,b)=>a.days-b.days);
}
module.exports={DAYS,Plans,Validate};
