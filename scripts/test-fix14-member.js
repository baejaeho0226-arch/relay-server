'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix14-member-'));process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
const state=require('../core/state'),s=require('../services/member/store'),hub=require('../services/member/service'),coins=require('../services/member/coins'),database=require('../storage/database');
require('../core/utils').EnsureDirs();let sequence=0;
function client(id,key){const c={type:'client',clientId:id,connected:true,permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,installationDeviceKey:key,socket:{destroyed:false,remoteAddress:'127.0.0.1',write(){return true;}}};state.clientIdentities.set(key,{id,serverId:''});state.clients.set(id,c);state.deviceAuthStatus.set('CLIENT:'+id,{verified:true,verifiedAt:Date.now()});return c;}
const run=(c,action,body={},id)=>hub.Execute(c,id||'FIX14REQ'+(++sequence).toString().padStart(8,'0'),action,body),admin=(action,body)=>hub.AdminWrite(action,body,'TEST');
const read=body=>hub.AdminRead(body),fail=(fn,code)=>assert.throws(fn,e=>e.message===code),count=(k,id)=>s.ViewCount(k,id);
const coinBody={symbol:'BTC',name:'비트코인',network:'Bitcoin',address:'TEST_ONLY_BTC_ADDRESS_123456789',memo:'',decimals:8,krwPerCoin:'100000000',confirmations:3,enabled:true};
try{
 const a=client('1111111111111111','FIX14-A'),b=client('2222222222222222','FIX14-B');const pa=run(a,'me').profile,pb=run(b,'me').profile;
 // Existing persisted schema must migrate without losing member/financial tables.
 const legacy=structuredClone(s.DB());legacy.schema=1;for(const key of ['coins','quotes','viewCounters','viewHits'])delete legacy[key];s.Import({memberHub:legacy});assert.equal(s.DB().schema,2);assert.equal(run(a,'me').profile.id,pa.id);
 const saved=JSON.stringify(s.DB());fail(()=>s.Import({memberHub:{...s.DB(),coins:[]}}),'MEMBER_STORAGE_INVALID');assert.equal(JSON.stringify(s.DB()),saved);
 const damaged=structuredClone(s.DB());delete damaged.coins;fail(()=>s.Import({memberHub:damaged}),'MEMBER_STORAGE_INVALID');assert.equal(JSON.stringify(s.DB()),saved);
 admin('settings.save',{topupEnabled:true,topupInstructions:'코인 입금 확인'});
 let btc=admin('coin.save',coinBody);const eth=admin('coin.save',{...coinBody,symbol:'ETH',name:'이더리움',network:'Ethereum',decimals:18,krwPerCoin:'3000000'});
 assert.equal(run(a,'me').settings.coins.length,2);
 const body={amount:1000,coinId:btc.id};const quote=run(a,'topup.quote',body,'QUOTE_RETRY_1').quote;
 assert.equal(quote.coinAmount,'0.00001');assert.ok(quote.qr.size>0);assert.deepEqual(run(a,'topup.quote',body,'QUOTE_RETRY_1').quote,quote);
 btc=admin('coin.save',{...btc,address:'TEST_ONLY_NEW_ADDRESS_987654321',krwPerCoin:'99999999.123456'});
 fail(()=>admin('coin.save',{...btc,revision:1}),'CONTENT_CHANGED');assert.equal(s.DB().quotes[quote.id].coin.address,coinBody.address);
 fail(()=>run(b,'topup.create',{quoteId:quote.id,txHash:'ab'.repeat(32)}),'QUOTE_NOT_FOUND');
 const top=run(a,'topup.create',{quoteId:quote.id,txHash:'0x'+'AB'.repeat(32),amount:999999,accountId:pb.id},'DEPOSIT_RETRY1').topup;
 assert.equal(top.amount,1000);assert.equal(top.coin.address,coinBody.address);assert.equal(top.coin.krwPerCoin,coinBody.krwPerCoin);assert.equal(run(a,'me').profile.balance,0);
 assert.equal(run(a,'topup.create',{quoteId:quote.id,txHash:'0x'+'AB'.repeat(32),amount:999999,accountId:pb.id},'DEPOSIT_RETRY1').topup.id,top.id);
 fail(()=>run(a,'topup.create',{quoteId:quote.id,txHash:'cd'.repeat(32)}),'QUOTE_ALREADY_USED');
 const receipt={id:top.id,approve:true,receivedAmount:top.coinAmount,confirmations:3,receiptVerified:true};
 fail(()=>admin('topup.decide',{...receipt,receivedAmount:'0.00000999'}),'COIN_AMOUNT_SHORT');
 fail(()=>admin('topup.decide',{...receipt,confirmations:2}),'CONFIRMATIONS_SHORT');
 fail(()=>admin('topup.decide',{...receipt,receiptVerified:false}),'RECEIPT_VERIFICATION_REQUIRED');
 const save=database.SaveDatabase,before=JSON.stringify(s.DB());database.SaveDatabase=()=>false;
 fail(()=>admin('topup.decide',receipt),'STORAGE_SAVE_FAILED');database.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),before);
 admin('topup.decide',receipt);admin('topup.decide',receipt);assert.equal(run(a,'me').profile.balance,1000);assert.equal(Object.keys(s.DB().ledger).length,1);assert.equal(run(b,'me').profile.balance,0);
 const q2=run(b,'topup.quote',{amount:1000,coinId:eth.id}).quote;assert.equal(q2.coinAmount,'0.000333333333333334');
 fail(()=>run(b,'topup.create',{quoteId:q2.id,txHash:'ab'.repeat(32)}),'TX_ALREADY_SUBMITTED');
 const canceled=run(b,'topup.create',{quoteId:q2.id,txHash:'de'.repeat(32)}).topup;run(b,'topup.cancel',{id:canceled.id});
 const q3=run(a,'topup.quote',body).quote;fail(()=>run(a,'topup.create',{quoteId:q3.id,txHash:'de'.repeat(32)}),'TX_ALREADY_SUBMITTED');
 admin('topup.reopen',{id:canceled.id});assert.equal(s.DB().topups[canceled.id].status,'PENDING');admin('topup.decide',{id:canceled.id,approve:false,reason:'확인 보류'});
 fail(()=>run(a,'topup.create',{quoteId:q3.id,txHash:'de'.repeat(32)}),'TX_ALREADY_SUBMITTED');
 s.DB().quotes[q3.id].expiresAt=Date.now()-1;fail(()=>run(a,'topup.create',{quoteId:q3.id,txHash:'ef'.repeat(32)}),'QUOTE_EXPIRED');
 const q4=run(a,'topup.quote',body).quote,q5=run(a,'topup.quote',body).quote;assert.equal(s.DB().quotes[q4.id],undefined);assert.ok(s.DB().quotes[q5.id]);
 admin('coin.save',{...btc,enabled:false});assert.equal(read({view:'coins',status:'active'}).total,1);fail(()=>run(a,'topup.quote',body),'COIN_UNAVAILABLE');
 // Decimal arithmetic is exact and always rounds up only the last atomic unit.
 for(const decimals of [0,6,8,18]){for(const rate of ['3','3000000','99999999.123456']){
  const c=admin('coin.save',{...coinBody,decimals,krwPerCoin:rate});const q=run(b,'topup.quote',{amount:12345,coinId:c.id}).quote;
  const units=coins.Units(q.coinAmount,decimals),scaled=coins.Units(rate,6),required=12345n*10n**BigInt(decimals)*1000000n;
  assert.ok(units*scaled>=required);assert.ok((units-1n)*scaled<required);
 }}
 fail(()=>coins.Units('1e-8',8),'COIN_AMOUNT_INVALID');fail(()=>coins.Units('0.000000001',8),'COIN_AMOUNT_INVALID');
 // The existing native center logo must not make short deposit-address QR codes unreadable.
 const {PNG}=require('pngjs'),decode=require('../services/qrImageDecoder').DecodeQrImage;
 for(const address of ['TEST_ADDRESS12','1'+'A'.repeat(33),'0x'+'a'.repeat(40),'T'+'A'.repeat(33),'A'.repeat(44)])for(const damage of [0,255]){
  const matrix=coins.AddressQr(address),scale=4,side=(matrix.size+16)*scale,png=new PNG({width:side,height:side});png.data.fill(255);
  for(let y=0;y<matrix.size;y++)for(let x=0;x<matrix.size;x++)if(matrix.bits[y*matrix.size+x]==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
   const i=(((y+8)*scale+dy)*side+(x+8)*scale+dx)*4;png.data[i]=png.data[i+1]=png.data[i+2]=0;
  }
  for(let y=(side-9*scale)/2;y<(side+9*scale)/2;y++)for(let x=(side-9*scale)/2;x<(side+9*scale)/2;x++){
   const i=(y*side+x)*4;png.data[i]=png.data[i+1]=png.data[i+2]=damage;
  }
  assert.equal(decode('data:image/png;base64,'+PNG.sync.write(png).toString('base64')),address);
 }
 // Public counters: once per account/day; hidden and private items cannot be counted.
 const product=admin('product.save',{title:'테일즈런너',description:'검색 단어',accessType:'TYPE1',price:1000,days:30,stock:1,published:true});
 const news=admin('news.save',{title:'공지',body:'내용',category:'NOTICE',published:true});const privateNews=admin('news.save',{title:'개인 알림',body:'비공개',category:'ALERT',published:true,audience:pa.id});
 for(let i=0;i<4;i++)run(a,'view',{screen:'checkout',kind:'product',id:product.id});assert.equal(count('screen','checkout'),1);assert.equal(count('product',product.id),1);
 run(b,'view',{screen:'checkout',kind:'product',id:product.id});assert.equal(count('product',product.id),2);
 s.DB().viewHits[pa.id+':product:'+product.id]='2000-01-01';run(a,'view',{screen:'checkout',kind:'product',id:product.id});assert.equal(count('product',product.id),3);assert.equal(run(a,'catalog').items[0].views,3);
 fail(()=>run(b,'view',{screen:'article',kind:'news',id:privateNews.id}),'CONTENT_NOT_FOUND');run(a,'view',{screen:'article',kind:'news',id:news.id});
 const post=run(a,'post.create',{body:'좋은 하루'}).post;run(a,'feed');run(a,'feed');assert.equal(count('post',post.id),1);
 const comment=run(b,'comment.create',{postId:post.id,body:'안녕하세요'}).comment;run(a,'thread',{postId:post.id});run(a,'thread',{postId:post.id});assert.equal(count('comment',comment.id),1);assert.equal(count('profile',pb.id),1);
 admin('content.action',{table:'posts',id:post.id,operation:'hide'});fail(()=>run(a,'view',{screen:'feed',kind:'post',id:post.id}),'CONTENT_NOT_FOUND');assert.equal(run(a,'feed').total,0);
 admin('content.action',{table:'posts',id:post.id,operation:'show'});admin('post.save',{id:post.id,body:'수정됨',revision:2});fail(()=>admin('post.save',{id:post.id,body:'충돌',revision:0}),'CONTENT_CHANGED');
 const viewBefore=JSON.stringify(s.DB());database.SaveDatabase=()=>false;fail(()=>run(b,'view',{screen:'menu'}),'STORAGE_SAVE_FAILED');database.SaveDatabase=save;assert.equal(JSON.stringify(s.DB()),viewBefore);
 admin('content.action',{table:'products',ids:[product.id],operation:'delete'});assert.equal(run(a,'catalog').total,0);fail(()=>run(a,'purchase',{productId:product.id,expectedPrice:1000}),'PRODUCT_UNAVAILABLE');assert.equal(read({view:'products',status:'deleted',q:'검색 단어'}).total,1);
 admin('content.action',{table:'products',id:product.id,operation:'restore'});assert.equal(run(a,'catalog').total,0);admin('content.action',{table:'products',id:product.id,operation:'publish'});assert.equal(run(a,'catalog').total,1);
 const productBefore=JSON.stringify(s.DB().products);fail(()=>admin('content.action',{table:'products',ids:[product.id,'MISSING'],operation:'delete'}),'CONTENT_NOT_FOUND');assert.equal(JSON.stringify(s.DB().products),productBefore);
 fail(()=>admin('content.action',{table:'ledger',id:Object.keys(s.DB().ledger)[0],operation:'delete'}),'CONTENT_ACTION_INVALID');
 run(b,'comment.delete',{id:comment.id});fail(()=>admin('content.action',{table:'comments',id:comment.id,operation:'restore'}),'CONTENT_RESTORE_UNAVAILABLE');
 run(b,'report',{postId:post.id,reason:'검토'});const report=read({view:'reports'}).items[0];admin('report.resolve',{id:report.id,resolution:'확인'});admin('report.reopen',{id:report.id,resolution:'재검토'});assert.equal(read({view:'reports',status:'OPEN'}).total,1);
 assert.ok(read({view:'analytics',sort:'views'}).total>0);assert.ok(read({view:'overview'}).pageViews>=3);
 admin('profile.block',{id:pb.id,blocked:true});fail(()=>run(b,'view',{screen:'menu'}),'ACCOUNT_BLOCKED');
 console.log('FIX14 MEMBER PASS: migration, exact coin quotes, immutable addresses, ownership, duplicate transactions, receipts, rollback, daily views, privacy, revisions, moderation, delete/restore and immutable ledger');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
