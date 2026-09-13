'use strict';
// Display reference only. Never import this module from a ledger, purchase or
// arcade settlement calculation. Monetary requests remain integer KRW.
const fs=require('node:fs'),path=require('node:path');
const currencies=['KRW','USD','EUR','JPY','CNY','GBP','CAD','AUD'];
function Normalize(raw){
 if(!raw||raw.baseCurrency!=='EUR'||!/^\d{4}-\d{2}-\d{2}$/.test(raw.rateDate||'')||
   !Number.isFinite(Date.parse(raw.rateDate))||new Date(raw.rateDate).toISOString().slice(0,10)!==raw.rateDate||
   raw.rateDate>new Date().toISOString().slice(0,10)||typeof raw.source!=='string'||!raw.source.trim()||raw.source.length>100||
   typeof raw.sourceUrl!=='string'||!/^https:\/\//.test(raw.sourceUrl)||raw.sourceUrl.length>500||
   !raw.rates||raw.rates.EUR!==1||!Number.isFinite(raw.rates.KRW)||raw.rates.KRW<=0)return null;
 const rates={KRW:1};
 for(const code of currencies){
  const value=raw.rates[code];
  if(Number.isFinite(value)&&value>0&&value<=100000000){const rate=value/raw.rates.KRW;if(rate>0&&Number.isFinite(rate))rates[code]=rate;}
 }
 return {baseCurrency:'KRW',rateDate:raw.rateDate,source:raw.source,sourceUrl:raw.sourceUrl,approximate:true,rates,currencies:currencies.filter(code=>Object.hasOwn(rates,code))};
}
function Load(){
 try{
  const file=process.env.MOAPLAY_CURRENCY_REFERENCE_PATH||path.join(__dirname,'currency-reference.json');
  if(fs.statSync(file).size>32768)return null;
  return Normalize(JSON.parse(fs.readFileSync(file,'utf8')));
 }catch(_){return null;}
}
const snapshot=Load();
function Reference(){return structuredClone(snapshot||{baseCurrency:'KRW',rateDate:'',source:'',sourceUrl:'',approximate:false,rates:{KRW:1},currencies:['KRW']});}
function Supported(code){return typeof code==='string'&&currencies.includes(code)&&!!(snapshot?.rates[code]||code==='KRW');}
module.exports={Reference,Supported,Normalize};
