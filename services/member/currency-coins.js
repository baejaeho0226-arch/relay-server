'use strict';
// CoinGecko Demo API: full active /coins/list (not a top-N market list), then
// /simple/price using the unique ID and KRW. These are display references only.
// https://docs.coingecko.com/demo/reference/coins-list
// https://docs.coingecko.com/demo/reference/simple-price
const fs=require('node:fs'),path=require('node:path'),{DATA_DIR}=require('../../config/config');
const CACHE=path.join(DATA_DIR,'currency-cache.json'),DAY=86400000,MINUTE=60000;
const ORIGIN='https://api.coingecko.com/api/v3';
let catalog=[],index=new Map(),catalogAt=0,catalogTask=null,catalogRetryAt=0,catalogError='',writeTask=null,writeVersion=0;
let prices=new Map(),quoteTasks=new Map(),quoteErrors=new Map(),nextQuoteAt=0;
function Clean(value,max){return typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,max):'';}
function CoinID(value){return typeof value==='string'&&/^[a-z0-9][a-z0-9._-]{0,159}$/.test(value);}
function CodeID(code){return typeof code==='string'&&code.startsWith('CG:')&&CoinID(code.slice(3))?code.slice(3):'';}
function Rows(raw){
 if(!Array.isArray(raw))throw Error('COIN_DATA_INVALID');
 const found=new Map();
 for(const row of raw){if(!row||!CoinID(row.id))continue;const name=Clean(row.name,100),symbol=Clean(row.symbol,30);if(!name||!symbol)continue;found.set(row.id,{id:row.id,name,symbol:symbol.toUpperCase()});}
 if(!found.size)throw Error('COIN_DATA_INVALID');
 return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name,'en')||a.id.localeCompare(b.id));
}
function ValidPrice(row){return !!row&&CoinID(row.id)&&Number.isFinite(row.rate)&&row.rate>0&&row.rate<1e100&&Number.isSafeInteger(row.at)&&row.at>0&&row.at<=Date.now()+300000;}
function SafeIcon(value){return typeof value==='string'&&value.length<32000&&/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24"><image width="24" height="24" href="data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+"\/><\/svg>$/.test(value)?value:'';}
function Load(){try{
 if(fs.statSync(CACHE).size>24*1024*1024)return;
 const raw=JSON.parse(fs.readFileSync(CACHE,'utf8'));if(raw.version!==1)return;
 catalog=Rows(raw.catalog);index=new Map(catalog.map(row=>[row.id,row]));
 catalogAt=Number.isSafeInteger(raw.catalogAt)&&raw.catalogAt<=Date.now()+300000?raw.catalogAt:0;
 for(const row of Array.isArray(raw.prices)?raw.prices:[])if(ValidPrice(row)&&index.has(row.id))prices.set(row.id,{id:row.id,rate:row.rate,at:row.at,fetchedAt:Number(row.fetchedAt)||0,iconSvg:SafeIcon(row.iconSvg)});
}catch(_){catalog=[];index=new Map();catalogAt=0;}}
Load();
function Persist(){
 // Catalog/quote IO does not copy, revise, or save the financial database.
 writeVersion++;if(writeTask)return writeTask;
 writeTask=(async()=>{
  let writtenVersion;
  do{
   await new Promise(resolve=>setTimeout(resolve,20));writtenVersion=writeVersion;
   const value=JSON.stringify({version:1,catalogAt,catalog,prices:[...prices.values()]});
   await fs.promises.mkdir(DATA_DIR,{recursive:true});const temporary=CACHE+'.tmp';
   await fs.promises.writeFile(temporary,value);await fs.promises.rename(temporary,CACHE);
  }while(writtenVersion!==writeVersion);
 })().catch(()=>{}).finally(()=>{writeTask=null;});return writeTask;
}
async function Bytes(url,maximum,api=false){
 const headers={Accept:api?'application/json':'image/png,image/jpeg,image/webp'};
 if(api&&process.env.COINGECKO_DEMO_API_KEY)headers['x-cg-demo-api-key']=process.env.COINGECKO_DEMO_API_KEY;
 const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(7000)});
 if(!response.ok)throw Error(response.status===429?'COIN_RATE_LIMITED':response.status===401||response.status===403?'COIN_API_UNAVAILABLE':'COIN_NETWORK_UNAVAILABLE');
 if(Number(response.headers.get('content-length'))>maximum)throw Error('COIN_DATA_INVALID');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)throw Error('COIN_DATA_INVALID');chunks.push(Buffer.from(value));}}
 finally{try{await reader.cancel();}catch(_){}}
 return {buffer:Buffer.concat(chunks),type:response.headers.get('content-type')||''};
}
async function Json(relative,maximum=1024*1024){return JSON.parse((await Bytes(ORIGIN+relative,maximum,true)).buffer.toString('utf8'));}
function Invalid(){const e=Error('INPUT_INVALID');e.memberError=true;throw e;}
function ErrorCode(e){return ['COIN_RATE_LIMITED','COIN_API_UNAVAILABLE','COIN_DATA_INVALID'].includes(e.message)?e.message:'COIN_NETWORK_UNAVAILABLE';}
function EnsureCatalog(){
 if(catalogTask||Date.now()<catalogRetryAt||catalog.length&&Date.now()-catalogAt<DAY)return;
 catalogTask=(async()=>{const rows=Rows(await Json('/coins/list?include_platform=false',20*1024*1024));catalog=rows;index=new Map(rows.map(row=>[row.id,row]));catalogAt=Date.now();catalogError='';await Persist();})()
 .catch(e=>{catalogError=ErrorCode(e);catalogRetryAt=Date.now()+MINUTE;}).finally(()=>{catalogTask=null;});
}
function Metadata(code){
 const id=CodeID(code),coin=index.get(id),price=prices.get(id);if(!coin)return null;
 const valid=ValidPrice(price);
 return {code:'CG:'+id,kind:'coin',name:coin.name,symbol:coin.symbol,rate:valid?price.rate:0,
  rateDate:valid?new Date(price.at).toISOString():'',source:'CoinGecko',sourceUrl:'https://www.coingecko.com/en/coins/'+encodeURIComponent(id),
  approximate:true,stale:valid&&Date.now()-price.at>5*MINUTE,iconSvg:valid?price.iconSvg||'':''};
}
function Supported(code){const id=CodeID(code);return !!id&&index.has(id)&&ValidPrice(prices.get(id));}
async function Icon(id){
 try{
  const detail=await Json('/coins/'+encodeURIComponent(id)+'?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false');
  const url=new URL(detail.image?.thumb||'');
  if(url.protocol!=='https:'||!['assets.coingecko.com','coin-images.coingecko.com'].includes(url.hostname)||url.username||url.password||url.port)return '';
  const {buffer,type}=await Bytes(url.href,22000);const mime=type.split(';')[0].trim();
  if(!['image/png','image/jpeg','image/webp'].includes(mime))return '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image width="24" height="24" href="data:'+mime+';base64,'+buffer.toString('base64')+'"/></svg>';
 }catch(_){return '';}
}
function EnsureQuote(id){
 const old=prices.get(id),failure=quoteErrors.get(id);
 if(quoteTasks.has(id)||old&&Date.now()-old.fetchedAt<MINUTE||failure&&Date.now()<failure.retryAt)return;
 if(Date.now()<nextQuoteAt||quoteTasks.size>=2){quoteErrors.set(id,{error:'COIN_RATE_LIMITED',retryAt:Math.max(Date.now()+2000,nextQuoteAt)});return;}
 nextQuoteAt=Date.now()+2000;
 quoteTasks.set(id,(async()=>{
  const value=(await Json('/simple/price?ids='+encodeURIComponent(id)+'&vs_currencies=krw&include_last_updated_at=true&precision=full'))[id];
  const at=Number(value?.last_updated_at)*1000,price=Number(value?.krw),rate=1/price;
  if(!Number.isFinite(price)||price<=0||!ValidPrice({id,at,rate})||Date.now()-at>DAY)throw Error('COIN_DATA_INVALID');
  // Keep a validated quote immediately usable while its optional icon loads.
  prices.set(id,{id,rate,at,fetchedAt:Date.now(),iconSvg:old?.iconSvg||''});quoteErrors.delete(id);
  await Persist();
  if(!old?.iconSvg){const svg=await Icon(id);if(svg){prices.get(id).iconSvg=svg;await Persist();}}
 })().catch(e=>{quoteErrors.set(id,{error:ErrorCode(e),retryAt:Date.now()+MINUTE});}).finally(()=>{quoteTasks.delete(id);}));
}
function List(body={}){
 const query=Clean(body.query??'',80).toLowerCase(),offset=Number(body.offset??0);
 if(typeof body.query!=='undefined'&&typeof body.query!=='string'||!Number.isSafeInteger(offset)||offset<0)Invalid();
 EnsureCatalog();
 const rows=query?catalog.filter(row=>row.id.includes(query)||row.name.toLowerCase().includes(query)||row.symbol.toLowerCase().includes(query)):catalog;
 const items=rows.slice(offset,offset+24).map(row=>({code:'CG:'+row.id,kind:'coin',name:row.name,symbol:row.symbol,available:Supported('CG:'+row.id),iconSvg:SafeIcon(prices.get(row.id)?.iconSvg)}));
 return {items,total:rows.length,offset,nextOffset:offset+24<rows.length?offset+24:null,query,loading:!!catalogTask,error:catalogError,
  catalogAt,stale:catalog.length>0&&Date.now()-catalogAt>=DAY,retryAt:catalogRetryAt,source:'CoinGecko',sourceUrl:'https://www.coingecko.com'};
}
function Quote(body={}){
 const code=body.code,id=CodeID(code);if(!id)Invalid();
 EnsureCatalog();if(index.has(id))EnsureQuote(id);
 const item=Metadata(code),failure=quoteErrors.get(id);
 return {code,ready:Supported(code),loading:!!catalogTask||quoteTasks.has(id),currency:item,
  error:failure?.error||(!index.has(id)?catalogError||(!catalogTask?'COIN_NOT_FOUND':''):''),retryAt:failure?.retryAt||catalogRetryAt};
}
module.exports={List,Quote,Metadata,Supported,CodeID};
