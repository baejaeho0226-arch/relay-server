'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'moaplay-fix52-currency-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';require('../core/utils').EnsureDirs();
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service');
const database=require('../storage/database'),currency=require('../services/member/currency'),preferences=require('../services/member/preferences');
let seq=0;
function device(id){
 const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,licenseAuthorized:true,biometricVerified:true,installationDeviceKey:'FIX52-CURRENCY-'+id,deviceAuthChallengeId:'AUTH-'+id,socket:{destroyed:false,write(){return true;}}};
 state.clients.set(id,c);state.clientIdentities.set(c.installationDeviceKey,{id,serverId:'',createdAt:Date.now()});
 state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});state.deviceSecrets.set('CLIENT:'+id,crypto.randomBytes(32).toString('hex'));return c;
}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX52-CURRENCY-'+(++seq),action,body);
try{
 const a=device('5252000000000001'),b=device('5252000000000002'),profile=s.Account(a);s.Account(b);
 s.Atomic(()=>s.Ledger(profile,10000,'QR_TOPUP','FIX52-CURRENCY-FUND'));
 const reference=run(a,'preferences').preferences.currencyReference;
 assert.equal(reference.baseCurrency,'KRW');assert.equal(reference.approximate,true);assert.equal(reference.rateDate,'2026-09-11');
 assert.deepEqual(reference.currencies,['KRW','USD','EUR','JPY','CNY','GBP','CAD','AUD']);
 assert.equal(reference.rates.KRW,1);assert.ok(Math.abs(reference.rates.USD-1.1592/1556.56)<1e-15);
 const ledger=JSON.stringify(s.DB().ledger);
 for(const code of reference.currencies){
  const result=run(a,'preferences.save',{displayCurrency:code});
  assert.equal(result.preferences.displayCurrency,code);assert.equal(result.profile.balance,10000);
  assert.equal(result.profile.preferences.displayCurrency,code);assert.equal(result.publicProfile.preferences,undefined);
  assert.equal(JSON.stringify(s.DB().ledger),ledger,'display preference must never adjust ledger amounts');
 }
 const saved=run(a,'preferences.save',{displayCurrency:'USD',feedDefaultSort:'popular',purchaseActivityVisible:false},'FIX52-CURRENCY-REPLAY');
 assert.equal(saved.preferences.feedDefaultSort,'popular');assert.equal(saved.preferences.purchaseActivityVisible,false);
 assert.deepEqual(run(a,'preferences.save',{displayCurrency:'USD',feedDefaultSort:'popular',purchaseActivityVisible:false},'FIX52-CURRENCY-REPLAY'),saved);
 assert.equal(run(b,'preferences').preferences.displayCurrency,'KRW');assert.equal(run(b,'preferences').preferences.feedDefaultSort,'latest');
 for(const invalid of [{displayCurrency:'usd'},{displayCurrency:'BTC'},{displayCurrency:1},{feedDefaultSort:'wrong'},
   {displayCurrency:'BAD',purchaseActivityVisible:true},{currencyReference:{rates:{USD:1000}}}]){
  const before=JSON.stringify(s.DB());assert.throws(()=>run(a,'preferences.save',invalid),/INPUT_INVALID/);
  assert.equal(JSON.stringify(s.DB()),before,'invalid preference write rolls back every field and operation');
 }
 const before=JSON.stringify(s.DB()),save=database.SaveDatabase;
 try{database.SaveDatabase=()=>false;assert.throws(()=>run(a,'preferences.save',{displayCurrency:'EUR'}),/STORAGE_SAVE_FAILED/);}finally{database.SaveDatabase=save;}
 assert.equal(JSON.stringify(s.DB()),before);
 const game=hub.AdminWrite('product.save',{title:'통화 설정 검증',description:'금액 기준 유지',genre:'레이싱',accessType:'TYPE1',plans:[{days:1,price:100}],published:true},'FIX52');
 const paid=run(a,'purchase',{productId:game.id,days:1,price:100,revision:game.revision});
 assert.equal(paid.profile.balance,9900);assert.equal(paid.order.amount,100);
 assert.equal(paid.profile.preferences.displayCurrency,'USD');
 assert.equal(Object.values(s.DB().ledger).find(row=>row.kind==='PURCHASE').amount,-100,'purchase still uses integer KRW');
 assert.equal(run(b,'activity').total,0,'purchase activity switch is actually enforced');
 run(a,'preferences.save',{purchaseActivityVisible:true});assert.equal(run(b,'activity').total,1);
 const snapshot=database.BuildDatabaseObject();assert.equal(database.ImportDatabaseObject(snapshot),true);
 assert.equal(run(a,'preferences').preferences.displayCurrency,'USD');assert.equal(run(a,'preferences').preferences.feedDefaultSort,'popular');
 assert.equal(run(a,'me').profile.balance,9900);
 assert.equal(preferences.Read({displayCurrency:'STALE',feedDefaultSort:'STALE'}).displayCurrency,'KRW');
 assert.equal(preferences.Read({displayCurrency:'STALE',feedDefaultSort:'STALE'}).feedDefaultSort,'latest');
 const bad=JSON.parse(JSON.stringify(require('../services/member/currency-reference.json')));
 bad.rates.KRW=0;assert.equal(currency.Normalize(bad),null);
 bad.rates.KRW=1556.56;bad.rateDate='2026-02-30';assert.equal(currency.Normalize(bad),null);
 const missing=JSON.parse(execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify(require('+JSON.stringify(require.resolve('../services/member/currency'))+').Reference()))'],{
  cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:{...process.env,MOAPLAY_CURRENCY_REFERENCE_PATH:path.join(temp,'missing.json')}
 }));
 assert.deepEqual(missing.rates,{KRW:1});assert.deepEqual(missing.currencies,['KRW']);assert.equal(missing.approximate,false);
 const copied=currency.Reference();copied.rates.USD=1000;assert.equal(currency.Reference().rates.USD,reference.rates.USD,'caller cannot alter shared rates');
 console.log('FIX52 CURRENCY SETTINGS PASS: eight reference currencies, server preference roundtrip, account isolation, immutable KRW ledger and purchase, activity privacy, input validation, save rollback, restart persistence and unavailable-rate fallback.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
