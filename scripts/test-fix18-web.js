'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix15-dom-'));
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
Object.defineProperty(w.document,'hidden',{get:()=>false});
const wait=()=>new Promise(r=>setTimeout(r,35));
const click=async el=>{assert.ok(el);el.click();await wait();};
(async()=>{try{
 await wait();w.switchView('member');await w.renderCurrent();
 assert.ok(w.document.getElementById('content').textContent.includes('많이 본 피드'));
 await click(w.document.querySelector('[data-view="member-products"]'));
 await click(w.document.querySelector('[data-member-action="product.new"]'));
 const field=(name,value)=>{w.document.querySelector('[data-modal-field="'+name+'"]').value=value;};
 field('title','테일즈런너 테스트 상품');field('description','설명 <script>실행 금지</script>');field('published','true');for(const [days,price] of [[1,1000],[7,6000],[15,12000],[30,20000]])field('price'+days,String(price));
 await click(w.document.getElementById('modal-confirm'));await wait();
 const store=require('../services/member/store');const products=Object.values(store.DB().products);assert.equal(products.length,1);assert.deepEqual(products[0].plans.map(x=>x.days),[1,7,15,30]);assert.equal(products[0].plans[3].price,20000);
 assert.ok(w.document.getElementById('content').textContent.includes('테일즈런너 테스트 상품'));
 await click(w.document.querySelector('[data-view="member-news"]'));await click(w.document.querySelector('[data-member-action="news.new"]'));
 field('title','공지 테스트');field('body','다음 업데이트를 안내합니다.');field('published','true');await click(w.document.getElementById('modal-confirm'));await wait();assert.equal(Object.values(store.DB().news).length,1);
 for(const view of ['overview','products','news','orders','ledger','profiles','posts','comments','reports']){await click(w.document.querySelector('[data-view="member-'+view+'"]'));assert.ok(w.document.getElementById('content').textContent.trim());}

 assert.equal(w.document.querySelectorAll('#nav [data-view^="member-"]').length,9);assert.equal(w.document.querySelector('.member-tabs'),null);
 const theme=w.document.getElementById('theme-toggle');await click(theme);assert.equal(w.document.documentElement.dataset.theme,'dark');assert.equal(w.localStorage.getItem('relay-admin-theme'),'dark');assert.equal(theme.getAttribute('aria-pressed'),'true');
 await click(w.document.querySelector('[data-view="member-news"]'));assert.equal(w.document.documentElement.dataset.theme,'dark');
 await click(theme);assert.equal(w.document.documentElement.dataset.theme,'light');assert.equal(w.localStorage.getItem('relay-admin-theme'),'light');
 const service=require('../services/member/service'),state=require('../core/state');
 const c={type:'client',clientId:'1111111111111111',connected:true,permissionsGranted:true,deviceAuthVerified:true,biometricVerified:true,licenseAuthorized:true,installationDeviceKey:'FIX15-WEB-CLIENT',socket:{destroyed:false,write(){}}};state.clientIdentities.set(c.installationDeviceKey,{id:c.clientId,serverId:''});state.clients.set(c.clientId,c);state.deviceAuthStatus.set('CLIENT:'+c.clientId,{verified:true,verifiedAt:Date.now()});
 const post=service.Execute(c,'WEBPOST0001','post.create',{body:'확인할 피드 원문'}).post;
 service.Execute(c,'WEBFEED0001','feed',{});
 for(const view of ['overview','news','products','profiles','posts','comments','reports','orders','ledger']){
  await click(w.document.querySelector('[data-view="member-'+view+'"]'));
  const text=w.document.getElementById('content').textContent;
  assert.ok(!text.includes('0–0'));assert.equal(w.document.querySelector('.member-pagination'),null);
  assert.equal(w.document.querySelector('[data-view="member-coins"]'),null);assert.equal(w.document.querySelector('[data-view="member-topups"]'),null);
  const headers=[...w.document.querySelectorAll('th')].map(x=>x.textContent);assert.equal(headers.includes('조회수'),view==='posts');
 }
 await click(w.document.querySelector('[data-view="member-posts"]'));await click(w.document.querySelector('[data-member-action="post.edit"]'));
 field('body','운영자가 수정한 본문');await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().posts[post.id].body,'운영자가 수정한 본문');
 // Background refresh is blocked for a held pointer, an open editor and selected rows.
 new vm.Script('memberInteractionUntil=0;memberLastRefresh=Date.now();').runInContext(dom.getInternalVMContext());
 w.document.querySelector('.member-item').dispatchEvent(new w.Event('pointerdown',{bubbles:true}));assert.equal(w.memberCanAutoRefresh(),false);
 service.AdminWrite('post.save',{id:post.id,body:'백그라운드에서 바뀐 내용'},'TEST');const oldBody=w.document.querySelector('.member-preview');await w.renderMember(true);assert.equal(w.document.querySelector('.member-preview'),oldBody);
 w.document.dispatchEvent(new w.Event('pointerup',{bubbles:true}));new vm.Script('memberInteractionUntil=0;').runInContext(dom.getInternalVMContext());
 const search=w.document.querySelector('#member-search');search.focus();assert.equal(w.memberCanAutoRefresh(),false);search.blur();
 search.value='입력 중인 검색어';assert.equal(w.memberCanAutoRefresh(),false);await w.renderMember(true);assert.equal(search.value,'입력 중인 검색어');assert.equal(w.document.querySelector('.member-preview'),oldBody);search.value='';
 const scroll=w.document.querySelector('.table-wrap');scroll.scrollTop=71;scroll.scrollLeft=19;
 await w.renderMember(true);assert.ok(w.document.getElementById('content').textContent.includes('백그라운드에서 바뀐 내용'));assert.equal(w.document.querySelector('.table-wrap').scrollTop,71);assert.equal(w.document.querySelector('.table-wrap').scrollLeft,19);
 const unchanged=w.document.querySelector('.member-shell');await w.renderMember(true);assert.equal(w.document.querySelector('.member-shell'),unchanged,'unchanged data must not rebuild controls');
 await click(w.document.querySelector('.member-check'));assert.equal(w.memberCanAutoRefresh(),false);
 // Search and bulk operations preserve the current filter and show no bogus page range.
 await click(w.document.querySelector('[data-view="member-products"]'));
 w.document.querySelector('#member-search').value='없는 상품';w.document.querySelector('#member-search-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await wait();assert.equal(w.document.querySelector('table'),null);assert.equal(w.document.querySelector('.member-pagination'),null);
 await click(w.document.querySelector('[data-member-action="reset"]'));await click(w.document.querySelector('#member-check-all'));await click(w.document.querySelector('[data-member-action="bulk.delete"]'));await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().products[products[0].id].deleted,true);
 const filter=w.document.querySelector('#member-filter');filter.value='deleted';filter.dispatchEvent(new w.Event('change',{bubbles:true}));await wait();await click(w.document.querySelector('[data-member-action="content.restore"]'));await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().products[products[0].id].deleted,false);
 const css=fs.readFileSync(root+'/public/admin-member.css','utf8');assert.equal(w.document.querySelector('.member-tabs'),null);assert.ok(css.includes('.sidebar #nav::-webkit-scrollbar-thumb'));assert.ok(css.includes('padding:24px'));
 // Retired coin routes are blocked over the real HTTP router as well as in the UI.
 for(const action of ['coin.save','topup.decide','settings.save']){const response=await w.fetch('/api/member/action',{method:'POST',body:JSON.stringify({action,id:'OLD'})});assert.equal(response.status,400);}
 // The administrator scans the actual member QR image and credits the non-expiring wallet.
 const charges=require('../services/member/charges'),profile=store.Account(c),issued=charges.Read(profile),charge=store.DB().chargeRequests[issued.request.id];
 const png=await require('qrcode').toBuffer('QRC1.'+charge.id+'.'+charge.token,{errorCorrectionLevel:'H',scale:6});
 await click(w.document.querySelector('[data-view="qrauth"]'));
 const chargeInput=w.document.querySelector('#qr-auth-file');Object.defineProperty(chargeInput,'files',{configurable:true,value:[new w.File([png],'charge.png',{type:'image/png'})]});
 chargeInput.dispatchEvent(new w.Event('change',{bubbles:true}));await wait();assert.equal(w.memberCanAutoRefresh(),false);assert.ok(w.document.querySelector('#qr-auth-preview').src.startsWith('data:image/png;base64,'));
 await w.renderQrAuth();assert.ok(w.document.querySelector('#qr-auth-preview').src.startsWith('data:image/png;base64,'));
 await click(w.document.querySelector('#qr-auth-scan-btn'));await click(w.document.querySelector('#qr-auth-approve-btn'));
 assert.ok(w.document.getElementById('modal').textContent.includes(profile.nickname));field('amount','20000');assert.equal(w.document.querySelector('[data-modal-field="days"]'),null);assert.equal(w.document.querySelector('[data-modal-field="accessType"]'),null);field('memo','입금 확인 후 등록');
 await click(w.document.getElementById('modal-confirm'));assert.equal(store.DB().chargeRequests[charge.id].status,'APPROVED');
 assert.equal(store.ProfileById(profile.id).balance,20000);assert.equal(Object.keys(store.DB().orders).length,0);
 assert.ok(w.document.getElementById('content').textContent.includes('잔액 충전'));assert.equal(w.document.querySelector('[data-member-action="charge.reject"]'),null);assert.ok(w.document.querySelector('#qr-auth-preview').classList.contains('hidden'));
 await click(w.document.querySelector('[data-view="member-products"]'));await click(w.document.querySelector('[data-member-action="product.edit"]'));
 for(const days of [1,7,15,30])assert.ok(w.document.querySelector('[data-modal-field="price'+days+'"]'));assert.equal(w.document.querySelector('[data-modal-field="days"]'),null);await click(w.document.getElementById('modal-confirm'));
 // An interrupted browser pointer cannot suppress polling forever.
 new vm.Script('memberPointerDown=true;memberPointerUntil=Date.now()-1;memberInteractionUntil=0;').runInContext(dom.getInternalVMContext());assert.equal(w.memberCanAutoRefresh(),true);
 // Late tab responses must not replace a newer tab or another main screen.
 await click(w.document.querySelector('[data-view="member-products"]'));
 const originalFetch=w.fetch;let release;
 w.fetch=async(url,options)=>{if(url.startsWith('/api/member?view=news'))await new Promise(resolve=>{release=resolve;});return originalFetch(url,options);};
 w.document.querySelector('[data-view="member-news"]').click();await wait();assert.ok(release);
 await click(w.document.querySelector('[data-view="member-products"]'));release();await wait();
 assert.ok(w.document.querySelector('[data-member-action="product.new"]'));
 w.document.querySelector('[data-view="member-news"]').click();await wait();
 w.switchView('dashboard');await w.renderCurrent();release();await wait();
 assert.equal(w.document.querySelector('[data-member-action="news.new"]'),null);
 w.fetch=originalFetch;
 // HTTP route rejects non-admin access independently of the hidden navigation button.
 for(const role of ['viewer','operator']){
  const req=require('node:stream').Readable.from([]);Object.assign(req,{url:'/api/member',method:'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}});let status;
  await api.HandleApiRequest(req,{writeHead(n){status=n;},end(){}},{role,id:'OTHER'});assert.equal(status,403);
 }
 assert.equal(errors.length,0,errors.join('\n'));assert.ok(!backend.some(x=>x.status>=500));
 console.log('FIX18 ADMIN DOM PASS: nine independent pages and unified QR, feed-only counts, owner/admin edits, empty pagination, search/archive/restore, safe automatic refresh, unchanged DOM and scroll preservation, retired coin routes, four duration price forms, QR preview retention and actual QR wallet approval');
}finally{w.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
