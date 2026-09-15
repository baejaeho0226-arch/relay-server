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
const coins=require('./currency-coins');
const names={KRW:'대한민국 원',USD:'미국 달러',EUR:'유로',JPY:'일본 엔',CNY:'중국 위안',GBP:'영국 파운드',CAD:'캐나다 달러',AUD:'호주 달러'};
function Reference(code='KRW'){
 const result=structuredClone(snapshot||{baseCurrency:'KRW',rateDate:'',source:'',sourceUrl:'',approximate:false,rates:{KRW:1},currencies:['KRW']});
 // A persisted coin preference also warms a missing cache after deployment.
 // Until its quote is verified the response keeps the honest KRW fallback.
 const quote=coins.CodeID(code)?coins.Quote({code}):null;
 if(quote?.ready){
  const selected=quote.currency;result.rates[code]=selected.rate;result.currencies.push(code);result.selected=selected;
  result.rateDate=selected.rateDate;result.source=selected.source;result.sourceUrl=selected.sourceUrl;result.approximate=true;
 }
 return result;
}
function Supported(code){return typeof code==='string'&&(currencies.includes(code)&&!!(snapshot?.rates[code]||code==='KRW')||coins.Supported(code));}
function List(body={}){
 const result=coins.List(body);
 return {...result,fiat:currencies.filter(Supported).map(code=>({code,name:names[code],kind:'fiat',symbol:code,available:true}))};
}
function Quote(body={}){
 if(currencies.includes(body.code)&&Supported(body.code)){const ref=Reference();return {code:body.code,ready:true,loading:false,error:'',currency:{code:body.code,kind:'fiat',symbol:body.code,name:names[body.code],rate:ref.rates[body.code],rateDate:ref.rateDate,source:ref.source}};}
 return coins.Quote(body);
}
module.exports={Reference,Supported,Normalize,List,Quote};
