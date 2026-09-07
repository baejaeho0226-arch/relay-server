'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix14-dom-'));
process.env.DATA_DIR=temp;process.env.STORAGE_ENGINE='json';
require('../core/utils').EnsureDirs();
const api=require('../web/webApi'),manager=require('../license/licenseManager');
const keys=[manager.CreateLicense(30,'USER_TEXT warning online 그대로').key,manager.CreateLicense(30,'두 번째').key];
const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const originalHtml=fs.readFileSync(root+'/public/index.html','utf8');
const dom=new JSDOM(originalHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''),{url:'https://fixture.invalid',runScripts:'outside-only',virtualConsole:vc});
const w=dom.window;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.matchMedia=()=>({matches:false,addListener(){}});w.EventSource=class{addEventListener(){}close(){}};
const backend=[];
w.fetch=async(url,options={})=>{
 if(url==='/api/session')return {status:200,ok:true,text:async()=>JSON.stringify({role:'admin',csrf:'TEST',expiresAt:Date.now()+100000})};
 const req=require('node:stream').Readable.from(options.body?[Buffer.from(options.body)]:[]);Object.assign(req,{url,method:options.method||'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}});
 let status,text;await api.HandleApiRequest(req,{writeHead(n){status=n;},end(t){text=t;}},{role:'admin',id:'TEST_ADMIN'});
 backend.push({url,status});return {status,ok:status>=200&&status<300,text:async()=>text};
};
for(const m of originalHtml.matchAll(/<script src="\/([^?]+)\?/g))new vm.Script(fs.readFileSync(root+'/public/'+m[1],'utf8')).runInContext(dom.getInternalVMContext());
const wait=()=>new Promise(r=>setTimeout(r,35));
const click=async el=>{assert.ok(el);el.click();await wait();};
(async()=>{try{
 await wait();w.switchView('member');await w.renderCurrent();
 assert.ok(w.document.getElementById('content').textContent.includes('충전 안내'));
 await click(w.document.querySelector('[data-member-view="products"]'));
 await click(w.document.querySelector('[data-member-action="product.new"]'));
 const field=(name,value)=>{w.document.querySelector('[data-modal-field="'+name+'"]').value=value;};
 field('title','테일즈런너 테스트 상품');field('description','설명 <script>실행 금지</script>');field('price','5000');field('days','30');field('stock','4');field('published','true');
 await click(w.document.getElementById('modal-confirm'));await wait();
 const store=require('../services/member/store');const products=Object.values(store.DB().products);assert.equal(products.length,1);assert.equal(products[0].price,5000);
 assert.ok(w.document.getElementById('content').textContent.includes('테일즈런너 테스트 상품'));
 await click(w.document.querySelector('[data-member-view="news"]'));await click(w.document.querySelector('[data-member-action="news.new"]'));
 field('title','공지 테스트');field('body','다음 업데이트를 안내합니다.');field('published','true');await click(w.document.getElementById('modal-confirm'));await wait();assert.equal(Object.values(store.DB().news).length,1);
 for(const view of ['overview','coins','products','news','topups','orders','ledger','profiles','posts','comments','reports','analytics']){await click(w.document.querySelector('[data-member-view="'+view+'"]'));assert.ok(w.document.getElementById('content').textContent.trim());}

 // New coin address editor persists settings without inventing receiving addresses.
 await click(w.document.querySelector('[data-member-view="coins"]'));await click(w.document.querySelector('[data-member-action="coin.new"]'));
 assert.equal(w.document.querySelector('[data-modal-field="address"]').value,'');
 field('symbol','BTC');field('name','비트코인');field('network','Bitcoin');field('address','TEST_ONLY_ADDRESS_123456789');field('krwPerCoin','100000000');field('decimals','8');field('confirmations','3');field('enabled','true');
 await click(w.document.getElementById('modal-confirm'));const coin=Object.values(store.DB().coins)[0];assert.ok(coin.enabled);
 await click(w.document.querySelector('[data-member-action="coin.edit"]'));field('name','비트코인 수정');await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().coins[coin.id].revision,2);
 const service=require('../services/member/service'),state=require('../core/state');
 service.AdminWrite('settings.save',{topupEnabled:true,topupInstructions:'입금 확인 후 반영'},'TEST');
 const c={type:'client',clientId:'1111111111111111',connected:true,permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,installationDeviceKey:'FIX14-WEB-CLIENT',socket:{destroyed:false,write(){}}};state.clientIdentities.set(c.installationDeviceKey,{id:c.clientId,serverId:''});state.clients.set(c.clientId,c);state.deviceAuthStatus.set('CLIENT:'+c.clientId,{verified:true,verifiedAt:Date.now()});
 const quote=service.Execute(c,'WEBQUOTE0001','topup.quote',{coinId:coin.id,amount:10000}).quote;
 const top=service.Execute(c,'WEBTOPUP0001','topup.create',{quoteId:quote.id,txHash:'fe'.repeat(32)}).topup;
 await click(w.document.querySelector('[data-member-view="topups"]'));await click(w.document.querySelector('[data-member-action="topup.approve"]'));
 assert.equal(w.document.querySelector('[data-modal-field="receivedAmount"]').value,'');assert.equal(w.document.querySelector('[data-modal-field="receiptVerified"]').value,'false');
 field('receivedAmount',top.coinAmount);field('confirmations','3');field('receiptVerified','true');await click(w.document.getElementById('modal-confirm'));
 assert.equal(store.DB().topups[top.id].status,'APPROVED');assert.equal(store.Account(c).balance,10000);
 // Search, multi-select delete, archived filter, restore and republish against the real HTTP routes.
 await click(w.document.querySelector('[data-member-view="products"]'));
 const search=w.document.getElementById('member-search');search.value='찾을 수 없는 상품';w.document.getElementById('member-search-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await wait();assert.equal(w.document.querySelectorAll('.member-check').length,0);
 await click(w.document.querySelector('[data-member-action="reset"]'));
 await click(w.document.querySelector('#member-check-all'));assert.equal(w.document.querySelector('[data-member-action="bulk.delete"]').disabled,false);
 await click(w.document.querySelector('[data-member-action="bulk.delete"]'));await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().products[products[0].id].deleted,true);
 const filter=w.document.querySelector('#member-filter');filter.value='deleted';filter.dispatchEvent(new w.Event('change',{bubbles:true}));await wait();assert.equal(w.document.querySelectorAll('.member-check').length,1);
 await click(w.document.querySelector('[data-member-action="content.restore"]'));await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().products[products[0].id].deleted,false);assert.equal(w.document.querySelectorAll('.member-check').length,0);
 await click(w.document.querySelector('[data-member-action="reset"]'));await click(w.document.querySelector('[data-member-action="content.publish"]'));await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().products[products[0].id].published,true);
 assert.equal(w.uiError('TX_ALREADY_SUBMITTED'),'이미 접수된 거래입니다. 충전 내역이나 고객센터에서 확인해주세요.');
 service.Execute(c,'WEBVIEW00001','view',{screen:'checkout',kind:'product',id:products[0].id});
 await click(w.document.querySelector('[data-member-view="analytics"]'));assert.ok(w.document.getElementById('content').textContent.includes('상품 상세'));
 // Late tab responses must not replace a newer tab or another main screen.
 await click(w.document.querySelector('[data-member-view="products"]'));
 const originalFetch=w.fetch;let release;
 w.fetch=async(url,options)=>{if(url.startsWith('/api/member?view=news'))await new Promise(resolve=>{release=resolve;});return originalFetch(url,options);};
 w.document.querySelector('[data-member-view="news"]').click();await wait();assert.ok(release);
 await click(w.document.querySelector('[data-member-view="products"]'));release();await wait();
 assert.ok(w.document.querySelector('[data-member-action="product.new"]'));
 w.document.querySelector('[data-member-view="news"]').click();await wait();
 w.switchView('dashboard');await w.renderCurrent();release();await wait();
 assert.equal(w.document.querySelector('[data-member-action="news.new"]'),null);
 w.fetch=originalFetch;
 // HTTP route rejects non-admin access independently of the hidden navigation button.
 for(const role of ['viewer','operator']){
  const req=require('node:stream').Readable.from([]);Object.assign(req,{url:'/api/member',method:'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}});let status;
  await api.HandleApiRequest(req,{writeHead(n){status=n;},end(){}},{role,id:'OTHER'});assert.equal(status,403);
 }
 assert.equal(errors.length,0,errors.join('\n'));assert.ok(!backend.some(x=>x.status>=500));
 console.log('FIX14 ADMIN DOM PASS: 12 views, real coin/product/news writes, receipt approval, search, bulk archive/restore, analytics, stale-response protection and admin-only routes');
}finally{w.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
