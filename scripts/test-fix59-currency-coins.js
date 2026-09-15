'use strict';
// Transport is fully mocked: this regression never needs a live quote/API key.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix59-currency-'));
process.env.DATA_DIR=temporary;process.env.STORAGE_ENGINE='json';process.env.COINGECKO_DEMO_API_KEY='test-key-not-a-real-secret';
const realFetch=global.fetch,realNow=Date.now;let now=realNow(),catalogGate,releaseCatalog;
Date.now=()=>now;
const calls=[],quotes=new Map(),details=new Map();
const catalogue=Array.from({length:1001},(_,i)=>({id:'asset-'+i,name:'Asset '+String(i).padStart(4,'0'),symbol:'a'+i}));
catalogue.push({id:'bitcoin',name:'Bitcoin',symbol:'btc'},{id:'bitcoin-copy',name:'Bitcoin Copy',symbol:'btc'},{id:'ether',name:'Ether',symbol:'eth'},
 {id:'bad-quote',name:'Bad Quote',symbol:'bad'},{id:'missing-icon',name:'Missing Icon',symbol:'mi'},
 {id:'oversized-icon',name:'Oversized Icon',symbol:'oi'}, {id:'../outside',name:'Invalid Path',symbol:'out'});
catalogGate=new Promise(resolve=>{releaseCatalog=resolve;});
let listStatus=200,quoteStatus=200;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64');
function response(value,status=200,type='application/json'){return new Response(type==='application/json'?JSON.stringify(value):value,{status,headers:{'content-type':type}});}
global.fetch=async(url,options)=>{
 const target=new URL(url);calls.push({url:target.href,headers:{...options.headers},redirect:options.redirect});
 assert.equal(options.redirect,'error');assert.ok(options.signal,'every provider call has a bounded timeout');
 if(target.hostname==='api.coingecko.com'){
  assert.equal(options.headers['x-cg-demo-api-key'],'test-key-not-a-real-secret');
  if(target.pathname==='/api/v3/coins/list') {await catalogGate;return response(catalogue,listStatus);}
  if(target.pathname==='/api/v3/simple/price'){
   assert.equal(target.searchParams.get('vs_currencies'),'krw');assert.equal(target.searchParams.get('include_last_updated_at'),'true');assert.equal(target.searchParams.get('precision'),'full');
   const id=target.searchParams.get('ids');assert.equal(id.includes(','),false,'only the requested unique asset needs a quote');
   return response({[id]:quotes.has(id)?quotes.get(id):{krw:65000000,last_updated_at:Math.floor(now/1000)}},quoteStatus);
  }
  const id=decodeURIComponent(target.pathname.slice('/api/v3/coins/'.length));
  return response(details.get(id)||{image:{thumb:'https://coin-images.coingecko.com/coins/images/1/thumb/bitcoin.png'}});
 }
 if(target.hostname==='coin-images.coingecko.com')return target.pathname.includes('oversized')?response(Buffer.alloc(22001),200,'image/png'):response(png,200,'image/png');
 throw Error('Unexpected external URL '+url);
};
require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),database=require('../storage/database');
const currency=require('../services/member/currency');
let sequence=0;
function client(n){
 const id=String(n).padStart(16,'0'),c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:'FIX59-CURRENCY-'+id,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(c.installationDeviceKey,{id,serverId:'',createdAt:now});state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:now});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));return c;
}
const run=(c,action,body={},requestId)=>hub.Execute(c,requestId||'FIX59-CURRENCY-'+(++sequence),action,body);
const until=async(predicate,label)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Timed out: '+label);};
const advance=ms=>{now+=ms;};
(async()=>{try{
 const a=client(590201),b=client(590202),pa=s.Account(a);s.Account(b);
 s.Atomic(()=>s.Ledger(pa,10000,'QR_TOPUP','CURRENCY-SEED'));
 const beforeReads=JSON.stringify(s.DB());
 const cold=run(a,'currency.list',{query:'',offset:0});assert.equal(cold.loading,true);assert.equal(cold.items.length,0);assert.equal(cold.offset,0);
 assert.deepEqual(cold.fiat.map(x=>x.code),['KRW','USD','EUR','JPY','CNY','GBP','CAD','AUD']);
 for(let i=0;i<40;i++)run(a,'currency.list',{query:'btc',offset:0});
 assert.equal(calls.filter(x=>x.url.includes('/coins/list')).length,1,'cold catalogue reads share one background request');
 assert.equal(JSON.stringify(s.DB()),beforeReads,'catalogue reads never revise wallets, profile, ledger or operation store');
 releaseCatalog();await until(()=>!currency.List({}).loading,'catalogue ready');
 const page=run(a,'currency.list',{offset:0});assert.equal(page.total,1007);assert.equal(page.items.length,24);assert.equal(page.nextOffset,24);
 assert.equal(run(a,'currency.list',{offset:24}).offset,24);assert.notEqual(run(a,'currency.list',{offset:24}).items[0].code,page.items[0].code);
 assert.equal(run(a,'currency.list',{offset:1007}).nextOffset,null);assert.deepEqual(run(a,'currency.list',{offset:1007}).items,[]);
 const search=run(a,'currency.list',{query:'BtC'});assert.equal(search.total,2);assert.deepEqual(search.items.map(x=>x.code),['CG:bitcoin','CG:bitcoin-copy']);
 assert.equal(run(a,'currency.list',{query:'ASSET 1000'}).items[0].code,'CG:asset-1000','full catalogue is not limited to a top-N market list');
 assert.equal(run(a,'currency.list',{query:'no-such-symbol'}).total,0);
 for(const body of [{offset:-1},{offset:1.5},{query:[]},{query:{}}])assert.throws(()=>run(a,'currency.list',body),/INPUT_INVALID/);
 for(const code of ['BTC','cg:bitcoin','CG:../secret','CG:bitcoin,ether',null])assert.throws(()=>run(a,'currency.quote',{code}),/INPUT_INVALID/);
 assert.throws(()=>run(a,'preferences.save',{displayCurrency:'CG:bitcoin'}),/INPUT_INVALID/,'catalogue entry cannot be selected before a verified quote');
 assert.equal(currency.Quote({code:'CG:unknown-token'}).error,'COIN_NOT_FOUND');
 const first=run(a,'currency.quote',{code:'CG:bitcoin'});assert.equal(first.loading,true);assert.equal(first.ready,false);
 for(let i=0;i<30;i++)run(a,'currency.quote',{code:'CG:bitcoin'});
 assert.equal(calls.filter(x=>x.url.includes('/simple/price')).length,1,'quote polling shares a single in-flight quote');
 await until(()=>!currency.Quote({code:'CG:bitcoin'}).loading,'bitcoin quote and optional icon ready');
 const result=run(a,'currency.quote',{code:'CG:bitcoin'});assert.equal(result.ready,true);assert.equal(result.currency.rate,1/65000000);assert.equal(result.currency.symbol,'BTC');
 assert.match(result.currency.iconSvg,/href="data:image\/png;base64,/);assert.equal(result.currency.source,'CoinGecko');assert.equal(result.currency.approximate,true);
 const dbAtQuote=JSON.stringify(s.DB());assert.equal(dbAtQuote,beforeReads,'remote cache is independent from financial database');
 const ledger=JSON.stringify(s.DB().ledger),saved=run(a,'preferences.save',{displayCurrency:'CG:bitcoin'},'COIN-PREFERENCE');
 assert.equal(saved.preferences.displayCurrency,'CG:bitcoin');assert.equal(saved.profile.balance,10000);assert.equal(saved.preferences.currencyReference.selected.code,'CG:bitcoin');
 assert.equal(saved.publicProfile.preferences,undefined);assert.equal(run(b,'preferences').preferences.displayCurrency,'KRW');
 assert.equal(JSON.stringify(s.DB().ledger),ledger,'choosing a coin display must not move even one KRW');
 assert.deepEqual(run(a,'preferences.save',{displayCurrency:'CG:bitcoin'},'COIN-PREFERENCE'),saved,'preference replay is durable');
 assert.throws(()=>run(a,'preferences.save',{displayCurrency:'BTC'}),/INPUT_INVALID/,'duplicate tickers can never choose an ambiguous asset');
 assert.throws(()=>run(a,'preferences.save',{currencyReference:{rates:{'CG:bitcoin':999999}}}),/INPUT_INVALID/);
 const reference=currency.Reference('CG:bitcoin');assert.equal(reference.currencies.length,9);assert.equal(Object.keys(reference.rates).length,9,'profile references contain fiat plus selected coin, never all token rates');
 reference.selected.rate=1;reference.rates['CG:bitcoin']=1;assert.equal(currency.Reference('CG:bitcoin').rates['CG:bitcoin'],1/65000000);
 const beforeFail=JSON.stringify(s.DB()),save=database.SaveDatabase;database.SaveDatabase=()=>false;
 try{assert.throws(()=>run(a,'preferences.save',{displayCurrency:'USD'}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),beforeFail,'failed preference persistence rolls back selected display');
 // A selected asset is a view over the existing integer KRW ledger.
 const game=hub.AdminWrite('product.save',{title:'Coin display fixture',description:'Integer KRW',genre:'레이싱',accessType:'TYPE1',plans:[{days:1,price:100}],published:true},'FIX59-CURRENCY');
 const order=run(a,'purchase',{productId:game.id,days:1,price:100,revision:game.revision});assert.equal(order.order.amount,100);assert.equal(order.profile.balance,9900);
 assert.equal(order.profile.preferences.displayCurrency,'CG:bitcoin');
 a.biometricVerified=false;assert.throws(()=>run(a,'currency.list',{}),/MEMBER_AUTH_REQUIRED/);assert.throws(()=>run(a,'currency.quote',{code:'CG:bitcoin'}),/MEMBER_AUTH_REQUIRED/);a.biometricVerified=true;
 // Catalogues stay fast and useful during provider downtime. Existing verified
 // references remain visibly stale; failures never manufacture another rate.
 advance(2*60000);quoteStatus=429;currency.Quote({code:'CG:bitcoin'});await until(()=>!currency.Quote({code:'CG:bitcoin'}).loading,'rate limit state');
 const limited=currency.Quote({code:'CG:bitcoin'});assert.equal(limited.ready,true);assert.equal(limited.error,'COIN_RATE_LIMITED');assert.equal(limited.currency.rate,1/65000000);
 const callsAtLimit=calls.length;for(let i=0;i<25;i++)currency.Quote({code:'CG:bitcoin'});assert.equal(calls.length,callsAtLimit,'provider errors have bounded backoff');
 advance(6*60000);assert.equal(currency.Reference('CG:bitcoin').selected.stale,true);
 await until(()=>!currency.Quote({code:'CG:bitcoin'}).loading,'stale quote retry finished');
 quoteStatus=200;advance(2*60000);
 quotes.set('bad-quote',{krw:0,last_updated_at:Math.floor(now/1000)});currency.Quote({code:'CG:bad-quote'});await until(()=>!currency.Quote({code:'CG:bad-quote'}).loading,'invalid zero quote');
 assert.equal(currency.Quote({code:'CG:bad-quote'}).ready,false);assert.equal(currency.Quote({code:'CG:bad-quote'}).error,'COIN_DATA_INVALID');assert.equal(currency.Supported('CG:bad-quote'),false);
 for(const invalidPrice of [()=>({krw:-1,last_updated_at:Math.floor(now/1000)}),()=>({krw:5,last_updated_at:Math.floor(now/1000)-90000}),()=>({krw:5,last_updated_at:Math.floor(now/1000)+600}),()=>({krw:5,last_updated_at:null})]){
  advance(2*60000);quotes.set('bad-quote',invalidPrice());currency.Quote({code:'CG:bad-quote'});await until(()=>!currency.Quote({code:'CG:bad-quote'}).loading,'invalid quote');assert.equal(currency.Supported('CG:bad-quote'),false);
 }
 // Only fixed trusted HTTPS icon hosts are allowed; icon failure does not hide
 // a verified quote and is represented by an empty SVG for a ticker fallback.
 advance(2*60000);details.set('missing-icon',{image:{thumb:'https://127.0.0.1/private'}});currency.Quote({code:'CG:missing-icon'});await until(()=>!currency.Quote({code:'CG:missing-icon'}).loading,'untrusted icon');
 assert.equal(currency.Quote({code:'CG:missing-icon'}).ready,true);assert.equal(currency.Quote({code:'CG:missing-icon'}).currency.iconSvg,'');assert.equal(calls.some(x=>x.url.includes('127.0.0.1')),false);
 advance(2*60000);details.set('oversized-icon',{image:{thumb:'https://coin-images.coingecko.com/oversized.png'}});currency.Quote({code:'CG:oversized-icon'});await until(()=>!currency.Quote({code:'CG:oversized-icon'}).loading,'oversized icon');assert.equal(currency.Quote({code:'CG:oversized-icon'}).currency.iconSvg,'');
 advance(2*60000);quotes.set('bitcoin-copy',{krw:0.000001,last_updated_at:Math.floor(now/1000)});currency.Quote({code:'CG:bitcoin-copy'});await until(()=>!currency.Quote({code:'CG:bitcoin-copy'}).loading,'same ticker second asset');assert.equal(currency.Quote({code:'CG:bitcoin-copy'}).currency.rate,1000000);assert.notEqual(currency.Quote({code:'CG:bitcoin-copy'}).currency.code,'CG:bitcoin');
 // A fresh process can use the verified persisted reference without any HTTP
 // call, including the encoded icon. Selected coin state remains account-local.
 await until(()=>fs.existsSync(path.join(temporary,'currency-cache.json')),'cache persisted');
 const boot=JSON.parse(execFileSync(process.execPath,['-e',`global.fetch=()=>{throw Error('UNEXPECTED_NETWORK')};process.stdout.write(JSON.stringify(require(${JSON.stringify(require.resolve('../services/member/currency'))}).Reference('CG:bitcoin')))`],{encoding:'utf8',env:{...process.env},cwd:path.resolve(__dirname,'..')}));
 assert.equal(boot.selected.code,'CG:bitcoin');assert.equal(boot.rates['CG:bitcoin'],1/65000000);assert.match(boot.selected.iconSvg,/data:image\/png/);
 assert.equal(currency.Reference().currencies.length,8,'another account never inherits the selected coin reference');
 const schema=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(schema),true);assert.equal(run(a,'preferences').preferences.displayCurrency,'CG:bitcoin');
 console.log('FIX59 CURRENCY COINS PASS: full active catalogue and paging/search, unique IDs, authenticated reads, async single-flight/cache, verified KRW quotes, rate-limit fallback, bounded trusted icons, account isolation, exact unchanged KRW ledger, replay/rollback and persisted reference.');
}finally{
 // Keep the mock installed until catalogue/quote/cache continuations finish,
 // including an assertion failure, so this test can never use the real network.
 releaseCatalog();await new Promise(resolve=>setTimeout(resolve,100));
 global.fetch=realFetch;Date.now=realNow;fs.rmSync(temporary,{recursive:true,force:true});
}})().catch(error=>{console.error(error);process.exitCode=1;});
