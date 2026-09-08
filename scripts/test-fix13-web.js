'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-fix13-dom-'));
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
 assert.ok(w.document.getElementById('content').textContent.includes('많이 본 피드'));
 await click(w.document.querySelector('[data-view="member-products"]'));
 await click(w.document.querySelector('[data-member-action="product.new"]'));
 const field=(name,value)=>{w.document.querySelector('[data-modal-field="'+name+'"]').value=value;};
 field('title','테일즈런너 테스트 상품');field('description','설명 <script>실행 금지</script>');field('published','true');
 await click(w.document.getElementById('modal-confirm'));await wait();
 const store=require('../services/member/store');const products=Object.values(store.DB().products);assert.equal(products.length,1);assert.equal(products[0].price,undefined);
 assert.ok(w.document.getElementById('content').textContent.includes('테일즈런너 테스트 상품'));
 await click(w.document.querySelector('[data-view="member-news"]'));await click(w.document.querySelector('[data-member-action="news.new"]'));
 field('title','공지 테스트');field('body','다음 업데이트를 안내합니다.');field('published','true');await click(w.document.getElementById('modal-confirm'));await wait();assert.equal(Object.values(store.DB().news).length,1);
 for(const view of ['overview','products','news','orders','ledger','profiles','posts','comments','reports']){await click(w.document.querySelector('[data-view="member-'+view+'"]'));assert.ok(w.document.getElementById('content').textContent.trim());}
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
 console.log('FIX13 ADMIN DOM PASS: all 9 management views, real product and news writes, rapid tab and page navigation, unchanged protocol values, admin-only API');
}finally{w.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
