'use strict';
const s=require('./store');
const DAYS=[1,7,15,30];
function Plans(product){
 return DAYS.map(days=>{
  const configured=product?.plans?.find(x=>x.days===days);
  // Preserve only an explicitly configured legacy price for this exact period.
  const price=configured?.price??(product?.days===days?product.price:0)??0;
  return {days,price,available:Number.isSafeInteger(price)&&price>0&&price<=10000000};
 });
}
function Validate(value,previous){
 if(value===undefined)return Plans(previous).map(({days,price})=>({days,price}));
 if(!Array.isArray(value)||value.length!==DAYS.length||DAYS.some(days=>value.filter(x=>x&&x.days===days).length!==1))s.Fail('GAME_PLAN_INVALID');
 return DAYS.map(days=>({days,price:s.Money(value.find(x=>x.days===days).price,0)}));
}
module.exports={DAYS,Plans,Validate};
